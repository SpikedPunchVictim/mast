import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Chunk, VectorEntry } from '../ast/types.js';

// Cache directory within the state dir: embed_cache/<model_id>/<sha256>.json
// We store vectors as JSON arrays rather than .npy to avoid a numpy dependency.
const CACHE_SUBDIR = 'embed_cache';

/**
 * Embedding model wrapper using @huggingface/transformers (Transformers.js v4).
 *
 * The ONNX model is loaded once per `Embedder` instance. Keep one instance
 * per process and reuse it across batch calls.
 *
 * Per §13.8.1, `env.cacheDir` MUST be set before the first `pipeline()` call
 * so that Docker pre-warmed weights are used rather than re-downloading.
 */
export class Embedder {
  private pipeline: EmbedderPipeline | null = null;
  private _dimension = 0;

  constructor(
    private readonly modelId: string,
    private readonly transformersCacheDir: string,
    private readonly embedCacheDir: string,
  ) {}

  /**
   * Load the embedding model. Idempotent — safe to call multiple times.
   * Must be called before `embed()`.
   */
  async load(): Promise<void> {
    if (this.pipeline !== null) return;

    // Dynamic import keeps the heavy ONNX runtime out of the main module graph
    // when embeddings are disabled (§13.11).
    const { pipeline, env } = await import('@huggingface/transformers');

    // Must be set before the first pipeline() call — see §13.8.1.
    env.cacheDir = this.transformersCacheDir;

    this.pipeline = (await pipeline('feature-extraction', this.modelId, {
      dtype: 'fp32',
    })) as unknown as EmbedderPipeline;

    // Detect the model's actual embedding dimension by probing with an empty string.
    // This allows swapping models without hardcoding the dimension per model.
    const probe = await this.pipeline('', { pooling: 'mean', normalize: true });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
    const probeData = (probe as any).data as Float32Array;
    this._dimension = probeData.length;
  }

  /**
   * Embed a batch of chunks. Checks the per-content-hash cache before calling
   * the model. Results are written back to the cache immediately.
   *
   * @returns One `VectorEntry` per input chunk, in the same order.
   */
  async embed(chunks: readonly Chunk[]): Promise<VectorEntry[]> {
    if (this.pipeline === null) throw new Error('Call load() before embed()');

    const results: VectorEntry[] = [];
    for (const chunk of chunks) {
      const contentHash = sha256(chunk.content);
      const cached = this.readCache(contentHash);

      if (cached !== null) {
        results.push({ chunk_id: chunk.chunk_id, embedding: cached, model_version: this.modelId });
        continue;
      }

      const output = await this.pipeline(chunk.content, { pooling: 'mean', normalize: true });
      // Transformers.js returns a Tensor; extract the float32 data array.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      const embedding: number[] = Array.from((output as any).data as Float32Array);

      this.writeCache(contentHash, embedding);
      results.push({ chunk_id: chunk.chunk_id, embedding, model_version: this.modelId });
    }

    return results;
  }

  /** Embedding dimension of the loaded model. Returns 0 before load(). */
  get dimension(): number {
    return this._dimension;
  }

  // ---------------------------------------------------------------------------
  // Cache helpers
  // ---------------------------------------------------------------------------

  private cacheFilePath(contentHash: string): string {
    return join(this.embedCacheDir, CACHE_SUBDIR, this.modelId.replace(/\//g, '_'), `${contentHash}.json`);
  }

  private readCache(contentHash: string): number[] | null {
    const cachePath = this.cacheFilePath(contentHash);
    if (!existsSync(cachePath)) return null;
    try {
      return JSON.parse(readFileSync(cachePath, 'utf-8')) as number[];
    } catch {
      return null;
    }
  }

  private writeCache(contentHash: string, embedding: number[]): void {
    const cachePath = this.cacheFilePath(contentHash);
    mkdirSync(join(cachePath, '..'), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(embedding));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Known embedding dimension for jinaai/jina-embeddings-v2-base-code. */
export const JINA_V2_DIM = 768;

/**
 * Minimal contract for an embedding model — used by `runPhase2` so that
 * tests can inject a deterministic fake without loading the ONNX runtime.
 */
export interface EmbedderLike {
  load(): Promise<void>;
  embed(chunks: readonly Chunk[]): Promise<VectorEntry[]>;
  readonly dimension: number;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** sha256 of chunk content — the freshness key stored alongside each vector. */
export function vectorContentHash(content: string): string {
  return sha256(content);
}

/**
 * Identity of a chunk's vector for freshness comparison: its id plus a hash of
 * the content it was embedded from. A chunk is "already embedded" only when a
 * stored vector matches BOTH — so an in-place edit (same id, new content)
 * counts as pending.
 */
export function vectorKey(chunkId: string, content: string): string {
  return joinVectorKey(chunkId, vectorContentHash(content));
}

/**
 * Join a chunk id and content hash into one freshness key. Shared by the
 * producer (`vectorKey`) and the stored-key reader
 * (`LanceStore.getEmbeddedVectorKeys`) so the format cannot drift. `:` never
 * appears in either sha256-hex component.
 */
export function joinVectorKey(chunkId: string, contentHash: string): string {
  return `${chunkId}:${contentHash}`;
}

/**
 * Stamp each vector with the content hash of the chunk it was embedded from.
 * The model doesn't produce this; the embed orchestration adds it before
 * storing so vector freshness can be checked on the next reindex (H1). Matched
 * by `chunk_id`, which is unique within an embed batch.
 */
export function stampVectorHashes(
  vectors: readonly VectorEntry[],
  chunks: readonly Chunk[],
): VectorEntry[] {
  const hashByChunkId = new Map(chunks.map((c) => [c.chunk_id, vectorContentHash(c.content)]));
  return vectors.map((v) => {
    const hash = hashByChunkId.get(v.chunk_id);
    return hash === undefined ? v : { ...v, content_hash: hash };
  });
}

/** Minimal type for the feature-extraction pipeline return. */
interface EmbedderPipeline {
  (text: string, options: { pooling: string; normalize: boolean }): Promise<unknown>;
}

/**
 * Create an `Embedder` instance. `transformersCacheDir` is resolved by the
 * caller (via `resolveTransformersCacheDir`) so this function stays pure.
 */
export function createEmbedder(modelId: string, stateDir: string, transformersCacheDir: string): Embedder {
  return new Embedder(modelId, transformersCacheDir, stateDir);
}
