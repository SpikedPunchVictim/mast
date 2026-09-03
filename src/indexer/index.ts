import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { ResolvedConfig } from '../store/config.js';
import { CURRENT_SCHEMA_VERSION } from '../store/config.js';
import { initLockMarkers, withLock } from '../store/lock.js';
import type { LockMetricsSink } from '../store/lockMetrics.js';
import { SqliteChunkStore, type ChunkStore } from '../store/sqliteChunkStore.js';
import { openDatabase, readPragmaValue, type OpenDatabaseOptions } from '../graph/db.js';
import { populateFile, insertEdges, insertReExportFiles, removeDeletedFiles } from '../graph/populate.js';
import type { PopulateFileOptions, WriteSpansMs } from '../graph/populate.js';
import { extractFile } from '../ast/extract.js';
import { walkProject, buildManifest, diffManifest, type FileEntry } from './walker.js';
import { getImportResolver, type MiscasedImportReport } from './import-resolver.js';
import type { IndexMeta, FreshnessCause } from '../ast/types.js';
import type { IndexFreshness } from './freshness.js';

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
  /**
   * Imports that resolved only because the filesystem ignored their casing.
   *
   * A defect in the INDEXED repository rather than in MAST: the specifier is
   * spelled differently from the file on disk, which compiles on APFS/NTFS and
   * fails on a case-sensitive filesystem. MAST resolves such an import to the
   * on-disk path, so the edge is correct either way; this exists so the
   * anomaly is visible rather than silent, on the same reasoning as
   * `staleWriteRejections`.
   */
  readonly miscasedImports: MiscasedImportReport;
  readonly durationMs: number;
  /**
   * The `cache_size` / `mmap_size` actually in force on this run's connection,
   * read back from SQLite itself immediately before the handle is closed.
   *
   * Keyed by the pragma's own names rather than the codebase's camelCase
   * because these are SQLite's values echoed verbatim, not a MAST-side model of
   * them — the whole point is that nothing between the pragma and this field
   * reinterprets anything. `cache_size` is negative when denominated in KiB.
   *
   * Exists so the E1-PHASE mechanism A/B can prove its arms differed. Both
   * pragmas are connection-scoped, so they vanish when the process exits and
   * cannot be recovered from the database file afterwards; if the run does not
   * report them, no later inspection can. Same evidentiary role as Gate 0's
   * `dist` content hash: it establishes WHICH configuration produced a timing,
   * rather than leaving it to be assumed from the command line that was meant
   * to be issued.
   */
  readonly appliedPragmas: {
    readonly cache_size: number;
    readonly mmap_size: number;
  };
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
  /**
   * Per-connection SQLite tuning for this run's `graph.db` handle
   * (`OpenDatabaseOptions`, `graph/db.ts`). Omitted everywhere in product code;
   * it exists so the E1-PHASE mechanism A/B can vary `cache_size` / `mmap_size`
   * between arms without config or environment acting as a hidden lever.
   */
  readonly dbOptions?: OpenDatabaseOptions;
  /**
   * When supplied, every `populateFile` call in this run accumulates its four
   * write regions into this record (`graph/populate.ts`'s {@link WriteSpansMs}).
   *
   * Omitted everywhere in product code. It exists so E1-FTS can decompose the
   * `write` phase that E1-PHASE showed carries the growth exponent; passing
   * nothing means no clock is read at all, so the production path is unchanged.
   */
  readonly writeSpans?: WriteSpansMs;
  /**
   * **Eval-only, and unsafe outside a cold build** — see
   * {@link PopulateFileOptions.skipFtsDeletes} for what it does and why it
   * corrupts an incremental index. E1-FTS's arm G.
   */
  readonly unsafeSkipFtsDeletes?: boolean;
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
  const db = openDatabase(config.resolved_state_dir, options.dbOptions ?? {});

  // M1 (eval/GITNEXUS_COMPARISON.md §15.1): chunks live in graph.db's
  // `chunks` table by default — `SqliteChunkStore` wraps the same `db`
  // connection every write below already uses. `chunkStoreOverride` (test
  // DI, §4.4) substitutes a fake for write-failure tests; see its docstring
  // on `IndexOptions` and `graph/populate.ts`'s `ChunkWriter`.
  const chunkStore: ChunkStore = options.chunkStoreOverride ?? new SqliteChunkStore(db);
  const chunkWriter = options.chunkStoreOverride
    ? options.chunkStoreOverride.replaceChunksForFile.bind(options.chunkStoreOverride)
    : undefined;

  // Built with conditional spreads for the same reason `index-cmd.ts` builds
  // `dbOptions` that way: `exactOptionalPropertyTypes` distinguishes an absent
  // property from one explicitly set to undefined, and the production path
  // depends on `spans` being genuinely absent so `populateFile` never takes a
  // clock reading at all.
  const populateOptions: PopulateFileOptions = {
    ...(chunkWriter !== undefined ? { chunkWriter } : {}),
    ...(options.writeSpans !== undefined ? { spans: options.writeSpans } : {}),
    ...(options.unsafeSkipFtsDeletes === true ? { skipFtsDeletes: true } : {}),
  };

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

  // An incremental run's work set is the manifest diff PLUS any walked file
  // with no `files` row. The manifest alone is not sufficient: a run that
  // failed on a file before 2026-08-20 recorded it as up to date anyway
  // (D034), so the diff reports it unchanged forever and the file never comes
  // back. Without this, `mast_status` would correctly report such an index
  // stale (`measureFreshness` reads the `files` stamps too) and every
  // incremental run would do nothing about it — a state that never converges.
  // On a full run every file is reindexed regardless, so this is scoped to the
  // incremental path and costs one indexed `path` scan.
  let toIndex: FileEntry[];
  if (options.incremental) {
    const queued = new Set([...stale, ...added].map((e) => e.relativePath));
    const indexedPaths = new Set(
      (await db.selectFrom('files').select('path').execute()).map((r) => r.path),
    );
    const neverWritten = currentFiles.filter(
      (e) => !queued.has(e.relativePath) && !indexedPaths.has(e.relativePath),
    );
    toIndex = [...stale, ...added, ...neverWritten];
  } else {
    toIndex = currentFiles;
  }

  let filesIndexed = 0;
  /**
   * Files parsed and queued for a write. NOT `filesIndexed` — a queued file
   * whose write then fails never lands, and conflating the two is what made
   * `files: N indexed` and `files_indexed: N` overstate the index (D038).
   * Kept solely so `onProgress` still advances during the parse phase, which
   * is where the wall-clock is spent on a large batch.
   */
  let filesQueued = 0;
  let parseErrors = 0;
  let writeErrors = 0;
  let staleWriteRejections = 0;
  let chunksAdded = 0;
  let filesStable = 0;
  /**
   * Relative paths this run attempted and did not get into the index — a parse
   * that threw, or a write that failed. They are withheld from the manifest at
   * finalise, so the next run's `diffManifest` sees them as new and retries
   * them. Recording them as up-to-date is what made one transient failure a
   * permanent hole (`docs/defects/LEDGER.md` D034).
   */
  const failedPaths = new Set<string>();

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
          // `filesIndexed` / `chunksAdded` are NOT incremented here. Both are
          // counted in the write loop below, once `populateFile` reports the
          // write actually landed — see D038.
          filesQueued++;
        }
      } catch (err) {
        process.stderr.write(`[mast] WARN: parse error in ${entry.path}: ${String(err)}\n`);
        parseErrors++;
        failedPaths.add(entry.relativePath);
      }
      options.onProgress?.(filesQueued + filesStable + parseErrors, toIndex.length);
    }

    phase.parse += Date.now() - batchParseStart;
    const batchWriteStart = Date.now();
    // E1-FTS `lock` span — see WriteSpansMs.lock. Acquisition is timed from
    // here to the first statement of the callback, release from the callback's
    // last statement to `withLock`'s return; both directly, neither derived.
    const lockAcquireStart = options.writeSpans === undefined ? 0 : performance.now();
    let lockBodyEnd = 0;

    // Write phase — LOCKED, scoped to this batch only (F1). Bounds how long
    // any caller (including a concurrent JIT re-parse) can be starved to
    // roughly one batch's writes, not the whole run.
    await withLock(config.resolved_state_dir, 'structure', lockOptions, async () => {
      if (options.writeSpans !== undefined) {
        options.writeSpans.lock += performance.now() - lockAcquireStart;
      }
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
          }, populateOptions);
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
          // Counted HERE, not in the parse loop: this is the first point at
          // which the file is known to be in the index (D038). A stale-write
          // rejection `continue`s above and a write failure `continue`s below,
          // so neither reaches this line.
          filesIndexed++;
          chunksAdded += result.chunks.length;
        } catch (err) {
          process.stderr.write(`[mast] ERROR: chunk store write failed for ${entry.path} — file will be absent from the index: ${String(err)}\n`);
          writeErrors++;
          failedPaths.add(entry.relativePath);
          continue;
        }
        edgeDataByFile.set(entry.relativePath, result);
      }
      lockBodyEnd = performance.now();
    });
    if (options.writeSpans !== undefined) {
      options.writeSpans.lock += performance.now() - lockBodyEnd;
    }
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
    // Files this run failed on are withheld: a manifest entry asserts "the
    // index reflects this file at this mtime", which is false for them. Leaving
    // the entry out makes the next run see the file as new and retry it, and —
    // because a file with no manifest entry is also what `measureFreshness`
    // counts as unindexed — keeps both status surfaces honest in the meantime.
    // A file that was never attempted (unchanged on an incremental run) is not
    // in `failedPaths` and keeps its entry, as it should.
    const freshEntries: FileEntry[] = currentFiles
      .filter((entry) => !failedPaths.has(entry.relativePath))
      .map((entry) => ({
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

  // Read the tuning pragmas back BEFORE the connection closes — they are
  // connection-scoped state, not file state, and are unrecoverable afterwards.
  const appliedPragmas = {
    cache_size: readPragmaValue(
      'cache_size',
      (await sql<Record<string, unknown>>`PRAGMA cache_size`.execute(db)).rows,
    ),
    mmap_size: readPragmaValue(
      'mmap_size',
      (await sql<Record<string, unknown>>`PRAGMA mmap_size`.execute(db)).rows,
    ),
  };

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
    // Drained, not read: the resolver is cached for the process lifetime and
    // serves every run, so each run must clear what it reported.
    miscasedImports: getImportResolver(config.resolved_project_root).drainMiscased(),
    durationMs: Date.now() - startMs,
    phaseMs: phase,
    appliedPragmas,
  };
}

/**
 * True when `result` is equivalent to what is already stored for `filePath`, so
 * re-writing it would be redundant (§7.1). Conservative:
 *
 *  - bails (returns false) if the file has any `block` chunk, whose content is
 *    not captured by a symbol hash and so cannot be verified here;
 *  - requires the exact same set of chunk ids (catches additions, removals, and
 *    declarations that moved to a different line);
 *  - requires every stored chunk's CONTENT to match byte-for-byte;
 *  - requires every symbol's declaration_hash AND body_hash to match the stored
 *    symbol of the same name+line;
 *  - requires the stored `imports` rows to match module-for-module.
 *
 * Any mismatch — or any uncertainty — falls through to a full rewrite.
 *
 * D030 — WHY THE LAST TWO CHECKS EXIST. This function decides that a write can
 * be skipped, so its equivalence check must cover everything the write covers.
 * It originally compared chunk IDs and symbol hashes only, and neither moves
 * when an edit lands OUTSIDE every symbol body. An `import` statement always
 * does. `populateFile` writes the `imports` table, and a skipped file is also
 * never added to `edgeDataByFile`, so pass 2 never re-resolves its edges —
 * which made an import-only edit invisible in both places at once. It never
 * self-healed: the finalise phase stamps the manifest from a fresh re-stat of
 * EVERY walked file, written or not, so the next run did not see the file as
 * stale either. Measured: after moving a declaration and repointing its
 * importer, `mast index --incremental` reported `0 indexed, 2 skipped`, the
 * `imports` row still read `./alpha.js` after that path had stopped existing,
 * and `mast_callers` returned `verified_callers: []` for a function with a
 * live caller.
 *
 * Chunk IDs deliberately do NOT change on a content edit (`dedupeChunkIds`,
 * ast/extract.ts — `vectorKey` depends on that), so ID equality can never
 * stand in for content equality here.
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

  // Structure: identical set of chunk ids, each carrying identical content.
  // The content comparison is what catches an edit outside every symbol body
  // — the import line, a top-level comment, a re-export (D030).
  const storedChunks = await chunkStore.getChunksByFilePath(filePath);
  if (storedChunks.length !== result.chunks.length) return false;
  const storedContentById = new Map(storedChunks.map((c) => [c.chunk_id, c.content]));
  if (!result.chunks.every((c) => storedContentById.get(c.chunk_id) === c.content)) return false;

  // Content: identical symbol hash signature.
  const storedSymbols = await db
    .selectFrom('symbols as s')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .select(['s.name', 's.line', 's.declaration_hash', 's.body_hash'])
    .where('f.path', '=', filePath)
    .execute();

  if (symbolSignature(result.symbols) !== symbolSignature(storedSymbols)) return false;

  // Imports: an import statement can sit outside every chunk entirely (a file
  // whose only chunks are its declarations, with `context_lines: 0`), so the
  // chunk-content check above does not subsume this one.
  const storedImports = await db
    .selectFrom('imports as i')
    .innerJoin('files as f', 'f.id', 'i.file_id')
    .select(['i.module', 'i.symbols', 'i.is_external', 'i.resolved_path'])
    .where('f.path', '=', filePath)
    .execute();

  return importSignature(result.imports) === importSignature(storedImports);
}

/**
 * Order-independent signature of a file's import set, over exactly the columns
 * `populateFile` writes to `imports`. The extracted and stored shapes differ
 * (camelCase vs snake_case, boolean vs 0/1, array vs JSON text), so both are
 * normalised to one canonical string rather than compared field by field.
 */
function importSignature(
  imports: readonly {
    module: string;
    symbols?: readonly string[] | string;
    isExternal?: boolean;
    is_external?: number;
    resolvedPath?: string | null;
    resolved_path?: string | null;
  }[],
): string {
  return imports
    .map((i) => {
      const symbols = typeof i.symbols === 'string' ? i.symbols : JSON.stringify(i.symbols ?? []);
      const external = i.isExternal ?? i.is_external === 1;
      const resolved = i.resolvedPath ?? i.resolved_path ?? '';
      return `${i.module}|${symbols}|${external ? 1 : 0}|${resolved}`;
    })
    .sort()
    .join('\n');
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
 * Derive the `freshness_cause` discriminator (§9 mast_status) from the measured
 * freshness. Stage 7.2 (IMPLEMENTATION_PLAN.md "Stage 7: Vector-store
 * deletion") dropped the second parameter this used to take
 * (`pendingEmbeddings`) along with the `'embedding_backlog'`/`'both'` cases —
 * the Phase 2 embedder that could produce a backlog distinct from Phase 1
 * staleness was excised in Stage 7.1, so a two-cause signature asserted a
 * distinction the code could no longer draw.
 *
 * It took the bare total from then until 2026-09-01 (D049), which asserted the
 * opposite error: `'phase1_stale'` for any non-zero count, including counts
 * with no stale file in them at all. It now takes the whole measurement,
 * because every distinction it draws is one `measureFreshness` already counted.
 *
 * `root_mismatch` is tested first and is the only compound condition. Let
 * `matched` be the files on disk the index actually knows (`walked -
 * unindexed`); the index describes a different tree when it disagrees with this
 * one in *both* directions more than it agrees in either — more unknown files
 * here than known ones, and more files listed that are absent than known ones.
 *
 * Both halves are load-bearing, and each excludes a different neighbour:
 * dropping the `unindexed` half would call a mass deletion a root mismatch
 * (many `deleted`, but every remaining file still matches); dropping the
 * `deleted` half would call a never-indexed project one (everything unknown,
 * but the index claims no files elsewhere).
 *
 * Stated as strict majorities against `matched` rather than as a ratio against
 * a tuned constant, and deliberately NOT as `unindexed === walked`: that was the
 * first form, and on the 1822-file index this was written for it did not fire,
 * because exactly one walked path coincidentally matched an indexed one and
 * `1569 === 1570` is false. A guard that a single accidental collision defeats
 * is the shape this ledger calls S-02.
 *
 * It is decided from counted content rather than by comparing the project root
 * against the one in the persisted state config: that path is recorded from a
 * previous process and is meaningless under the shared-volume mounts
 * `pickStateConfigCustomization` exists to survive.
 *
 * The remaining three are ordered by what a caller should do about them, not by
 * size: `phase1_stale` first because it is the one JIT re-parse silently
 * corrects on read, so it is the least alarming reading of a mixed count. The
 * exact split always travels beside it in `stale_breakdown`.
 */
export function freshnessCause(freshness: IndexFreshness): FreshnessCause {
  if (freshness.total === 0) return null;
  const matched = freshness.walked - freshness.unindexed;
  if (freshness.unindexed > matched && freshness.deleted > matched) return 'root_mismatch';
  if (freshness.stale > 0) return 'phase1_stale';
  if (freshness.unindexed > 0) return 'unindexed_files';
  return 'deleted_files';
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
