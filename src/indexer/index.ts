import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../store/config.js';
import { CURRENT_SCHEMA_VERSION } from '../store/config.js';
import { initLockMarkers, withLock } from '../store/lock.js';
import type { LockMetricsSink } from '../store/lockMetrics.js';
import { SqliteChunkStore, type ChunkStore } from '../store/sqliteChunkStore.js';
import { openDatabase } from '../graph/db.js';
import { populateFile, insertEdges, insertReExportFiles, removeDeletedFiles } from '../graph/populate.js';
import { extractFile } from '../ast/extract.js';
import { walkProject, buildManifest, diffManifest, type FileEntry } from './walker.js';
import type { IndexMeta, FreshnessCause } from '../ast/types.js';

export interface IndexResult {
  readonly filesIndexed: number;
  readonly filesSkipped: number;
  readonly chunksAdded: number;
  readonly chunksRemoved: number;
  readonly parseErrors: number;
  /**
   * Files whose chunk-store write failed. Distinct from `parseErrors` — the
   * file parsed fine but its chunks/symbols/edges/imports/FTS rows were never
   * written (GITNEXUS_COMPARISON.md §15.3 item 3: a storage failure must
   * never be counted as a parse failure).
   */
  readonly writeErrors: number;
  /**
   * Files whose write was refused by `populateFile`'s monotonic write-guard
   * (F12) because the stored row already carried a NEWER mtime than this
   * run's parse — an older-stamped write losing a race against a fresher one
   * (typically a concurrent JIT refresh, `mcp/staleness.ts`). The DB is
   * correct in this case; this counter exists only so the rejection is
   * visible instead of silently indistinguishable from an ordinary write
   * (mirrors `writeErrors`'s precedent).
   */
  readonly staleWriteRejections: number;
  readonly durationMs: number;
  /**
   * Cumulative wall-clock per phase, in ms. The phases tile the run: their sum is
   * `durationMs` less a small unattributed remainder.
   *
   * The remainder is `db.destroy()` and the return — NOT `openDatabase`, which runs before
   * the `walk` stamp and is therefore inside `walk` (and inside the calibration constant
   * `c`, per A4-C1). This matters because `db.destroy()` closes the last connection, which
   * triggers WAL's close-time checkpoint: the one size-coupled cost outside every phase.
   * E1-PHASE reports the remainder as its own series rather than treating it as slack.
   *
   * Exists because E1 measured a growth exponent of ~1.75 on the nested ladder — ~1.90
   * over its upper half — from `durationMs` alone, which localises the cost to the run and
   * no further. The candidate mechanisms are distinguishable only by phase: a page-cache
   * cliff loads `write` while `parse` stays linear; call/symbol resolution loads `edges`;
   * FTS5 segment-merge cost loads `write` but scales with chunks rather than with database
   * size. Reported so a scaling run can discriminate them instead of guessing.
   *
   * `write` and `edges` include the time spent waiting for `structure.lock`, which is
   * correct for a scaling measurement (a cold build contends with nothing) but must not be
   * read as pure I/O under concurrency.
   */
  readonly phaseMs: {
    /** Project walk and manifest diff — everything before the first parse batch. */
    readonly walk: number;
    /** Pass 1, unlocked: tree-sitter extraction. Expected to be linear in bytes. */
    readonly parse: number;
    /** Pass 1, locked: `populateFile` — chunks + symbols + imports + FTS, per file. */
    readonly write: number;
    /** Pass 2, locked: edge and star-re-export insertion once every symbol row exists. */
    readonly edges: number;
    /** Final phase: re-stat, manifest write, `index.json`. */
    readonly finalise: number;
  };
}

