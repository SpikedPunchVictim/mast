import { sql, type Db } from './db.js';
import type { Chunk, Language, SymbolRecord, ImportRecord, EdgeRecord, CallerResolution } from '../ast/types.js';
import type { IdentifierRow, StarReExportRecord } from '../ast/extractor.js';
import { chunkRowsForSqlite, chunkValuesForSqlite } from './sqliteBatch.js';
import { pathPrefixUpperBound } from './path-range.js';
import { markEdgeRepairsPending } from './importer-repair.js';
import { namesExportedAs } from './exported-as.js';
import { CURRENT_SCHEMA_VERSION } from '../store/config.js';
import { fieldNamesOf } from './class-fields.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// SymbolRecord, ImportRecord, and EdgeRecord are defined in ast/types.ts so that
// ast/extract.ts can return them without creating a circular import chain.
export type { SymbolRecord, ImportRecord, EdgeRecord };

export interface FileIndexData {
  readonly filePath: string;
  readonly language: Language;
  readonly mtime: number;
  readonly chunks: readonly Chunk[];
  readonly imports: readonly ImportRecord[];
  readonly symbols: readonly SymbolRecord[];
  /**
   * Pre-extracted identifier tokens per chunk, produced by the language
   * extractor — what counts as an "identifier" is a language-level judgment
   * (markdown contributes none). This layer only persists them.
   */
  readonly identifierRows: readonly IdentifierRow[];
  /** Populated on the second pass after all symbols are inserted. */
  readonly edges: readonly EdgeRecord[];
}

/**
 * Result of {@link populateFile}: the new `files` row id, plus how many
 * previously-stored chunks were replaced (for `IndexResult.chunksRemoved`
 * accounting — mirrors the removed-count `SqliteChunkStore.replaceChunksForFile`
 * used to report directly before chunks moved into this transaction).
 */
export interface PopulateFileResult {
  readonly fileId: number;
  readonly chunksRemoved: number;
  /**
   * False when the monotonic write-guard (F12, see {@link populateFile}'s
   * doc) refused this write because the stored row's mtime already exceeds
   * `data.mtime` — this call lost a race against a fresher write. The row is
   * left completely unchanged: `fileId` is the EXISTING row's id and
   * `chunksRemoved` is 0. Callers must surface this (count it, log it) rather
   * than treat it as an ordinary successful write — a skipped write must
   * never be indistinguishable from a completed one (the `writeErrors`
   * precedent this mirrors).
   */
  readonly written: boolean;
  /** What `mast index --checker` had stored and this write removed; see {@link removeCheckerResults}. */
  readonly checkerResultsRemoved: CheckerResultCounts;
}

/** Rows of the two kinds `mast index --checker` writes. */
export interface CheckerResultCounts {
  readonly edges: number;
  readonly verdicts: number;
}

/**
 * Deletes every edge and verdict `mast index --checker` wrote, and returns how
 * many there were.
 *
 * Called by every write that changes a file's rows. The compiler resolved each
 * call against the whole program, so what a call resolves to can change when a
 * file that is neither end of the edge changes: a re-exporting index file, a
 * type a receiver is declared with. The cascade from an edge's two ends does
 * not see that, and an edge left behind is a verified caller of something the
 * code no longer calls (D150). The pass's results are therefore a snapshot of
 * one tree, removed whole at the first write after it and computed again by
 * the next `--checker` run.
 */
export async function removeCheckerResults(db: Db): Promise<CheckerResultCounts> {
  const edges = await db.deleteFrom('edges').where('resolution', '=', 'checker').executeTakeFirst();
  const verdicts = await db.deleteFrom('checker_verdicts').executeTakeFirst();
  return { edges: Number(edges.numDeletedRows), verdicts: Number(verdicts.numDeletedRows) };
}

/**
 * Test-only injection point (§4.4 DI): when provided, `populateFile` calls
 * this instead of writing the `chunks` table inline. Lets write-failure tests
 * (`indexer/__tests__/write-failures.test.ts`) inject a chunk-store failure
 * with an in-memory fake — since the call happens INSIDE this function's own
 * `BEGIN IMMEDIATE` transaction, a rejection here still rolls back everything
 * else the transaction already wrote (symbols/imports/chunk_fts/identifier_fts),
 * proving the same atomicity the production (no-override) path gets from
 * writing straight to the shared `chunks` table. Structurally compatible with
 * `ChunkStore.replaceChunksForFile` (store/sqliteChunkStore.js) without this
 * module importing that type — graph/ stays independent of store/'s DI seam,
 * only its method shape.
 */
export type ChunkWriter = (filePath: string, chunks: readonly Chunk[]) => Promise<number>;

/**
 * Cumulative wall-clock, in ms, for the four regions that tile a file's write.
 *
 * Eval instrument (E1-FTS, IMPLEMENTATION_PLAN.md § E1-FTS PRE-REGISTRATION,
 * 2026-08-14). E1-PHASE localised the super-linear growth exponent to the
 * `write` phase (`b_write = 1.9685`, 94.01% of T9's run) but no further; these
 * four decompose that phase.
 *
 * Mutable by design — it is an accumulator summed across every `populateFile`
 * call in a run, in the same shape and for the same reason as `runIndex`'s own
 * `phase` record. Data, not behaviour (§4.2), so it is a record and not a class.
 *
 * **Every region is timed by its own start and end. None is computed by
 * subtraction.** A `rest` derived as `write − fts` would silently absorb any
 * cost the other timers missed, which is precisely how this experiment's first
 * draft would have produced a false null: FTS5 flushes its segments at COMMIT
 * (`fts5SyncMethod`, `sqlite3.c:262278`; `xCommit` is a no-op at `:262302`),
 * not inside the INSERT, so a naive `fts_ms` around the inserts misses them.
 * Because the regions are timed independently they need not tile exactly, and
 * the shortfall is the point: unattributed work shows up as a tiling gap the
 * harness's ≥ 0.95 gate can see, instead of being absorbed in silence.
 */
export interface WriteSpansMs {
  /** The two `DELETE FROM *_fts WHERE file_path = ?` statements. */
  fts_del: number;
  /** The two batched `INSERT INTO *_fts` loops. */
  fts_ins: number;
  /** The per-file `COMMIT`, where FTS5's segment flush actually happens. */
  commit: number;
  /** The monotonic guard, the `files` row, and the chunks/symbols/imports writes. */
  rest: number;
  /**
   * Per-file transaction machinery: connection checkout, the two `busy_timeout`
   * pragmas, and `BEGIN IMMEDIATE`.
   *
   * AMENDMENT 1 to the registration (2026-08-14, pre-run, no data collected).
   * The four registered spans left this unattributed, and it is a per-FILE
   * constant — measured at 0.72 ms/file, which is ~33% of T1's write phase and
   * ~2% of T9's. Two consequences, both bad, both caught by running the
   * instrument before the experiment: the registered tiling gate would have
   * voided the cheapest rung, the one that anchors the exponent, while passing
   * the rung where the answer is least in doubt; and folding it into `rest`
   * instead would have contaminated `b_rest` — the PARTIAL condition — with a
   * per-file constant that pulls any exponent toward 1.0, biasing PARTIAL
   * toward not firing.
   */
  txn: number;
  /**
   * `structure.lock` acquisition and release, once per 16-file write batch.
   *
   * The only span not accumulated by {@link populateFile} — the indexer owns it,
   * because the lock is per-BATCH and wraps the whole file loop (F1,
   * `indexer/index.ts`). Named separately rather than folded in because the
   * `phaseMs` docblock already warns that `write` includes lock wait and "must
   * not be read as pure I/O under concurrency"; with this span that caveat
   * becomes a number instead of a warning.
   *
   * AMENDMENT 1, same provenance as {@link WriteSpansMs.txn}.
   */
  lock: number;
}

/** A zeroed {@link WriteSpansMs} accumulator. */
export function newWriteSpans(): WriteSpansMs {
  return { fts_del: 0, fts_ins: 0, commit: 0, rest: 0, txn: 0, lock: 0 };
}

/**
 * Charge one region's elapsed wall-clock to `key`.
 *
 * `performance.now()` rather than `Date.now()`: the registration costed the
 * timers against `Date.now()`, but measured on this machine that clock yields
 * only 33 distinct values across a 200,000-call burst (~1 ms granularity) while
 * costing 65.3 ns/call, against 34.8 ns/call and full sub-microsecond
 * resolution for `performance.now()`. At T1 a per-file FTS delete runs well
 * under a millisecond, so `Date.now()` would round each one to 0 or 1 — turning
 * the cheapest rung, which anchors the growth exponent being measured, into a
 * coin flip. The higher-resolution clock is cheaper AND less biased, so the
 * deviation from the registered clock is in the direction of a harder test.
 *
 * Returns `fn()` untouched when no accumulator was supplied, so the production
 * path — which never passes one — pays nothing at all.
 */
async function timed<T>(
  spans: WriteSpansMs | undefined,
  key: keyof WriteSpansMs,
  fn: () => Promise<T>,
): Promise<T> {
  if (spans === undefined) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    spans[key] += performance.now() - started;
  }
}

/**
 * Optional per-call knobs for {@link populateFile}.
 *
 * An options object rather than more positional parameters: `chunkWriter` was
 * the third argument, and the two additions here are both eval instruments that
 * would otherwise have to be threaded past it in a fixed order.
 */
export interface PopulateFileOptions {
  /** See {@link ChunkWriter} — test-only chunk-write substitution. */
  readonly chunkWriter?: ChunkWriter;
  /** When supplied, this call's four write regions are accumulated into it. */
  readonly spans?: WriteSpansMs;
  /**
   * **Eval-only, and unsafe outside a cold build.** Skips the two
   * `DELETE FROM *_fts WHERE file_path = ?` statements.
   *
   * This is E1-FTS's arm G — the causal test for whether those deletes carry
   * the write phase's exponent, and a rehearsal of the fix (guarding them on
   * whether the file was previously indexed, which the monotonic-guard SELECT
   * below already knows).
   *
   * On a **cold** build the skipped deletes match zero rows, so the finished
   * database is byte-identical to the control's — that identity is what makes
   * arm G confound-free, and it is asserted both by
   * `__tests__/write-spans.test.ts` and by a per-rung gate in the harness. On
   * **any other** path it corrupts the index, leaving the previous version's
   * FTS rows behind alongside the new ones while the ordinary tables replace
   * correctly. The CLI therefore refuses to combine it with `--incremental`.
   */
  readonly skipFtsDeletes?: boolean;
  /**
   * Paths to record as waiting for their edges (`edge_repair_pending`) in the
   * same transaction as the write, when the write lands.
   *
   * The write deletes every edge other files hold into this file. A caller
   * that puts them back afterwards without the structure lock — the
   * query-time refresh — can lose the database to another writer in between,
   * and then this record is the only thing that says edges are missing. So it
   * must not be possible for the write to commit without it.
   */
  readonly pendingEdgeRepairs?: readonly string[];
}

