// Stage 2 — run one model end-to-end: embed the corpus, measure the rubric's
// operational axes, and score retrieval on the frozen gold set.
//
//   node eval/run-model.mjs <modelId> [dtype]
//
// Reuses the shipped code paths: runEmbed (dist/indexer) writes vectors.lance
// exactly as production does; hybridSearch (dist/search) fuses FTS+vector via
// RRF exactly as mast_search does. Only the embedder is a dtype-parametrized
// mirror of the shipped Embedder (identical mean-pool + normalize logic).
//
// Writes results/<model>__<dtype>.json. Gating: if the model cannot load or
// embed real chunks, records { gate: 'failed', ... } and exits 0 (dropped, not
// fatal — the bake-off continues).

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../dist/graph/db.js';
import { LanceStore, chunkRecordToChunk } from '../dist/store/lance.js';
import { stampVectorHashes } from '../dist/indexer/embedder.js';
import { hybridSearch } from '../dist/search/hybrid.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { getModel } from './models.mjs';
import { BASE_STATE_DIR, MODEL_CACHE_DIR, RESULTS_DIR, modelStateDir } from './paths.mjs';

const modelId = process.argv[2];
const dtype = process.argv[3] ?? 'fp32';
if (!modelId) throw new Error('usage: run-model.mjs <modelId> [dtype]');
const spec = getModel(modelId);

const SIMILARITY_THRESHOLD = 0.70;
const RRF_K = 60;
const EMBED_BATCH = 32;

mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = join(RESULTS_DIR, `${modelId.replace(/\//g, '_')}__${dtype}.json`);
const log = (...a) => console.log(`[${spec.label}/${dtype}]`, ...a);

function dirSizeBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSizeBytes(p);
    else total += statSync(p).size;
  }
  return total;
}
const modelCacheSubdir = join(MODEL_CACHE_DIR, ...modelId.split('/'));

const result = {
  modelId, label: spec.label, role: spec.role, dtype,
  license: spec.license, paramsM: spec.paramsM, codeSpecialized: spec.codeSpecialized,
  gate: 'pending', error: null,
};