export interface IndexOptions {
  /** When true, only reindex files whose mtime changed since the last run. */
  readonly incremental: boolean;
  /** Called after each file is processed (parse phase) with running and total counts. */
  readonly onProgress?: (processed: number, total: number) => void;
  /**
   * Test-only injection point (§4.4 DI): a fake `ChunkStore` used for chunk
   * reads (`isFileUnchanged`, the final `chunkCount()`) and, via
   * `populateFile`'s `chunkWriter` param, for the per-file chunk WRITE too —
   * see `graph/populate.ts`'s `ChunkWriter` docstring for why a rejection
   * from the override still rolls back the whole per-file transaction.
   * Lets write-failure tests (`indexer/__tests__/write-failures.test.ts`)
   * exercise write-failure handling without a real SQLite backend. `runIndex`
   * never destroys an injected override — the caller owns its lifecycle.
   */
  readonly chunkStoreOverride?: ChunkStore;
  /**
   * Test-only injection point (§4.4 DI): overrides the per-file extraction
   * step used in the parse phase. Lets tests simulate a slow parse (e.g. to
   * create a deterministic multi-batch window for exercising the per-batch
   * `structure.lock` scope — F1, GITNEXUS_COMPARISON.md §13.2) without
   * sleeping the whole test suite. Defaults to the real `extractFile`.
   */
  readonly extractFileFn?: typeof extractFile;
  /**
   * Test-only injection point (§4.4 DI): routes this run's `structure.lock`
   * acquire/release events to a fake sink instead of the default
   * `<stateDir>/lock-metrics.jsonl` file (store/lockMetrics.ts), so tests can
   * assert on lock-hold count/duration structurally without touching the
   * filesystem. Production call sites omit this and get the default sink.
   */
  readonly lockMetricsSink?: LockMetricsSink;
}

/**
 * Fresh best-effort mtime read (seconds), used wherever a value written to
 * `files.mtime` or `file_manifest.json` must reflect disk state as observed
 * at READ time rather than at walk time (F1/F12 — see the WHY-comments in
 * {@link runIndex} for why the two can diverge once `structure.lock` no
 * longer spans the whole run). Two call sites, two different reasons: the
 * parse loop calls this IMMEDIATELY BEFORE `doExtract` so the stamp can never
 * be newer than the content it accompanies (F12 invariant 1); the final
 * manifest phase calls this with no accompanying content read at all, purely
 * for `file_manifest.json` bookkeeping (see invariant 1's note on why that
 * one doesn't need the same fix). Falls back to `fallbackSeconds` if the file
 * has vanished since it was walked — mirrors `walkProject`'s own
 * best-effort disappearance handling (walker.ts:63-65).
 */
function statMtimeSecondsOrFallback(absPath: string, fallbackSeconds: number): number {
  try {
    return statSync(absPath).mtimeMs / 1_000;
  } catch {
    return fallbackSeconds;
  }
}

