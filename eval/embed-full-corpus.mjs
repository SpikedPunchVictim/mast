// Embed EVERY chunk in a state dir — closes the subset-asymmetry confound.
//
// The 3,000-chunk frozen subset was designed for MODEL-vs-model comparison,
// where an easier-but-identical pool cancels out. It does NOT cancel for
// ARM-vs-arm comparison: arm V ranks within the embedded subset while arms L/H
// rank against full-corpus FTS, so the vector arm solves an easier problem and
// the fusion receives FTS candidates that have no vector at all. Production
// embeds everything; the harness must too before fusion (F16) or vector value
// (Q1) can be honestly measured.
//
//   MAST_EVAL_STATE=<dir> node eval/embed-full-corpus.mjs

import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore, chunkRecordToChunk } from '../dist/store/lance.js';
import { stampVectorHashes } from '../dist/indexer/embedder.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { MODEL_CACHE_DIR, BASE_STATE_DIR } from './paths.mjs';

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const BATCH = 32;

const db = openDatabase(BASE_STATE_DIR);
const chunkStore = new SqliteChunkStore(db);
const lance = await LanceStore.open(BASE_STATE_DIR);

const all = await chunkStore.getAllChunks();
const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, BASE_STATE_DIR, 'fp32');
await embedder.load();
await lance.ensureVectorsTable(embedder.dimension);

const already = await lance.getEmbeddedChunkIds();
const todo = all.filter((c) => !already.has(c.chunk_id));
console.log(`[full-embed] ${BASE_STATE_DIR}`);
console.log(`[full-embed] chunks=${all.length} already=${already.size} todo=${todo.length}`);

const t0 = Date.now();
let done = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const cs = todo.slice(i, i + BATCH).map(chunkRecordToChunk);
  await lance.upsertVectors(stampVectorHashes(await embedder.embed(cs), cs));
  done += cs.length;
  process.stdout.write(`\r[full-embed] ${done}/${todo.length} ${(done / ((Date.now() - t0) / 1000)).toFixed(2)} ch/s`);
}
console.log(`\n[full-embed] done in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min; vectorCount=${await lance.vectorCount()} of ${all.length} chunks`);
await db.destroy();
