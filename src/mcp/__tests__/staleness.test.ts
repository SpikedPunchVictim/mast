import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Sqlite from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase, type Db } from '../../graph/db.js';
import { populateFile } from '../../graph/populate.js';
import { checkAndRefreshIfStale } from '../staleness.js';

// ---------------------------------------------------------------------------
// F13 — a SQLITE_BUSY_SNAPSHOT thrown by `populateFile` used to escape
// `checkAndRefreshIfStale` uncaught, bypassing F2's
// `file_busy_returning_stale_cache` flag and violating MAST_SPEC.md §9.0's
// "do not throw" TOCTOU policy (52 real occurrences across 23/32 runs,
// eval/e7-round2.json — every one with `structure.lock` correctly held, so
// the lock never protects against this).
//
// These tests induce a GENUINE SQLITE_BUSY_SNAPSHOT the same way
// mast-bench's e7r2-busy-snapshot-repro.mjs did: a second real
// better-sqlite3 connection commits a write between a Kysely transaction's
// first read (which — under Kysely's deferred BEGIN — establishes its
// snapshot) and its own write attempt. This is deterministic, not a timing
// race: the steps are sequenced by the `await` boundaries inside the
// transaction callback, not by scheduling.
// ---------------------------------------------------------------------------

/**
 * Induce a real `SQLITE_BUSY_SNAPSHOT` against `db` and return the error
 * SQLite actually threw (real `SqliteError` instance, real `.code`) rather
 * than fabricating one — mirrors `populateFile`'s own monotonic-guard shape
 * (read `files`, then write `files`) so the failure is representative.
 */
async function induceRealBusySnapshot(db: Db, stateDir: string): Promise<Error & { code: string }> {
  const rawWriter = new Sqlite(join(stateDir, 'graph.db'));
  rawWriter.pragma('journal_mode = WAL');
  try {
    await db.transaction().execute(async (trx) => {
      // Step 1 (read): establishes this transaction's snapshot — same shape
      // as populateFile's monotonic write-guard SELECT (graph/populate.ts).
      await trx.selectFrom('files').select(['id', 'mtime']).limit(1).executeTakeFirst();
      // Step 2: a second, independent connection commits a write to the same
      // table while the transaction above is still open.
      rawWriter.prepare("UPDATE files SET mtime = mtime + 0.001 WHERE id = (SELECT id FROM files LIMIT 1)").run();
      // Step 3 (write): this transaction's snapshot is now stale relative to
      // step 2's commit — SQLite returns SQLITE_BUSY_SNAPSHOT here.
      await trx.updateTable('files').set({ mtime: 999_999 }).where('id', '=', -1).execute();
    });
    throw new Error('induceRealBusySnapshot: transaction committed instead of hitting SQLITE_BUSY_SNAPSHOT — test setup is broken');
  } catch (err) {
    // mast-assertion-rule-allow: `unknown` here narrows a genuinely-unknown
    // caught error's `code` property before the `typeof` guard proves it's a
    // string — this is a type-narrowing idiom on driver errors, not a
    // parsed tool/CLI response annotation the D4 rule targets.
    if (err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
      return err as Error & { code: string };
    }
    throw err;
  } finally {
    rawWriter.close();
  }
}

/** Induce a real `SQLITE_CONSTRAINT*` error (UNIQUE violation on `files.path`) — genuinely NOT a busy code. */
function induceRealConstraintViolation(stateDir: string, existingPath: string): Error & { code: string } {
  const raw = new Sqlite(join(stateDir, 'graph.db'));
  try {
    raw.prepare("INSERT INTO files (path, language, mtime) VALUES (?, 'typescript', 0)").run(existingPath);
    throw new Error('induceRealConstraintViolation: insert succeeded — test setup is broken');
  } catch (err) {
    // mast-assertion-rule-allow: same narrowing idiom as induceRealBusySnapshot above.
    if (err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
      return err as Error & { code: string };
    }
    throw err;
  } finally {
    raw.close();
  }
}

describe('F13: SQLITE_BUSY_SNAPSHOT from populateFile must not escape checkAndRefreshIfStale', () => {
  const TARGET = 'target.ts';
  let dir: string;
  let config: ReturnType<typeof resolveConfig>;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mast-f13-'));
    writeFileSync(join(dir, TARGET), 'export function contentA(): number { return 1; }\n');
    config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false }); // seeds a real `files` row + lock markers

    // Make the file stale so checkAndRefreshIfStale actually reaches the
    // populateFile call instead of short-circuiting on `diskMtime <= storedMtime`.
    writeFileSync(join(dir, TARGET), 'export function contentB(): number { return 2; }\n');
    const newMtime = Date.now() / 1_000 + 5;
    utimesSync(join(dir, TARGET), newMtime, newMtime);

    db = openDatabase(config.resolved_state_dir);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('yields { refreshed: false, busy: true } instead of throwing when retries are exhausted', async () => {
    const busyErr = await induceRealBusySnapshot(db, config.resolved_state_dir);
    expect(busyErr.code).toBe('SQLITE_BUSY_SNAPSHOT'); // sanity: the induction actually produced the code this fix targets

    const alwaysBusy: typeof populateFile = async () => { throw busyErr; };
    const storedRow = await db.selectFrom('files').select('mtime').where('path', '=', TARGET).executeTakeFirstOrThrow();

    // The decisive assertion (§14.6, values not shape): before the fix this
    // call rejects with busyErr instead of resolving with the flag.
    await expect(checkAndRefreshIfStale(db, config, TARGET, storedRow.mtime, alwaysBusy))
      .resolves.toEqual({ refreshed: false, busy: true });
  });

  it('a retry that succeeds returns { refreshed: true, busy: false }', async () => {
    const busyErr = await induceRealBusySnapshot(db, config.resolved_state_dir);
    let calls = 0;
    const failOnceThenReal: typeof populateFile = async (...args) => {
      calls += 1;
      if (calls === 1) throw busyErr;
      return populateFile(...args); // second attempt delegates to the real write
    };
    const storedRow = await db.selectFrom('files').select('mtime').where('path', '=', TARGET).executeTakeFirstOrThrow();

    const result = await checkAndRefreshIfStale(db, config, TARGET, storedRow.mtime, failOnceThenReal);

    expect(result).toEqual({ refreshed: true, busy: false });
    expect(calls).toBe(2); // proves the retry actually ran the real write, not that the error was merely swallowed

    const updatedRow = await db.selectFrom('files').select('mtime').where('path', '=', TARGET).executeTakeFirstOrThrow();
    expect(updatedRow.mtime).toBeGreaterThan(storedRow.mtime); // the real populateFile call actually landed
  });

  it('a non-busy error is NOT reclassified as busy — it propagates', async () => {
    const constraintErr = induceRealConstraintViolation(config.resolved_state_dir, TARGET);
    expect(constraintErr.code.startsWith('SQLITE_CONSTRAINT')).toBe(true); // sanity: genuinely not a busy code
    let calls = 0;
    const alwaysConstraintError: typeof populateFile = async () => { calls += 1; throw constraintErr; };
    const storedRow = await db.selectFrom('files').select('mtime').where('path', '=', TARGET).executeTakeFirstOrThrow();

    await expect(checkAndRefreshIfStale(db, config, TARGET, storedRow.mtime, alwaysConstraintError))
      .rejects.toBe(constraintErr); // surfaces distinctly — not swallowed, not remapped to { busy: true }
    expect(calls).toBe(1); // not retried — only SQLITE_BUSY* codes get the retry-then-map treatment
  });
});