try {
  // --- Fresh per-model state dir: copy the frozen corpus, drop any prior vectors. ---
  // EVAL_RESUME=1 reuses an existing state dir + embed cache (recovery after a
  // killed run whose embed already completed). Cache hits make a re-measured
  // throughput meaningless, so resume requires EVAL_THROUGHPUT_OVERRIDE (the
  // ch/s printed by the killed run) and stamps its provenance in the result.
  const resume = process.env.EVAL_RESUME === '1';
  const stateDir = modelStateDir(modelId);
  if (resume) {
    if (!existsSync(stateDir)) throw new Error(`EVAL_RESUME=1 but no state dir at ${stateDir}`);
    if (!process.env.EVAL_THROUGHPUT_OVERRIDE) throw new Error('EVAL_RESUME=1 requires EVAL_THROUGHPUT_OVERRIDE=<ch/s from the original run log>');
    log('RESUME: reusing existing state dir + embed cache');
  } else {
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    log('copying base corpus…');
    cpSync(BASE_STATE_DIR, stateDir, { recursive: true });
    rmSync(join(stateDir, 'lance', 'vectors.lance'), { recursive: true, force: true });
  }

  // --- Load (gating proof: must load ONNX in Transformers.js) ---
  const _rssBefore = process.memoryUsage().rss;
  const cacheBefore = dirSizeBytes(modelCacheSubdir);
  const embedder = new HarnessEmbedder(modelId, MODEL_CACHE_DIR, stateDir, dtype);
  const tLoad0 = Date.now();
  await embedder.load();
  const loadMs = Date.now() - tLoad0;
  const rssAfterLoad = process.memoryUsage().rss;
  result.dims = embedder.dimension;
  result.loadMs = loadMs;
  log(`loaded: dims=${embedder.dimension} loadMs=${loadMs}`);

  // --- Query latency: 28 distinct short gold queries, uncached, warm, median. ---
  // In resume mode the previous run's numbers were measured on an idle machine;
  // carry them over rather than re-timing under whatever load exists now.
  const gold = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf-8'));
  const prevResult = resume && existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf-8')) : null;
  if (prevResult?.queryLatencyMedianMs != null) {
    result.queryLatencyMedianMs = prevResult.queryLatencyMedianMs;
    result.queryLatencyP90Ms = prevResult.queryLatencyP90Ms;
    result.latencySource = 'measured by the original run (resume carries it over)';
    log(`query latency (carried over) median=${result.queryLatencyMedianMs}ms p90=${result.queryLatencyP90Ms}ms`);
  } else {
    // Warm-up (JIT + first-inference allocation) before timing.
    for (let i = 0; i < 3; i++) await embedder.embedRawUncached('warmup query for jit');
    const latencies = [];
    for (const q of gold.queries) {
      const t = Date.now();
      await embedder.embedRawUncached(q.query);
      latencies.push(Date.now() - t);
    }
    latencies.sort((a, b) => a - b);
    result.queryLatencyMedianMs = latencies[Math.floor(latencies.length / 2)];
    result.queryLatencyP90Ms = latencies[Math.floor(latencies.length * 0.9)];
    log(`query latency median=${result.queryLatencyMedianMs}ms p90=${result.queryLatencyP90Ms}ms`);
  }

  // --- Index throughput: embed the FROZEN subset (gold targets + distractors). ---
  // We open the store, ensure a vectors table at this model's dim, then embed the
  // subset chunks and store them via the shipped storage path (stampVectorHashes
  // + LanceStore.upsertVectors). The chunks.lance + FTS side stays full-corpus so
  // hybrid search still fuses against all 12.8k lexical candidates.
  const subset = JSON.parse(readFileSync(new URL('./corpus-subset.json', import.meta.url), 'utf-8'));
  const embedStore = await LanceStore.open(stateDir);
  const subsetRecords = await embedStore.getChunksByIds(subset.chunkIds);
  await embedStore.ensureVectorsTable(embedder.dimension);
  log(`embedding ${subsetRecords.length}-chunk subset (slow part)…`);
  const tEmbed0 = Date.now();
  let embedded = 0;
  for (let i = 0; i < subsetRecords.length; i += EMBED_BATCH) {
    const batch = subsetRecords.slice(i, i + EMBED_BATCH).map(chunkRecordToChunk);
    const vectors = await embedder.embed(batch);
    await embedStore.upsertVectors(stampVectorHashes(vectors, batch));
    embedded += batch.length;
    if (embedded % 1024 < EMBED_BATCH || embedded === subsetRecords.length) log(`  embedded ${embedded}/${subsetRecords.length}`);
  }
  const embedWallMs = Date.now() - tEmbed0;
  result.chunksEmbedded = embedded;
  result.subsetSize = subset.size;
  result.embedWallMs = embedWallMs;
  result.embedBatchSize = EMBED_BATCH;
  if (resume) {
    result.throughputChunksPerSec = Number(process.env.EVAL_THROUGHPUT_OVERRIDE);
    result.throughputSource = 'measured by the original (killed) run; resume re-embed was cache-hits only';
  } else {
    result.throughputChunksPerSec = +(embedded / (embedWallMs / 1000)).toFixed(2);
  }
  log(`throughput=${result.throughputChunksPerSec} ch/s over ${embedded} chunks`);

  // --- Footprint: download size + vectors.lance on-disk + rss ---
  result.downloadBytes = dirSizeBytes(modelCacheSubdir) - cacheBefore + cacheBefore; // absolute size of this model's cache
  result.downloadBytesAbs = dirSizeBytes(modelCacheSubdir);
  result.vectorsLanceBytes = dirSizeBytes(join(stateDir, 'lance', 'vectors.lance'));
  result.rssAfterLoadBytes = rssAfterLoad;
  result.rssPeakBytes = process.memoryUsage().rss;
  // Projected vectors.lance for full ~12.8k corpus (fp32 vector payload = dims*4*N).
  const N = 12853;
  result.projectedVectorPayloadBytes = embedder.dimension * 4 * N;

  // --- Scoring: pure-vector + hybrid@0.70 (shipped) + hybrid@0 (threshold-free) ---
  const db = openDatabase(stateDir);
  const lance = await LanceStore.open(stateDir);

  const scoreVariants = {
    pure_vector: { agg: newAgg(), perQuery: [] },
    hybrid_shipped: { agg: newAgg(), perQuery: [] },
    hybrid_thresh0: { agg: newAgg(), perQuery: [] },
  };
  let vectorAboveThresholdQueries = 0;

  for (const q of gold.queries) {
    // Pure vector: raw cosine ranking, no threshold — isolates the model.
    const qVec = await embedder.embedRawUncached(q.query);
    const vhits = await lance.searchVectors(qVec, 40);
    const vScored = vhits.map((h) => ({ chunk_id: h.chunk_id, score: 1 - h._distance }));
    const anyAbove = vScored.some((h) => h.score >= SIMILARITY_THRESHOLD);
    if (anyAbove) vectorAboveThresholdQueries++;
    const vRecs = await lance.getChunksByIds(vScored.map((h) => h.chunk_id));
    const vById = new Map(vRecs.map((r) => [r.chunk_id, r]));
    const pureRanked = vScored
      .map((h) => vById.get(h.chunk_id))
      .filter(Boolean)
      .slice(0, 10)
      .map((r) => ({ file_path: r.file_path, symbol_name: r.symbol_name, start_line: r.start_line, end_line: r.end_line }));
    scoreOne(scoreVariants.pure_vector, q, pureRanked);

    // Hybrid @0.70 (exact shipped config) and @0 (threshold-free) via real code path.
    const hShipped = await hybridSearch(db, lance, embedder, { query: q.query, limit: 10 }, { rrf_k: RRF_K, similarity_threshold: SIMILARITY_THRESHOLD });
    scoreOne(scoreVariants.hybrid_shipped, q, hShipped.results);

    const hThresh0 = await hybridSearch(db, lance, embedder, { query: q.query, limit: 10 }, { rrf_k: RRF_K, similarity_threshold: 0 });
    scoreOne(scoreVariants.hybrid_thresh0, q, hThresh0.results);
  }

  for (const v of Object.values(scoreVariants)) finalizeAgg(v.agg);
  result.scores = {
    pure_vector: scoreVariants.pure_vector.agg,
    hybrid_shipped: scoreVariants.hybrid_shipped.agg,
    hybrid_thresh0: scoreVariants.hybrid_thresh0.agg,
  };
  result.perQuery = {
    pure_vector: scoreVariants.pure_vector.perQuery,
    hybrid_shipped: scoreVariants.hybrid_shipped.perQuery,
    hybrid_thresh0: scoreVariants.hybrid_thresh0.perQuery,
  };
  result.vectorAboveThresholdQueries = vectorAboveThresholdQueries;
  result.goldQueryCount = gold.queries.length;
  result.gate = 'passed';
  await db.destroy();
  log(`SCORES hybrid_shipped NDCG@10=${result.scores.hybrid_shipped.ndcg} pure_vector NDCG@10=${result.scores.pure_vector.ndcg}`);

  // per-query stash for the variant we report on primarily
  function scoreOne(variant, q, ranked) {
    const m = scoreQuery(q, ranked);
    variant.agg.ndcgSum += m.ndcg;
    variant.agg.recallSum += m.recall;
    variant.agg.mrrSum += m.rr;
    variant.agg.n++;
    variant.perQuery.push({ id: q.id, ndcg: +m.ndcg.toFixed(3), recall: +m.recall.toFixed(3), rr: +m.rr.toFixed(3), firstRel: m.firstRel });
  }
} catch (err) {
  result.gate = 'failed';
  result.error = String(err && err.stack ? err.stack : err);
  log('GATE FAILED:', result.error.split('\n')[0]);
}

writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(`\nwrote ${outFile}`);

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function newAgg() { return { ndcgSum: 0, recallSum: 0, mrrSum: 0, n: 0 }; }
function finalizeAgg(a) {
  a.ndcg = +(a.ndcgSum / a.n).toFixed(4);
  a.recall = +(a.recallSum / a.n).toFixed(4);
  a.mrr = +(a.mrrSum / a.n).toFixed(4);
}

/** Relevance: file match AND (symbol match OR line containment). Returns the
 *  index of the matched target (for distinct-target recall) or -1. */
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
    // Only the FIRST chunk matching a given target earns DCG credit — a second
    // chunk hitting the same target (e.g. a split class shell) would push NDCG
    // above 1 because IDCG assumes each target is one ideal document.
    const rel = idx >= 0 && !coveredTargets.has(idx) ? 1 : 0;
    if (rel) {
      dcg += 1 / Math.log2(i + 2); // rank i (0-based) -> position i+1
      coveredTargets.add(idx);
      if (firstRel === 0) firstRel = i + 1;
    }
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(T, 10); i++) idcg += 1 / Math.log2(i + 2);
  const ndcg = idcg > 0 ? dcg / idcg : 0;
  const recall = T > 0 ? coveredTargets.size / T : 0;
  const rr = firstRel > 0 ? 1 / firstRel : 0;
  return { ndcg, recall, rr, firstRel };
}
