// Stage 3.1 — PageRank probe (second and FINAL centrality knob, per plan
// step 5 / §R reserve trigger). Run only because in-degree failed the gate
// with a confirmed hub-displacement signature (rank-1 answers pushed down by
// query-irrelevant high-in-degree candidates; see REPORT.md).
//
// Identical 3-ranker fusion to run.mjs's after arm, with the in-degree map
// swapped for PageRank (damping 0.85, standard power iteration, same
// POTENTIAL_CALL/IMPLEMENTS edge set). Before arm is not re-run — run.mjs's
// before numbers are the comparison basis (same corpus, same vectors).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../../dist/graph/db.js';
import { LanceStore } from '../../../dist/store/lance.js';
import { rrfScore, dedupShellMethodCollisions } from '../../../dist/search/hybrid.js';
import { searchFts } from '../../../dist/search/fts.js';
import { searchVectors } from '../../../dist/search/vector.js';
import { HarnessEmbedder } from '../../harness-embedder.mjs';
import { MODEL_CACHE_DIR, BASE_STATE_DIR, modelStateDir } from '../../paths.mjs';
import { scoreChunks, coverageStats } from './centrality.mjs';
import { computePageRank } from './pagerank.mjs';

const INCUMBENT = 'jinaai/jina-embeddings-v2-base-code';
const RRF_K = 60;
const LIMIT = 10;
const CANDIDATE_LIMIT = LIMIT * 4;

const SPIKE_DIR = new URL('.', import.meta.url).pathname;

const t0 = Date.now();
const { centrality, iterations, symbolCount } = computePageRank(BASE_STATE_DIR);
console.log(`[pagerank] symbols=${symbolCount} converged in ${iterations} iterations (${Date.now() - t0}ms)`);

const baseLance = await LanceStore.open(BASE_STATE_DIR);
const allChunks = await baseLance.getAllChunks();
// PageRank assigns every node nonzero mass; for coverage parity with the
// in-degree run we count chunks whose score exceeds the uniform floor a
// no-inbound-edge node would get — i.e. chunks whose symbol actually gained
// rank from the edge structure.
const uniformFloor = 1 / symbolCount + 1e-12;
const fullScores = scoreChunks(centrality, allChunks);
let aboveFloor = 0;
for (const v of fullScores.values()) if (v > uniformFloor * 1.01) aboveFloor++;
console.log(`[pagerank] chunks above uniform floor: ${aboveFloor}/${fullScores.size} (${((100 * aboveFloor) / fullScores.size).toFixed(2)}%)`);

const gold = JSON.parse(readFileSync(new URL('../../gold-set.json', import.meta.url), 'utf-8'));
const stateDir = modelStateDir(INCUMBENT);
const embedder = new HarnessEmbedder(INCUMBENT, MODEL_CACHE_DIR, stateDir, 'fp32');
await embedder.load();
const db = openDatabase(stateDir);
const lance = await LanceStore.open(stateDir);

function queryAsChunk(query) {
  return {
    chunk_id: '__query__', file_path: '__query__', start_line: 0, end_line: 0,
    content: query, chunk_type: 'block', symbol_name: null, parent_symbol: null,
    is_exported: false, language: 'typescript', file_mtime: 0,
  };
}