/**
 * Dedicated `busy_timeout` (ms) for {@link populateFile}'s own transaction —
 * distinct from `graph.db`'s shared 5000ms connection default
 * (`openDatabase`, `graph/db.ts`).
 *
 * F11 (`IMPLEMENTATION_PLAN.md` "Replace fail-fast advisory locking") moves
 * this transaction from Kysely's deferred `BEGIN` to `BEGIN IMMEDIATE` (see
 * `populateFile`'s doc comment for why) so it takes the write reservation up
 * front instead of discovering contention via `SQLITE_BUSY_SNAPSHOT` on its
 * own commit (F13). That makes the busy_timeout wait live for the first time
 * on this path — under the inherited 5000ms default, ANY genuine contention
 * would block better-sqlite3's synchronous busy-wait for up to 5 seconds,
 * freezing the ENTIRE `mast serve` process (its native busy-wait blocks the
 * whole event loop, not just the calling promise chain — measured directly in
 * `eval/eventloop-probe.json`, see IMPLEMENTATION_PLAN.md's "HARD CONSTRAINT
 * ON F11"). 200ms keeps that freeze window in the same neighbourhood as the
 * 3x100ms `structure.lock` retry budget the JIT path used to pay instead of
 * ever reaching SQLite's own wait (`mcp/staleness.ts`, pre-F11), rather than
 * inheriting the 25x-longer 5000ms shared default. Set and restored only
 * around this transaction's own exclusive connection window (see
 * `populateFile`) so no unrelated statement on the shared connection ever
 * inherits the short value.
 */
export const IMMEDIATE_WRITE_BUSY_TIMEOUT_MS = 200;

/** `graph.db`'s shared connection-wide default (`openDatabase`, `graph/db.ts`) — restored after {@link populateFile}'s short window closes. */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Runs `work` on this `Db`'s connection with writes waiting at most
 * {@link IMMEDIATE_WRITE_BUSY_TIMEOUT_MS} for another writer, where they would
 * otherwise wait the connection's 5000 ms. Pass `work`'s argument, not `db`,
 * to everything inside it.
 *
 * For writes made on a read tool's request path outside `populateFile`: the
 * wait is synchronous and stops the whole server process, so it has the same
 * bound there as `populateFile`'s own (F11). A statement that loses the wait
 * throws `SQLITE_BUSY`.
 */
export async function withBoundedWriteWait<T>(db: Db, work: (conn: Db) => Promise<T>): Promise<T> {
  return db.connection().execute(async (conn) => {
    await sql.raw(`pragma busy_timeout = ${IMMEDIATE_WRITE_BUSY_TIMEOUT_MS}`).execute(conn);
    try {
      return await work(conn);
    } finally {
      await sql.raw(`pragma busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`).execute(conn);
    }
  });
}

/**
 * Delete all rows for `filePath` from files, symbols, edges, imports,
 * re_export_files (cascaded via FK), chunks, and FTS5 tables, then re-insert
 * everything from `data` — all within a single SQLite transaction.
 *
 * M1 (`eval/GITNEXUS_COMPARISON.md` §15.1): chunk rows join this SAME
 * transaction instead of being written by a separate chunk-store call before
 * this function runs. That closes the consistency seam the spike deliberately
 * left open — a chunk-store write succeeding while the graph write then fails
 * (or vice versa) can no longer leave the two out of sync, because there is
 * only one commit/rollback boundary for both.
 *
 * The two-pass structure (insert all symbols first, then insert all edges
 * via `insertEdges`) is required for cross-file POTENTIAL_CALL resolution.
 *
 * **Monotonic write-guard (F12, `GITNEXUS_COMPARISON.md` Stage 1)**: refuses
 * to replace a row whose stored `mtime` already exceeds `data.mtime`. Two
 * writers can legitimately race to write the same file — a reindex batch and
 * a concurrent JIT refresh (`mcp/staleness.ts`) both call this function.
 * Without this guard, whichever writer commits LAST wins even if it parsed
 * OLDER content — silently regressing the row. With it, the write carrying
 * the NEWER stamp always wins, independent of arrival order, which is what
 * actually makes the ordering guarantee in `runIndex`'s WHY-comment
 * (`indexer/index.ts`) hold. This is strictly subject to mtime-granularity
 * blindness (see that WHY-comment) — two writes landing in the same tick
 * compare equal, not ordered, and whichever call happens second wins; that is
 * a known, documented limitation, not something this guard claims to solve.
 *
 * **`BEGIN IMMEDIATE`, not a plain `db.transaction()` (F11)**: Kysely's
 * better-sqlite3 driver only ever issues a deferred `BEGIN`
 * (`sqlite-driver.js`'s `beginTransaction` — `CompiledQuery.raw('begin')`,
 * hardcoded), and there is no config knob to change that. A deferred-BEGIN
 * read-then-write (this function's own monotonic-guard SELECT, followed by
 * its writes) can fail `SQLITE_BUSY_SNAPSHOT` in 1-2ms against ANY competing
 * holder — even one that never commits — which `busy_timeout` cannot wait
 * out, because the snapshot is already stale, not merely locked (F13,
 * `eval/e7-round2.json`, 52 real occurrences). `BEGIN IMMEDIATE` takes the
 * write reservation up front instead, eliminating that failure class and
 * falling back to an honest bounded `busy_timeout` wait when genuinely
 * contended (`eval/eventloop-probe.json` Phase 2/3). Since Kysely cannot be
 * asked for `BEGIN IMMEDIATE` via `db.transaction()`, this function instead
 * checks out the underlying connection exclusively via `db.connection()` and
 * issues `begin immediate` / `commit` / `rollback` as raw statements around
 * the same statement sequence a `db.transaction()` callback would have run.
 * Kysely's SQLite adapter reports `supportsMultipleConnections: false`, so
 * `RuntimeDriver` (`runtime-driver.js`) guards every connection acquisition
 * on a given `Db` instance with one `ConnectionMutex` — verified by reading
 * that source AND empirically (20 independently-staggered concurrent
 * `db.connection().execute()` calls against one shared `Db`: zero
 * interleaving errors, all 20 rows landed, in submission order). That means
 * no OTHER statement issued through the SAME `Db` instance — chiefly a
 * same-process concurrent JIT refresh of a different file, now that F11
 * removes `structure.lock` from that path — can interleave into this
 * transaction's raw `begin immediate` / ... / `commit` window. A genuinely
 * different connection (reindex's own `openDatabase()` call in
 * `indexer/index.ts`, or another `mast serve` process) is real SQLite-level
 * concurrency, correctly governed by `BEGIN IMMEDIATE`'s write-reservation
 * semantics and this transaction's own short `busy_timeout`
 * ({@link IMMEDIATE_WRITE_BUSY_TIMEOUT_MS}), not by this in-process mutex.
 */
export async function populateFile(
  db: Db,
  data: Omit<FileIndexData, 'edges'>,
  options: PopulateFileOptions = {},
): Promise<PopulateFileResult> {
  // Stamped before `db.connection()` so the `txn` span includes the connection
  // checkout itself — Kysely serialises every acquisition on one
  // `ConnectionMutex` (see the doc comment above), so that wait is real.
  const enteredAt = options.spans === undefined ? 0 : performance.now();

  return db.connection().execute(async (conn) => {
    if (options.spans !== undefined) options.spans.txn += performance.now() - enteredAt;

    // The busy_timeout toggle must happen INSIDE this exclusive connection
    // window (see the doc comment above) so no unrelated statement on the
    // shared connection ever runs with the short value — pragmas are cheap
    // and synchronous, so bracketing the transaction with them costs nothing
    // measurable.
    await timed(options.spans, 'txn', () =>
      sql.raw(`pragma busy_timeout = ${IMMEDIATE_WRITE_BUSY_TIMEOUT_MS}`).execute(conn));

    try {
      await timed(options.spans, 'txn', () => sql`begin immediate`.execute(conn));
    } catch (err) {
      // BEGIN IMMEDIATE itself lost the busy_timeout wait — no transaction
      // was ever opened, so there is nothing to roll back. Restore the
      // shared default before propagating.
      await sql.raw(`pragma busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`).execute(conn);
      throw err;
    }

    try {
      const result = await writePopulatedFileRows(conn, data, options);
      if (result.written && options.pendingEdgeRepairs !== undefined) {
        await markEdgeRepairsPending(conn, options.pendingEdgeRepairs);
      }
      // Timed as its own region because this is where FTS5 actually writes its
      // segments — `fts5SyncMethod` runs at COMMIT (sqlite3.c:262278), not
      // inside the INSERT statements above.
      await timed(options.spans, 'commit', () => sql`commit`.execute(conn));
      return result;
    } catch (err) {
      await sql`rollback`.execute(conn);
      throw err;
    } finally {
      // Runs after both the commit and the rollback branches above — see the
      // doc comment's "checks out the underlying connection exclusively"
      // paragraph for why this must land before the connection is released.
      await timed(options.spans, 'txn', () =>
        sql.raw(`pragma busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`).execute(conn));
    }
  });
}

/**
 * The actual delete-and-replace statement sequence, run against `trx` — a
 * `db.connection()`-bound `Db` sitting inside {@link populateFile}'s
 * already-open `BEGIN IMMEDIATE`. Split out of `populateFile` so that
 * function's `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` bracketing has a
 * single call to wrap, including the monotonic write-guard's early "nothing
 * to write" return — that path still needs the transaction committed
 * (nothing was mutated, but the write reservation `BEGIN IMMEDIATE` took
 * must still be released), not treated as an error.
 */
/**
 * Inclusive bounds of the contiguous rowid block a file owns in one FTS5
 * virtual table. `null` bounds mean no block was ever recorded: the `files`
 * row predates the columns, or there is no row.
 */
interface FtsBlock {
  readonly lo: number | null;
  readonly hi: number | null;
}

/**
 * The block of a file that owns no rows in a table: a range with nothing in
 * it, since rowids start at 1. Recorded instead of NULL because NULL already
 * means "not recorded", and a delete that finds NULL has to scan the whole
 * table by path. Markdown never has identifier rows, so with NULL every
 * re-write of a markdown file ran that scan (D082).
 */
const EMPTY_FTS_BLOCK: FtsBlock = { lo: 0, hi: -1 };

type FtsTable = 'chunk_fts' | 'identifier_fts';

/**
 * Reserves the next `rowCount` rowids in `table`.
 *
 * SQLite assigns an unspecified rowid as `max(rowid) + 1`, so reserving is just
 * reading that maximum — `SEARCH ... INDEX 192:`, measured at 0.0008 ms on a
 * 73,359-row `chunk_fts`. Callers must reserve BEFORE deleting the file's old
 * block, so that the reserved range cannot collide with rows still present.
 * (Deleting first would lower the maximum and hand back rowids the old block
 * still occupies.) Reserving early only ever leaves gaps, which cost nothing.
 */
async function reserveFtsBlock(trx: Db, table: FtsTable, rowCount: number): Promise<FtsBlock> {
  if (rowCount === 0) return EMPTY_FTS_BLOCK;
  const result = await sql<{ m: number | null }>`
    SELECT max(rowid) AS m FROM ${sql.table(table)}
  `.execute(trx);
  const lo = (result.rows[0]?.m ?? 0) + 1;
  return { lo, hi: lo + rowCount - 1 };
}

