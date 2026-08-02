// Diagnostic: is the batched embed() slowdown driven by long-sequence
// batches (attention is O(seqLen^2)), or is batching itself slow here
// regardless of length? Times four small, isolated pipeline() calls
// directly (bypassing Embedder) so we control exactly what's batched.
import { openDatabase } from '/Users/spikedpunchvictim/projects/kluster/packages/mast/dist/graph/db.js';
import { SqliteChunkStore } from '/Users/spikedpunchvictim/projects/kluster/packages/mast/dist/store/sqliteChunkStore.js';
import { pipeline, env } from '@huggingface/transformers';
import { join } from 'node:path';

const STATE_DIR = '/Users/spikedpunchvictim/temp/mast-bench/embed-batching-eval-state';
const MODEL_ID = 'jinaai/jina-embeddings-v2-base-code';
env.cacheDir = join(process.env.HOME, '.cache', 'mast', 'transformers');

const db = openDatabase(STATE_DIR);
const store = new SqliteChunkStore(db);
const all = await store.getAllChunks();
await db.destroy();

const byLen = [...all].sort((a, b) => a.content.length - b.content.length);
const shortest16 = byLen.slice(0, 16).map((c) => c.content);
const longest16 = byLen.slice(-16).map((c) => c.content);
const longestLens = byLen.slice(-16).map((c) => c.content.length);
console.log('shortest16 lens:', byLen.slice(0, 16).map((c) => c.content.length));
console.log('longest16 lens:', longestLens);

const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' });

async function timeCall(label, texts) {
  const t0 = Date.now();
  await extractor(texts, { pooling: 'mean', normalize: true });
  const ms = Date.now() - t0;
  console.log(`${label}: n=${texts.length} wallMs=${ms} rssNowMB=${(process.memoryUsage().rss / 1e6).toFixed(0)}`);
  return ms;
}

// Single-item baseline calls (unbatched, per-chunk) for reference.
await timeCall('solo-short x1', [shortest16[0]]);
await timeCall('solo-long x1', [longest16[15]]);

// Batched calls.
await timeCall('batch-16-short', shortest16);
await timeCall('batch-16-long', longest16);
await timeCall('batch-4-long', longest16.slice(0, 4));

console.log('resourceUsage.maxRSS(KB):', process.resourceUsage().maxRSS);
