// A dtype-parametrized embedder for the bake-off.
//
// The shipped Embedder (src/indexer/embedder.ts) hardcodes `dtype: 'fp32'` and
// applies `pooling: 'mean', normalize: true` to every model. This wrapper
// reproduces that EXACT embedding logic (mean pooling + L2 normalize) so the
// numbers reflect the shipped pipeline, while exposing `dtype` so we can also
// measure the fp32-vs-quantized delta the rubric's quantization axis asks for.
//
// It implements the same EmbedderLike contract (load / embed / dimension) that
// runEmbed and hybridSearch consume, so it drops into the real search code path.
//
// Fidelity note: for a fair "what would a naive MAST swap get" reading, we apply
// mean pooling and NO model-specific query/document prompts to every model —
// identical to the shipped path. Models trained for CLS pooling or that require
// task prompts (embeddinggemma) may score higher under their recommended recipe;
// that is called out in the report as a ceiling caveat, not corrected here.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function sha256(t) {
  return createHash('sha256').update(t).digest('hex');
}

export class HarnessEmbedder {
  /**
   * @param {string} modelId
   * @param {string} transformersCacheDir  weight cache (env.cacheDir)
   * @param {string} embedCacheDir         per-model vector cache root
   * @param {string} dtype                 'fp32' | 'q8' | 'int8' | ...
   */
  constructor(modelId, transformersCacheDir, embedCacheDir, dtype = 'fp32', opts = {}) {
    this.modelId = modelId;
    this.transformersCacheDir = transformersCacheDir;
    this.embedCacheDir = embedCacheDir;
    this.dtype = dtype;
    // Recipe overrides — default is the SHIPPED recipe (mean pool, no prefix).
    // The recommended-recipe probe (run-recipe.mjs) sets these to a model's
    // intended pooling / task prompts to measure its ceiling vs the naive swap.
    this.pooling = opts.pooling ?? 'mean';
    this.docPrefix = opts.docPrefix ?? '';
    this.recipeTag = opts.recipeTag ?? 'shipped';
    this.pipeline = null;
    this._dimension = 0;
  }

  async load() {
    if (this.pipeline !== null) return;
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = this.transformersCacheDir;
    // allowRemoteModels defaults true; downloads land in cacheDir.
    this.pipeline = await pipeline('feature-extraction', this.modelId, {
      dtype: this.dtype,
    });
    const probe = await this.pipeline('', { pooling: this.pooling, normalize: true });
    this._dimension = probe.data.length;
  }

  /** Embed chunks (content-hash cached, keyed by model+dtype). */
  async embed(chunks) {
    if (this.pipeline === null) throw new Error('call load() before embed()');
    const out = [];
    for (const chunk of chunks) {
      const contentHash = sha256(chunk.content);
      const cached = this._readCache(contentHash);
      if (cached !== null) {
        out.push({ chunk_id: chunk.chunk_id, embedding: cached, model_version: this.modelId });
        continue;
      }
      const res = await this.pipeline(this.docPrefix + chunk.content, { pooling: this.pooling, normalize: true });
      const embedding = Array.from(res.data);
      this._writeCache(contentHash, embedding);
      out.push({ chunk_id: chunk.chunk_id, embedding, model_version: this.modelId });
    }
    return out;
  }

  /** Embed a single raw string with no caching — used for latency timing and
   *  for query embedding (pass the query prefix as `prefix` in a recipe probe). */
  async embedRawUncached(text, prefix = '') {
    const res = await this.pipeline(prefix + text, { pooling: this.pooling, normalize: true });
    return Array.from(res.data);
  }

  get dimension() {
    return this._dimension;
  }

  _cachePath(contentHash) {
    const key = `${this.modelId}__${this.dtype}__${this.recipeTag}`.replace(/\//g, '_');
    return join(this.embedCacheDir, 'embed_cache', key, `${contentHash}.json`);
  }
  _readCache(h) {
    const p = this._cachePath(h);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  }
  _writeCache(h, emb) {
    const p = this._cachePath(h);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(emb));
  }
}