/**
 * Walk the project, parse changed files into chunks, populate the graph
 * database and FTS indexes.
 *
 * F1 (GITNEXUS_COMPARISON.md §13.2, MAST_SPEC.md:822-826): `structure.lock`
 * is acquired and released separately for each write phase — deleted-file
 * cleanup, each `LANCE_BATCH`-sized write batch, each edge-insertion batch,
 * and the final manifest/index.json write — instead of once for the whole
 * run. The read-only walk and the CPU-bound parse phase never hold the lock
 * at all. Before this change the lock was held for the run's full duration
 * (measured max: 280,782 ms on a 1,335-file corpus — eval/baseline-locks.json),
 * which starved the JIT re-parse path (mcp/staleness.ts:56, 3 retries x
 * 100 ms) for minutes at a time — directly contradicting MAST_SPEC.md:822-826
 * ("lock holding is per-file-parse (10-50ms), not per-tool-call").
 *
 * Narrowing the lock's scope means a JIT re-parse can now interleave BETWEEN
 * phases of an in-flight run. Two invariants keep that safe:
 *
 * 1. **[F12, `GITNEXUS_COMPARISON.md` Stage 1]** The row's stamped mtime must
 *    never be NEWER than the content it is stamped against — i.e.
 *    `stamp <= mtime-at-content-read`. This is an ORDERING property, not a
 *    mutual-exclusion one: no lock can enforce it, because a file's editor
 *    never takes `structure.lock`. An earlier version of this invariant
 *    re-stat'd each file AFTER `doExtract` (inside the locked write phase) to
 *    stop `files.mtime` *regressing* below `entry.mtime` — but that opened
 *    the real hazard: an edit landing in the (unlocked, seconds-wide under
 *    §15.2's FTS growth) parse-to-write window would be stamped with a mtime
 *    NEWER than the content that was actually parsed, permanently disarming
 *    staleness detection for that file (`diskMtime <= storedMtime` reads
 *    "fresh" forever — the exact P0 class this stage exists to eliminate).
 *    The fix stats each file IMMEDIATELY BEFORE `doExtract`, in the parse
 *    loop below (unlocked, same as `mcp/staleness.ts`'s JIT path, which has
 *    always done this correctly), and carries that pre-parse stamp through to
 *    the write untouched — no re-stat at write time. A post-stat edit then
 *    leaves stamp < content, so staleness re-fires on the next check and the
 *    system self-heals, the same property the JIT path already had.
 * 2. **Monotonic write-guard, `graph/populate.ts`'s `populateFile`**: even
 *    with (1), two writers (e.g. this run's batch write and a concurrent JIT
 *    refresh of the same file) can still race to write the SAME row with
 *    DIFFERENT stamps, and `structure.lock` only serializes the two writes —
 *    it does not guarantee the one with the fresher stamp wins. `populateFile`
 *    refuses to replace a row whose stored mtime already exceeds the incoming
 *    stamp, so whichever write carries the NEWER stamp wins regardless of
 *    which one reaches the lock first — fixing the reindex-vs-JIT race
 *    *better* than the lock alone does (the lock only serializes; the guard
 *    orders).
 *
 * Known limitation (not solved here): mtime-granularity blindness. An edit
 * landing in the SAME mtime tick as the stamp compares equal, not greater,
 * and reads as fresh (the git racy-lstat problem). Near-moot on APFS's
 * nanosecond-resolution mtimes; real on coarse-mtime volumes (e.g. some
 * shared/network filesystems), which is exactly the container-deployment
 * case MAST_SPEC.md §7.6 targets. Solving it properly means content hashing,
 * not mtime comparison, and is out of scope for F12.
 *
 * `file_manifest.json` (which drives the NEXT run's incremental diff, see
 * `diffManifest`) is rebuilt from a fresh re-stat of every file under the
 * FINAL lock acquisition (below), not from the run-start walk snapshot or
 * from the parse-phase stamps above. This one does NOT need invariant 1's
 * fix: it is a stat with no accompanying content read in this final phase, so
 * there is no stamp/content pair to invert. If it ever disagrees with
 * `files.mtime` for a file JIT touched concurrently, that disagreement
 * self-heals on the next JIT check (`checkAndRefreshIfStale` compares disk
 * mtime, not the manifest, against `files.mtime`) — the manifest only feeds
 * the NEXT run's `diffManifest`, and a stale manifest entry there causes an
 * extra, harmless re-parse, never a missed one.
 *
 * The two-pass edge-insertion structure (`insertEdges` needs every file's
 * symbols already present) is preserved: ALL pass-1 batches — across the
 * whole run, not just the current batch — complete before pass 2 starts, so
 * cross-file edge targets are always resolvable regardless of how finely
 * pass 1's own lock acquisitions are chunked.
 */
