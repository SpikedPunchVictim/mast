// Task 9 validation — score-only re-run of the incumbent's hybrid retrieval on
// the frozen gold set, without re-embedding anything (reuses the model state
// dir written by run-model.mjs: vectors.lance + full-corpus FTS + embed cache).
//
//   node eval/score-only.mjs [label]
//
// Run BEFORE the vector-gate change (dist built from the shipped code) and
// AFTER (dist rebuilt) to measure the NDCG@10 / Recall@10 / MRR delta of
// replacing the absolute 0.70 cosine gate with rank-based inclusion. Also
// dumps the cosine evidence the floor decision needs: per gold query the
// top-1 / rank-10 / rank-40 cosine, plus top-1 cosines for deliberately
// nonsensical junk queries (does ANY absolute floor separate gold from junk?).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../dist/graph/db.js';
import { LanceStore } from '../dist/store/lance.js';
import { hybridSearch } from '../dist/search/hybrid.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { MODEL_CACHE_DIR, RESULTS_DIR, modelStateDir } from './paths.mjs';

const INCUMBENT = 'jinaai/jina-embeddings-v2-base-code';
const label = process.argv[2] ?? 'unlabeled';
const RRF_K = 60;

// Junk queries: no code meaning, no gold relevance — the "should return
// nothing useful" class. Used only for the cosine-floor evidence.
const JUNK_QUERIES = [
  'adddd', 'qwperiuzxnmv', 'florble grunk wizzle', 'aaaa bbbb cccc dddd',
  'purple elephant sandwich orchestra', 'zzzzzz yyyyy xxxxx',
];

const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf-8'));
const stateDir = modelStateDir(INCUMBENT);

const embedder = new HarnessEmbedder(INCUMBENT, MODEL_CACHE_DIR, stateDir, 'fp32');
await embedder.load();
const db = openDatabase(stateDir);
const lance = await LanceStore.open(stateDir);

// --- Hybrid scoring: shipped config shape AND threshold-free shape. Post-change
// the extra similarity_threshold property is ignored, so both variants converge.
const variants = {
  hybrid_shipped_config: { rrf_k: RRF_K, similarity_threshold: 0.70 },
  hybrid_thresh0: { rrf_k: RRF_K, similarity_threshold: 0 },
};

const scores = {};
for (const [name, cfg] of Object.entries(variants)) {
  const agg = { ndcgSum: 0, recallSum: 0, mrrSum: 0, n: 0 };
  for (const q of gold.queries) {
    const res = await hybridSearch(db, lance, embedder, { query: q.query, limit: 10 }, cfg);
    const m = scoreQuery(q, res.results);
    agg.ndcgSum += m.ndcg; agg.recallSum += m.recall; agg.mrrSum += m.rr; agg.n++;
  }
  scores[name] = {
    ndcg: +(agg.ndcgSum / agg.n).toFixed(4),
    recall: +(agg.recallSum / agg.n).toFixed(4),
    mrr: +(agg.mrrSum / agg.n).toFixed(4),
  };
}

// --- Cosine evidence for the floor decision ---
async function cosineProfile(query) {
  const vec = await embedder.embedRawUncached(query);
  const hits = await lance.searchVectors(vec, 40);
  const cos = hits.map((h) => +(1 - h._distance).toFixed(4));
  return { top1: cos[0] ?? null, rank10: cos[9] ?? null, rank40: cos[39] ?? null };
}

const goldCos = [];
for (const q of gold.queries) goldCos.push({ id: q.id, ...(await cosineProfile(q.query)) });
const junkCos = [];
for (const jq of JUNK_QUERIES) junkCos.push({ query: jq, ...(await cosineProfile(jq)) });

const goldTop1 = goldCos.map((g) => g.top1).sort((a, b) => a - b);
const junkTop1 = junkCos.map((g) => g.top1).sort((a, b) => a - b);

const out = {
  label,
  ranAt: new Date().toISOString(),
  goldQueryCount: gold.queries.length,
  scores,
  cosineEvidence: {
    gold_top1_min: goldTop1[0],
    gold_top1_median: goldTop1[Math.floor(goldTop1.length / 2)],
    gold_top1_max: goldTop1[goldTop1.length - 1],
    junk_top1_min: junkTop1[0],
    junk_top1_median: junkTop1[Math.floor(junkTop1.length / 2)],
    junk_top1_max: junkTop1[junkTop1.length - 1],
    perGoldQuery: goldCos,
    perJunkQuery: junkCos,
  },
};

mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = join(RESULTS_DIR, `task9-score-${label}.json`);
writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ label, scores, cosineSummary: { goldTop1: { min: out.cosineEvidence.gold_top1_min, med: out.cosineEvidence.gold_top1_median, max: out.cosineEvidence.gold_top1_max }, junkTop1: { min: out.cosineEvidence.junk_top1_min, med: out.cosineEvidence.junk_top1_median, max: out.cosineEvidence.junk_top1_max } } }, null, 2));
console.log(`wrote ${outFile}`);
await db.destroy();

// --- scoring (identical to run-model.mjs) ---
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
  const targets = q.relevant;
  const T = targets.length;
  const coveredTargets = new Set();
  let dcg = 0;
  let firstRel = 0;
  for (let i = 0; i < Math.min(ranked.length, 10); i++) {
    const idx = matchedTargetIndex(ranked[i], targets);
    const rel = idx >= 0 && !coveredTargets.has(idx) ? 1 : 0;
    if (rel) {
      dcg += 1 / Math.log2(i + 2);
      coveredTargets.add(idx);
      if (firstRel === 0) firstRel = i + 1;
    }
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(T, 10); i++) idcg += 1 / Math.log2(i + 2);
  return { ndcg: idcg > 0 ? dcg / idcg : 0, recall: T > 0 ? coveredTargets.size / T : 0, rr: firstRel > 0 ? 1 / firstRel : 0, firstRel };
}
