// Feasibility-spike throughput sample — embed the first ~100 chunks of the
// vscode-state-full corpus and measure chunks/s on this machine, mirroring
// embed-full-corpus.mjs's construction (HarnessEmbedder, fp32, batch 32).
// Writes real vectors into the state dir (a legitimate head start on the full
// embed) but issues NO search/query of any kind, per the spike's hard constraint.
//
//   MAST_EVAL_STATE=~/.cache/mast-eval/vscode-state-full node eval/vscode-embed-sample.mjs

import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore, chunkRecordToChunk } from '../dist/store/lance.js';
import { stampVectorHashes } from '../dist/indexer/embedder.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { MODEL_CACHE_DIR } from './paths.mjs';

const STATE_DIR = process.env.MAST_EVAL_STATE;
if (!STATE_DIR) { console.error('set MAST_EVAL_STATE'); process.exit(1); }

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const BATCH = 32;
const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE ?? 100);
const PROJECT_TOTAL = Number(process.env.PROJECT_TOTAL ?? 152969);

const db = openDatabase(STATE_DIR);
const chunkStore = new SqliteChunkStore(db);
const lance = await LanceStore.open(STATE_DIR);

const all = await chunkStore.getAllChunks();
const already = await lance.getEmbeddedChunkIds();
const todoAll = all.filter((c) => !already.has(c.chunk_id));
const sample = todoAll.slice(0, SAMPLE_SIZE);

console.log(`[embed-sample] state_dir=${STATE_DIR}`);
console.log(`[embed-sample] total_chunks=${all.length} already_embedded=${already.size} sample=${sample.length}`);

const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, STATE_DIR, 'fp32');
const loadT0 = Date.now();
await embedder.load();
const loadMs = Date.now() - loadT0;
await lance.ensureVectorsTable(embedder.dimension);
console.log(`[embed-sample] model_loaded_in=${(loadMs / 1000).toFixed(2)}s dim=${embedder.dimension}`);

const t0 = Date.now();
let done = 0;
for (let i = 0; i < sample.length; i += BATCH) {
  const cs = sample.slice(i, i + BATCH).map(chunkRecordToChunk);
  await lance.upsertVectors(stampVectorHashes(await embedder.embed(cs), cs));
  done += cs.length;
}
const elapsedS = (Date.now() - t0) / 1000;
const rate = done / elapsedS;
console.log(`[embed-sample] embedded ${done} chunks in ${elapsedS.toFixed(2)}s = ${rate.toFixed(3)} chunks/s`);
console.log(`[embed-sample] projected ${PROJECT_TOTAL} chunks: ${(PROJECT_TOTAL / rate / 3600).toFixed(2)} h`);
console.log(`[embed-sample] vectorCount now = ${await lance.vectorCount()}`);

await db.destroy();
