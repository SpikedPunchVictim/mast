import { sql, type Db } from './db.js';
import type { Chunk, Language, SymbolRecord, ImportRecord, EdgeRecord, CallerResolution } from '../ast/types.js';
import type { IdentifierRow, StarReExportRecord } from '../ast/extractor.js';
import { chunkRowsForSqlite, chunkValuesForSqlite } from './sqliteBatch.js';
import { pathPrefixUpperBound } from './path-range.js';

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
  const existing = await timed(spans, 'rest', () => trx
    .selectFrom('files')
    .select(['id', 'mtime'])
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
    return { fileId: existing.id, chunksRemoved: 0, written: false };
  }

  // Delete-and-replace: FK cascades remove symbols, edges, imports.
  const file = await timed(spans, 'rest', async () => {
    await trx.deleteFrom('files').where('path', '=', data.filePath).execute();

    const [row] = await trx
      .insertInto('files')
      .values({
        path: data.filePath,
        language: data.language,
        mtime: data.mtime,
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
    }[] = data.symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      file_id: fileId,
      line: s.line,
      is_exported: s.isExported ? 1 : 0,
      declaration_hash: s.declarationHash,
      body_hash: s.bodyHash,
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
      is_external: 0 | 1;
      resolved_path: string | null;
    }[] = data.imports.map((imp) => ({
      file_id: fileId,
      module: imp.module,
      symbols: JSON.stringify(imp.symbols),
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
  const fileHadPreviousVersion = existing !== undefined;
  if (options.skipFtsDeletes !== true && fileHadPreviousVersion) {
    await timed(spans, 'fts_del', async () => {
      await trx.deleteFrom('chunk_fts').where('file_path', '=', data.filePath).execute();
      await trx.deleteFrom('identifier_fts').where('file_path', '=', data.filePath).execute();
    });
  }

  // Batch-insert all chunks in one statement instead of one INSERT per chunk
  // — further batched under the parameter ceiling, same as above.
  await timed(spans, 'fts_ins', async () => {
    if (data.chunks.length > 0) {
      const chunkFtsRows = data.chunks.map((chunk) => ({
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
      const identifierFtsRows = data.identifierRows.map((row) => ({
        identifiers: row.identifiers,
        chunk_id: row.chunk_id,
        file_path: data.filePath,
      }));
      for (const batch of chunkRowsForSqlite(identifierFtsRows)) {
        await trx.insertInto('identifier_fts').values(batch).execute();
      }
    }
  });

  return { fileId, chunksRemoved, written: true };
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
  if (edges.length === 0) return;

  const fromNames = [...new Set(edges.map((e) => e.fromName))];

  // Batch-resolve "from" IDs — must belong to filePath. `fromNames` is
  // deduped via `Set` above, so splitting it into `IN`-list-sized chunks
  // (`chunkValuesForSqlite`, graph/sqliteBatch.ts — 1 bound parameter per
  // name) and merging the results cannot introduce duplicate-name collisions:
  // each name appears in exactly one chunk, so `fromMap` ends up identical to
  // what the single unbatched query would have produced. A whale file's
  // unique symbol-name list can sit close to the 32,766 parameter ceiling
  // (§ Stage 4.5 S1's class survey site 8), so this stays correct at any size.
  const fromRows: { id: number; name: string }[] = [];
  for (const nameBatch of chunkValuesForSqlite(fromNames)) {
    const rows = await db
      .selectFrom('symbols as s')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select(['s.id', 's.name'])
      .where('s.name', 'in', nameBatch)
      .where('f.path', '=', filePath)
      .execute();
    fromRows.push(...rows);
  }
  const fromMap = new Map(fromRows.map((r) => [r.name, r.id]));

  // Structural edges (IMPLEMENTS/EXTENDS/PARENT_OF) carry no file evidence at
  // all — batch-resolve them exactly as before. POTENTIAL_CALL edges are
  // resolved separately below, file-scoped per §10.3.1's resolution rules.
  // RE_EXPORTS edges DO carry file evidence (`toResolvedPath`, Task 0) and are
  // also resolved separately below — they must NOT fall into this bare-name
  // batch, which is exactly the sibling false-green this fix closes.
  const structuralEdges = edges.filter((e) => e.edgeType !== 'POTENTIAL_CALL' && e.edgeType !== 'RE_EXPORTS');
  const structuralToNames = [...new Set(structuralEdges.map((e) => e.toName))];
  // Same `IN`-list batching as `fromNames` above. Unlike `fromMap`,
  // `structuralToMap` dedups on a real ambiguity — the SAME name can be
  // declared in multiple files, so more than one row can come back for one
  // `toName` even within a single query, and "first row wins" picks among
  // them. `structuralToNames` is deduped (`Set`), so each name lands in
  // exactly ONE batch; the dedup loop below therefore sees each name's
  // candidate rows in the same relative order a single unbatched query would
  // have returned them, batch-by-batch, preserving `if (!has(name))`'s
  // first-row-wins semantics exactly.
  const structuralToMap = new Map<string, number>();
  if (structuralToNames.length > 0) {
    for (const nameBatch of chunkValuesForSqlite(structuralToNames)) {
      const rows = await db
        .selectFrom('symbols')
        .select(['id', 'name'])
        .where('name', 'in', nameBatch)
        .where('kind', '!=', 'export')
        .execute();
      for (const row of rows) {
        if (!structuralToMap.has(row.name)) structuralToMap.set(row.name, row.id);
      }
    }
  }

  // POTENTIAL_CALL edges: resolve each unique (toName) once, file-scoped by
  // the resolution rule's own evidence (§10.3.1). A bare name has a single
  // deterministic resolution per file (LocalTypeEnvironment's "first
  // recorded wins" seeding — import beats same-file, and receiver bindings
  // are keyed by receiver, not by callee name), so it is safe to resolve
  // once per toName rather than once per edge.
  const callEdgesByToName = new Map<string, EdgeRecord>();
  for (const e of edges) {
    if (e.edgeType === 'POTENTIAL_CALL' && !callEdgesByToName.has(e.toName)) {
      callEdgesByToName.set(e.toName, e);
    }
  }

  const callToMap = new Map<string, number>();
  if (callEdgesByToName.size > 0) {
    const fromFile = await db.selectFrom('files').select('id').where('path', '=', filePath).executeTakeFirst();
    // No `files` row for the calling file is an invariant violation (pass 1
    // always inserts it before pass 2 runs edges) — fromMap would be empty
    // too in that case, so every edge is dropped downstream regardless.
    if (fromFile !== undefined) {
      for (const [toName, edge] of callEdgesByToName) {
        const targetId = await resolveCallTarget(db, fromFile.id, edge.resolution, toName);
        if (targetId !== null) callToMap.set(toName, targetId);
      }
    }
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

  const edgeValues = edges.flatMap((edge) => {
    const from_id = fromMap.get(edge.fromName);
    if (from_id === undefined) return [];
    const to_id = edge.edgeType === 'POTENTIAL_CALL'
      ? callToMap.get(edge.toName)
      : edge.edgeType === 'RE_EXPORTS'
        ? reExportToMap.get(reExportKey(edge))
        : structuralToMap.get(edge.toName);
    if (to_id === undefined) return [];
    return [{
      from_id,
      to_id,
      edge_type: edge.edgeType,
      resolution: edge.resolution ?? null,
      call_line: edge.callLine ?? null,
      context: edge.context ?? null,
    }];
  });

  if (edgeValues.length === 0) return;

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
  resolution: CallerResolution | undefined,
  toName: string,
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
      return resolveSameFileScoped(db, fromFileId, toName);

    case 'import': {
      const lookup = await importResolvedPathFor(db, fromFileId, toName);
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
      // that file (or its re-export chain). Falls back to a global
      // bare-name match when `typeName` has no file evidence at all (a
      // known, narrow coverage gap — MAST_SPEC §10.3.1).
      return resolveQualifiedNameScoped(db, fromFileId, toName, legacyGlobalFirstMatch);

    // F4: `super.foo()` — toName is `ParentName.methodName`, traced exactly
    // like a field_type receiver's type (import first, then same-file
    // declaration). Unlike field_type/parameter_type/new_expression, an
    // unresolvable parent name produces NO edge rather than a global
    // bare-name guess: `emitClassEdges` only seeds this binding when a real
    // `extends` clause named a parent, so "no file evidence for the parent"
    // here means the parent is an ambient/global/unresolvable type, not a
    // missing binding — and a wrong "verified" super-call edge would poison
    // `verified_callers`' safe-to-act-on contract more than a missing one.
    case 'super_method':
      return resolveQualifiedNameScoped(db, fromFileId, toName, async () => null);

    default:
      // A POTENTIAL_CALL edge always carries a resolution (`emitCallEdges`
      // sets it from `LocalTypeEnvironment.resolveCall`'s result); this
      // branch only guards an unexpected shape defensively.
      return legacyGlobalFirstMatch(db, toName);
  }
}

/**
 * The call target must be declared in exactly `fromFileId` — the file
 * itself is the evidence, no lookup needed to establish it. Shared by
 * `same_file` (bare name) and F4's `this_method` (qualified
 * `ClassName.methodName` name) — both resolve identically once the toName
 * is fixed, since the enclosing class is always declared in the same file
 * as the `this`-call site that names it.
 */
async function resolveSameFileScoped(db: Db, fromFileId: number, toName: string): Promise<number | null> {
  const row = await db
    .selectFrom('symbols')
    .select('id')
    .where('name', '=', toName)
    .where('file_id', '=', fromFileId)
    .where('kind', '!=', 'export')
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Resolve a `TypeName.methodName` toName using the receiver type's own file
 * evidence: `typeName` against this file's own imports first, then its
 * same-file declarations, following the re-export chain into a barrel when
 * needed (§10.3.1). `onUnresolved` is invoked only when NEITHER source names
 * `typeName` at all — callers choose whether that falls back to a global
 * bare-name match (the historical field_type/parameter_type/new_expression
 * behaviour) or drops the edge (super_method, which has no legacy fallback
 * to preserve).
 */
async function resolveQualifiedNameScoped(
  db: Db,
  fromFileId: number,
  toName: string,
  onUnresolved: (db: Db, toName: string) => Promise<number | null>,
): Promise<number | null> {
  const dot = toName.indexOf('.');
  const typeName = dot === -1 ? toName : toName.slice(0, dot);

  const lookup = await importResolvedPathFor(db, fromFileId, typeName);
  if (lookup !== null) {
    if (lookup.resolvedPath === null) return null; // imported but unresolved — no edge
    return resolveInFileOrReExportChain(db, lookup.resolvedPath, toName);
  }

  const sameFileType = await db
    .selectFrom('symbols')
    .select('id')
    .where('name', '=', typeName)
    .where('file_id', '=', fromFileId)
    .where('kind', '!=', 'export')
    .executeTakeFirst();
  if (sameFileType !== undefined) {
    return resolveSameFileScoped(db, fromFileId, toName);
  }

  // Neither an import nor a same-file declaration names `typeName` — e.g. a
  // default/namespace import (not tracked as a named import, see
  // `extractEdges`' `importedNames` collection) or an ambient/global type.
  // No file evidence exists to scope this edge.
  return onUnresolved(db, toName);
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
async function importResolvedPathFor(
  db: Db,
  fromFileId: number,
  name: string,
): Promise<{ resolvedPath: string | null } | null> {
  const rows = await db
    .selectFrom('imports')
    .select(['symbols', 'resolved_path'])
    .where('file_id', '=', fromFileId)
    .execute();

  for (const row of rows) {
    let importedSymbols: string[];
    try {
      importedSymbols = JSON.parse(row.symbols) as string[];
    } catch {
      continue; // malformed row — treat as not naming `name`
    }
    if (importedSymbols.includes(name)) return { resolvedPath: row.resolved_path };
  }
  return null;
}

/**
 * Resolve `toName` within `resolvedPath`, following the barrel re-export
 * machinery (§6.3) when the resolved file doesn't declare it directly:
 * a named re-export leaves an `export`-kind marker symbol with a RE_EXPORTS
 * edge to the real declaration; a star re-export (`export * from`) leaves a
 * `re_export_files` row. Both are walked before giving up.
 */
async function resolveInFileOrReExportChain(
  db: Db,
  resolvedPath: string,
  toName: string,
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

  const direct = await db
    .selectFrom('symbols')
    .select('id')
    .where('name', '=', toName)
    .where('file_id', '=', targetFile.id)
    .where('kind', '!=', 'export')
    .executeTakeFirst();
  if (direct !== undefined) return direct.id;

  // Named re-export: a marker symbol (kind 'export') anchors a RE_EXPORTS
  // edge to the real declaration (§10.1).
  const marker = await db
    .selectFrom('symbols')
    .select('id')
    .where('name', '=', toName)
    .where('file_id', '=', targetFile.id)
    .where('kind', '=', 'export')
    .executeTakeFirst();
  if (marker !== undefined) {
    const declared = await followReExportEdgeChain(db, marker.id);
    if (declared !== null) return declared;
  }

  // Star re-export: no per-symbol marker exists, only a file-level
  // `re_export_files` row (§10.3). Walk the chain forward to the file that
  // actually declares `toName` — the recursive CTE from MAST_SPEC §6.3.
  return resolveThroughStarChain(db, targetFile.id, toName);
}

/** Bounded hop count for chained named re-exports (barrel re-exporting a barrel). */
const MAX_RE_EXPORT_HOPS = 5;

/** Follow RE_EXPORTS edges from a marker symbol to the real (non-marker) declaration. */
async function followReExportEdgeChain(db: Db, markerId: number): Promise<number | null> {
  let currentId = markerId;
  for (let hop = 0; hop < MAX_RE_EXPORT_HOPS; hop++) {
    const edge = await db
      .selectFrom('edges')
      .select('to_id')
      .where('from_id', '=', currentId)
      .where('edge_type', '=', 'RE_EXPORTS')
      .executeTakeFirst();
    if (edge === undefined) return null;

    const target = await db
      .selectFrom('symbols')
      .select(['id', 'kind'])
      .where('id', '=', edge.to_id)
      .executeTakeFirst();
    if (target === undefined) return null;
    if (target.kind !== 'export') return target.id;
    currentId = target.id;
  }
  return null;
}

/**
 * Walk `re_export_files` forward from `startFileId` (a barrel doing
 * `export * from '...'`) to find the file that actually declares `toName`.
 * Mirrors the `re_export_chain` recursive CTE documented in MAST_SPEC §6.3.
 */
async function resolveThroughStarChain(db: Db, startFileId: number, toName: string): Promise<number | null> {
  const row = await db
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
    .select('s.id')
    .where('s.name', '=', toName)
    .where('s.kind', '!=', 'export')
    .orderBy('s.file_id', 'asc')
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Pre-fix behaviour: match `toName` against any indexed symbol, first match
 * wins (excluding re-export markers). Only reached when a resolution rule
 * has no file evidence available at all (see `resolveCallTarget`'s
 * `field_type`/`parameter_type`/`new_expression` default-import/ambient-type
 * fallback) — a known, documented coverage gap, not a silent regression.
 */
async function legacyGlobalFirstMatch(db: Db, toName: string): Promise<number | null> {
  const row = await db
    .selectFrom('symbols')
    .select('id')
    .where('name', '=', toName)
    .where('kind', '!=', 'export')
    .executeTakeFirst();
  return row?.id ?? null;
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

  for (const star of stars) {
    if (star.resolvedPath === null) continue;
    // resolved_path may lack an extension — the prefix range matches `x.ts`,
    // `x/index.ts`, etc. (same convention as resolveTypeContext, §13.7).
    const target = await db
      .selectFrom('files')
      .select('id')
      .where('path', '>=', star.resolvedPath)
      .where('path', '<', pathPrefixUpperBound(star.resolvedPath))
      .orderBy('path', 'asc')
      .executeTakeFirst();
    if (target === undefined || target.id === fromFile.id) continue;

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

      await trx.deleteFrom('chunks').where('file_path', '=', filePath).execute();
      await trx.deleteFrom('chunk_fts').where('file_path', '=', filePath).execute();
      await trx.deleteFrom('identifier_fts').where('file_path', '=', filePath).execute();
    }
    await trx.deleteFrom('files').where('path', 'in', deletedPaths).execute();
    return chunksRemoved;
  });
}
