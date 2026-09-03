// Stage 3.1 offline experiment — graph centrality as a third RRF ranker.
//
// Quarantined spike per IMPLEMENTATION_PLAN_VEXP.md Feature 3 / Stage 3.1.
// NOT wired into production hybridSearch. Mirrors the score-only.mjs
// before/after pattern: imports compiled dist/ modules, re-scores the frozen
// 28-query gold set without re-embedding anything.
//
//   node eval/spikes/centrality/run.mjs
//
// Before arm: calls the shipped `hybridSearch` UNCHANGED (2-ranker FTS+vector
// RRF) — this is the production code path, not a reimplementation, so its
// fidelity is guaranteed by construction. Its aggregate NDCG@10 is validated
// against the recorded N1 baseline (~0.580, eval/results/task9-score-after.json)
// before the after-arm is trusted (plan step: "if before differs by more than
// ~0.02, STOP and diagnose").
//
// After arm: reimplements the RRF fusion using the same exported primitives
// hybridSearch itself calls (searchFts, searchVectors, rrfScore,
// dedupShellMethodCollisions) plus a third rank list — the candidate union
// (FTS ∪ vector), ranked by in-degree centrality descending, chunk_id as a
// deterministic tie-break. Candidates are never injected from outside that
// union (§ Stage 3.2 design: "centrality re-orders matches, it never adds
// them").

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../../dist/graph/db.js';
import { LanceStore } from '../../../dist/store/lance.js';
import { hybridSearch, rrfScore, dedupShellMethodCollisions } from '../../../dist/search/hybrid.js';
import { searchFts } from '../../../dist/search/fts.js';
import { searchVectors } from '../../../dist/search/vector.js';
import { HarnessEmbedder } from '../../harness-embedder.mjs';
import { MODEL_CACHE_DIR, BASE_STATE_DIR, RESULTS_DIR, modelStateDir } from '../../paths.mjs';
import { computeInDegreeCentrality, scoreChunks, coverageStats } from './centrality.mjs';

const INCUMBENT = 'jinaai/jina-embeddings-v2-base-code';
const RRF_K = 60;
const LIMIT = 10;
const CANDIDATE_LIMIT = LIMIT * 4; // mirrors hybridSearch's `limit * 4` over-fetch
const BASELINE_NDCG = 0.580;
const BASELINE_TOLERANCE = 0.02;
const PROMOTE_DELTA = 0.05;

