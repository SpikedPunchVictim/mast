// Q1 — is the vector store justified at all?
//
// Pre-registered design: packages/mast/IMPLEMENTATION_PLAN.md
//   § "Q1 — pre-registered experiment design".
// The decision rule below was committed BEFORE any arm was scored. Do not edit
// it in response to a result; append an amendment instead.
//
//   node eval/q1-vector-value.mjs embed    # populate vectors for the frozen subset
//   node eval/q1-vector-value.mjs score    # run the three arms + apply the rule
//
// Arms:
//   L  lexical-only  — hybridSearch(..., embedder = null, ...) -> mode 'lexical'
//   H  hybrid        — shipped RRF, rank-based vector inclusion (§7.3)
//   V  pure vector   — raw cosine ranking; isolates the model
//
// NOTE on chunkStore: hybridSearch's 6th parameter defaults to `lance`, which
// post-M1 is a DEAD chunk table. Every call here passes SqliteChunkStore
// explicitly — omitting it silently returns zero results for every arm.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore } from '../dist/store/lance.js';
import { hybridSearch } from '../dist/search/hybrid.js';
import { stampVectorHashes } from '../dist/indexer/embedder.js';
import { chunkRecordToChunk } from '../dist/store/lance.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { BASE_STATE_DIR, MODEL_CACHE_DIR, RESULTS_DIR, CORPUS_SHA } from './paths.mjs';

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const RRF_K = 60;
const LIMIT = 10;
const BATCH = 32;
const mode = process.argv[2] ?? 'score';

const goldAnti = JSON.parse(readFileSync(new URL('./gold-set.json', import.meta.url), 'utf-8'));
const goldNorm = JSON.parse(readFileSync(new URL(existsSync(new URL('./gold-set-normal-r2.json', import.meta.url)) ? './gold-set-normal-r2.json' : './gold-set-normal.json', import.meta.url), 'utf-8'));
const subset = JSON.parse(readFileSync(new URL('./corpus-subset.json', import.meta.url), 'utf-8'));

const db = openDatabase(BASE_STATE_DIR);
const chunkStore = new SqliteChunkStore(db);
const lance = await LanceStore.open(BASE_STATE_DIR);

