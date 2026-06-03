import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../store/config.js';
import { CURRENT_SCHEMA_VERSION } from '../store/config.js';
import { initLockMarkers, withLock } from '../store/lock.js';
import { LanceStore, chunkRecordToChunk } from '../store/lance.js';
import { openDatabase } from '../graph/db.js';
import { populateFile, insertEdges, removeDeletedFiles } from '../graph/populate.js';
import { extractFile } from '../ast/extract.js';
import { walkProject, buildManifest, diffManifest, type FileEntry } from './walker.js';
import { createEmbedder, vectorKey, stampVectorHashes, type EmbedderLike } from './embedder.js';
import type { IndexMeta } from '../ast/types.js';

export interface IndexResult {
  readonly filesIndexed: number;
  readonly filesSkipped: number;
  readonly chunksAdded: number;
  readonly chunksRemoved: number;
  readonly parseErrors: number;
  readonly durationMs: number;
}

export interface IndexOptions {
  /** When true, only reindex files whose mtime changed since the last run. */
  readonly incremental: boolean;
  /** Called after each file is processed (parse phase) with running and total counts. */
  readonly onProgress?: (processed: number, total: number) => void;
}

/**
 * Walk the project, parse changed files into chunks, populate the graph
 * database and FTS indexes.
 *
 * Acquires `structure.lock` for the duration of the run. On completion,
 * updates `file_manifest.json` and `index.json`.
 */
