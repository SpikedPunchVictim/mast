import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../index.js';
import { extractFile } from '../../ast/extract.js';
import { openDatabase, type Db } from '../../graph/db.js';
import { checkAndRefreshIfStale } from '../../mcp/staleness.js';
import type { LockEvent, LockMetricsSink } from '../../store/lockMetrics.js';

// ---------------------------------------------------------------------------
// F1 — structure.lock scope: whole-run -> per-batch (indexer/index.ts).
//
// GITNEXUS_COMPARISON.md §13.2 / MAST_SPEC.md:822-826: `runIndex` used to wrap
// its ENTIRE run in one `withLock(...'structure'...)`, measured to hold for
// 280,782ms on a 1,335-file corpus (eval/baseline-locks.json) — starving the
// JIT re-parse path (mcp/staleness.ts:56, 3 retries x 100ms) for the whole
// run. These tests assert the decisive behaviour the fix must produce: a JIT
// re-parse succeeds while a multi-file reindex is in flight, and neither
// `files.mtime` (the DB column staleness detection reads —
// mcp/tools/_helpers.ts:50,66) nor `file_manifest.json` (the next run's
// incremental-diff input) regress backward for a file JIT touched mid-run.
// ---------------------------------------------------------------------------

/** In-memory fake sink (§5.3 "fakes over mocks") — no filesystem writes. */
function fakeSink(): { sink: LockMetricsSink; events: LockEvent[] } {
  const events: LockEvent[] = [];
  return { sink: { record: (event) => { events.push(event); } }, events };
}

/**
 * Synchronous, per-call delay injected into the parse phase (§4.4 DI via
 * `IndexOptions.extractFileFn`) so a multi-batch reindex stays "in flight"
 * long enough to race a concurrent JIT call deterministically — without
 * `sleep`-ing the whole test suite. `extractFile` is itself synchronous
 * (tree-sitter, no I/O awaits), so a busy-wait is the only way to slow this
 * specific call without changing its (synchronous) contract.
 */
function slowExtractFile(delayMs: number): typeof extractFile {
  return (...args) => {
    const result = extractFile(...args);
    const until = Date.now() + delayMs;
    while (Date.now() < until) { /* deterministic per-file delay */ }
    return result;
  };
}

const FILE_COUNT = 40; // 3 LANCE_BATCH(16)-sized batches: 16, 16, 8.
const TARGET = 'f0.ts';