export async function runIndex(
  config: ResolvedConfig,
  options: IndexOptions,
): Promise<IndexResult> {
  const startMs = Date.now();
  // initLockMarkers is idempotent — safe to call on every run so that
  // `mast index` works even without a prior `mast init`.
  initLockMarkers(config.resolved_state_dir);

  const lockOptions = {
    maxRetries: 5,
    retryIntervalMs: 1_000,
    caller: 'index-run',
    sink: options.lockMetricsSink,
  };
  const doExtract = options.extractFileFn ?? extractFile;

  // Opening the db handle is connection setup, not a graph/chunk-store
  // mutation — no lock needed.
  const db = openDatabase(config.resolved_state_dir);

  // M1 (eval/GITNEXUS_COMPARISON.md §15.1): chunks live in graph.db's
  // `chunks` table by default — `SqliteChunkStore` wraps the same `db`
  // connection every write below already uses. `chunkStoreOverride` (test
  // DI, §4.4) substitutes a fake for write-failure tests; see its docstring
  // on `IndexOptions` and `graph/populate.ts`'s `ChunkWriter`.
  const chunkStore: ChunkStore = options.chunkStoreOverride ?? new SqliteChunkStore(db);
  const chunkWriter = options.chunkStoreOverride
    ? options.chunkStoreOverride.replaceChunksForFile.bind(options.chunkStoreOverride)
    : undefined;

  // Load previous manifest for incremental comparison.
  const manifestPath = join(config.resolved_state_dir, 'file_manifest.json');
  const prevManifest: Record<string, number> = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, number>)
    : {};

  const currentFiles = await walkProject(config);
  const { stale, added, deleted } = diffManifest(currentFiles, prevManifest);

  let chunksRemoved = 0;

  // Deleted-file cleanup — cascade removes symbols/edges/imports/chunks from
  // the graph (one transaction, `removeDeletedFiles`). Its own short lock
  // acquisition, separate from pass 1's per-batch locks.
  await withLock(config.resolved_state_dir, 'structure', lockOptions, async () => {
    chunksRemoved += await removeDeletedFiles(db, deleted);

    // Full reindex: also purge DB entries for files no longer in the current
    // walk (e.g. dist/ files left over from a previous indexing configuration
    // that predates the current exclude_patterns). These are invisible to the
    // manifest-diff above because they were never written to file_manifest.json
    // under the current config.
    if (!options.incremental) {
      const currentPaths = new Set(currentFiles.map((e) => e.relativePath));
      const dbRows = await db.selectFrom('files').select('path').execute();
      const orphans = dbRows.map((r) => r.path).filter((p) => !currentPaths.has(p));
      if (orphans.length > 0) {
        chunksRemoved += await removeDeletedFiles(db, orphans);
      }
    }
  });

  const toIndex = options.incremental ? [...stale, ...added] : currentFiles;

  let filesIndexed = 0;
  let parseErrors = 0;
  let writeErrors = 0;
  let staleWriteRejections = 0;
  let chunksAdded = 0;
  let filesStable = 0;

  // Pass 1: parse, then write (chunks + graph + FTS together via
  // populateFile), processed in batches so a batch's worth of parse results
  // doesn't sit in memory indefinitely. SQLite writes are sequential —
  // better-sqlite3 serialises internally, and M1 (§15.1) removed the
  // separate concurrent chunk-store write phase that existed only because
  // the spike's chunk store was a different file/connection from graph.db.
  // F1: `structure.lock` now wraps only the write half of each batch (below),
  // not the parse phase and not the whole loop — see the runIndex WHY-comment.
  const LANCE_BATCH = 16;
  type ParsedItem = { entry: FileEntry; result: ReturnType<typeof extractFile>; mtime: number };
  const edgeDataByFile = new Map<string, ReturnType<typeof extractFile>>();

  // Phase accumulators. Summed across batches rather than sampled, because the parse/write
  // interleave runs once per 16-file batch and a single stamp would capture only one of them.
  const phase = { walk: 0, parse: 0, write: 0, edges: 0, finalise: 0 };
  // Everything from `startMs` to here is the walk and manifest diff.
  phase.walk = Date.now() - startMs;

  for (let i = 0; i < toIndex.length; i += LANCE_BATCH) {
    const batch = toIndex.slice(i, i + LANCE_BATCH);
    const batchParseStart = Date.now();

    // Parse phase — synchronous tree-sitter, cannot be parallelised without
    // workers, and does not touch the graph db / chunk store, so it runs
    // UNLOCKED. This is exactly the window in which a concurrent JIT
    // re-parse of a not-yet-reached file can acquire structure.lock.
    const parsed: ParsedItem[] = [];
    for (const entry of batch) {
      try {
        // F12: stat IMMEDIATELY BEFORE doExtract, not after — mirrors
        // mcp/staleness.ts's JIT path (which has always stat'd before
        // parsing). This is invariant 1 from the runIndex WHY-comment:
        // `stamp <= mtime-at-content-read`. Stat'ing AFTER doExtract (the
        // prior ordering) let a concurrent edit land in between, stamping
        // this row with a mtime NEWER than the content that was actually
        // parsed — permanently disarming staleness detection for the file
        // (F12), and no lock can fix that ordering because editors never
        // take structure.lock.
        const preParseMtime = statMtimeSecondsOrFallback(entry.path, entry.mtime);
        const result = doExtract(entry.path, config.resolved_project_root, config.context_lines, config.chunk_split_threshold, config.markdown_heading_depth);
        // §7.1 stability skip: a file whose mtime changed but whose chunked
        // content is identical (e.g. `git checkout` rewriting the same bytes)
        // is re-parsed but need not be re-written. Incremental only; the
        // check is conservative and bails to a full rewrite on any doubt.
        if (options.incremental && await isFileUnchanged(db, chunkStore, entry.relativePath, result)) {
          filesStable++;
        } else {
          parsed.push({ entry, result, mtime: preParseMtime });
          chunksAdded += result.chunks.length;
          filesIndexed++;
        }
      } catch (err) {
        process.stderr.write(`[mast] WARN: parse error in ${entry.path}: ${String(err)}\n`);
        parseErrors++;
      }
      options.onProgress?.(filesIndexed + filesStable + parseErrors, toIndex.length);
    }

    phase.parse += Date.now() - batchParseStart;
    const batchWriteStart = Date.now();

    // Write phase — LOCKED, scoped to this batch only (F1). Bounds how long
    // any caller (including a concurrent JIT re-parse) can be starved to
    // roughly one batch's writes, not the whole run.
    await withLock(config.resolved_state_dir, 'structure', lockOptions, async () => {
      // populateFile now writes chunks + symbols + edges + imports + FTS in
      // ONE per-file transaction (M1, §15.1) — a failure anywhere in it rolls
      // back everything for that file, so there is no separate "chunk store
      // write" step to run before this loop any more.
      //
      // A write failure is counted as `writeErrors`, NEVER `parseErrors` — the
      // file parsed correctly; only its storage failed. Conflating the two
      // (the original defect, GITNEXUS_COMPARISON.md §15.3 item 3) hid a
      // storage failure behind a "parse error" label, which is the wrong
      // diagnosis for anyone debugging it. Logged at ERROR (not WARN): the
      // file's chunks/symbols/edges/imports/FTS rows are skipped entirely —
      // this is not a soft warning.
      //
      // Deliberately NOT aborted and NOT quarantined per-chunk: one
      // pathological file must not turn a monorepo index into a total outage,
      // and partial-chunk recovery is out of scope for this fix. The file
      // still fails to index — it just fails loudly and is correctly
      // classified, instead of silently amputating the file under a WARN and
      // a miscounted `parseErrors`.
      for (const { entry, result, mtime } of parsed) {
        // `mtime` is the PRE-parse stamp captured in the parse loop above
        // (F12 invariant 1) — carried through untouched, NOT re-stat'd here.
        // Re-statting at this point (the prior ordering) is exactly the bug:
        // it reads disk state AFTER doExtract already read the content, so a
        // concurrent edit landing in between gets stamped as newer-than-content.
        try {
          const { chunksRemoved: removed, written } = await populateFile(db, {
            filePath: entry.relativePath,
            language: result.language,
            mtime,
            chunks: result.chunks,
            imports: result.imports,
            symbols: result.symbols,
            identifierRows: result.identifierRows,
          }, chunkWriter);
          if (!written) {
            // Monotonic write-guard (F12 invariant 2, graph/populate.ts)
            // rejected this write: some other writer — a concurrent JIT
            // refresh, or a later batch in this same run reprocessing the
            // file — already stamped a NEWER mtime. The DB row is already at
            // least as fresh as what this parse would have written, so this
            // is correct behaviour, not a failure, but it must stay visible
            // rather than look like an ordinary successful write (the
            // `writeErrors` precedent).
            staleWriteRejections++;
            continue;
          }
          chunksRemoved += removed;
        } catch (err) {
          process.stderr.write(`[mast] ERROR: chunk store write failed for ${entry.path} — file will be absent from the index: ${String(err)}\n`);
          writeErrors++;
          continue;
        }
        edgeDataByFile.set(entry.relativePath, result);
      }
    });
    phase.write += Date.now() - batchWriteStart;
  }

  // Pass 2: insert edges and star re-export rows now that all files' symbols
  // and file rows exist (both may reference files indexed later in pass 1).
  // Batched the same way as pass 1 and for the same reason (F1) — each batch
  // gets its own short lock instead of one lock spanning every file's edges.
  // Safe because ALL of pass 1 (every batch above) has already completed by
  // the time this loop starts, so every cross-file edge target this run
  // could produce already exists, independent of how pass 2's own lock
  // acquisitions are chunked.
  const edgeEntries = [...edgeDataByFile];
  const edgesStart = Date.now();
  for (let i = 0; i < edgeEntries.length; i += LANCE_BATCH) {
    const batch = edgeEntries.slice(i, i + LANCE_BATCH);
    await withLock(config.resolved_state_dir, 'structure', lockOptions, async () => {
      for (const [filePath, data] of batch) {
        await insertEdges(db, filePath, data.edges);
        await insertReExportFiles(db, filePath, data.starReExports);
      }
    });
  }

  phase.edges = Date.now() - edgesStart;
  const finaliseStart = Date.now();

  // Final phase — manifest + index.json, under one more short lock. See
  // invariant 2 in the runIndex WHY-comment for why this re-stats every file
  // instead of reusing `currentFiles`' run-start walk snapshot, and why it
  // needs the lock at all (to not race a JIT write that is already in flight).
  await withLock(config.resolved_state_dir, 'structure', lockOptions, async () => {
    const freshEntries: FileEntry[] = currentFiles.map((entry) => ({
      ...entry,
      mtime: statMtimeSecondsOrFallback(entry.path, entry.mtime),
    }));
    const newManifest = buildManifest(freshEntries);
    writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2));

    const chunkCount = await chunkStore.chunkCount();
    const meta: IndexMeta = {
      schema_version: CURRENT_SCHEMA_VERSION,
      last_indexed: new Date().toISOString(),
      file_count: currentFiles.length,
      chunk_count: chunkCount,
      parse_errors: parseErrors > 0 ? parseErrors : undefined,
      write_errors: writeErrors > 0 ? writeErrors : undefined,
    };
    writeFileSync(
      join(config.resolved_state_dir, 'index.json'),
      JSON.stringify(meta, null, 2),
    );
  });

  phase.finalise = Date.now() - finaliseStart;

  await db.destroy();
  // SqliteChunkStore (default path) wraps this same `db` connection (§15.1) —
  // no separate handle to close. `chunkStoreOverride`, when supplied, is
  // owned by the caller regardless.

  return {
    // Files skipped = never-parsed (mtime unchanged) + parsed-but-stable.
    filesIndexed,
    filesSkipped: currentFiles.length - toIndex.length + filesStable,
    chunksAdded,
    chunksRemoved,
    parseErrors,
    writeErrors,
    staleWriteRejections,
    durationMs: Date.now() - startMs,
    phaseMs: phase,
  };
}

