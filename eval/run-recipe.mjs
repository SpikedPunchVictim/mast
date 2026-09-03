// Recommended-recipe probe (fairness supplement to run-model.mjs).
//
// The shipped MAST pipeline applies mean pooling + no task prompts to every
// model. Some finalists are trained for a different recipe (CLS pooling; or
// embeddinggemma's query/document task prompts). This probe re-scores a model's
// PURE-VECTOR retrieval under its intended recipe on the same frozen subset, so
// the report can separate "the model is worse" from "MAST's recipe handicaps it"
// — which changes whether a near-miss finalist deserves a conditional switch.
//
//   node eval/run-recipe.mjs <modelId> <recipeTag> <pooling> [queryPrefix] [docPrefix]
//   node eval/run-recipe.mjs Alibaba-NLP/gte-modernbert-base cls cls
//   node eval/run-recipe.mjs onnx-community/embeddinggemma-300m-ONNX prompted mean \
//        'task: search result | query: ' 'title: none | text: '
//
// Writes results/<model>__recipe_<tag>.json (pure_vector only).

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LanceStore, chunkRecordToChunk } from '../dist/store/lance.js';
import { stampVectorHashes } from '../dist/indexer/embedder.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { getModel } from './models.mjs';
import { BASE_STATE_DIR, MODEL_CACHE_DIR, RESULTS_DIR, modelStateDir } from './paths.mjs';

const [modelId, recipeTag, pooling, queryPrefix = '', docPrefix = ''] = process.argv.slice(2);
if (!modelId || !recipeTag || !pooling) throw new Error('usage: run-recipe.mjs <modelId> <recipeTag> <pooling> [queryPrefix] [docPrefix]');
const spec = getModel(modelId);
const log = (...a) => console.log(`[recipe ${spec.label}/${recipeTag}]`, ...a);

const stateDir = modelStateDir(modelId) + '__recipe_' + recipeTag;
rmSync(stateDir, { recursive: true, force: true });
cpSync(BASE_STATE_DIR, stateDir, { recursive: true });
rmSync(join(stateDir, 'lance', 'vectors'), { recursive: true, force: true });

const embedder = new HarnessEmbedder(modelId, MODEL_CACHE_DIR, stateDir, 'fp32', { pooling, docPrefix, recipeTag });
await embedder.load();
log(`loaded dims=${embedder.dimension} pooling=${pooling} queryPrefix=${JSON.stringify(queryPrefix)} docPrefix=${JSON.stringify(docPrefix)}`);

const subset = JSON.parse(readFileSync(new URL('./corpus-subset.json', import.meta.url), 'utf-8'));
const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf-8'));
const lance = await LanceStore.open(stateDir);
const recs = await lance.getChunksByIds(subset.chunkIds);
await lance.ensureVectorsTable(embedder.dimension);
log(`embedding ${recs.length}-chunk subset with recipe…`);
for (let i = 0; i < recs.length; i += 32) {
  const batch = recs.slice(i, i + 32).map(chunkRecordToChunk);
  const vectors = await embedder.embed(batch);
  await lance.upsertVectors(stampVectorHashes(vectors, batch));
  if (i % 1024 < 32) log(`  embedded ${i}/${recs.length}`);
}

// Pure-vector scoring with the query prefix.
const agg = { ndcgSum: 0, recallSum: 0, mrrSum: 0, n: 0 };
const perQuery = [];
for (const q of gold.queries) {
  const qVec = await embedder.embedRawUncached(q.query, queryPrefix);
  const vhits = await lance.searchVectors(qVec, 40);
  const ids = vhits.map((h) => h.chunk_id);
  const vrecs = await lance.getChunksByIds(ids);
  const byId = new Map(vrecs.map((r) => [r.chunk_id, r]));
  const ranked = ids.map((id) => byId.get(id)).filter(Boolean).slice(0, 10)
    .map((r) => ({ file_path: r.file_path, symbol_name: r.symbol_name, start_line: r.start_line, end_line: r.end_line }));
  const m = scoreQuery(q, ranked);
  agg.ndcgSum += m.ndcg; agg.recallSum += m.recall; agg.mrrSum += m.rr; agg.n++;
  perQuery.push({ id: q.id, ndcg: +m.ndcg.toFixed(3), recall: +m.recall.toFixed(3), rr: +m.rr.toFixed(3) });
}
const out = {
  modelId, label: spec.label, recipeTag, pooling, queryPrefix, docPrefix,
  dims: embedder.dimension,
  pure_vector: {
    ndcg: +(agg.ndcgSum / agg.n).toFixed(4),
    recall: +(agg.recallSum / agg.n).toFixed(4),
    mrr: +(agg.mrrSum / agg.n).toFixed(4),
  },
  perQuery,
};
mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(join(RESULTS_DIR, `${modelId.replace(/\//g, '_')}__recipe_${recipeTag}.json`), JSON.stringify(out, null, 2));
log(`pure_vector NDCG@10=${out.pure_vector.ndcg} recall=${out.pure_vector.recall} mrr=${out.pure_vector.mrr}`);

function matchedTargetIndex(res, targets) {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t.file_path !== res.file_path) continue;
    if (t.symbol != null && res.symbol_name === t.symbol) return i;
    if (t.line != null && res.start_line != null && t.line >= res.start_line && t.line <= res.end_line) return i;
  }
  return -1;
}
function scoreQuery(q, ranked) {
  const T = q.relevant.length;
  const covered = new Set();
  let dcg = 0, firstRel = 0;
  for (let i = 0; i < Math.min(ranked.length, 10); i++) {
    const idx = matchedTargetIndex(ranked[i], q.relevant);
    // First match per target only — see run-model.mjs scoreQuery for why.
    if (idx >= 0 && !covered.has(idx)) { dcg += 1 / Math.log2(i + 2); covered.add(idx); if (!firstRel) firstRel = i + 1; }
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(T, 10); i++) idcg += 1 / Math.log2(i + 2);
  return { ndcg: idcg ? dcg / idcg : 0, recall: T ? covered.size / T : 0, rr: firstRel ? 1 / firstRel : 0 };
}
