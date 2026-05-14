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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
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

/** Minimal type for the feature-extraction pipeline return. */
interface EmbedderPipeline {
  (text: string, options: { pooling: string; normalize: boolean }): Promise<unknown>;
}

/**
 * Create a default `Embedder` instance wired to the standard state directory
 * layout expected by the SDD pipeline.
 */
export function createEmbedder(modelId: string, stateDir: string): Embedder {
  return new Embedder(
    modelId,
    '/opt/transformers-cache',  // Docker pre-warmed path; see §13.8.1
    stateDir,
  );
}