/**
 * True when `result` is byte-for-byte equivalent to what is already stored for
 * `filePath`, so re-writing it would be redundant (§7.1). Conservative:
 *
 *  - bails (returns false) if the file has any `block` chunk, whose content is
 *    not captured by a symbol hash and so cannot be verified here;
 *  - requires the exact same set of chunk ids (catches additions, removals, and
 *    declarations that moved to a different line);
 *  - requires every symbol's declaration_hash AND body_hash to match the stored
 *    symbol of the same name+line.
 *
 * Any mismatch — or any uncertainty — falls through to a full rewrite.
 */
async function isFileUnchanged(
  db: ReturnType<typeof openDatabase>,
  chunkStore: ChunkStore,
  filePath: string,
  result: ReturnType<typeof extractFile>,
): Promise<boolean> {
  // `block` chunks carry no symbol hash, and `doc` chunks carry no symbols at
  // all — neither can be content-verified here, so both bail to a full rewrite.
  if (result.chunks.some((c) => c.chunk_type === 'block' || c.chunk_type === 'doc')) return false;

  // Structure: identical set of chunk ids.
  const storedChunks = await chunkStore.getChunksByFilePath(filePath);
  if (storedChunks.length !== result.chunks.length) return false;
  const storedIds = new Set(storedChunks.map((c) => c.chunk_id));
  if (!result.chunks.every((c) => storedIds.has(c.chunk_id))) return false;

  // Content: identical symbol hash signature.
  const storedSymbols = await db
    .selectFrom('symbols as s')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .select(['s.name', 's.line', 's.declaration_hash', 's.body_hash'])
    .where('f.path', '=', filePath)
    .execute();

  return symbolSignature(result.symbols) === symbolSignature(storedSymbols);
}