/**
 * Removes one file's rows from an FTS5 table, using its recorded rowid block.
 *
 * Issued as one `WHERE rowid = ?` per row rather than a single
 * `WHERE rowid BETWEEN ? AND ?`, which looks equivalent and is not: FTS5
 * reports a rowid RANGE as `SCAN ... INDEX 0:=`, and the `SCAN` is literal —
 * measured at 75.96 ms against 75.01 ms for an unconstrained scan on T9, i.e.
 * no saving at all. Only exact equality is a seek. Same corpus, same file:
 * 1.125 ms by per-rowid equality against 129.8 ms by `file_path`.
 *
 * That makes the cost O(rows in this file) where it was O(rows in the corpus),
 * so it wins by more the larger the repository gets. The two curves do cross
 * for a file holding a large fraction of the corpus — at T9 scale, measured on
 * a synthetic corpus, a 3,000-chunk file (4% of all chunks) is still 1.3x
 * faster this way, and a 5-chunk file 27x. No real file approaches the
 * crossover, so there is deliberately no size heuristic here: an untested
 * branch that fires on no real input is worse than the branch it replaces.
 *
 * Raw SQL because `rowid` is a column Kysely's schema models only as an
 * insert-time hint; `sql.table` takes a literal from {@link FtsTable}, never
 * caller input.
 */
async function deleteFtsRowidBlock(
  trx: Db,
  table: FtsTable,
  block: FtsBlock,
  filePath: string,
): Promise<void> {
  if (block.lo === null || block.hi === null) {
    // No block recorded — a `files` row written before Stage 4.6 added the
    // columns, or before a file with no rows got `EMPTY_FTS_BLOCK` (D082).
    // Fall back to the scan this change exists to remove: slow, but correct,
    // and self-healing because the row is about to be rewritten with a block.
    // Never skipped — skipping would leave stale rows findable.
    await sql`DELETE FROM ${sql.table(table)} WHERE file_path = ${filePath}`.execute(trx);
    return;
  }
  for (let rowid = block.lo; rowid <= block.hi; rowid++) {
    await sql`DELETE FROM ${sql.table(table)} WHERE rowid = ${rowid}`.execute(trx);
  }
}

async function writePopulatedFileRows(
  trx: Db,
  data: Omit<FileIndexData, 'edges'>,
  options: PopulateFileOptions,
): Promise<PopulateFileResult> {
  const { chunkWriter, spans } = options;
  // Monotonic write-guard — see the F12 paragraph in populateFile's doc
  // comment above. Reading the existing row's mtime and deciding whether to
  // proceed inside the SAME transaction that performs the delete-and-replace
  // keeps the check-then-act pair atomic relative to any other populateFile
  // call, exactly as invariant 1's read-then-write pair is kept atomic
  // relative to other `structure.lock` holders (indexer/index.ts).
  // Selecting the FTS blocks here — rather than at the delete below — is what
  // makes the whole scheme work: this SELECT runs BEFORE the `files` row is
  // deleted and reinserted a few lines down, so it is the last point at which
  // the OLD block is still readable.
  const existing = await timed(spans, 'rest', () => trx
    .selectFrom('files')
    .select(['id', 'mtime', 'chunk_fts_lo', 'chunk_fts_hi', 'ident_fts_lo', 'ident_fts_hi'])
    .where('path', '=', data.filePath)
    .executeTakeFirst());

  if (existing !== undefined && existing.mtime > data.mtime) {
    // Logged at WARN, not ERROR — this is a correctly-refused stale write,
    // not a failure (contrast the write-failure ERROR log below). Still
    // never silent: a caller that ignored this row's `written: false`
    // would see a normal-looking `PopulateFileResult` and never learn its
    // parse was discarded.
    process.stderr.write(
      `[mast] WARN: monotonic write-guard rejected a stale write for ${data.filePath} ` +
      `(stored mtime ${existing.mtime} > incoming ${data.mtime}) — existing row left unchanged\n`,
    );
    return { fileId: existing.id, chunksRemoved: 0, written: false, checkerResultsRemoved: { edges: 0, verdicts: 0 } };
  }

  // Reserved before the old rows are deleted, so the new block cannot overlap
  // rows that are still present — see `reserveFtsBlock`. The two tables get
  // different counts for the same file (markdown chunks produce no identifier
  // rows), so they are reserved independently.
  const chunkBlock = await timed(spans, 'rest', () => reserveFtsBlock(trx, 'chunk_fts', data.chunks.length));
  const identBlock = await timed(spans, 'rest', () => reserveFtsBlock(trx, 'identifier_fts', data.identifierRows.length));

  // Before the delete below, whose cascade would take some of them uncounted.
  const checkerResultsRemoved = await timed(spans, 'rest', () => removeCheckerResults(trx));

  // Delete-and-replace: FK cascades remove symbols, edges, imports.
  const file = await timed(spans, 'rest', async () => {
    await trx.deleteFrom('files').where('path', '=', data.filePath).execute();

    const [row] = await trx
      .insertInto('files')
      .values({
        path: data.filePath,
        language: data.language,
        mtime: data.mtime,
        chunk_fts_lo: chunkBlock.lo,
        chunk_fts_hi: chunkBlock.hi,
        ident_fts_lo: identBlock.lo,
        ident_fts_hi: identBlock.hi,
        written_by: CURRENT_SCHEMA_VERSION,
      })
      .returning('id')
      .execute();
    return row;
  });

  if (file === undefined) throw new Error(`Insert into files returned no id for ${data.filePath}`);

  const fileId = file.id;

  // Chunks — same transaction as the rest of this file's derived state
  // (§15.1). Default path writes the shared `chunks` table directly;
  // `chunkWriter` (test-only) substitutes an injected implementation, see
  // its docstring above for why that stays atomic too.
  const chunksRemoved = await timed(spans, 'rest', () => chunkWriter !== undefined
    ? chunkWriter(data.filePath, data.chunks)
    : replaceChunksInline(trx, data.filePath, data.chunks));

  // Insert symbols. Batched under SQLite's 32,766 bound-parameter ceiling
  // (Stage 4.5 S1, IMPLEMENTATION_PLAN.md — see `replaceChunksInline`'s
  // WHY-comment below for the full defect and why batching the statement
  // rather than the transaction preserves atomicity).
  if (data.symbols.length > 0) {
    // Explicit row-type annotation (`is_exported: 0 | 1`, not `number`) —
    // extracting this `.map()` into its own `const` (needed so the same
    // array can be both batched and, in principle, inspected) loses the
    // contextual typing `.values(data.symbols.map(...))` got for free when
    // the ternary's result fed straight into Kysely's `InsertObject`;
    // without this annotation, `s.isExported ? 1 : 0` widens to `number`
    // and fails `symbols`'s `BoolCol` (`0 | 1`) column type.
    const symbolRows: {
      name: string;
      kind: string;
      file_id: number;
      line: number;
      is_exported: 0 | 1;
      declaration_hash: string | null;
      body_hash: string | null;
      fields: string | null;
      is_static: 0 | 1;
      is_default_export: 0 | 1;
    }[] = data.symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      file_id: fileId,
      line: s.line,
      is_exported: s.isExported ? 1 : 0,
      declaration_hash: s.declarationHash,
      body_hash: s.bodyHash,
      fields: s.fields === undefined ? null : JSON.stringify(s.fields),
      is_static: s.isStatic === true ? 1 : 0,
      is_default_export: s.isDefaultExport === true ? 1 : 0,
    }));
    await timed(spans, 'rest', async () => {
      for (const batch of chunkRowsForSqlite(symbolRows)) {
        await trx.insertInto('symbols').values(batch).execute();
      }
    });
  }

  // Insert imports. Same batching as symbols above.
  if (data.imports.length > 0) {
    // Same widening issue and fix as `symbolRows` above (`is_external` is
    // also a `BoolCol`).
    const importRows: {
      file_id: number;
      module: string;
      symbols: string;
      aliases: string | null;
      exported_as: string | null;
      is_external: 0 | 1;
      resolved_path: string | null;
    }[] = data.imports.map((imp) => ({
      file_id: fileId,
      module: imp.module,
      symbols: JSON.stringify(imp.symbols),
      aliases: imp.aliases === undefined ? null : JSON.stringify(imp.aliases),
      exported_as: imp.exportedAs === undefined ? null : JSON.stringify(imp.exportedAs),
      is_external: imp.isExternal ? 1 : 0,
      resolved_path: imp.resolvedPath,
    }));
    await timed(spans, 'rest', async () => {
      for (const batch of chunkRowsForSqlite(importRows)) {
        await trx.insertInto('imports').values(batch).execute();
      }
    });
  }

  // FTS5 updates — same transaction as graph writes (§7.1 step 5).
  //
  // Delete existing rows by file_path, but ONLY when this file had a previous
  // version. FTS5 supports the predicate on an UNINDEXED column and cannot use
  // it: `xBestIndex` (sqlite3.c:260775-260860) will not consume an equality
  // constraint on an ordinary column, so each statement is
  // `SCAN <table> VIRTUAL TABLE INDEX 0:` — a full table scan of an index that
  // grows with the whole corpus, giving the write phase a quadratic term.
  //
  // E1-FTS measured it (IMPLEMENTATION_PLAN.md § E1-FTS RESULT): at T9 the two
  // deletes were **91.7% of the write phase**, growing with exponent 2.35, and
  // on a cold build every one of them matched ZERO rows. Skipping them took the
  // write phase's exponent from 1.94 to 1.10 and T9's cold build from 499 s to
  // 59 s.
  //
  // `existing` is the monotonic write-guard's own SELECT, a few lines above —
  // this reuses a read that already happened rather than adding one. Its safety
  // rests on a single invariant:
  //
  //     A file's FTS rows exist only if its `files` row exists.
  //
  // maintained by the only two writers of these tables, both in this file and
  // both transactional: this function writes the `files` row and the FTS rows
  // inside one `BEGIN IMMEDIATE`, and `removeDeletedFiles` deletes both inside
  // one transaction. That second one is load-bearing and easy to lose:
  // `chunk_fts` / `identifier_fts` are FTS5 VIRTUAL tables, so they do NOT
  // participate in the foreign-key cascade that removes `symbols` / `edges` /
  // `imports` when a `files` row goes — the deletes there are explicit and must
  // stay. `__tests__/fts-delete-guard.test.ts` pins the invariant directly, so
  // a future change that drops a `files` row without its FTS rows fails there
  // rather than silently making this guard wrong.
  //
  // The SELECT and these DELETEs share one transaction, so no concurrent writer
  // can insert FTS rows between them — the same atomicity argument F12 already
  // relies on for the monotonic guard.
  //
  // `skipFtsDeletes` is E1-FTS's arm G, retained because it is the instrument of
  // a completed experiment. It is unconditional and unsafe outside a cold build.
  // Tests `existing` directly rather than via a named boolean so that
  // TypeScript narrows it — the recorded block is read from it below.
  if (options.skipFtsDeletes !== true && existing !== undefined) {
    await timed(spans, 'fts_del', async () => {
      await deleteFtsRowidBlock(
        trx, 'chunk_fts',
        { lo: existing.chunk_fts_lo, hi: existing.chunk_fts_hi },
        data.filePath,
      );
      await deleteFtsRowidBlock(
        trx, 'identifier_fts',
        { lo: existing.ident_fts_lo, hi: existing.ident_fts_hi },
        data.filePath,
      );
    });
  }

  // Batch-insert all chunks in one statement instead of one INSERT per chunk
  // — further batched under the parameter ceiling, same as above.
  await timed(spans, 'fts_ins', async () => {
    if (data.chunks.length > 0) {
      // Explicit rowids, so the block recorded on `files` above is true by
      // construction rather than inferred from SQLite's assignment order.
      const chunkFtsRows = data.chunks.map((chunk, i) => ({
        rowid: (chunkBlock.lo ?? 0) + i,
        content: chunk.content,
        symbol_name: chunk.symbol_name,
        chunk_id: chunk.chunk_id,
        file_path: data.filePath,
      }));
      for (const batch of chunkRowsForSqlite(chunkFtsRows)) {
        await trx.insertInto('chunk_fts').values(batch).execute();
      }
    }

    if (data.identifierRows.length > 0) {
      const identifierFtsRows = data.identifierRows.map((row, i) => ({
        rowid: (identBlock.lo ?? 0) + i,
        identifiers: row.identifiers,
        chunk_id: row.chunk_id,
        file_path: data.filePath,
      }));
      for (const batch of chunkRowsForSqlite(identifierFtsRows)) {
        await trx.insertInto('identifier_fts').values(batch).execute();
      }
    }
  });

  return { fileId, chunksRemoved, written: true, checkerResultsRemoved };
}

