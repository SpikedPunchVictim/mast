// F16 — is RRF fusion mis-tuned? Sweep rrf_k against the pure-vector baseline.
//
// Post-F15, arm V (pure vector) beats arm H (shipped hybrid) on 2 of 3 measured
// sets. Hypothesis: `rrf_k = 60` is calibrated for TREC-style pools of ~1000,
// but hybridSearch fuses a pool of `limit * 4 = 40`. At k=60 the constant
// dominates the rank: rrfScore(1,60)=0.01639 vs rrfScore(40,60)=0.01000 — rank 1
// and rank 40 differ by only 64%, while merely APPEARING IN BOTH lists roughly
// doubles the score. So "weak lexical match that is also a mediocre vector
// match" outranks "the true target at vector rank 1, absent from FTS top-40".
// F15's OR-join made this worse by admitting many more weak lexical candidates.
//
//   node eval/f16-rrf-sweep.mjs

import { readFileSync } from 'node:fs';
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore } from '../dist/store/lance.js';
import { hybridSearch } from '../dist/search/hybrid.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { MODEL_CACHE_DIR } from './paths.mjs';

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const LIMIT = 10;
const K_VALUES = [0, 1, 2, 5, 10, 20, 40, 60, 120];
const HOME = process.env.HOME;

const SETS = [
  { name: 'kluster-normal', state: `${HOME}/.cache/mast-eval/base-state-r2`, file: './gold-set-normal-r2.json', match: 'line' },
  { name: 'kluster-anti', state: `${HOME}/.cache/mast-eval/base-state-r2`, file: './gold-set.json', match: 'both' },
  { name: 'nest', state: `${HOME}/.cache/mast-eval/base-state-nest`, file: './gold-set-nest.json', match: 'symbol' },
];

function ndcgFor(q, ranked, mode) {
  const targets = q.relevant;
  const covered = new Set();
  let dcg = 0;
  for (let i = 0; i < Math.min(ranked.length, LIMIT); i++) {
    const r = ranked[i];
    let idx = -1;
    for (let k = 0; k < targets.length; k++) {
      const t = targets[k];
      if (t.file_path !== r.file_path) continue;
      const bySym = t.symbol != null && r.symbol_name === t.symbol;
      const byLine = t.line != null && r.start_line != null && t.line >= r.start_line && t.line <= r.end_line;
      if (mode === 'symbol' ? bySym : mode === 'line' ? byLine : bySym || byLine) { idx = k; break; }
    }
    if (idx >= 0 && !covered.has(idx)) { dcg += 1 / Math.log2(i + 2); covered.add(idx); }
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(targets.length, LIMIT); i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

for (const set of SETS) {
  const gold = JSON.parse(readFileSync(new URL(set.file, import.meta.url), 'utf-8'));
  const db = openDatabase(set.state);
  const chunkStore = new SqliteChunkStore(db);
  const lance = await LanceStore.open(set.state);
  const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, set.state, 'fp32');
  await embedder.load();

  // baselines
  const score = async (embOrNull, k) => {
    let sum = 0;
    for (const q of gold.queries) {
      const r = await hybridSearch(db, lance, embOrNull, { query: q.query, limit: LIMIT }, { rrf_k: k }, chunkStore);
      sum += ndcgFor(q, r.results, set.match);
    }
    return sum / gold.queries.length;
  };

  // pure vector baseline (rank by cosine only, no fusion)
  let vSum = 0;
  for (const q of gold.queries) {
    const hits = await lance.searchVectors(await embedder.embedRawUncached(q.query), LIMIT);
    const recs = await chunkStore.getChunksByIds(hits.map((h) => h.chunk_id));
    const byId = new Map(recs.map((r) => [r.chunk_id, r]));
    vSum += ndcgFor(q, hits.map((h) => byId.get(h.chunk_id)).filter(Boolean), set.match);
  }
  const V = vSum / gold.queries.length;
  const L = await score(null, 60);

  const row = [];
  for (const k of K_VALUES) row.push({ k, ndcg: +(await score(embedder, k)).toFixed(4) });

  const best = row.reduce((a, b) => (b.ndcg > a.ndcg ? b : a));
  console.log(`\n=== ${set.name} (n=${gold.queries.length})  L=${L.toFixed(4)}  V=${V.toFixed(4)} ===`);
  console.log(row.map((r) => `k=${String(r.k).padStart(3)}: ${r.ndcg.toFixed(4)}${r.k === 60 ? ' (shipped)' : ''}${r === best ? '  <-- best' : ''}`).join('\n'));
  console.log(`best hybrid ${best.ndcg} @ k=${best.k}  |  vs V ${V.toFixed(4)}  ->  ${best.ndcg > V ? 'HYBRID WINS' : 'VECTOR STILL WINS'}`);
  await db.destroy();
}
