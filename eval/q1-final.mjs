// Q1/F16 re-run against FULL embeds, with inferential statistics.
//
// Corrections applied vs. the withdrawn run (adversarial review, 2026-08-01):
//  - Full corpus embedded (no subset asymmetry, no needle-seeding advantage).
//  - ONE relevance matcher for every corpus (symbol OR line containment). The
//    prior runs used line-containment on kluster and exact-symbol on nest, which
//    made 0.2477 and 0.1082 non-comparable.
//  - Paired confidence intervals, not point estimates. Every prior threshold in
//    this program was applied to a bare mean; the external "margin" turned out to
//    be 9x smaller than its own standard error.
//
//   node eval/q1-final.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore } from '../dist/store/lance.js';
import { hybridSearch } from '../dist/search/hybrid.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { MODEL_CACHE_DIR, RESULTS_DIR } from './paths.mjs';

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const LIMIT = 10;
const HOME = process.env.HOME;
const SETS = [
  { name: 'kluster-normal', bias: 'declared FOR lexical (UNVALIDATED - see review)', state: `${HOME}/.cache/mast-eval/base-state-r2`, file: './gold-set-normal-r2.json' },
  { name: 'kluster-anti', bias: 'FOR vectors (worded to defeat trigram FTS)', state: `${HOME}/.cache/mast-eval/base-state-r2`, file: './gold-set.json' },
  { name: 'nest-external', bias: 'declared FOR lexical (UNVALIDATED)', state: `${HOME}/.cache/mast-eval/base-state-nest`, file: './gold-set-nest.json' },
];

/** Unified matcher: a result is relevant if it matches by symbol OR contains the cited line. */
function ndcg(q, ranked) {
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
      if (bySym || byLine) { idx = k; break; }
    }
    if (idx >= 0 && !covered.has(idx)) { dcg += 1 / Math.log2(i + 2); covered.add(idx); }
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(targets.length, LIMIT); i++) idcg += 1 / Math.log2(i + 2);
  return { ndcg: idcg > 0 ? dcg / idcg : 0, recall: covered.size / targets.length };
}

/** Two-sided 95% CI on a paired mean. t critical approximated for df>=10. */
function pairedStats(diffs) {
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const tcrit = n >= 30 ? 2.045 : n >= 20 ? 2.093 : n >= 15 ? 2.131 : n >= 11 ? 2.228 : 2.262;
  return {
    n, mean: +mean.toFixed(4), sd: +sd.toFixed(4), se: +se.toFixed(4),
    ci95: [+(mean - tcrit * se).toFixed(4), +(mean + tcrit * se).toFixed(4)],
    t_vs_zero: se > 0 ? +(mean / se).toFixed(3) : null,
    significant_vs_zero: se > 0 && Math.abs(mean / se) > tcrit,
  };
}

const report = {};
for (const set of SETS) {
  const gold = JSON.parse(readFileSync(new URL(set.file, import.meta.url), 'utf-8'));
  const db = openDatabase(set.state);
  const chunkStore = new SqliteChunkStore(db);
  const lance = await LanceStore.open(set.state);
  const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, set.state, 'fp32');
  await embedder.load();
  const chunkTotal = await chunkStore.chunkCount();
  const vecTotal = await lance.vectorCount();

  const per = { L: [], H: [], V: [] };
  const rec = { L: [], H: [], V: [] };
  for (const q of gold.queries) {
    for (const arm of ['L', 'H', 'V']) {
      let ranked;
      if (arm === 'V') {
        const hits = await lance.searchVectors(await embedder.embedRawUncached(q.query), LIMIT);
        const recs = await chunkStore.getChunksByIds(hits.map((h) => h.chunk_id));
        const byId = new Map(recs.map((r) => [r.chunk_id, r]));
        ranked = hits.map((h) => byId.get(h.chunk_id)).filter(Boolean);
      } else {
        ranked = (await hybridSearch(db, lance, arm === 'H' ? embedder : null, { query: q.query, limit: LIMIT }, { rrf_k: 60 }, chunkStore)).results;
      }
      const m = ndcg(q, ranked);
      per[arm].push(m.ndcg);
      rec[arm].push(m.recall);
    }
  }

  const mean = (a) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(4);
  const HminusL = pairedStats(per.H.map((v, i) => v - per.L[i]));
  const VminusH = pairedStats(per.V.map((v, i) => v - per.H[i]));

  report[set.name] = {
    bias: set.bias, n: gold.queries.length,
    corpus: { chunks: chunkTotal, vectors: vecTotal, embedded_pct: +((vecTotal / chunkTotal) * 100).toFixed(1) },
    ndcg: { L: mean(per.L), H: mean(per.H), V: mean(per.V) },
    recall: { L: mean(rec.L), H: mean(rec.H), V: mean(rec.V) },
    'H-L': HminusL, 'V-H': VminusH,
  };

  const r = report[set.name];
  console.log(`\n=== ${set.name} (n=${r.n}, ${r.corpus.embedded_pct}% embedded) ===`);
  console.log(`NDCG@10   L=${r.ndcg.L}  H=${r.ndcg.H}  V=${r.ndcg.V}`);
  console.log(`Recall@10 L=${r.recall.L}  H=${r.recall.H}  V=${r.recall.V}`);
  console.log(`H-L: mean=${HminusL.mean} CI95=[${HminusL.ci95}] t=${HminusL.t_vs_zero} sig=${HminusL.significant_vs_zero}`);
  console.log(`V-H: mean=${VminusH.mean} CI95=[${VminusH.ci95}] t=${VminusH.t_vs_zero} sig=${VminusH.significant_vs_zero}`);
  await db.destroy();
}

mkdirSync(RESULTS_DIR, { recursive: true });
const f = join(RESULTS_DIR, 'q1-final-fullembed.json');
writeFileSync(f, JSON.stringify({
  experiment: 'Q1/F16 re-run — full embeds, unified matcher, paired CIs',
  ranAt: new Date().toISOString(), model: MODEL, results: report,
  caveats: [
    'Arm V still bypasses hybridSearch dedup/post-filters — arms not fully equalised (review finding 5).',
    'The "declared FOR lexical" bias of the normal sets remains UNVALIDATED and may be inverted.',
    'Identifier-decomposition reserve arm not yet run.',
  ],
}, null, 2));
console.log(`\nwrote ${f}`);