describe('F1: structure.lock scope is per-batch, not whole-run', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-lock-scope-'));
    for (let i = 0; i < FILE_COUNT; i++) {
      writeFileSync(join(dir, `f${i}.ts`), `export function f${i}(): number { return ${i}; }\n`);
    }
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a JIT refresh succeeds while a multi-file reindex is in progress', async () => {
    // Explicit timeout: this test deliberately runs a real multi-batch
    // reindex plus lock-retry backoff concurrently with other CPU-bound
    // test files under vitest's `forks` pool (vitest.config.ts) — the
    // default 5000ms budget is comfortable in isolation but flaky under a
    // loaded CI machine (matches store/__tests__/lock.test.ts's own "no
    // wall-clock exact match... resilient to a loaded CI machine" stance).
    const config = resolveConfig({ projectRoot: dir });

    // Baseline: fully index once so `files.mtime` exists for every file —
    // matches the realistic scenario (an already-indexed corpus, one file
    // edited, a reindex now in progress).
    await runIndex(config, { incremental: false });

    const preEditDb: Db = openDatabase(config.resolved_state_dir);
    const storedRow = await preEditDb
      .selectFrom('files').select('mtime').where('path', '=', TARGET).executeTakeFirstOrThrow();
    await preEditDb.destroy();

    // Edit the target file so its disk mtime is ahead of what's stored —
    // genuinely stale for the JIT path. Bump mtime explicitly: some
    // filesystems have mtime resolution too coarse to guarantee the write
    // above already moved it forward within the same test tick.
    const targetPath = join(dir, TARGET);
    writeFileSync(targetPath, 'export function f0(): number { return 999; }\n');
    const bumped = Date.now() / 1_000 + 5;
    utimesSync(targetPath, bumped, bumped);

    const { sink, events } = fakeSink();
    const runPromise = runIndex(config, {
      incremental: false, // reprocesses all 40 files — a genuine "multi-file reindex in progress"
      extractFileFn: slowExtractFile(5),
      lockMetricsSink: sink,
    });

    const jitDb: Db = openDatabase(config.resolved_state_dir);
    const jitPromise = checkAndRefreshIfStale(jitDb, config, TARGET, storedRow.mtime);

    const [runResult, jitResult] = await Promise.all([runPromise, jitPromise]);
    await jitDb.destroy();

    // The decisive assertion (§14.6 — values, not shape): today this is
    // `{ refreshed: false, busy: true }` because the whole run holds
    // structure.lock; after F1 it must be able to acquire the lock in one of
    // the gaps between per-batch acquisitions.
    expect(jitResult).toEqual({ refreshed: true, busy: false });

    // The reindex itself must still have completed correctly — F1 must not
    // trade correctness for lock availability.
    expect(runResult.filesIndexed).toBe(FILE_COUNT);
    expect(runResult.parseErrors).toBe(0);
    expect(runResult.writeErrors).toBe(0);

    // Bounded, per-batch acquisitions — not the pre-fix single whole-run hold.
    const acquiredByIndexRun = events.filter((e) => e.kind === 'acquired' && e.caller === 'index-run');
    expect(acquiredByIndexRun.length).toBeGreaterThan(1);
  }, 20_000);

  it('a file JIT-refreshed mid-run keeps a monotonic files.mtime (no regression)', async () => {
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });

    const preEditDb: Db = openDatabase(config.resolved_state_dir);
    const storedRow = await preEditDb
      .selectFrom('files').select('mtime').where('path', '=', TARGET).executeTakeFirstOrThrow();
    await preEditDb.destroy();

    const targetPath = join(dir, TARGET);
    writeFileSync(targetPath, 'export function f0(): number { return 999; }\n');
    const bumped = Date.now() / 1_000 + 5;
    utimesSync(targetPath, bumped, bumped);
    const diskMtimeAfterEdit = statSync(targetPath).mtimeMs / 1_000;

    const runPromise = runIndex(config, { incremental: false, extractFileFn: slowExtractFile(5) });
    const jitDb: Db = openDatabase(config.resolved_state_dir);
    const jitPromise = checkAndRefreshIfStale(jitDb, config, TARGET, storedRow.mtime);
    await Promise.all([runPromise, jitPromise]);
    await jitDb.destroy();

    // `files.mtime` is what countStaleFiles/checkAndRefreshIfStale compare
    // disk mtime against (mcp/tools/_helpers.ts:50,66) — this is the
    // user-visible staleness signal. It must reflect the edit, not regress
    // back to the pre-edit value the run's walk observed at start-of-run.
    const finalDb: Db = openDatabase(config.resolved_state_dir);
    const finalRow = await finalDb
      .selectFrom('files').select('mtime').where('path', '=', TARGET).executeTakeFirstOrThrow();
    await finalDb.destroy();

    expect(finalRow.mtime).toBeGreaterThanOrEqual(diskMtimeAfterEdit - 0.001);
    // Not stale: disk mtime no longer exceeds the stored mtime.
    expect(statSync(targetPath).mtimeMs / 1_000).toBeLessThanOrEqual(finalRow.mtime + 0.001);
  }, 20_000);

  it('a file JIT-refreshed mid-run is not left marked stale in file_manifest.json', async () => {
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });

    const preEditDb: Db = openDatabase(config.resolved_state_dir);
    const storedRow = await preEditDb
      .selectFrom('files').select('mtime').where('path', '=', TARGET).executeTakeFirstOrThrow();
    await preEditDb.destroy();

    const targetPath = join(dir, TARGET);
    writeFileSync(targetPath, 'export function f0(): number { return 999; }\n');
    const bumped = Date.now() / 1_000 + 5;
    utimesSync(targetPath, bumped, bumped);

    const runPromise = runIndex(config, { incremental: false, extractFileFn: slowExtractFile(5) });
    const jitDb: Db = openDatabase(config.resolved_state_dir);
    const jitPromise = checkAndRefreshIfStale(jitDb, config, TARGET, storedRow.mtime);
    await Promise.all([runPromise, jitPromise]);
    await jitDb.destroy();

    const manifestPath = join(config.resolved_state_dir, 'file_manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, number>;
    const diskMtime = statSync(targetPath).mtimeMs / 1_000;

    // The manifest drives the NEXT run's diffManifest — if it still records
    // the pre-edit mtime, the next run would flag this file as stale again
    // even though it is already fully up to date (the regression F1 must
    // not reintroduce, one cycle later).
    expect(manifest[TARGET]).toBeCloseTo(diskMtime, 2);
  }, 20_000);
  // The former "MAST_CHUNK_STORE=sqlite arm" sanity test is retired along
  // with the env gate (M1, §15.1) — SQLite is now the only chunk-store path,
  // and every other test in this file already exercises it by default.
});