/**
 * Default (production) chunk write, inline in `trx` — delete-then-insert by
 * `file_path`, same shape as the `chunk_fts` block above. Returns the count
 * of rows removed (§ `IndexResult.chunksRemoved`).
 */
async function replaceChunksInline(
  trx: Db,
  filePath: string,
  chunks: readonly Chunk[],
): Promise<number> {
  const row = await trx
    .selectFrom('chunks')
    .select((eb) => eb.fn.count<number>('chunk_id').as('count'))
    .where('file_path', '=', filePath)
    .executeTakeFirst();
  const removed = row?.count ?? 0;

  await trx.deleteFrom('chunks').where('file_path', '=', filePath).execute();
  if (chunks.length > 0) {
    // Batched under SQLite's 32,766 bound-parameter ceiling (Stage 4.5 S1,
    // IMPLEMENTATION_PLAN.md "batch `replaceChunksForFile`'s insert", added
    // 2026-08-07). This is the PRODUCTION per-file chunk write (`populateFile`'s
    // default path, no `chunkWriter` override) — an 11-column row shape caps a
    // single unbatched INSERT at ~2,978 rows; a whale file's chunks (e.g.
    // vscode's 146,620-line fixtures) otherwise throw `SqliteError: too many
    // SQL variables`, rolling back this WHOLE transaction (symbols/edges/
    // imports/FTS along with it) and silently dropping the file from the
    // index for orchestration that gates only on exit code. `chunkRowsForSqlite`
    // (graph/sqliteBatch.ts) computes a batch size that stays under the
    // ceiling for any row shape. Every batch below runs INSIDE the SAME `trx`
    // this function was handed — batching the STATEMENT, not the transaction,
    // so a whale file's chunks still land atomically (all rows or none) with
    // its symbols/edges/imports/FTS rows, exactly as before. This same pattern
    // (batch inside the existing transaction) is applied at every other
    // multi-row insert in this file and in `store/sqliteChunkStore.ts`'s
    // `replaceChunksForFile` — see IMPLEMENTATION_PLAN.md's Stage 4.5 S1
    // result block for the full class survey.
    // Same widening issue and fix as `populateFile`'s `symbolRows` — an
    // explicit row type keeps `is_exported` narrowed to `0 | 1`.
    const chunkRows: {
      chunk_id: string;
      file_path: string;
      start_line: number;
      end_line: number;
      content: string;
      chunk_type: Chunk['chunk_type'];
      symbol_name: string | null;
      parent_symbol: string | null;
      is_exported: 0 | 1;
      language: Language;
      file_mtime: number;
    }[] = chunks.map((c) => ({
      chunk_id:      c.chunk_id,
      file_path:     c.file_path,
      start_line:    c.start_line,
      end_line:      c.end_line,
      content:       c.content,
      chunk_type:    c.chunk_type,
      symbol_name:   c.symbol_name,
      parent_symbol: c.parent_symbol,
      is_exported:   c.is_exported ? 1 : 0,
      language:      c.language,
      file_mtime:    c.file_mtime,
    }));
    for (const batch of chunkRowsForSqlite(chunkRows)) {
      await trx.insertInto('chunks').values(batch).execute();
    }
  }
  return removed;
}

/**
 * Second-pass edge insertion. Run after ALL files' symbols have been inserted
 * so cross-file references resolve correctly.
 *
 * Each `EdgeRecord` uses symbol names, which are resolved to IDs here.
 * Unresolved names are silently skipped (external or not-yet-indexed).
 */
export async function insertEdges(db: Db, filePath: string, edges: readonly EdgeRecord[]): Promise<void> {
  await insertEdgesReportingUnresolved(db, filePath, edges);
}

/** A row of the file the records come from, that an edge can start at. */
interface FromRow {
  readonly id: number;
  readonly name: string;
  readonly line: number;
  readonly kind: string;
}

/**
 * `insertEdges`, returning the records that produced no edge. The staged pass
 * (`insertGraphEdges`) needs them: a `RE_EXPORTS` record whose target is itself
 * a re-export resolves only once that other edge exists, so it is tried again.
 */