export async function runIndex(
  config: ResolvedConfig,
  options: IndexOptions,
): Promise<IndexResult> {
  const startMs = Date.now();
  // initLockMarkers is idempotent — safe to call on every run so that
  // `mast index` works even without a prior `mast init`.
  initLockMarkers(config.resolved_state_dir);

  return withLock(config.resolved_state_dir, 'structure', { maxRetries: 5, retryIntervalMs: 1_000 }, async () => {
    const db = openDatabase(config.resolved_state_dir);
    const lance = await LanceStore.open(config.resolved_state_dir);
    await lance.ensureChunksTable();

    // Load previous manifest for incremental comparison.
    const manifestPath = join(config.resolved_state_dir, 'file_manifest.json');
    const prevManifest: Record<string, number> = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, number>)
      : {};

    const currentFiles = await walkProject(config);
    const { stale, added, deleted } = diffManifest(currentFiles, prevManifest);

    let chunksRemoved = 0;

    // Deleted file cleanup — cascade removes symbols/edges/imports from graph.
    await removeDeletedFiles(db, deleted);
    chunksRemoved += await lance.deleteChunksForFiles(deleted);

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
        await removeDeletedFiles(db, orphans);
        chunksRemoved += await lance.deleteChunksForFiles(orphans);
      }
    }

    const toIndex = options.incremental ? [...stale, ...added] : currentFiles;

    let filesIndexed = 0;
    let parseErrors = 0;
    let chunksAdded = 0;
    let filesStable = 0;

    // Pass 1: parse → lance (concurrent) → SQLite, processed in batches so
    // lance IO overlaps across files without holding all results in memory.
    // SQLite writes remain sequential — better-sqlite3 serialises internally.
    const LANCE_BATCH = 16;
    type ParsedItem = { entry: FileEntry; result: ReturnType<typeof extractFile> };
    const edgeDataByFile = new Map<string, ReturnType<typeof extractFile>>();

    for (let i = 0; i < toIndex.length; i += LANCE_BATCH) {
      const batch = toIndex.slice(i, i + LANCE_BATCH);

      // Parse phase — synchronous tree-sitter, cannot be parallelised without workers.
      const parsed: ParsedItem[] = [];
      for (const entry of batch) {
        try {
          const result = extractFile(entry.path, config.resolved_project_root, config.context_lines, config.chunk_split_threshold);
          // §7.1 stability skip: a file whose mtime changed but whose chunked
          // content is identical (e.g. `git checkout` rewriting the same bytes)
          // is re-parsed but need not be re-written. Incremental only; the
          // check is conservative and bails to a full rewrite on any doubt.
          if (options.incremental && await isFileUnchanged(db, lance, entry.relativePath, result)) {
            filesStable++;
          } else {
            parsed.push({ entry, result });
            chunksAdded += result.chunks.length;
            filesIndexed++;
          }
        } catch (err) {
          process.stderr.write(`[mast] WARN: parse error in ${entry.path}: ${String(err)}\n`);
          parseErrors++;
        }
        options.onProgress?.(filesIndexed + filesStable + parseErrors, toIndex.length);
      }

      // Lance writes — all concurrent within the batch.
      const lanceOk = new Set<string>();
      const removedCounts = await Promise.all(
        parsed.map(async ({ entry, result }) => {
          try {
            const removed = await lance.replaceChunksForFile(entry.relativePath, result.chunks);
            lanceOk.add(entry.relativePath);
            return removed;
          } catch (err) {
            process.stderr.write(`[mast] WARN: lance write error in ${entry.path}: ${String(err)}\n`);
            parseErrors++;
            return 0;
          }
        }),
      );
      chunksRemoved += removedCounts.reduce((sum, n) => sum + n, 0);

      // SQLite writes — sequential.
      for (const { entry, result } of parsed) {
        if (!lanceOk.has(entry.relativePath)) continue;
        await populateFile(db, {
          filePath: entry.relativePath,
          language: result.language as 'typescript' | 'javascript',
          mtime: entry.mtime,
          chunks: result.chunks,
          imports: result.imports,
          symbols: result.symbols,
        });
        edgeDataByFile.set(entry.relativePath, result);
      }
    }

    // Pass 2: insert edges now that all symbols are in the graph.
    for (const [filePath, data] of edgeDataByFile) {
      await insertEdges(db, filePath, data.edges);
    }

    // Update manifest and index.json.
    const newManifest = buildManifest(currentFiles);
    writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2));

    const chunkCount = await lance.chunkCount();
    const meta: IndexMeta = {
      schema_version: CURRENT_SCHEMA_VERSION,
      last_indexed: new Date().toISOString(),
      file_count: currentFiles.length,
      chunk_count: chunkCount,
      model: config.embedding_model,
      parse_errors: parseErrors > 0 ? parseErrors : undefined,
    };
    writeFileSync(
      join(config.resolved_state_dir, 'index.json'),
      JSON.stringify(meta, null, 2),
    );

    await db.destroy();

    return {
      // Files skipped = never-parsed (mtime unchanged) + parsed-but-stable.
      filesIndexed,
      filesSkipped: currentFiles.length - toIndex.length + filesStable,
      chunksAdded,
      chunksRemoved,
      parseErrors,
      durationMs: Date.now() - startMs,
    };
  });
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
  lance: LanceStore,
  filePath: string,
  result: ReturnType<typeof extractFile>,
): Promise<boolean> {
  if (result.chunks.some((c) => c.chunk_type === 'block')) return false;

  // Structure: identical set of chunk ids.
  const storedChunks = await lance.getChunksByFilePath(filePath);
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
// Phase 2: Embedding
// ---------------------------------------------------------------------------

export interface EmbedResult {
  readonly chunksEmbedded: number;
  readonly chunksSkipped: number;
  readonly durationMs: number;
}

export interface EmbedOptions {
  /** Chunks per model call. Default 32. */
  readonly batchSize?: number;
  /**
   * Inject a pre-configured embedder. Defaults to the model in `config`.
   * Pass a fake here in tests to avoid loading the ONNX runtime.
   */
  readonly embedder?: EmbedderLike;
  /** Called after each batch with running and total pending counts. */
  readonly onProgress?: (embedded: number, total: number) => void;
}

/**
 * Embed all un-vectorised chunks and store results in LanceDB.
 *
 * Acquires `vectors.lock` for the duration. Idempotent — chunks already in
 * the vectors table are skipped; orphaned vectors (whose chunks were deleted)
 * are cleaned up before new embeddings are inserted.
 */
export async function runEmbed(
  config: ResolvedConfig,
  options: EmbedOptions = {},
): Promise<EmbedResult> {
  const startMs = Date.now();
  const batchSize = options.batchSize ?? 32;

  return withLock(
    config.resolved_state_dir,
    'vectors',
    { maxRetries: 5, retryIntervalMs: 1_000 },
    async () => {
      const lance = await LanceStore.open(config.resolved_state_dir);

      const allChunks = await lance.getAllChunks();
      const embeddedIds = await lance.getEmbeddedChunkIds();
      const vectorKeys = await lance.getEmbeddedVectorKeys();

      // Remove vectors whose corresponding chunk no longer exists.
      const allChunkIds = new Set(allChunks.map((c) => c.chunk_id));
      const orphanIds = [...embeddedIds].filter((id) => !allChunkIds.has(id));
      if (orphanIds.length > 0) {
        await lance.deleteVectorsForChunks(orphanIds);
      }

      // Pending = chunks whose CURRENT content is not embedded. A content edit
      // keeps the chunk_id but changes the content hash, so it is re-embedded
      // even though the id is unchanged (H1).
      const pending = allChunks.filter((c) => !vectorKeys.has(vectorKey(c.chunk_id, c.content)));
      if (pending.length === 0) {
        return {
          chunksEmbedded: 0,
          chunksSkipped: allChunks.length,
          durationMs: Date.now() - startMs,
        };
      }

      // Load the embedder first so we can detect the model's actual dimension,
      // then create the vectors table with the correct size.
      const embedder =
        options.embedder ?? createEmbedder(config.embedding_model, config.resolved_state_dir, config.resolved_transformers_cache_dir);
      await embedder.load();
      await lance.ensureVectorsTable(embedder.dimension);

      let chunksEmbedded = 0;
      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize).map(chunkRecordToChunk);
        const vectors = await embedder.embed(batch);
        // Stamp each vector with its content hash (the embedder doesn't), then
        // upsert so a re-embed overwrites the stale vector instead of dup'ing it.
        await lance.upsertVectors(stampVectorHashes(vectors, batch));
        chunksEmbedded += batch.length;
        options.onProgress?.(chunksEmbedded, pending.length);
      }

      return {
        chunksEmbedded,
        chunksSkipped: allChunks.length - pending.length,
        durationMs: Date.now() - startMs,
      };
    },
  );
}

/** Load `index.json` from the state directory, or return null if absent. */
export function loadIndexMeta(stateDir: string): IndexMeta | null {
  const metaPath = join(stateDir, 'index.json');
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, 'utf-8')) as IndexMeta;
}

/** Write `index.json` to the state directory. */
export function writeIndexMeta(stateDir: string, meta: IndexMeta): void {
  writeFileSync(join(stateDir, 'index.json'), JSON.stringify(meta, null, 2));
}
