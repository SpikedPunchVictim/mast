// RESERVE-2 — second-COLUMN construction, single joint bm25(), NO fusion.
// Pre-registered in IMPLEMENTATION_PLAN.md § "Q1/RESERVE-2".
//
//   L      shipped chunk_fts (trigram, content)          baseline
//   T+D    trigram,   (content, decomposed)              decomposition under shipped tokenization
//   W      unicode61, (content)                          the tokenizer change ALONE
//   W+D    unicode61, (content, decomposed)              decomposition on top of word tokenization
//   H      RRF(chunk_fts, vectors)                       shipped hybrid, for reference
//
// Pure contrasts: (T+D)-L and (W+D)-W are decomposition with the tokenizer HELD FIXED.
// W-L is the tokenizer alone. RESERVE-1's (L+D)-L was confounded by RRF fusion.
//
// PRE-DECLARED: every lexical arm uses the IDENTICAL query expression (shipped toFtsMatch
// token set: [A-Za-z0-9_]+ of length >= 3, phrase-quoted, OR-joined). No query-side
// camelCase splitting, so every lexical contrast is an INDEX-side-only comparison. This
// costs nothing on this instrument — camelCase appears in 0/11 normal, 0/20 nest and
// 2/28 anti queries (registration § "Known instrument limit").
//
//   node eval/q1-reserve2.mjs

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore } from '../dist/store/lance.js';
import { hybridSearch, rrfScore, dedupShellMethodCollisions } from '../dist/search/hybrid.js';
import { searchFts } from '../dist/search/fts.js';
import { searchVectors } from '../dist/search/vector.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { MODEL_CACHE_DIR, RESULTS_DIR } from './paths.mjs';

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const LIMIT = 10;
const RRF_K = 60;
const CANDIDATE_LIMIT = LIMIT * 4; // 40 — hybrid.ts:59
const LEXICAL_POOL = LIMIT * 8;    // 80 — searchFts's own limit*2 at candidateLimit=40
const HOME = process.env.HOME;

const SETS = [
  { name: 'kluster-normal', state: `${HOME}/.cache/mast-eval/base-state-r2`,   idx: `${HOME}/.cache/mast-eval/decomp/kluster-r2.db`, file: './gold-set-normal-r2.json', oneDirectional: false },
  { name: 'kluster-anti',   state: `${HOME}/.cache/mast-eval/base-state-r2`,   idx: `${HOME}/.cache/mast-eval/decomp/kluster-r2.db`, file: './gold-set.json',          oneDirectional: true  },
  { name: 'nest-external',  state: `${HOME}/.cache/mast-eval/base-state-nest`, idx: `${HOME}/.cache/mast-eval/decomp/nest-r2.db`,    file: './gold-set-nest.json',    oneDirectional: false },
];

