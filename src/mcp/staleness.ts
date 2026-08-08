import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../graph/db.js';
import type { ResolvedConfig } from '../store/config.js';
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
 * function treats as recoverable.
 *
 * Originally (F13): F12's monotonic-guard `SELECT` turned `populateFile`'s
 * transaction into a read-then-write shape, which — under Kysely's deferred
 * `BEGIN` (`sqlite-driver.js:32-34`) — could make the transaction's snapshot
 * go stale if another writer committed in between; a fresh transaction takes
 * a fresh snapshot and usually succeeds (E7-r2, `eval/e7-round2.json`, 52
 * occurrences across 23/32 real runs).
 *
 * F11 moved `populateFile` to `BEGIN IMMEDIATE` (`graph/populate.ts`), which
 * eliminates that specific `SQLITE_BUSY_SNAPSHOT` failure mode at the source
 * — it takes the write reservation up front instead of discovering
 * contention on commit. This retry-then-map loop stays as the backstop §9.0
 * requires regardless: `populateFile`'s own short `busy_timeout`
 * (`IMMEDIATE_WRITE_BUSY_TIMEOUT_MS`) can still be legitimately exhausted
 * under real contention (surfacing as plain `SQLITE_BUSY`), and a retry with
 * a fresh transaction is still the correct response to either code. Any
 * other `SQLITE_*` code (constraint violation, corruption, disk full, ...)
 * is a genuinely unexpected failure, not TOCTOU noise — conflating it with
 * "busy" would repeat the parse_errors/write_errors misclassification this
 * codebase already fixed once (`indexer/__tests__/write-failures.test.ts`),
 * so it is deliberately excluded here and left to propagate.
 */
function isRetryableBusySnapshot(err: unknown): boolean {
  return hasSqliteCode(err) && (err.code === 'SQLITE_BUSY_SNAPSHOT' || err.code === 'SQLITE_BUSY');
}

/**
 * Bounded retry count for `populateFile` under a busy snapshot. Chosen small
 * (1 retry = 2 attempts total) because each retry opens a brand-new
 * transaction — either the contention has cleared and the retry succeeds
 * immediately, or the file is under sustained concurrent write pressure and
 * further retries just delay the `busy: true` fallback the TOCTOU policy
 * (§9.0) already exists to handle. No sleep between attempts: a stale
 * `SQLITE_BUSY_SNAPSHOT` needs a fresh transaction, not time, to resolve;
 * `SQLITE_BUSY` already got its own bounded wait inside `populateFile`'s own
 * `busy_timeout` (`IMMEDIATE_WRITE_BUSY_TIMEOUT_MS`, F11) before it ever
 * reaches this retry loop, so adding a second wait here would double-count
 * the same contention.
 */
const MAX_POPULATE_RETRIES = 1;

// ---------------------------------------------------------------------------
// F7 — stat-and-flag staleness for mast_search / mast_implementors (§9.0)
// ---------------------------------------------------------------------------

/**
 * Stat each of `filePaths` (deduplicated by the caller — see below) and
 * compare disk mtime against the `files` table's stored mtime, WITHOUT
 * acquiring `structure.lock` or re-parsing anything.
 *
 * `mast_search` and `mast_implementors` deliberately do NOT get the
 * JIT-refresh treatment `checkAndRefreshIfStale` gives single-file tools
 * (`mast_signature`, `mast_exports`, ...): both can return results spanning
 * dozens of files, and a naive per-result JIT refresh would mean up to ~50
 * `structure.lock` acquisitions on one call PLUS re-parsing files whose
 * content change could invalidate the ranking that already selected these
 * results (a result re-parsed mid-response could shift rank, gain/lose a
 * match, or change chunk boundaries entirely — `eval/GITNEXUS_COMPARISON.md`
 * §13.7). Stat-and-flag reports the discrepancy honestly without paying
 * that cost or contaminating the ranking: the agent is told the coordinates
 * may be off and can decide whether to re-verify.
 *
 * Returns the subset of `filePaths` to flag with
 * `file_busy_returning_stale_cache: true`: disk mtime newer than the
 * indexed mtime, OR the stat failed (file deleted/renamed — its coordinates
 * are definitely untrustworthy). A path absent from the `files` table is
 * left out of the returned set entirely — there is nothing indexed to be
 * stale against, so no signal is invented.
 */
