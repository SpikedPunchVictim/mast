import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../graph/db.js';
import type { ResolvedConfig } from '../store/config.js';
import { acquireLock } from '../store/lock.js';
import { extractFile } from '../ast/extract.js';
import { populateFile } from '../graph/populate.js';

// ---------------------------------------------------------------------------
// F13 — SQLITE_BUSY_SNAPSHOT retry classification
// ---------------------------------------------------------------------------

/** better-sqlite3 attaches a SQLite result code to the `code` property of every error it throws (`SqliteError`, `lib/sqlite-error.js`). */
interface SqliteCodedError {
  readonly code: string;
}

function hasSqliteCode(err: unknown): err is SqliteCodedError {
  return err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string';
}

/**
 * `SQLITE_BUSY_SNAPSHOT` (and plain `SQLITE_BUSY`) are the only codes this
 * function treats as recoverable. F12's monotonic-guard `SELECT` turned
 * `populateFile`'s transaction into a read-then-write shape, which — under
 * Kysely's deferred `BEGIN` (`sqlite-driver.js:32-34`) — can make the
 * transaction's snapshot go stale if another writer commits in between; a
 * fresh transaction takes a fresh snapshot and usually succeeds (E7-r2,
 * `eval/e7-round2.json`, 52 occurrences across 23/32 real runs). Any other
 * `SQLITE_*` code (constraint violation, corruption, disk full, ...) is a
 * genuinely unexpected failure, not TOCTOU noise — conflating it with "busy"
 * would repeat the parse_errors/write_errors misclassification this codebase
 * already fixed once (`indexer/__tests__/write-failures.test.ts`), so it is
 * deliberately excluded here and left to propagate.
 */
function isRetryableBusySnapshot(err: unknown): boolean {
  return hasSqliteCode(err) && (err.code === 'SQLITE_BUSY_SNAPSHOT' || err.code === 'SQLITE_BUSY');
}

/**
 * Bounded retry count for `populateFile` under a busy snapshot. Chosen small
 * (1 retry = 2 attempts total) because each retry opens a brand-new
 * transaction with a fresh snapshot — either that snapshot is no longer
 * contended and the retry succeeds immediately, or the file is under
 * sustained concurrent write pressure and further retries just delay the
 * `busy: true` fallback the TOCTOU policy (§9.0) already exists to handle.
 * No sleep between attempts: `SQLITE_BUSY_SNAPSHOT` means the snapshot is
 * stale, not merely locked — waiting cannot refresh it, only a fresh
 * transaction can (contrast `SQLITE_BUSY`'s `busy_timeout`, which this retry
 * also covers for free).
 */
const MAX_POPULATE_RETRIES = 1;

// ---------------------------------------------------------------------------
// JIT staleness detection and re-parse (§9.0)
// ---------------------------------------------------------------------------

export interface StalenessCheckResult {
  /** True if a JIT re-parse was successfully performed. */
  readonly refreshed: boolean;
  /**
   * True when the file was stale but the lock could not be acquired (file is
   * mid-write). Callers should set `file_busy_returning_stale_cache: true` on
   * affected result objects rather than throwing.
   */
  readonly busy: boolean;
}

/**
 * Check `filePath` for staleness by comparing disk mtime against
 * `storedMtime`. If stale, acquire `structure.lock` and run Phase 1 for that
 * file only (10–50ms per spec §9.0).
 *
 * On lock acquisition failure (file mid-write) returns `{ busy: true }`
 * so the caller can fall back to the TOCTOU policy — return the stale chunk
 * with `file_busy_returning_stale_cache: true`.
 */