const SPIKE_DIR = new URL('.', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// 1. Centrality — computed over the FULL corpus (base-state graph.db), not
//    the embedded subset, per Stage 3.1 step 1 ("Record the mapping coverage
//    ... % of corpus chunks").
// ---------------------------------------------------------------------------
const { centrality, symbolCount, edgeCount } = computeInDegreeCentrality(BASE_STATE_DIR);

const baseLance = await LanceStore.open(BASE_STATE_DIR);
const allChunks = await baseLance.getAllChunks();
const fullCorpusScores = scoreChunks(centrality, allChunks);
const coverage = coverageStats(fullCorpusScores);
console.log(
  `[centrality] symbols=${symbolCount} in-degree edges (POTENTIAL_CALL+IMPLEMENTS)=${edgeCount} ` +
  `corpus chunks=${coverage.total} nonzero=${coverage.nonzero} coverage=${coverage.coveragePct.toFixed(2)}%`,
);

// ---------------------------------------------------------------------------
// 2/3. Before + after arms over the incumbent's embedded subset state dir.
// ---------------------------------------------------------------------------
const gold = JSON.parse(readFileSync(new URL('../../gold-set.json', import.meta.url), 'utf-8'));
const stateDir = modelStateDir(INCUMBENT);

const embedder = new HarnessEmbedder(INCUMBENT, MODEL_CACHE_DIR, stateDir, 'fp32');
await embedder.load();
const db = openDatabase(stateDir);
const lance = await LanceStore.open(stateDir);

/** Wrap a raw query string as a minimal Chunk for the embedder — copied from
 *  src/search/hybrid.ts `queryAsChunk` (not exported; trivial pure helper). */
function queryAsChunk(query) {
  return {
    chunk_id: '__query__', file_path: '__query__', start_line: 0, end_line: 0,
    content: query, chunk_type: 'block', symbol_name: null, parent_symbol: null,
    is_exported: false, language: 'typescript', file_mtime: 0,
  };
}

/** Reimplementation of the shipped RRF fusion (hybrid.ts) plus a third
 *  centrality rank list built from the FTS ∪ vector candidate union only. */
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

  // Deterministic centrality ranking: score desc, chunk_id asc tie-break.
  const centralityRanked = [...unionIds].sort((a, b) => {
    const sa = centralityScoreById.get(a) ?? 0;
    const sb = centralityScoreById.get(b) ?? 0;
    if (sb !== sa) return sb - sa;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const centralityRankMap = new Map(centralityRanked.map((id, i) => [id, i + 1]));

  const scored = unionIds.map((id) => {
    let rrf = 0;
    const ftsRank = ftsMap.get(id);
    const vecRank = vecMap.get(id);
    const cenRank = centralityRankMap.get(id);
    if (ftsRank !== undefined) rrf += rrfScore(ftsRank, RRF_K);
    if (vecRank !== undefined) rrf += rrfScore(vecRank, RRF_K);
    if (cenRank !== undefined) rrf += rrfScore(cenRank, RRF_K);
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

// --- scoring (identical to score-only.mjs / run-model.mjs) ---
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

/** Rank tier bucketing for the per-query degradation gate. Mechanical,
 *  documented interpretation (the plan defines tiers only for NDCG score
 *  resolution, ±30%, not for rank position) — see REPORT.md discussion. */
function rrTier(firstRel) {
  if (firstRel === 0) return 4; // not found in top 10
  if (firstRel === 1) return 0; // rank 1
  if (firstRel <= 3) return 1;  // rank 2-3
  if (firstRel <= 6) return 2;  // rank 4-6
  return 3;                     // rank 7-10
}

const perQuery = [];
const beforeAgg = { ndcgSum: 0, recallSum: 0, mrrSum: 0, n: 0 };
const afterAgg = { ndcgSum: 0, recallSum: 0, mrrSum: 0, n: 0 };

for (const q of gold.queries) {
  const beforeRes = await hybridSearch(db, lance, embedder, { query: q.query, limit: LIMIT }, { rrf_k: RRF_K });
  const beforeM = scoreQuery(q, beforeRes.results);
  beforeAgg.ndcgSum += beforeM.ndcg; beforeAgg.recallSum += beforeM.recall; beforeAgg.mrrSum += beforeM.rr; beforeAgg.n++;

  const afterRanked = await threeRankerSearch(q.query);
  const afterM = scoreQuery(q, afterRanked);
  afterAgg.ndcgSum += afterM.ndcg; afterAgg.recallSum += afterM.recall; afterAgg.mrrSum += afterM.rr; afterAgg.n++;

  const beforeTier = rrTier(beforeM.firstRel);
  const afterTier = rrTier(afterM.firstRel);
  perQuery.push({
    id: q.id, query: q.query, hard_class: q.hard_class,
    before: { ndcg: +beforeM.ndcg.toFixed(4), recall: +beforeM.recall.toFixed(4), rr: +beforeM.rr.toFixed(4), firstRel: beforeM.firstRel, tier: beforeTier },
    after: { ndcg: +afterM.ndcg.toFixed(4), recall: +afterM.recall.toFixed(4), rr: +afterM.rr.toFixed(4), firstRel: afterM.firstRel, tier: afterTier },
    ndcgDelta: +(afterM.ndcg - beforeM.ndcg).toFixed(4),
    tierDelta: afterTier - beforeTier, // positive = degraded (moved to a worse/higher-numbered tier)
  });
}

const beforeScores = {
  ndcg: +(beforeAgg.ndcgSum / beforeAgg.n).toFixed(4),
  recall: +(beforeAgg.recallSum / beforeAgg.n).toFixed(4),
  mrr: +(beforeAgg.mrrSum / beforeAgg.n).toFixed(4),
};
const afterScores = {
  ndcg: +(afterAgg.ndcgSum / afterAgg.n).toFixed(4),
  recall: +(afterAgg.recallSum / afterAgg.n).toFixed(4),
  mrr: +(afterAgg.mrrSum / afterAgg.n).toFixed(4),
};

const baselineDelta = +(beforeScores.ndcg - BASELINE_NDCG).toFixed(4);
const baselineValidated = Math.abs(baselineDelta) <= BASELINE_TOLERANCE;

const ndcgDelta = +(afterScores.ndcg - beforeScores.ndcg).toFixed(4);
const worstTierDelta = Math.max(...perQuery.map((p) => p.tierDelta));
const anyQueryDegradedMoreThanOneTier = worstTierDelta > 1;

let verdict;
if (!baselineValidated) {
  verdict = 'INVALID — before-arm does not reproduce the recorded baseline within tolerance; harness reproduction is suspect, gate not applied';
} else if (ndcgDelta >= PROMOTE_DELTA && !anyQueryDegradedMoreThanOneTier) {
  verdict = 'PROMOTE';
} else if (ndcgDelta <= 0) {
  verdict = 'REJECT';
} else {
  verdict = 'HOLD-IN-RESERVE';
}

console.log(`\n[before] NDCG@10=${beforeScores.ndcg} Recall@10=${beforeScores.recall} MRR=${beforeScores.mrr}`);
console.log(`[before] baseline validation: recorded=${BASELINE_NDCG} measured=${beforeScores.ndcg} delta=${baselineDelta} (tolerance ±${BASELINE_TOLERANCE}) -> ${baselineValidated ? 'OK' : 'FAILED'}`);
console.log(`[after]  NDCG@10=${afterScores.ndcg} Recall@10=${afterScores.recall} MRR=${afterScores.mrr}`);
console.log(`[gate]   NDCG delta=${ndcgDelta} (promote threshold +${PROMOTE_DELTA}); worst per-query tier delta=${worstTierDelta} (fail threshold >1)`);
console.log(`[gate]   VERDICT: ${verdict}`);

const out = {
  ranAt: new Date().toISOString(),
  provenance: {
    corpusPath: 'rebuilt (2026-07-15) — frozen 2026-07-10 base-state graph.db was absent (only chunks.lance survived; see REPORT.md)',
    model: INCUMBENT,
    dtype: 'fp32',
    rrf_k: RRF_K,
    limit: LIMIT,
    candidatePoolSize: CANDIDATE_LIMIT,
    corpusChunks: coverage.total,
    subsetEmbedded: null, // filled in below from the model-state dir if available
  },
  centrality: {
    method: 'in-degree, edge_type IN (POTENTIAL_CALL, IMPLEMENTS)',
    symbolCount,
    edgeCount,
    coverage,
  },
  baselineValidation: {
    recordedBaselineNdcg: BASELINE_NDCG,
    measuredBeforeNdcg: beforeScores.ndcg,
    delta: baselineDelta,
    tolerance: BASELINE_TOLERANCE,
    ok: baselineValidated,
  },
  aggregate: { before: beforeScores, after: afterScores, ndcgDelta },
  gate: {
    promoteThreshold: PROMOTE_DELTA,
    ndcgDelta,
    worstPerQueryTierDelta: worstTierDelta,
    anyQueryDegradedMoreThanOneTier,
    verdict,
  },
  perQuery,
};

mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = join(SPIKE_DIR, 'results.json');
writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`\nwrote ${outFile}`);

await db.destroy();