async function threeRankerSearch(query) {
  const ftsRows = await searchFts(db, query, { limit: CANDIDATE_LIMIT });
  const ftsMap = new Map();
  ftsRows.forEach((r, i) => ftsMap.set(r.chunk_id, i + 1));

  const [queryVec] = await embedder.embed([queryAsChunk(query)]);
  const vecMap = new Map();
  if (queryVec !== undefined) {
    const hits = await searchVectors(lance, queryVec.embedding, CANDIDATE_LIMIT);
    hits.forEach((h, i) => vecMap.set(h.chunkId, i + 1));
  }

  const unionIds = [...new Set([...ftsMap.keys(), ...vecMap.keys()])];
  const unionChunks = await lance.getChunksByIds(unionIds);
  const centralityScoreById = scoreChunks(centrality, unionChunks);

  const centralityRanked = [...unionIds].sort((a, b) => {
    const sa = centralityScoreById.get(a) ?? 0;
    const sb = centralityScoreById.get(b) ?? 0;
    if (sb !== sa) return sb - sa;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const centralityRankMap = new Map(centralityRanked.map((id, i) => [id, i + 1]));

  const scored = unionIds.map((id) => {
    let rrf = 0;
    const f = ftsMap.get(id); const v = vecMap.get(id); const c = centralityRankMap.get(id);
    if (f !== undefined) rrf += rrfScore(f, RRF_K);
    if (v !== undefined) rrf += rrfScore(v, RRF_K);
    if (c !== undefined) rrf += rrfScore(c, RRF_K);
    return { chunk_id: id, rrf };
  });
  scored.sort((a, b) => b.rrf - a.rrf);

  const topIds = scored.slice(0, CANDIDATE_LIMIT).map((s) => s.chunk_id);
  const chunkRecords = await lance.getChunksByIds(topIds);
  const rrfByChunkId = new Map(scored.map((s) => [s.chunk_id, s.rrf]));
  chunkRecords.sort((a, b) => (rrfByChunkId.get(b.chunk_id) ?? 0) - (rrfByChunkId.get(a.chunk_id) ?? 0));

  const deduped = dedupShellMethodCollisions(chunkRecords, LIMIT);
  return deduped.map(({ chunk: c }) => ({
    file_path: c.file_path, symbol_name: c.symbol_name,
    start_line: c.start_line, end_line: c.end_line,
  }));
}

// --- scoring (identical to run.mjs / score-only.mjs) ---
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
  let dcg = 0; let firstRel = 0;
  for (let i = 0; i < Math.min(ranked.length, 10); i++) {
    const idx = matchedTargetIndex(ranked[i], targets);
    const rel = idx >= 0 && !coveredTargets.has(idx) ? 1 : 0;
    if (rel) { dcg += 1 / Math.log2(i + 2); coveredTargets.add(idx); if (firstRel === 0) firstRel = i + 1; }
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(T, 10); i++) idcg += 1 / Math.log2(i + 2);
  return { ndcg: idcg > 0 ? dcg / idcg : 0, recall: T > 0 ? coveredTargets.size / T : 0, rr: firstRel > 0 ? 1 / firstRel : 0, firstRel };
}
function rrTier(firstRel) {
  if (firstRel === 0) return 4;
  if (firstRel === 1) return 0;
  if (firstRel <= 3) return 1;
  if (firstRel <= 6) return 2;
  return 3;
}

const prior = JSON.parse(readFileSync(join(SPIKE_DIR, 'results.json'), 'utf-8'));
const beforeById = new Map(prior.perQuery.map((p) => [p.id, p.before]));

const agg = { ndcgSum: 0, recallSum: 0, mrrSum: 0, n: 0 };
const perQuery = [];
for (const q of gold.queries) {
  const ranked = await threeRankerSearch(q.query);
  const m = scoreQuery(q, ranked);
  agg.ndcgSum += m.ndcg; agg.recallSum += m.recall; agg.mrrSum += m.rr; agg.n++;
  const before = beforeById.get(q.id);
  const tier = rrTier(m.firstRel);
  perQuery.push({
    id: q.id, hard_class: q.hard_class,
    pagerank: { ndcg: +m.ndcg.toFixed(4), recall: +m.recall.toFixed(4), rr: +m.rr.toFixed(4), firstRel: m.firstRel, tier },
    ndcgDeltaVsBefore: +(m.ndcg - before.ndcg).toFixed(4),
    tierDeltaVsBefore: tier - before.tier,
  });
}

const scores = {
  ndcg: +(agg.ndcgSum / agg.n).toFixed(4),
  recall: +(agg.recallSum / agg.n).toFixed(4),
  mrr: +(agg.mrrSum / agg.n).toFixed(4),
};
const ndcgDelta = +(scores.ndcg - prior.aggregate.before.ndcg).toFixed(4);
const worstTierDelta = Math.max(...perQuery.map((p) => p.tierDeltaVsBefore));

console.log(`[pagerank arm] NDCG@10=${scores.ndcg} Recall@10=${scores.recall} MRR=${scores.mrr}`);
console.log(`[pagerank arm] delta vs before=${ndcgDelta}; worst tier delta=${worstTierDelta}`);

const out = {
  ranAt: new Date().toISOString(),
  variant: 'pagerank d=0.85, same edge set (POTENTIAL_CALL, IMPLEMENTS)',
  iterations,
  aggregate: { before: prior.aggregate.before, pagerank: scores, ndcgDelta },
  worstPerQueryTierDelta: worstTierDelta,
  perQuery,
};
writeFileSync(join(SPIKE_DIR, 'results-pagerank.json'), JSON.stringify(out, null, 2));
console.log(`wrote ${join(SPIKE_DIR, 'results-pagerank.json')}`);
await db.destroy();