export async function checkAndRefreshIfStale(
  db: Db,
  config: ResolvedConfig,
  filePath: string,
  storedMtime: number,
  // Test-only injection point (§4.4 DI), mirroring `populateFile`'s own
  // `ChunkWriter` seam (`graph/populate.ts`) — lets F13's regression tests
  // (`mcp/__tests__/staleness.test.ts`) induce a genuine SQLITE_BUSY_SNAPSHOT
  // via a second real connection instead of mocking `populateFile` wholesale.
  populateFileImpl: typeof populateFile = populateFile,
): Promise<StalenessCheckResult> {
  const absPath = join(config.resolved_project_root, filePath);
  let diskMtime: number;
  try {
    const stat = statSync(absPath);
    diskMtime = stat.mtimeMs / 1_000;
  } catch {
    // File deleted — nothing to refresh; callers handle missing results.
    return { refreshed: false, busy: false };
  }

  if (diskMtime <= storedMtime) return { refreshed: false, busy: false };

  // File is stale — attempt JIT re-parse under structure.lock.
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLock(config.resolved_state_dir, 'structure', {
      maxRetries: 3,
      retryIntervalMs: 100,
      caller: 'jit-staleness',
    });
  } catch {
    // Lock busy — fall through to TOCTOU policy.
    return { refreshed: false, busy: true };
  }

  try {
    let result;
    try {
      result = extractFile(absPath, config.resolved_project_root, config.context_lines, config.chunk_split_threshold, config.markdown_heading_depth);
    } catch {
      // TOCTOU: file mid-write, first parse attempt failed.
      await new Promise<void>((res) => setTimeout(res, 50));
      try {
        result = extractFile(absPath, config.resolved_project_root, config.context_lines, config.chunk_split_threshold, config.markdown_heading_depth);
      } catch {
        // Second attempt also failed — signal busy to caller.
        return { refreshed: false, busy: true };
      }
    }

    // populateFile writes chunks + FTS5 + graph rows in ONE SQLite
    // transaction (M1, §15.1) — no separate chunk-store call needed here any
    // more (the pre-M1 code wrote chunks to Lance in a step of its own,
    // which — once SQLite became the default chunk store — would have left
    // a JIT refresh's new chunk content invisible to every reader).
    //
    // F13: this call used to be unwrapped, so a SQLITE_BUSY_SNAPSHOT thrown
    // here escaped uncaught — bypassing the busy flag below and violating
    // §9.0's "do not throw" TOCTOU policy (52 real occurrences, E7-r2). Retry
    // a bounded number of times for the specific busy codes (see
    // `isRetryableBusySnapshot`'s WHY-comment); on exhaustion, fall through
    // to the same `{ busy: true }` result the lock-acquisition and
    // second-parse-attempt failures above already return, so every TOCTOU
    // path in this function agrees on one contract. A non-busy error is
    // NOT retried and NOT reclassified — it propagates immediately.
    //
    // The deeper fix (F11 territory, out of scope here) is `BEGIN IMMEDIATE`
    // for this guard transaction, which would take the write lock up front
    // and prevent the read-then-write shape from ever seeing a stale
    // snapshot — but that interacts with `structure.lock`'s redesign, so
    // this retry-then-map is the bounded fix for now.
    const totalAttempts = MAX_POPULATE_RETRIES + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      try {
        await populateFileImpl(db, {
          filePath,
          language: result.language,
          mtime: diskMtime,
          chunks: result.chunks,
          imports: result.imports,
          symbols: result.symbols,
          identifierRows: result.identifierRows,
        });
        return { refreshed: true, busy: false };
      } catch (err) {
        if (!isRetryableBusySnapshot(err)) throw err; // not busy — surface distinctly, do not retry
        if (attempt === totalAttempts) return { refreshed: false, busy: true }; // retries exhausted
        // Retries remain — loop immediately, no sleep (see
        // MAX_POPULATE_RETRIES's WHY-comment: a stale snapshot needs a fresh
        // transaction, not time).
      }
    }

    // Unreachable: the loop above always returns or throws on its final
    // iteration. TypeScript can't prove that from a `for` bound by a runtime
    // constant, so an explicit busy fallback keeps `noImplicitReturns`
    // satisfied without an `as never`.
    return { refreshed: false, busy: true };
  } finally {
    await release();
  }
}