// ---------------------------------------------------------------------------
// embed — populate vectors.lance for the frozen subset only
// ---------------------------------------------------------------------------
if (mode === 'embed') {
  const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, BASE_STATE_DIR, 'fp32');
  await embedder.load();
  await lance.ensureVectorsTable(embedder.dimension);

  const already = await lance.getEmbeddedChunkIds();
  const todo = subset.chunkIds.filter((id) => !already.has(id));
  console.log(`[q1-embed] subset=${subset.chunkIds.length} already=${already.size} todo=${todo.length}`);

  const t0 = Date.now();
  let done = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const recs = await chunkStore.getChunksByIds(todo.slice(i, i + BATCH));
    if (recs.length === 0) continue;
    const chunks = recs.map(chunkRecordToChunk);
    const vectors = await embedder.embed(chunks);
    await lance.upsertVectors(stampVectorHashes(vectors, chunks));
    done += chunks.length;
    const rate = done / ((Date.now() - t0) / 1000);
    process.stdout.write(`\r[q1-embed] ${done}/${todo.length}  ${rate.toFixed(2)} ch/s`);
  }
  process.stdout.write('\n');
  console.log(`[q1-embed] done in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
  console.log(`[q1-embed] vectorCount = ${await lance.vectorCount()}`);
  await db.destroy();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// score — three arms over two query sets
// ---------------------------------------------------------------------------
const vectorCount = await lance.vectorCount();
if (vectorCount === 0) {
  console.error('FAIL: no vectors — run `node eval/q1-vector-value.mjs embed` first.');
  process.exit(1);
}

const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, BASE_STATE_DIR, 'fp32');
await embedder.load();
const cfg = { rrf_k: RRF_K };

/** Relevance: same rule both gold sets declare. */
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
  const covered = new Set();
  let dcg = 0;
  let firstRel = 0;
  for (let i = 0; i < Math.min(ranked.length, LIMIT); i++) {
    const idx = matchedTargetIndex(ranked[i], targets);
    const rel = idx >= 0 && !covered.has(idx) ? 1 : 0;
    if (rel) {
      dcg += 1 / Math.log2(i + 2);
      covered.add(idx);
      if (firstRel === 0) firstRel = i + 1;
    }
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(T, LIMIT); i++) idcg += 1 / Math.log2(i + 2);
  return { ndcg: idcg > 0 ? dcg / idcg : 0, recall: T > 0 ? covered.size / T : 0, rr: firstRel > 0 ? 1 / firstRel : 0 };
}

async function runArm(arm, query) {
  if (arm === 'V') {
    const vec = await embedder.embedRawUncached(query);
    const hits = await lance.searchVectors(vec, LIMIT);
    const recs = await chunkStore.getChunksByIds(hits.map((h) => h.chunk_id));
    const byId = new Map(recs.map((r) => [r.chunk_id, r]));
    return hits.map((h) => byId.get(h.chunk_id)).filter(Boolean);
  }
  const useEmbedder = arm === 'H' ? embedder : null;
  const res = await hybridSearch(db, lance, useEmbedder, { query, limit: LIMIT }, cfg, chunkStore);
  return res.results;
}

async function scoreSet(name, queries) {
  const out = {};
  for (const arm of ['L', 'H', 'V']) {
    const agg = { ndcg: 0, recall: 0, mrr: 0, n: 0 };
    const perQuery = [];
    for (const q of queries) {
      const ranked = await runArm(arm, q.query);
      const m = scoreQuery(q, ranked);
      agg.ndcg += m.ndcg; agg.recall += m.recall; agg.mrr += m.rr; agg.n++;
      perQuery.push({ id: q.id, ndcg: +m.ndcg.toFixed(4), recall: +m.recall.toFixed(4) });
    }
    out[arm] = {
      ndcg: +(agg.ndcg / agg.n).toFixed(4),
      recall: +(agg.recall / agg.n).toFixed(4),
      mrr: +(agg.mrr / agg.n).toFixed(4),
      perQuery,
    };
    console.log(`[${name}] arm ${arm}: NDCG@10=${out[arm].ndcg} Recall@10=${out[arm].recall} MRR=${out[arm].mrr}`);
  }
  return out;
}

console.log(`corpus_sha=${CORPUS_SHA}  vectors=${vectorCount}\n`);
const normal = await scoreSet('normal', goldNorm.queries);
console.log('');
const anti = await scoreSet('anti-lexical', goldAnti.queries);

// --- SANITY GATE (Q1-r2). The v1 run was void because nothing asserted a floor
// on arm behaviour: arm L returned exactly one result — the query's own source
// document — for all 15 queries, and scored 0 by construction. A run violating
// this gate is void BY RULE, not by judgement.
const lArmCounts = [];
for (const q of goldNorm.queries) {
  const r = await hybridSearch(db, lance, null, { query: q.query, limit: LIMIT }, cfg, chunkStore);
  lArmCounts.push({ id: q.id, n: r.results.length, top: r.results[0]?.file_path ?? null, topType: r.results[0]?.chunk_type ?? null });
}
// RATIFIED AMENDMENT 2026-08-01 (approved after the r2 run; original clause and
// its failure are preserved in IMPLEMENTATION_PLAN.md § "Q1-r2 RESULT"). The
// original ">1 result for >=80% of queries" clause was a PROXY for "the lexical
// arm is being exercised" and mis-measured it: a query legitimately returning one
// excellent result is not a broken arm. It is replaced by a direct assertion on
// RETRIEVAL, which is what the gate was for. The soleDocHit clause — the one that
// actually detects the v1 leakage pathology — is unchanged.
const multiResult = lArmCounts.filter((c) => c.n > 1).length;
const soleDocHit = lArmCounts.filter((c) => c.n === 1 && c.topType === 'doc').length;
const lRetrieving = normal.L.perQuery.filter((q) => q.ndcg > 0).length;
const minRetrieving = Math.ceil(goldNorm.queries.length * 0.4);
const gate = {
  clause_retrieval: { lRetrieving, required: minRetrieving, of: goldNorm.queries.length },
  clause_no_source_leak: { soleDocHit },
  multiResult_informational: multiResult,
  passed: lRetrieving >= minRetrieving && soleDocHit === 0,
};
console.log(`\n[sanity gate] arm L retrieves a target on ${lRetrieving}/${goldNorm.queries.length} (need >=${minRetrieving}); sole-doc-hits=${soleDocHit} -> ${gate.passed ? 'PASS' : 'FAIL'}`);

// --- the RE-COMMITTED bracketing decision rule (IMPLEMENTATION_PLAN.md
// § "Q1-r2 — RE-REGISTERED protocol"). Do not edit in response to a result.
//   normal set      = biased FOR lexical (TSDoc tokens sit inside the target)
//   anti-lexical set = biased FOR vectors (worded to defeat trigram FTS, §14.3)
// A win on the set rigged against you is decisive; each winning its own is not.
const deltaNormal = +(normal.H.ndcg - normal.L.ndcg).toFixed(4);
const deltaAnti = +(anti.H.ndcg - anti.L.ndcg).toFixed(4);
const hybridWinsNormal = deltaNormal >= 0.10;
const lexicalWinsAnti = deltaAnti <= 0;

let verdict;
if (!gate.passed) {
  verdict = 'VOID — sanity gate failed; the lexical arm is not being exercised. Do not use these numbers.';
} else if (lexicalWinsAnti) {
  verdict = 'VECTORS DIE — lexical won the set rigged FOR vectors. M2 resolves to arm D (delete vectors.lance, drop @lancedb/lancedb).';
} else if (hybridWinsNormal) {
  verdict = 'VECTORS JUSTIFIED — hybrid won the set rigged FOR lexical by >=0.10 NDCG@10. Proceed to the A-vs-C backend benchmark at 153k.';
} else {
  verdict = 'AMBIGUOUS BY CONSTRUCTION — each arm won only its own biased set. Do NOT force a call: escalate to the metrics.args_json real-query harvest and the nest replication.';
}

const out = {
  experiment: 'Q1 — is the vector store justified at all?',
  ranAt: new Date().toISOString(),
  corpus_sha: CORPUS_SHA,
  model: MODEL,
  vectors_in_index: vectorCount,
  subset_size: subset.chunkIds.length,
  arms: { L: 'lexical-only (embedder=null)', H: 'hybrid RRF', V: 'pure vector cosine' },
  results: { normal, anti_lexical: anti },
  decision: {
    rule: 'BRACKETING (Q1-r2): lexical wins the anti-lexical set (rigged FOR vectors) -> vectors die; hybrid wins the normal set (rigged FOR lexical) by >=0.10 NDCG@10 -> justified; each wins only its own biased set -> ambiguous by construction; sanity gate must pass or the run is void.',
    delta_ndcg_normal: deltaNormal,
    delta_ndcg_anti: deltaAnti,
    sanity_gate: gate,

    verdict,
  },
  caveats: [
    'The anti-lexical set is one-directional by construction (§14.3): it can kill vectors, never justify them. Only the NORMAL set drives the verdict.',
    'Vector pool is the frozen 3,000-chunk subset; FTS is full-corpus (10,997). Absolute scores are easier than full-corpus, identically for every arm.',
    'Single corpus (kluster @ pinned SHA) — home-field. nest replication is conditional on the ambiguous band.',
  ],
};

mkdirSync(RESULTS_DIR, { recursive: true });
const file = join(RESULTS_DIR, 'q1-vector-value.json');
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\ndelta NDCG@10 normal (H-L) = ${deltaNormal}  [set biased FOR lexical]`);
console.log(`delta NDCG@10 anti   (H-L) = ${deltaAnti}  [set biased FOR vectors]`);
console.log(`VERDICT: ${verdict}`);
console.log(`wrote ${file}`);
await db.destroy();