/** Shipped toFtsMatch, verbatim (fts.ts:214) — identical for every lexical arm. */
function toMatch(query) {
  const tokens = (query.match(/[A-Za-z0-9_]+/g) ?? []).filter((t) => t.length >= 3);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

function score(q, ranked) {
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

function pairedStats(diffs) {
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const tcrit = n >= 30 ? 2.045 : n >= 20 ? 2.093 : n >= 15 ? 2.131 : n >= 11 ? 2.228 : 2.262;
  return {
    n, mean: +mean.toFixed(4), sd: +sd.toFixed(4),
    ci95: [+(mean - tcrit * se).toFixed(4), +(mean + tcrit * se).toFixed(4)],
    t: se > 0 ? +(mean / se).toFixed(3) : null,
    sig: se > 0 && Math.abs(mean / se) > tcrit,
  };
}

async function runArm({ db, lance, chunkStore, idxDb, embedder, query, arm }) {
  const maps = [];

  if (arm === 'L' || arm === 'H') {
    const rows = await searchFts(db, query, { limit: CANDIDATE_LIMIT, filePattern: null, language: null });
    const m = new Map();
    rows.forEach((r, i) => m.set(r.chunk_id, i + 1));
    maps.push(m);
  } else if (arm !== 'V') {
    const table = { 'T+D': 'tri_cd', W: 'uni_c', 'W+D': 'uni_cd' }[arm];
    const expr = toMatch(query);
    const m = new Map();
    if (expr !== null) {
      const rows = idxDb
        .prepare(`SELECT chunk_id FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}) ASC LIMIT ?`)
        .all(expr, LEXICAL_POOL);
      rows.forEach((r, i) => m.set(r.chunk_id, i + 1));
    }
    maps.push(m);
  }

  if (arm === 'H' || arm === 'V') {
    const m = new Map();
    const [qv] = await embedder.embed([queryAsChunk(query)]);
    if (qv !== undefined) {
      const hits = await searchVectors(lance, qv.embedding, CANDIDATE_LIMIT);
      hits.forEach((h, i) => m.set(h.chunkId, i + 1));
    }
    maps.push(m);
  }

  const allIds = new Set(maps.flatMap((m) => [...m.keys()]));
  const scored = [];
  for (const id of allIds) {
    let rrf = 0;
    for (const m of maps) { const r = m.get(id); if (r !== undefined) rrf += rrfScore(r, RRF_K); }
    scored.push({ chunk_id: id, rrf });
  }
  scored.sort((a, b) => b.rrf - a.rrf);
  const records = await chunkStore.getChunksByIds(scored.slice(0, CANDIDATE_LIMIT).map((s) => s.chunk_id));
  const rrfById = new Map(scored.map((s) => [s.chunk_id, s.rrf]));
  records.sort((a, b) => (rrfById.get(b.chunk_id) ?? 0) - (rrfById.get(a.chunk_id) ?? 0));
  return dedupShellMethodCollisions(records, LIMIT).map((k) => k.chunk);
}

function queryAsChunk(query) {
  return { chunk_id: '__query__', file_path: '__query__', start_line: 0, end_line: 0,
    content: query, chunk_type: 'block', symbol_name: null, parent_symbol: null,
    is_exported: false, language: 'typescript', file_mtime: 0 };
}

/**
 * Canary query with the target's symbol-derived tokens stripped.
 * RESERVE-1 FIX: kluster-normal targets are line-addressed (`symbol: null`), so the
 * symbol is now resolved from the chunk at the cited line instead of read off the target.
 */
async function canaryQuery(q, chunkStore) {
  let sym = q.relevant.find((t) => t.symbol != null)?.symbol ?? null;
  if (sym === null) {
    const t = q.relevant[0];
    if (t?.line != null) {
      const cs = await chunkStore.getChunksByFilePath(t.file_path);
      sym = cs.find((c) => t.line >= c.start_line && t.line <= c.end_line)?.symbol_name ?? null;
    }
  }
  if (sym === null) return null;
  const words = new Set(
    sym.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
       .split(/[^A-Za-z0-9]+/).map((s) => s.toLowerCase()).filter((s) => s.length >= 3));
  const kept = q.query.split(/\s+/).filter((w) => !words.has(w.toLowerCase().replace(/[^a-z0-9]/gi, '')));
  return kept.length >= 3 ? kept.join(' ') : null;
}

const ARMS = ['L', 'T+D', 'W', 'W+D', 'H', 'V'];  // V equalised through this pipeline (registration: Q1/ARM-V)
const LEXICAL = ['L', 'T+D', 'W', 'W+D'];
const report = {};

for (const set of SETS) {
  const gold = JSON.parse(readFileSync(new URL(set.file, import.meta.url), 'utf-8'));
  const db = openDatabase(set.state);
  const chunkStore = new SqliteChunkStore(db);
  const lance = await LanceStore.open(set.state);
  const idxDb = new Database(set.idx, { readonly: true, fileMustExist: true });
  const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, set.state, 'fp32');
  await embedder.load();

  const nd = {}, rc = {}, empty = {};
  for (const a of ARMS) { nd[a] = []; rc[a] = []; empty[a] = 0; }
  const canaryNd = {}; for (const a of LEXICAL) canaryNd[a] = [];
  let scMismatch = 0, canaryN = 0;
  const perQuery = [];

  for (const q of gold.queries) {
    const row = { id: q.id };
    for (const arm of ARMS) {
      const ranked = await runArm({ db, lance, chunkStore, idxDb, embedder, query: q.query, arm });
      const m = score(q, ranked);
      nd[arm].push(m.ndcg); rc[arm].push(m.recall);
      if (ranked.length === 0) empty[arm]++;
      row[arm] = +m.ndcg.toFixed(4);
    }
    // Self-check: arms L and H must still equal shipped hybridSearch.
    for (const [arm, emb] of [['L', null], ['H', embedder]]) {
      const shipped = (await hybridSearch(db, lance, emb, { query: q.query, limit: LIMIT }, { rrf_k: RRF_K }, chunkStore)).results;
      const mine = await runArm({ db, lance, chunkStore, idxDb, embedder, query: q.query, arm });
      if (shipped.map((r) => `${r.file_path}:${r.start_line}`).join('|') !== mine.map((r) => `${r.file_path}:${r.start_line}`).join('|')) scMismatch++;
    }
    const cq = await canaryQuery(q, chunkStore);
    if (cq !== null) {
      canaryN++;
      for (const arm of LEXICAL) {
        const ranked = await runArm({ db, lance, chunkStore, idxDb, embedder, query: cq, arm });
        canaryNd[arm].push(score(q, ranked).ndcg);
      }
    }
    perQuery.push(row);
  }

  const mean = (a) => (a.length === 0 ? null : +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(4));
  const diff = (x, y) => pairedStats(nd[x].map((v, i) => v - nd[y][i]));

  // best_lexical, RAW per-set max: DESCRIPTIVE ONLY. Max-of-4-correlated-arms at n=11
  // inflates the winner by roughly 0.5-1 SE (~0.05-0.09 NDCG) — the size of the entire
  // nest H-L effect — so an equivalence test against it would manufacture deletion.
  const bestArmRaw = LEXICAL.reduce((b, a) => (mean(nd[a]) > mean(nd[b]) ? a : b), 'L');

  // LEAVE-ONE-OUT selection: for query i, pick the lexical arm on the OTHER n-1 queries,
  // then score query i under that pick. Removes first-order selection bias at n where a
  // holdout split is infeasible (selecting on 5 to score on 6). This is the ONLY lexical
  // baseline permitted to bear the delete-branch contrast.
  const looNd = [], looPick = [];
  for (let i = 0; i < nd.L.length; i++) {
    let best = 'L', bestMean = -Infinity;
    for (const a of LEXICAL) {
      const m = nd[a].reduce((s, v, j) => (j === i ? s : s + v), 0) / (nd[a].length - 1);
      if (m > bestMean) { bestMean = m; best = a; }
    }
    looNd.push(nd[best][i]); looPick.push(best);
  }
  const looDiff = pairedStats(nd.H.map((v, i) => v - looNd[i]));

  // 2x2 factorial interaction: does decomposition's value DEPEND on word tokenization?
  const interaction = pairedStats(
    nd['W+D'].map((v, i) => (v - nd.W[i]) - (nd['T+D'][i] - nd.L[i])),
  );

  report[set.name] = {
    n: gold.queries.length, one_directional: set.oneDirectional,
    ndcg: Object.fromEntries(ARMS.map((a) => [a, mean(nd[a])])),
    recall: Object.fromEntries(ARMS.map((a) => [a, mean(rc[a])])),
    decomposition_trigram_TD_minus_L: diff('T+D', 'L'),
    decomposition_unicode_WD_minus_W: diff('W+D', 'W'),
    tokenizer_W_minus_L: diff('W', 'L'),
    interaction_decomp_x_tokenizer: interaction,
    // "lives" branch requires beating the SHIPPED alternative, not just its tokenizer-mate
    beats_shipped_WD_minus_L: diff('W+D', 'L'),
    best_lexical_arm_raw_DESCRIPTIVE_ONLY: bestArmRaw,
    H_minus_best_lexical_raw_DESCRIPTIVE_ONLY: diff('H', bestArmRaw),
    H_minus_loo_lexical_DECISIVE: looDiff,
    loo_picks: looPick,
    gate: { self_check_mismatches: scMismatch, empty_by_arm: empty,
            any_arm_exactly_zero: ARMS.filter((a) => mean(nd[a]) === 0) },
    canary: { n: canaryN, ndcg: Object.fromEntries(LEXICAL.map((a) => [a, mean(canaryNd[a])])) },
    per_query: perQuery,
  };

  const r = report[set.name];
  console.log(`\n=== ${set.name} (n=${r.n})${set.oneDirectional ? '  [ONE-DIRECTIONAL]' : ''}`);
  console.log(`NDCG@10   ${ARMS.map((a) => `${a}=${r.ndcg[a]}`).join('  ')}`);
  console.log(`Recall@10 ${ARMS.map((a) => `${a}=${r.recall[a]}`).join('  ')}`);
  console.log(`DECOMP trigram  (T+D)-L : mean=${r.decomposition_trigram_TD_minus_L.mean} CI=[${r.decomposition_trigram_TD_minus_L.ci95}] t=${r.decomposition_trigram_TD_minus_L.t} sig=${r.decomposition_trigram_TD_minus_L.sig}`);
  console.log(`DECOMP unicode  (W+D)-W : mean=${r.decomposition_unicode_WD_minus_W.mean} CI=[${r.decomposition_unicode_WD_minus_W.ci95}] t=${r.decomposition_unicode_WD_minus_W.t} sig=${r.decomposition_unicode_WD_minus_W.sig}`);
  console.log(`TOKENIZER        W-L    : mean=${r.tokenizer_W_minus_L.mean} CI=[${r.tokenizer_W_minus_L.ci95}] t=${r.tokenizer_W_minus_L.t} sig=${r.tokenizer_W_minus_L.sig}`);
  console.log(`INTERACTION decomp x tok: mean=${r.interaction_decomp_x_tokenizer.mean} CI=[${r.interaction_decomp_x_tokenizer.ci95}] sig=${r.interaction_decomp_x_tokenizer.sig}`);
  console.log(`BEATS-SHIPPED  (W+D)-L  : mean=${r.beats_shipped_WD_minus_L.mean} CI=[${r.beats_shipped_WD_minus_L.ci95}] sig=${r.beats_shipped_WD_minus_L.sig}`);
  console.log(`H - lexical[LOO] DECISIVE: mean=${r.H_minus_loo_lexical_DECISIVE.mean} CI=[${r.H_minus_loo_lexical_DECISIVE.ci95}] t=${r.H_minus_loo_lexical_DECISIVE.t} sig=${r.H_minus_loo_lexical_DECISIVE.sig}  picks=${[...new Set(r.loo_picks)].join(',')}`);
  console.log(`H - best_lexical[raw ${r.best_lexical_arm_raw_DESCRIPTIVE_ONLY}] (descriptive): mean=${r.H_minus_best_lexical_raw_DESCRIPTIVE_ONLY.mean}`);
  console.log(`CANARY n=${r.canary.n}  ${LEXICAL.map((a) => `${a}=${r.canary.ndcg[a]}`).join('  ')}`);
  console.log(`GATE   self-check=${scMismatch}  empty=${JSON.stringify(empty)}`);

  idxDb.close();
  await db.destroy();
}

mkdirSync(RESULTS_DIR, { recursive: true });
const f = join(RESULTS_DIR, 'q1-reserve2.json');
writeFileSync(f, JSON.stringify({
  experiment: 'Q1 RESERVE-2 — second-COLUMN construction, single joint bm25(), no fusion',
  ranAt: new Date().toISOString(), model: MODEL, rrf_k: RRF_K,
  pinned: { candidate_limit: CANDIDATE_LIMIT, lexical_pool: LEXICAL_POOL,
            query_expr: 'shipped toFtsMatch, identical for every lexical arm (index-side-only contrasts)' },
  results: report,
}, null, 2));
console.log(`\nwrote ${f}`);