export async function findStaleFiles(
  db: Db,
  config: ResolvedConfig,
  filePaths: readonly string[],
): Promise<ReadonlySet<string>> {
  if (filePaths.length === 0) return new Set();

  const rows = await db
    .selectFrom('files')
    .select(['path', 'mtime'])
    .where('path', 'in', filePaths)
    .execute();

  const stale = new Set<string>();
  for (const row of rows) {
    try {
      const stat = statSync(join(config.resolved_project_root, row.path));
      if (stat.mtimeMs / 1_000 > row.mtime) stale.add(row.path);
    } catch {
      // File deleted/renamed since indexing — coordinates are definitely
      // untrustworthy, flag rather than silently omit.
      stale.add(row.path);
    }
  }
  return stale;
}

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
 * `storedMtime`. If stale, re-parse and persist it via {@link populateFile}
 * (10–50ms per spec §9.0).
 *
 * **F11 (`IMPLEMENTATION_PLAN.md` "Replace fail-fast advisory locking")
 * removed `structure.lock` from this path entirely.** Before F11, this
 * function acquired the lock (`maxRetries: 3, retryIntervalMs: 100`) before
 * re-parsing — but `structure.lock` was a single lock per state dir with no
 * file component (`store/lock.ts`'s `markerPath`), so a JIT re-parse of file
 * A blocked a JIT re-parse of file B despite touching disjoint rows. E7
 * measured this as 35–88.5% JIT failure rates under pure reader-vs-reader
 * concurrency (zero reindex running), which only gets worse as more agents
 * work concurrently. That contention class disappears by construction once
 * this path stops taking a lock at all: two JIT refreshes of different files
 * now run their (dominant-cost, per E7-r2) parse step fully in parallel, and
 * only briefly serialize on `populateFile`'s own short `BEGIN IMMEDIATE`
 * write (see that function's doc comment) — which also correctly governs the
 * ONE thing `structure.lock` was still protecting on this path: real
 * cross-connection SQLite contention (a concurrent reindex batch, or another
 * `mast serve` process). `structure.lock` itself is not deleted — coarse
 * writers (`mast index`, `mast_reindex`, the manifest/`index.json` phase, the
 * checker-resolver flush) still acquire it unchanged, because SQLite cannot
 * coordinate the plain-JSON manifest writes those callers also make.
 *
 * On a genuinely contended write (`populateFile`'s `BEGIN IMMEDIATE` losing
 * its own short `busy_timeout` wait, or a mid-write parse failure) returns
 * `{ busy: true }` so the caller can fall back to the TOCTOU policy — return
 * the stale chunk with `file_busy_returning_stale_cache: true`. Never throws
 * for these expected contention outcomes (§9.0).
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

  // File is stale — re-parse and persist it. No lock acquisition here (F11,
  // see this function's doc comment) — `populateFile`'s own `BEGIN IMMEDIATE`
  // transaction is what now bounds and serializes the write.
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

  // populateFile writes chunks + FTS5 + graph rows in ONE SQLite transaction
  // (M1, §15.1) — no separate chunk-store call needed here any more (the
  // pre-M1 code wrote chunks to Lance in a step of its own, which — once
  // SQLite became the default chunk store — would have left a JIT refresh's
  // new chunk content invisible to every reader).
  //
  // F13: this call used to be unwrapped, so a SQLITE_BUSY_SNAPSHOT thrown
  // here escaped uncaught — bypassing the busy flag below and violating
  // §9.0's "do not throw" TOCTOU policy (52 real occurrences, E7-r2). F11's
  // `BEGIN IMMEDIATE` (`graph/populate.ts`) eliminates that specific failure
  // class at the source, but this retry-then-map loop stays as the backstop
  // §9.0 requires: `populateFile`'s own short `busy_timeout` can still be
  // legitimately exhausted under real contention, and that must map to
  // `{ busy: true }`, never propagate as a raw throw. A non-busy error is NOT
  // retried and NOT reclassified — it propagates immediately.
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
}