/** Order-independent signature of a symbol set's identity + stability hashes. */
function symbolSignature(
  symbols: readonly { name: string; line: number; declarationHash?: string | null; declaration_hash?: string | null; bodyHash?: string | null; body_hash?: string | null }[],
): string {
  return symbols
    .map((s) => {
      const decl = s.declarationHash ?? s.declaration_hash ?? '';
      const body = s.bodyHash ?? s.body_hash ?? '';
      return `${s.name}|${s.line}|${decl}|${body}`;
    })
    .sort()
    .join('\n');
}

// ---------------------------------------------------------------------------
// Freshness diagnostics (mast_status, `mast status`)
// ---------------------------------------------------------------------------

/**
 * Derive the `freshness_cause` discriminator (§9 mast_status) from the stale
 * file count. Stage 7.2 (IMPLEMENTATION_PLAN.md "Stage 7: Vector-store
 * deletion") dropped the second parameter this used to take
 * (`pendingEmbeddings`) along with the `'embedding_backlog'`/`'both'` cases —
 * the Phase 2 embedder that could produce a backlog distinct from Phase 1
 * staleness was excised in Stage 7.1, so a two-cause signature asserted a
 * distinction the code could no longer draw.
 */
export function freshnessCause(staleFiles: number): FreshnessCause {
  return staleFiles > 0 ? 'phase1_stale' : null;
}

/**
 * Load `index.json` from the state directory, or return null if absent.
 *
 * Unvalidated cast, not a zod parse — an `index.json` written before Stage
 * 7.2 (IMPLEMENTATION_PLAN.md "Stage 7: Vector-store deletion") may still
 * carry the removed `model` field; it rides along as an untyped extra key
 * and is simply never read, so old files load without error.
 */
export function loadIndexMeta(stateDir: string): IndexMeta | null {
  const metaPath = join(stateDir, 'index.json');
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, 'utf-8')) as IndexMeta;
}

/** Write `index.json` to the state directory. */
export function writeIndexMeta(stateDir: string, meta: IndexMeta): void {
  writeFileSync(join(stateDir, 'index.json'), JSON.stringify(meta, null, 2));
}
