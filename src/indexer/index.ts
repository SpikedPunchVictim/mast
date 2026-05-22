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
import { createEmbedder, type EmbedderLike } from './embedder.js';
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

    // Deleted file cleanup — cascade removes symbols/edges/imports from graph.
    await removeDeletedFiles(db, deleted);
    await lance.deleteChunksForFiles(deleted);

    const toIndex = options.incremental ? [...stale, ...added] : currentFiles;

    let filesIndexed = 0;
    let parseErrors = 0;
    let chunksAdded = 0;
    let chunksRemoved = 0;

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
          parsed.push({ entry, result });
          chunksAdded += result.chunks.length;
          filesIndexed++;
        } catch (err) {
          process.stderr.write(`[mast] WARN: parse error in ${entry.path}: ${String(err)}\n`);
          parseErrors++;
        }
        options.onProgress?.(filesIndexed + parseErrors, toIndex.length);
      }

      // Lance writes — all concurrent within the batch.
      const lanceOk = new Set<string>();
      await Promise.all(
        parsed.map(async ({ entry, result }) => {
          try {
            await lance.replaceChunksForFile(entry.relativePath, result.chunks);
            lanceOk.add(entry.relativePath);
          } catch (err) {
            process.stderr.write(`[mast] WARN: lance write error in ${entry.path}: ${String(err)}\n`);
            parseErrors++;
          }
        }),
      );

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
    };
    writeFileSync(
      join(config.resolved_state_dir, 'index.json'),
      JSON.stringify(meta, null, 2),
    );

    await db.destroy();

    return {
      filesIndexed,
      filesSkipped: currentFiles.length - toIndex.length,
      chunksAdded,
      chunksRemoved,
      parseErrors,
      durationMs: Date.now() - startMs,
    };
  });
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

      // Remove vectors whose corresponding chunk no longer exists.
      const allChunkIds = new Set(allChunks.map((c) => c.chunk_id));
      const orphanIds = [...embeddedIds].filter((id) => !allChunkIds.has(id));
      if (orphanIds.length > 0) {
        await lance.deleteVectorsForChunks(orphanIds);
      }

      const pending = allChunks.filter((c) => !embeddedIds.has(c.chunk_id));
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
        options.embedder ?? createEmbedder(config.embedding_model, config.resolved_state_dir);
      await embedder.load();
      await lance.ensureVectorsTable(embedder.dimension);

      let chunksEmbedded = 0;
      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize).map(chunkRecordToChunk);
        const vectors = await embedder.embed(batch);
        await lance.insertVectors(vectors);
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