async function insertEdgesReportingUnresolved(
  db: Db,
  filePath: string,
  records: readonly EdgeRecord[],
): Promise<EdgeRecord[]> {
  // A local alias makes no edge; it is a row of `reexport_aliases` (D124).
  const edges = records.filter((e) => e.localAlias !== true);
  if (edges.length === 0) return [];

  const fromNames = [...new Set(edges.map((e) => e.fromName))];

  // Batch-resolve "from" IDs — must belong to filePath. `fromNames` is
  // deduped via `Set` above, so splitting it into `IN`-list-sized chunks
  // (`chunkValuesForSqlite`, graph/sqliteBatch.ts — 1 bound parameter per
  // name) and merging the results cannot introduce duplicate-name collisions:
  // each name appears in exactly one chunk, so `fromMap` ends up identical to
  // what the single unbatched query would have produced. A whale file's
  // unique symbol-name list can sit close to the 32,766 parameter ceiling
  // (§ Stage 4.5 S1's class survey site 8), so this stays correct at any size.
  const fromRows: FromRow[] = [];
  for (const nameBatch of chunkValuesForSqlite(fromNames)) {
    const rows = await db
      .selectFrom('symbols as s')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select(['s.id', 's.name', 's.line', 's.kind'])
      .where('s.name', 'in', nameBatch)
      .where('f.path', '=', filePath)
      .execute();
    fromRows.push(...rows);
  }
  // A record that says which line its declaration is on is on that row and no
  // other: two declarations in a file can have one name, and by name alone the
  // last row read took the edges of both (D121). A `RE_EXPORTS` record has no
  // line and is on the marker of its name, not on a private declaration of the
  // name beside it.
  const fromByName = new Map(fromRows.map((r) => [r.name, r]));
  const markerByName = new Map(fromRows.filter((r) => r.kind === 'export').map((r) => [r.name, r]));
  const fromByLine = new Map(fromRows.map((r) => [`${r.name}@${String(r.line)}`, r]));
  //
  // The line tells the rows of one name apart and does nothing else. A file
  // resolved again without being written is parsed as it is on disk while its
  // rows are as it was last written, so a line can match no row; the record is
  // then on the row of its name when there is one, and on none when there are
  // two.
  const declarationsByName = new Map<string, FromRow[]>();
  for (const r of fromRows) {
    if (r.kind !== 'export') declarationsByName.set(r.name, [...(declarationsByName.get(r.name) ?? []), r]);
  }
  const fromRowOf = (e: EdgeRecord): FromRow | undefined => {
    if (e.fromLine === undefined) {
      return (e.edgeType === 'RE_EXPORTS' ? markerByName.get(e.fromName) : undefined) ?? fromByName.get(e.fromName);
    }
    const onLine = fromByLine.get(`${e.fromName}@${String(e.fromLine)}`);
    if (onLine !== undefined) return onLine;
    const declarations = declarationsByName.get(e.fromName) ?? [];
    return declarations.length === 1 ? declarations[0] : undefined;
  };

  // No `files` row for this file is an invariant violation (pass 1 always
  // inserts it before pass 2 runs edges). `fromMap` is empty too in that case,
  // so no record could produce an edge.
  const fromFile = await db.selectFrom('files').select('id').where('path', '=', filePath).executeTakeFirst();
  if (fromFile === undefined) return [...edges];
  // One import index per file, built lazily. `fromFile.id` is invariant across
  // every loop below, so a per-lookup query would re-read and re-parse
  // identical rows once per unique name. LAZY rather than eager because most
  // resolution rules never consult imports at all (`same_file` and
  // `this_method` are ~76% of resolved call edges on the T8 corpus), and an
  // eager build would add a query to every file instead of removing them.
  const imports = fileImportIndexLoader(db, fromFile.id);

  // Structural edges resolve by the evidence the file itself holds, never by a
  // name match across the graph (D085). A member is declared in its class's own
  // file. The target of `implements` / `extends` is a name the file imports or
  // declares; with neither — a built-in such as `Error` or `Record`, a default
  // import — there is no edge. A name match there linked 27 such
  // records on n8n and all 27 were wrong
  // (adr/proposals/incremental-graph-correctness/spikes/s6-structural-fallback).
  // Keyed by edge type as well as name: the two rules differ.
  // The module is part of the key: two imports can bind one exported name.
  //
  // A class extends a value, so the class of the name before an interface of
  // it. `implements`, and an interface's `extends`, name a type.
  const heritageMeaning = (e: EdgeRecord): Meaning =>
    e.edgeType === 'EXTENDS' && fromRowOf(e)?.kind === 'class' ? 'value' : 'type';
  const structuralKey = (e: EdgeRecord): string =>
    e.edgeType === 'PARENT_OF'
      ? `member::${e.toName}::${String(e.toLine)}`
      : `${heritageMeaning(e)}::${e.toName}::${String(e.importModule)}`;
  const structuralToMap = new Map<string, number>();
  const structuralSeen = new Set<string>();
  for (const e of edges) {
    if (e.edgeType === 'POTENTIAL_CALL' || e.edgeType === 'RE_EXPORTS') continue;
    const key = structuralKey(e);
    if (structuralSeen.has(key)) continue;
    structuralSeen.add(key);
    const targetId = e.edgeType === 'PARENT_OF'
      ? await resolveMemberRow(db, fromFile.id, e.toName, e.toLine)
      : await resolveQualifiedNameScoped(db, fromFile.id, importPlacerFor(imports, e.importModule), e.toName, null, heritageMeaning(e));
    if (targetId !== null) structuralToMap.set(key, targetId);
  }

  // POTENTIAL_CALL edges: resolve each unique (toName) once, file-scoped by
  // the resolution rule's own evidence (§10.3.1). A bare name has a single
  // deterministic resolution per file (LocalTypeEnvironment's "first
  // recorded wins" seeding — import beats same-file, and receiver bindings
  // are keyed by receiver, not by callee name), so it is safe to resolve
  // once per toName rather than once per edge.
  //
  // Construction is keyed apart: `new X()` and a call `X()` name the same
  // thing and can land on different symbols (the constructor, the class).
  const callKey = (e: EdgeRecord): string =>
    `${e.resolution === 'construction' ? 'new ' : ''}${e.toName}::${String(e.importModule)}::${String(memberSideOf(e))}`;
  const callEdgesByKey = new Map<string, EdgeRecord>();
  for (const e of edges) {
    if (e.edgeType === 'POTENTIAL_CALL' && !callEdgesByKey.has(callKey(e))) {
      callEdgesByKey.set(callKey(e), e);
    }
  }

  // A member the receiver's class does not declare is looked for on the
  // classes above it (`resolveInheritedMember`).
  const callToMap = new Map<string, number>();
  for (const [key, edge] of callEdgesByKey) {
    const placer = importPlacerFor(imports, edge.importModule);
    const targetId =
      (await resolveCallTarget(db, fromFile.id, placer, edge.resolution, edge.toName, memberSideOf(edge))) ??
      (await resolveInheritedMember(db, fromFile.id, placer, edge.resolution, edge.toName, memberSideOf(edge)));
    if (targetId !== null) callToMap.set(key, targetId);
  }

  // RE_EXPORTS edges: resolve each unique (toName, toResolvedPath) pair once,
  // file-scoped by the re-export's own module specifier (Task 0 fix — the
  // named-re-export sibling of the POTENTIAL_CALL false-green above). Keyed by
  // toResolvedPath as well as toName because one barrel file can re-export
  // same-named symbols from two different modules
  // (`export { x } from './a'; export { x as xB } from './b';`).
  const reExportKey = (e: EdgeRecord): string => `${e.toName}::${e.toResolvedPath ?? ''}`;
  const reExportEdgesByKey = new Map<string, EdgeRecord>();
  for (const e of edges) {
    if (e.edgeType === 'RE_EXPORTS' && !reExportEdgesByKey.has(reExportKey(e))) {
      reExportEdgesByKey.set(reExportKey(e), e);
    }
  }
  const reExportToMap = new Map<string, number>();
  for (const [key, edge] of reExportEdgesByKey) {
    // No resolved path (external module, or a relative specifier that didn't
    // probe to a real file) — the honest result is no edge, not a name-only
    // guess across the whole graph.
    if (edge.toResolvedPath == null) continue;
    const targetId = await resolveInFileOrReExportChain(db, edge.toResolvedPath, edge.toName);
    if (targetId !== null) reExportToMap.set(key, targetId);
  }

  const unresolved: EdgeRecord[] = [];
  const edgeValues = edges.flatMap((edge) => {
    const from_id = fromRowOf(edge)?.id;
    const to_id = edge.edgeType === 'POTENTIAL_CALL'
      ? callToMap.get(callKey(edge))
      : edge.edgeType === 'RE_EXPORTS'
        ? reExportToMap.get(reExportKey(edge))
        : structuralToMap.get(structuralKey(edge));
    if (from_id === undefined || to_id === undefined) {
      unresolved.push(edge);
      return [];
    }
    return [{
      from_id,
      to_id,
      edge_type: edge.edgeType,
      resolution: edge.resolution ?? null,
      call_line: edge.callLine ?? null,
      context: edge.context ?? null,
    }];
  });

  // Composite PK on (from_id, to_id, edge_type) — ignore duplicates. Batched
  // under the parameter ceiling (Stage 4.5 S1 class survey site 7); a
  // 6-column row shape caps a single unbatched INSERT at ~5,461 rows.
  // `.onConflict(doNothing())` is re-applied per batch — each batch is its
  // own statement, so the conflict clause must be present on every one, not
  // just the first.
  for (const batch of chunkRowsForSqlite(edgeValues)) {
    await db
      .insertInto('edges')
      .values(batch)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  return unresolved;
}

/**
 * Paths of the files, other than `paths` themselves, that hold an edge or a
 * star re-export row into one of `paths`.
 *
 * Re-writing or deleting a file deletes its rows, and every edge and star row
 * pointing at them goes with them by cascade. The files that held those edges
 * are not re-written, so nothing puts the edges back: a body edit to a called
 * file left it with no callers until the next full index (D081). Call this
 * BEFORE the write, while the edges still exist, and resolve the returned
 * files again afterwards (`clearOutgoingEdges`, then `insertGraphEdges`).
 */
export async function findFilesWithEdgesInto(db: Db, paths: readonly string[]): Promise<string[]> {
  const holders = new Set<string>();
  for (const batch of chunkValuesForSqlite(paths)) {
    const targets = await db.selectFrom('files').select('id').where('path', 'in', batch).execute();
    for (const idBatch of chunkValuesForSqlite(targets.map((t) => t.id))) {
      const byEdge = await db
        .selectFrom('edges as e')
        .innerJoin('symbols as to_s', 'to_s.id', 'e.to_id')
        .innerJoin('symbols as from_s', 'from_s.id', 'e.from_id')
        .innerJoin('files as from_f', 'from_f.id', 'from_s.file_id')
        .select('from_f.path')
        .distinct()
        .where('to_s.file_id', 'in', idBatch)
        .execute();
      const byStar = await db
        .selectFrom('re_export_files as r')
        .innerJoin('files as from_f', 'from_f.id', 'r.from_file_id')
        .select('from_f.path')
        .where('r.to_file_id', 'in', idBatch)
        .execute();
      for (const row of [...byEdge, ...byStar]) holders.add(row.path);
    }
  }
  for (const path of paths) holders.delete(path);
  return [...holders];
}

/**
 * Deletes the edges and star rows `filePath` is the source of, ahead of
 * resolving its records again. Without the delete, an edge whose target has
 * since moved would stay beside the new one.
 *
 * Checker edges are not this function's to delete: they are not written from
 * the file's records. The write that made this re-resolve necessary has
 * already removed all of them (`removeCheckerResults`).
 */
export async function clearOutgoingEdges(db: Db, filePath: string): Promise<void> {
  const file = await db.selectFrom('files').select('id').where('path', '=', filePath).executeTakeFirst();
  if (file === undefined) return;
  await db
    .deleteFrom('edges')
    .where('from_id', 'in', (qb) => qb.selectFrom('symbols').select('id').where('file_id', '=', file.id))
    .where((eb) => eb.or([eb('resolution', 'is', null), eb('resolution', '!=', 'checker')]))
    .execute();
  await db.deleteFrom('re_export_files').where('from_file_id', '=', file.id).execute();
}

/** What pass 2 needs from one file's extraction. */
export interface FileEdgeData {
  readonly filePath: string;
  readonly edges: readonly EdgeRecord[];
  readonly starReExports: readonly StarReExportRecord[];
}

/**
 * Runs `work` for one batch of files. The indexer passes a wrapper that takes
 * the structure lock, so each batch holds it briefly (F1); the default runs
 * the work as it is.
 */
export type EdgeBatchRunner = (work: () => Promise<void>) => Promise<void>;

const EDGE_BATCH_SIZE = 16;

/**
 * Pass 2 for a set of files whose symbols are already written: star re-export
 * rows, then named re-export edges, then the edges of a class (`extends`,
 * `implements`, its members), then calls.
 *
 * The order is what makes the result independent of the order of `files`
 * (D083). A call or an `implements` that goes through a barrel resolves by
 * reading the barrel's star rows and `RE_EXPORTS` edges, so those must all be
 * in place first. Written file by file instead, a caller that sorted before
 * its barrel found neither and got no edge: 1,939 edges on n8n, with nothing
 * reported (adr/proposals/incremental-graph-correctness/spikes/s1-walk-order).
 *
 * Named re-exports chain (a barrel re-exporting a barrel), and an outer one
 * resolves only once the inner one's edge exists. So that stage repeats over
 * the records still unresolved until a round resolves none. Every round but
 * the last resolves at least one record, which bounds it.
 *
 * Calls come after every structural edge for the same reason. A call of a
 * method its receiver's class inherits is resolved by following the stored
 * `EXTENDS` edges, which belong to other files. In one stage with the calls,
 * 287 of the 1,064 such edges on n8n were missing, with nothing reported
 * (adr/proposals/inherited-call-edges/spikes/RESULTS.md).
 */
export async function insertGraphEdges(
  db: Db,
  files: readonly FileEdgeData[],
  runBatch: EdgeBatchRunner = (work) => work(),
): Promise<void> {
  const inBatches = async <T>(items: readonly T[], each: (item: T) => Promise<void>): Promise<void> => {
    for (let i = 0; i < items.length; i += EDGE_BATCH_SIZE) {
      const batch = items.slice(i, i + EDGE_BATCH_SIZE);
      await runBatch(async () => {
        for (const item of batch) await each(item);
      });
    }
  };

  await inBatches(files, (file) => insertReExportFiles(db, file.filePath, file.starReExports));

  let pending = files
    .map((file) => ({ filePath: file.filePath, edges: file.edges.filter((e) => e.edgeType === 'RE_EXPORTS') }))
    .filter((file) => file.edges.length > 0);
  await inBatches(pending, (file) => insertReExportAliases(db, file.filePath, file.edges));
  for (;;) {
    const stillPending: typeof pending = [];
    let resolvedAny = false;
    await inBatches(pending, async (file) => {
      const unresolved = await insertEdgesReportingUnresolved(db, file.filePath, file.edges);
      if (unresolved.length < file.edges.length) resolvedAny = true;
      if (unresolved.length > 0) stillPending.push({ filePath: file.filePath, edges: unresolved });
    });
    pending = stillPending;
    if (!resolvedAny || pending.length === 0) break;
  }

  await inBatches(files, async (file) => {
    await insertEdges(db, file.filePath, file.edges.filter((e) => e.edgeType !== 'RE_EXPORTS' && e.edgeType !== 'POTENTIAL_CALL'));
  });
  await inBatches(files, async (file) => {
    await insertEdges(db, file.filePath, file.edges.filter((e) => e.edgeType === 'POTENTIAL_CALL'));
  });
}

// ---------------------------------------------------------------------------
// POTENTIAL_CALL target resolution — file-scoped by resolution-rule evidence
// ---------------------------------------------------------------------------

/**
 * Resolve a POTENTIAL_CALL edge's target symbol id using the file evidence
 * the resolution rule (§10.3.1) actually carries, instead of matching the
 * bare/qualified name against the *entire* graph.
 *
 * Without this, two files exporting a same-named symbol race on insertion
 * order: `WHERE name = ? LIMIT 1` with no file filter deterministically
 * returns whichever row SQLite happens to have inserted first, regardless of
 * which file the call site's own import (or same-file declaration) actually
 * names. That produced a wrong "verified" edge — see
 * IMPLEMENTATION_PLAN_VEXP.md §P "Shipped-resolver finding" (2026-07-15) and
 * eval/spikes/checker-edges/REPORT.md Q4b. `verified_callers` is documented
 * as "safe to act on" (MAST_SPEC §9) precisely because ambiguity like this is
 * not supposed to reach it — better no edge than a wrong one.
 */
async function resolveCallTarget(
  db: Db,
  fromFileId: number,
  imports: ImportPlacer,
  resolution: CallerResolution | undefined,
  toName: string,
  side: MemberSide | null,
): Promise<number | null> {
  switch (resolution) {
    case 'same_file':
      // The call target must be declared in this exact file — the file
      // itself is the evidence, no lookup needed to establish it.
      return resolveSameFileScoped(db, fromFileId, toName);

    // F4: `this.foo()` — the enclosing class is declared IN the calling
    // file by construction (`emitClassEdges` seeds the `this` binding from
    // the class node it is currently walking), so this is the identical
    // file-scoped lookup `same_file` uses, keyed on the qualified
    // `ClassName.methodName` toName instead of a bare name.
    case 'this_method':
      return resolveSameFileScoped(db, fromFileId, toName, side);

    case 'import': {
      const lookup = await imports(toName);
      // An `import`-resolution edge is only emitted for a name the extractor
      // saw in this file's own import_clause (local-type-env.ts
      // recordImport), so an import row always exists; `lookup === null`
      // is defensive, not an expected path.
      const resolvedPath = lookup?.resolvedPath ?? null;
      // Unresolved (external, or a relative specifier that didn't probe to
      // a real file) — the honest result is no edge, not a name-only guess.
      if (resolvedPath === null) return null;
      return resolveInFileOrReExportChain(db, resolvedPath, toName);
    }

    case 'field_type':
    case 'parameter_type':
    case 'new_expression':
      // toName is `TypeName.methodName` — the receiver's type must be
      // file-scoped first, then the qualified method name resolved within
      // that file (or its re-export chain). No edge when `typeName` has no
      // file evidence at all: the first symbol with the name anywhere in the
      // graph used to be taken instead, and an incremental run had nothing
      // to find that edge's holder by (D092; measured at 7 of 30,740 call
      // edges on n8n, spikes/s9-call-fallback).
      return resolveQualifiedNameScoped(db, fromFileId, imports, toName, side);

    // `new X()` — toName is the class name, placed by the same file evidence
    // as a receiver's type. The constructor is the thing called, so the edge
    // goes to it when the class declares one. A class with none has no such
    // symbol, and the edge goes to the class.
    case 'construction':
      return (
        (await resolveQualifiedNameScoped(db, fromFileId, imports, `${toName}.constructor`)) ??
        resolveQualifiedNameScoped(db, fromFileId, imports, toName)
      );

    // F4: `super.foo()` — toName is `ParentName.methodName`, traced exactly
    // like a field_type receiver's type (import first, then same-file
    // declaration), with no edge when the parent name has no file evidence.
    case 'super_method':
      return resolveQualifiedNameScoped(db, fromFileId, imports, toName, side);

    // `X.make()` — toName is `X.make`, with `X` placed by this file's imports
    // or declarations. An object or an enum of that name has no such symbol,
    // and there is no edge.
    case 'static_method':
      return resolveQualifiedNameScoped(db, fromFileId, imports, toName, side);

    default:
      // A POTENTIAL_CALL edge always carries a resolution (`emitCallEdges`
      // sets it from `LocalTypeEnvironment.resolveCall`'s result); this
      // branch only guards an unexpected shape, and without a rule there is
      // no file evidence to resolve by.
      return null;
  }
}

/** The rules whose `toName` is `Class.member`, with `Class` placed by the file's own evidence. */
const MEMBER_OF_A_CLASS: ReadonlySet<CallerResolution> = new Set<CallerResolution>([
  'this_method',
  'super_method',
  'field_type',
  'parameter_type',
  'new_expression',
  'static_method',
]);

/** Which members of a class a call can reach: its statics, or those of an instance. */
type MemberSide = 'static' | 'instance';

/**
 * The side a call record's member is on, or null when the record names no
 * member of a class. A call written on the class (`X.m()`) reaches statics, and
 * so do `this.m()` and `super.m()` written in a static method; a call on a
 * value of the class reaches instance members (D118).
 */
function memberSideOf(edge: EdgeRecord): MemberSide | null {
  if (edge.resolution === undefined || !MEMBER_OF_A_CLASS.has(edge.resolution)) return null;
  return edge.resolution === 'static_method' || edge.inStaticMethod === true ? 'static' : 'instance';
}

/**
 * `Class.member` where `Class` does not declare `member`: the member of the
 * nearest class above it that does. A member of the other side is not one.
 *
 * `Class` is placed as the rule places it. From there the stored `EXTENDS`
 * edges are followed, each of which was placed by its own file's evidence
 * (D085), and the member is read from the file that declares each class, under
 * the name the class has there. No name is matched across the graph.
 *
 * Null, and so no edge, when a class on the way has no stored parent (a class
 * outside the index, a default import, a mixin), when the chain comes back to a
 * class it has passed, and when the row has two stored parents (an interface
 * that extends two): which of them declares the member is not decided here. A
 * class merged with an interface is two rows, and the class's is the one
 * followed (D121).
 *
 * Null also when a class on the way, the receiver's included, has a field of
 * the name. A field has no symbol row and is still the nearest declaration:
 * the call runs what the field holds, which is not stored (D115). A call that
 * reaches statics is stopped by a static field, every other by an instance one.
 *
 * Reads edges other files wrote, so `insertGraphEdges` writes every structural
 * edge before any call.
 */
async function resolveInheritedMember(
  db: Db,
  fromFileId: number,
  placeImport: ImportPlacer,
  resolution: CallerResolution | undefined,
  toName: string,
  side: MemberSide | null,
): Promise<number | null> {
  const dot = toName.indexOf('.');
  if (side === null || dot === -1) return null;
  const member = toName.slice(dot);
  const className = toName.slice(0, dot);

  // `this` is the class the call is written in, which is in this file.
  let current = resolution === 'this_method'
    ? await resolveSameFileScoped(db, fromFileId, className)
    : await resolveQualifiedNameScoped(db, fromFileId, placeImport, className);
  if (current === null) return null;
  const own = await db.selectFrom('symbols').select('fields').where('id', '=', current).executeTakeFirst();
  if (fieldNamesOf(own?.fields ?? null)[side].includes(member.slice(1))) return null;

  const passed = new Set<number>();
  while (current !== null && !passed.has(current)) {
    passed.add(current);
    const parents: { id: number; name: string; file_id: number; fields: string | null }[] = await db
      .selectFrom('edges as e')
      .innerJoin('symbols as p', 'p.id', 'e.to_id')
      .select(['p.id', 'p.name', 'p.file_id', 'p.fields'])
      .where('e.from_id', '=', current)
      .where('e.edge_type', '=', 'EXTENDS')
      .limit(2)
      .execute();
    const parent = parents[0];
    if (parent === undefined || parents.length > 1) return null;
    const declared = await resolveSameFileScoped(db, parent.file_id, `${parent.name}${member}`, side);
    if (declared !== null) return declared;
    if (fieldNamesOf(parent.fields)[side].includes(member.slice(1))) return null;
    current = parent.id;
  }
  return null;
}

/** A row's static flag, with a row written before the column existed read as not static. */
const IS_STATIC = sql<number>`COALESCE(is_static, 0)`;

/**
 * The call target must be declared in exactly `fromFileId` — the file
 * itself is the evidence, no lookup needed to establish it. Shared by
 * `same_file` (bare name) and F4's `this_method` (qualified
 * `ClassName.methodName` name) — both resolve identically once the toName
 * is fixed, since the enclosing class is always declared in the same file
 * as the `this`-call site that names it.
 */
async function resolveSameFileScoped(
  db: Db,
  fromFileId: number,
  toName: string,
  side: MemberSide | null = null,
  meaning: Meaning = 'value',
): Promise<number | null> {
  const row = await db
    .selectFrom('symbols')
    .select('id')
    .where('name', '=', toName)
    .where('file_id', '=', fromFileId)
    .where('kind', '!=', 'export')
    .$if(side !== null, (q) => q.where(IS_STATIC, '=', side === 'static' ? 1 : 0))
    .orderBy(IS_A_TYPE, orderOf(meaning))
    .orderBy('line', 'asc')
    .orderBy('id', 'asc')
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * The row of the member `toName` of a class in `fileId`: the one on `line`
 * when the record has a line and a row is on it, and otherwise the row of the
 * name when there is one only (see `fromRowOf`).
 */
async function resolveMemberRow(db: Db, fileId: number, toName: string, line: number | undefined): Promise<number | null> {
  const rows = await db
    .selectFrom('symbols')
    .select(['id', 'line'])
    .where('name', '=', toName)
    .where('file_id', '=', fileId)
    .where('kind', '!=', 'export')
    .orderBy('line', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const onLine = line === undefined ? undefined : rows.find((r) => r.line === line);
  if (onLine !== undefined) return onLine.id;
  return rows.length === 1 || line === undefined ? (rows[0]?.id ?? null) : null;
}

/**
 * What a use of a name means. A file can declare a name twice, once as a type
 * (an interface, a type alias) and once as a value (a class, a function): a
 * call, `new` and a class's `extends` mean the value, `implements` and a
 * parameter's type the type.
 *
 * The other row is taken when the one meant is not there. A value that is not
 * a function or a class has no row (`export const X = lazy(...)` beside
 * `export type X`), and the row of the name is then the type's: 27 call edges
 * on n8n are of this kind. The compiler's target for each is the constant, of
 * the same file and name (adr/proposals/resolver-shapes, D121).
 */
export type Meaning = 'value' | 'type';

/** 1 on a row that is a type and not a value, 0 on any other. */
const IS_A_TYPE = sql<number>`CASE WHEN kind IN ('interface', 'type') THEN 1 ELSE 0 END`;

/** The order of `IS_A_TYPE` that puts the rows of `meaning` first. */
function orderOf(meaning: Meaning): 'asc' | 'desc' {
  return meaning === 'type' ? 'desc' : 'asc';
}

/**
 * The row of `meaning` among those that share a file and a name with `id`, or
 * `id` when it is one already or there is no other. A marker's edge is placed
 * once, by the value, and an `implements` that comes through it means the type.
 */
async function rowOfMeaning(db: Db, id: number, meaning: Meaning): Promise<number> {
  const row = await db.selectFrom('symbols').select(['file_id', 'name']).where('id', '=', id).executeTakeFirst();
  if (row === undefined) return id;
  const meant = await db
    .selectFrom('symbols')
    .select('id')
    .where('file_id', '=', row.file_id)
    .where('name', '=', row.name)
    .where('kind', '!=', 'export')
    .orderBy(IS_A_TYPE, orderOf(meaning))
    .orderBy(sql<number>`CASE WHEN id = ${id} THEN 0 ELSE 1 END`, 'asc')
    .orderBy('line', 'asc')
    .orderBy('id', 'asc')
    .executeTakeFirst();
  return meant?.id ?? id;
}

/**
 * Resolve a `TypeName.methodName` toName using the receiver type's own file
 * evidence: `typeName` against this file's own imports first, then its
 * same-file declarations, following the re-export chain into a barrel when
 * needed (§10.3.1). Null when NEITHER source names `typeName` at all.
 */
async function resolveQualifiedNameScoped(
  db: Db,
  fromFileId: number,
  placeImport: ImportPlacer,
  toName: string,
  side: MemberSide | null = null,
  meaning: Meaning = 'value',
): Promise<number | null> {
  const dot = toName.indexOf('.');
  const typeName = dot === -1 ? toName : toName.slice(0, dot);

  const lookup = await placeImport(typeName);
  if (lookup !== null) {
    if (lookup.resolvedPath === null) return null; // imported but unresolved — no edge
    return resolveInFileOrReExportChain(db, lookup.resolvedPath, toName, side, meaning);
  }

  const sameFileType = await db
    .selectFrom('symbols')
    .select('id')
    .where('name', '=', typeName)
    .where('file_id', '=', fromFileId)
    .where('kind', '!=', 'export')
    .executeTakeFirst();
  if (sameFileType !== undefined) {
    return resolveSameFileScoped(db, fromFileId, toName, side, meaning);
  }

  // Neither an import nor a same-file declaration names `typeName` — e.g. a
  // default/namespace import (not tracked as a named import, see
  // `extractEdges`' `importedNames` collection) or an ambient/global type.
  // No file evidence exists to scope this edge, so there is none (D092).
  return null;
}

/**
 * Look up whether `name` is one of `fromFileId`'s own named imports.
 *
 * Returns `null` when `name` is not imported by this file at all (no
 * evidence). Returns `{ resolvedPath }` when it is — `resolvedPath` is
 * itself `null` for an external or otherwise-unresolvable module, which the
 * caller must treat as "no edge", not "no evidence" (the import statement
 * proves the receiver came from *some* module; that module just isn't ours).
 */
interface FileImportIndex {
  readonly byName: ReadonlyMap<string, string | null>;
  /** The same resolved paths by module specifier, for a record that names its module. */
  readonly byModule: ReadonlyMap<string, string | null>;
}

/**
 * Where one edge record's name is imported from: `{ resolvedPath }` when this
 * file imports it (`null` inside for a module that is not an indexed file),
 * `null` when it does not.
 */
type ImportPlacer = (name: string) => Promise<{ resolvedPath: string | null } | null>;

/**
 * The placer for a record. A record that names its module (`importModule`, set
 * by the extractor) is placed by that import alone, and one that says the name
 * is not imported is placed by none, so a name the file imports under an alias
 * is never mistaken for a declaration of its own, nor the other way (D106). A
 * record with neither is placed by name, the first import that has it.
 */
function importPlacerFor(imports: ImportIndexLoader, importModule: string | null | undefined): ImportPlacer {
  if (importModule === null) return () => Promise.resolve(null);
  return async (name) => {
    const index = await imports();
    if (importModule === undefined) return importResolvedPathFor(index, name);
    const resolvedPath = index.byModule.get(importModule);
    return resolvedPath === undefined ? null : { resolvedPath };
  };
}

/**
 * Deferred, memoised access to one file's import index.
 *
 * Invoking it more than once for the same file issues exactly one query; never
 * invoking it issues none.
 */
type ImportIndexLoader = () => Promise<FileImportIndex>;

/**
 * Every symbol this file imports, mapped to the module's resolved path.
 *
 * `null` values are meaningful and distinct from absence: the name IS imported,
 * from a module that did not resolve to a file we index. Absence means the file
 * does not import the name at all. Callers must keep the two apart — see
 * `importResolvedPathFor`.
 *
 * FIRST WRITE WINS, which preserves the row-scan order this replaced: the old
 * code returned the first `imports` row naming the symbol, and both read rows in
 * `idx_imports_file` order. A later duplicate import of the same name is
 * therefore ignored exactly as before.
 */
async function buildFileImportIndex(db: Db, fromFileId: number): Promise<FileImportIndex> {
  const rows = await db
    .selectFrom('imports')
    .select(['module', 'symbols', 'resolved_path'])
    .where('file_id', '=', fromFileId)
    .execute();

  const index = new Map<string, string | null>();
  const byModule = new Map<string, string | null>();
  for (const row of rows) {
    if (!byModule.has(row.module)) byModule.set(row.module, row.resolved_path);
    let importedSymbols: string[];
    try {
      importedSymbols = JSON.parse(row.symbols) as string[];
    } catch {
      continue; // malformed row — treat as naming nothing
    }
    for (const symbol of importedSymbols) {
      if (!index.has(symbol)) index.set(symbol, row.resolved_path);
    }
  }
  return { byName: index, byModule };
}

function fileImportIndexLoader(db: Db, fromFileId: number): ImportIndexLoader {
  let pending: Promise<FileImportIndex> | null = null;
  return () => (pending ??= buildFileImportIndex(db, fromFileId));
}

function importResolvedPathFor(
  index: FileImportIndex,
  name: string,
): { resolvedPath: string | null } | null {
  const resolvedPath = index.byName.get(name);
  // `undefined` can only mean absent — the map never stores it, only `null`.
  if (resolvedPath === undefined) return null;
  return { resolvedPath };
}

/**
 * Resolve `toName` within `resolvedPath`, following the barrel re-export
 * machinery (§6.3) when the resolved file doesn't declare it directly:
 * a named re-export leaves an `export`-kind marker symbol with a RE_EXPORTS
 * edge to the real declaration; a star re-export (`export * from`) leaves a
 * `re_export_files` row. Both are walked before giving up.
 *
 * `side`, for a `Type.member` name, keeps the lookup to the type's static
 * members or to its instance ones.
 */
export async function resolveInFileOrReExportChain(
  db: Db,
  resolvedPath: string,
  toName: string,
  side: 'static' | 'instance' | null = null,
  meaning: Meaning = 'value',
): Promise<number | null> {
  // The import resolver (`src/indexer/import-resolver.ts`) always returns an
  // extension-inclusive path, but prefix matching mirrors the existing
  // precedent (`resolveTypeContext`, `insertReExportFiles`) defensively.
  const targetFile = await db
    .selectFrom('files')
    .select('id')
    .where('path', '>=', resolvedPath)
    .where('path', '<', pathPrefixUpperBound(resolvedPath))
    .orderBy('path', 'asc')
    .executeTakeFirst();
  if (targetFile === undefined) return null;

  // A member (`Type.method`, `Type.constructor`) is exported by nothing: only
  // its type is. So the chain is followed for the type, and the member is then
  // read from the file that declares the type. Looking for the qualified name
  // along the chain found it only where the import named the declaring file,
  // or where every hop was an `export *`.
  const dot = toName.indexOf('.');
  if (dot !== -1) {
    // `ns.f()` on a name the file exports as all of a module is `f` of that
    // module. Only for a call written on the name: a value of a type called
    // `ns` is not the namespace.
    if (side !== 'instance') {
      const namespace = await moduleExportedAs(db, targetFile.id, toName.slice(0, dot));
      if (namespace !== undefined) {
        return namespace.resolvedPath === null
          ? null
          : resolveInFileOrReExportChain(db, namespace.resolvedPath, toName.slice(dot + 1), null, meaning);
      }
    }
    const ownerId = await resolveInFileOrReExportChain(db, resolvedPath, toName.slice(0, dot));
    if (ownerId === null) return null;
    // The member is stored under the name its type was declared with, which a
    // renaming re-export (`export { Column as DslColumn }`) makes differ from
    // the name the import uses (D105).
    const owner = await db
      .selectFrom('symbols')
      .select(['file_id', 'name'])
      .where('id', '=', ownerId)
      .executeTakeFirst();
    if (owner === undefined) return null;
    const member = await db
      .selectFrom('symbols')
      .select('id')
      .where('file_id', '=', owner.file_id)
      .where('name', '=', `${owner.name}${toName.slice(dot)}`)
      .where('kind', '!=', 'export')
      .$if(side !== null, (q) => q.where(IS_STATIC, '=', side === 'static' ? 1 : 0))
      .executeTakeFirst();
    return member?.id ?? null;
  }

  // `default` is the name of an export and of no declaration: the row is the
  // one flagged as the file's default export, whatever it is called (D148).
  if (toName === 'default') {
    const defaultExport = await db
      .selectFrom('symbols')
      .select('id')
      .where('file_id', '=', targetFile.id)
      .where('is_default_export', '=', 1)
      .where('kind', '!=', 'export')
      .orderBy(IS_A_TYPE, orderOf(meaning))
      .orderBy('line', 'asc')
      .orderBy('id', 'asc')
      .executeTakeFirst();
    if (defaultExport !== undefined) return defaultExport.id;
  }

  // Only a declaration the file exports is what an import of the name means.
  // A private one of the same name, in a file that gets the name from an
  // `export *`, took every caller of the public one (D120).
  const direct = await db
    .selectFrom('symbols')
    .select(['id', 'is_default_export'])
    .where('name', '=', toName)
    .where('file_id', '=', targetFile.id)
    .where('kind', '!=', 'export')
    .where('is_exported', '=', 1)
    .orderBy('is_default_export', 'asc')
    .orderBy(IS_A_TYPE, orderOf(meaning))
    .orderBy('line', 'asc')
    .orderBy('id', 'asc')
    .executeTakeFirst();
  // The name a default export was declared with is not a name the file
  // exports, and the row does not say whether the declaration is exported by
  // name as well. So such a row is taken only when the file's re-exports do
  // not supply the name (D167; D164 is the same behind a star).
  if (direct !== undefined && direct.is_default_export === 0) return declarationBehindLocalAlias(db, direct.id);

  // Named re-export: a marker symbol (kind 'export') anchors a RE_EXPORTS
  // edge to the real declaration (§10.1).
  const marker = await db
    .selectFrom('symbols')
    .select('id')
    .where('name', '=', toName)
    .where('file_id', '=', targetFile.id)
    .where('kind', '=', 'export')
    .executeTakeFirst();
  // A name the file re-exports by name is that export and nothing else: an
  // `export *` in the same file does not supply it as well. So an unresolved
  // marker ends the search here. Falling through to the star rows would, while
  // the marker's own edge is still to be written, pick up a same-named
  // declaration behind the star and record an edge to the wrong file.
  if (marker !== undefined) {
    const target = await followReExportEdgeChain(db, marker.id);
    return target === null ? null : rowOfMeaning(db, await declarationBehindLocalAlias(db, target), meaning);
  }

  // Star re-export: no per-symbol marker exists, only a file-level
  // `re_export_files` row (§10.3). Walk the chain forward to the file that
  // actually declares `toName` — the recursive CTE from MAST_SPEC §6.3.
  const behindStar = await resolveThroughStarChain(db, targetFile.id, toName, meaning);
  return behindStar !== null || direct === undefined ? behindStar : declarationBehindLocalAlias(db, direct.id);
}

/**
 * The module that file `fileId` exports whole under `name`, or undefined when
 * it exports no namespace of that name. `resolvedPath` is null for a module
 * that is no indexed file.
 *
 * Read from the import rows' `exported_as` and from nothing else. A namespace
 * import of the name that the file does not export says nothing about what
 * `name` is to an importer: the file may get it from an `export *`, or export
 * something else under it.
 */
async function moduleExportedAs(db: Db, fileId: number, name: string): Promise<{ resolvedPath: string | null } | undefined> {
  const rows = await db
    .selectFrom('imports')
    .select(['exported_as', 'resolved_path'])
    .where('file_id', '=', fileId)
    .where('exported_as', 'is not', null)
    .execute();
  for (const row of rows) {
    if (namesExportedAs(row.exported_as).includes(name)) return { resolvedPath: row.resolved_path };
  }
  return undefined;
}

/** Bounded hop count for chained named re-exports (barrel re-exporting a barrel). */
const MAX_RE_EXPORT_HOPS = 5;

/** Follow RE_EXPORTS edges from a marker symbol to the real (non-marker) declaration. */
async function followReExportEdgeChain(db: Db, markerId: number): Promise<number | null> {
  let currentId = markerId;
  for (let hop = 0; hop < MAX_RE_EXPORT_HOPS; hop++) {
    // A file can re-export one name from two files. It is not valid
    // TypeScript, and the marker then has two edges; the one in the lowest
    // path is followed, so the answer does not depend on which was written
    // first (D111, as D094 for two stars).
    const target = await db
      .selectFrom('edges as e')
      .innerJoin('symbols as s', 's.id', 'e.to_id')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select(['s.id', 's.kind'])
      .where('e.from_id', '=', currentId)
      .where('e.edge_type', '=', 'RE_EXPORTS')
      .orderBy('f.path', 'asc')
      .orderBy('s.id', 'asc')
      .executeTakeFirst();
    if (target === undefined) return null;
    if (target.kind !== 'export') return target.id;
    currentId = target.id;
  }
  return null;
}

/**
 * Walk `re_export_files` forward from `startFileId` (a barrel doing
 * `export * from '...'`) to find `toName` in a file the stars reach: declared
 * there, or re-exported there by name. Mirrors the `re_export_chain` recursive
 * CTE documented in MAST_SPEC §6.3.
 *
 * The second case is how package entry points are commonly built — `index.ts`
 * stars `errors/index.ts`, which re-exports each class by name — and looking
 * only for declarations found none of those names (D086).
 */
async function resolveThroughStarChain(
  db: Db,
  startFileId: number,
  toName: string,
  meaning: Meaning,
): Promise<number | null> {
  const candidates = await db
    .withRecursive('re_export_chain', (qb) =>
      qb
        .selectFrom('re_export_files')
        .select('to_file_id as file_id')
        .where('from_file_id', '=', startFileId)
        .union(
          qb
            .selectFrom('re_export_files as rf')
            .innerJoin('re_export_chain', 're_export_chain.file_id', 'rf.from_file_id')
            .select('rf.to_file_id as file_id'),
        ),
    )
    .selectFrom('symbols as s')
    .innerJoin('re_export_chain as rec', 'rec.file_id', 's.file_id')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .select(['s.id', 's.kind'])
    .where('s.name', '=', toName)
    // An `export *` passes on what the file exports and nothing else (D120).
    .where('s.is_exported', '=', 1)
    // An `export *` does not pass on a default export, and the row does not say
    // whether its declaration is exported by name as well. So a row that is a
    // default export is taken only when no other file has the name (D164).
    .orderBy('s.is_default_export', 'asc')
    // By path, not by file id: when two files behind the stars have the name,
    // the one chosen must not depend on which was written last. A re-written
    // file gets a new id, so id order made an edit to one of them move every
    // importer's edge to the other (D094).
    .orderBy('f.path', 'asc')
    .orderBy(sql<number>`CASE WHEN s.kind IN ('interface', 'type') THEN 1 ELSE 0 END`, orderOf(meaning))
    .orderBy('s.line', 'asc')
    .orderBy('s.id', 'asc')
    .execute();

  const declared = candidates.find((c) => c.kind !== 'export');
  if (declared !== undefined) return declarationBehindLocalAlias(db, declared.id);

  for (const marker of candidates) {
    const target = await followReExportEdgeChain(db, marker.id);
    if (target !== null) return rowOfMeaning(db, await declarationBehindLocalAlias(db, target), meaning);
  }
  return null;
}

/**
 * The declaration that the row `symbolId` is another name for, or `symbolId`
 * when it is a declaration itself.
 *
 * `export { a as b }` gives the file a row `b` beside `a`, of `a`'s kind and on
 * `a`'s line (§10.1), so that the exported name can be found. An import of `b`
 * means `a`: placed on `b`, the edge was on a row nothing else points at, and
 * `a` had no callers (D124). The `reexport_aliases` row says which name `b`
 * stands for; the line says which row of that name, when there are two (D121).
 * A re-export from another file has a marker and is not read here.
 */
export async function declarationBehindLocalAlias(db: Db, symbolId: number): Promise<number> {
  const declaration = await db
    .selectFrom('symbols as alias')
    .innerJoin('reexport_aliases as ra', (join) =>
      join.onRef('ra.file_id', '=', 'alias.file_id').onRef('ra.exported_name', '=', 'alias.name'),
    )
    .innerJoin('symbols as d', (join) =>
      join
        .onRef('d.file_id', '=', 'alias.file_id')
        .onRef('d.name', '=', 'ra.source_name')
        .onRef('d.line', '=', 'alias.line')
        .onRef('d.kind', '=', 'alias.kind'),
    )
    .select('d.id')
    .where('alias.id', '=', symbolId)
    .where('alias.kind', '!=', 'export')
    .orderBy('d.id', 'asc')
    .executeTakeFirst();
  return declaration?.id ?? symbolId;
}

/**
 * Records each name `filePath` re-exports under another name
 * (`export { a as b }`). Written whether or not the source resolves: repair
 * reads it to find the importers of `b` when a file gains or loses `a`, which
 * is exactly when the marker has no edge to say so (D112). A re-written file's
 * rows went with its `files` row.
 */
async function insertReExportAliases(db: Db, filePath: string, reExports: readonly EdgeRecord[]): Promise<void> {
  const renamed = reExports.filter((edge) => edge.fromName !== edge.toName);
  if (renamed.length === 0) return;
  const file = await db.selectFrom('files').select('id').where('path', '=', filePath).executeTakeFirst();
  if (file === undefined) return;
  await db
    .insertInto('reexport_aliases')
    .values(renamed.map((edge) => ({ file_id: file.id, exported_name: edge.fromName, source_name: edge.toName })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/**
 * Second-pass star re-export insertion (`export * from './x'` → one
 * `re_export_files` row per resolved target). Runs after all files' rows
 * exist, like `insertEdges`, because the target file may be indexed later in
 * the same run. Unresolved or unindexed targets are silently skipped.
 */
export async function insertReExportFiles(
  db: Db,
  filePath: string,
  stars: readonly StarReExportRecord[],
): Promise<void> {
  if (stars.length === 0) return;

  const fromFile = await db
    .selectFrom('files')
    .select('id')
    .where('path', '=', filePath)
    .executeTakeFirst();
  if (fromFile === undefined) return;

  // A relative star that matches no indexed file is recorded, so that the run
  // which later adds the file can find this barrel again (D090).
  const recordUnresolved = async (module: string): Promise<void> => {
    if (!module.startsWith('.')) return;
    await db
      .insertInto('star_reexport_unresolved')
      .values({ file_id: fromFile.id, module })
      .onConflict((oc) => oc.doNothing())
      .execute();
  };

  for (const star of stars) {
    if (star.resolvedPath === null) {
      await recordUnresolved(star.module);
      continue;
    }
    // resolved_path may lack an extension — the prefix range matches `x.ts`,
    // `x/index.ts`, etc. (same convention as resolveTypeContext, §13.7).
    const target = await db
      .selectFrom('files')
      .select('id')
      .where('path', '>=', star.resolvedPath)
      .where('path', '<', pathPrefixUpperBound(star.resolvedPath))
      .orderBy('path', 'asc')
      .executeTakeFirst();
    if (target === undefined) {
      await recordUnresolved(star.module);
      continue;
    }
    await db
      .deleteFrom('star_reexport_unresolved')
      .where('file_id', '=', fromFile.id)
      .where('module', '=', star.module)
      .execute();
    if (target.id === fromFile.id) continue;

    await db
      .insertInto('re_export_files')
      .values({ from_file_id: fromFile.id, to_file_id: target.id })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

/**
 * Remove all data for files that were present in the previous manifest but
 * are absent from the current filesystem scan (deleted files). Returns the
 * number of `chunks` rows removed (§ `IndexResult.chunksRemoved`).
 *
 * `chunks` (M1, §15.1) and the FTS5 virtual tables (chunk_fts, identifier_fts)
 * do not participate in SQLite FK cascades, so all three must be cleaned up
 * explicitly before the files row is deleted. Wrapped in one transaction so a
 * deleted-file cleanup is atomic the same way `populateFile` is — a failure
 * partway through cannot leave chunks/FTS rows orphaned from a `files` row
 * that was (or wasn't) removed.
 */
export async function removeDeletedFiles(db: Db, deletedPaths: readonly string[]): Promise<number> {
  if (deletedPaths.length === 0) return 0;
  return db.transaction().execute(async (trx) => {
    let chunksRemoved = 0;
    for (const filePath of deletedPaths) {
      const row = await trx
        .selectFrom('chunks')
        .select((eb) => eb.fn.count<number>('chunk_id').as('count'))
        .where('file_path', '=', filePath)
        .executeTakeFirst();
      chunksRemoved += row?.count ?? 0;

      // Read before `files` is deleted below — the row is the only record of
      // which rowids this file owns. A path with no `files` row yields no
      // block, and `deleteFtsRowidBlock` then falls back to the scan, so a
      // caller passing an unknown path still gets correct (if slow) cleanup.
      const block = await trx
        .selectFrom('files')
        .select(['chunk_fts_lo', 'chunk_fts_hi', 'ident_fts_lo', 'ident_fts_hi'])
        .where('path', '=', filePath)
        .executeTakeFirst();

      await trx.deleteFrom('chunks').where('file_path', '=', filePath).execute();
      await deleteFtsRowidBlock(
        trx, 'chunk_fts',
        { lo: block?.chunk_fts_lo ?? null, hi: block?.chunk_fts_hi ?? null },
        filePath,
      );
      await deleteFtsRowidBlock(
        trx, 'identifier_fts',
        { lo: block?.ident_fts_lo ?? null, hi: block?.ident_fts_hi ?? null },
        filePath,
      );
    }
    // Batched for the same reason every other IN list in this file is: the
    // caller supplies `deletedPaths` and nothing bounds it — deleting a
    // vendored directory, or re-indexing after an `exclude_patterns` change,
    // hands this whatever the manifest diff produced. Over the ceiling the
    // statement throws `too many SQL variables`, and because this runs inside
    // the transaction above, the throw rolls back every chunk and FTS row the
    // loop already deleted. D001, this ledger's founding S0, is that same
    // ceiling breached from the insert side.
    for (const batch of chunkValuesForSqlite(deletedPaths)) {
      await trx.deleteFrom('files').where('path', 'in', [...batch]).execute();
    }
    return chunksRemoved;
  });
}
