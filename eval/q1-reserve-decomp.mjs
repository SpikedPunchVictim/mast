// Q1 RESERVE ARM — identifier decomposition. Pre-registered in IMPLEMENTATION_PLAN.md
// § "Q1/RESERVE — identifier-decomposition arm: PRE-REGISTRATION" (commit c5f4486,
// written and committed BEFORE this script produced a number).
//
// Five arms, ONE pipeline:
//   L    chunk_fts BM25                       (shipped lexical)
//   D    decomp_fts BM25                      (diagnostic)
//   L+D  RRF(chunk_fts, decomp_fts)           (the reserve arm)
//   H    RRF(chunk_fts, vectors)              (shipped hybrid)
//   H+D  RRF(chunk_fts, decomp_fts, vectors)
//
// Primary contrast (H+D)-(L+D); secondary H-(L+D); Recall@10 co-primary.
//
//   node eval/q1-reserve-decomp.mjs

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
import { toDecompMatch } from './decomp-index.mjs';

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const LIMIT = 10;
const RRF_K = 60;
// PINNED PRE-RUN (registration § "Knobs pinned"). Changing either after seeing a score
// is tuning, not fixing.
const CANDIDATE_LIMIT = LIMIT * 4; // 40 — hybrid.ts:59
const LEXICAL_POOL = LIMIT * 8;    // 80 — searchFts's own limit*2 at candidateLimit=40
const HOME = process.env.HOME;

const SETS = [
  { name: 'kluster-normal', state: `${HOME}/.cache/mast-eval/base-state-r2`,   decomp: `${HOME}/.cache/mast-eval/decomp/kluster.db`, file: './gold-set-normal-r2.json', oneDirectional: false },
  { name: 'kluster-anti',   state: `${HOME}/.cache/mast-eval/base-state-r2`,   decomp: `${HOME}/.cache/mast-eval/decomp/kluster.db`, file: './gold-set.json',          oneDirectional: true  },
  { name: 'nest-external',  state: `${HOME}/.cache/mast-eval/base-state-nest`, decomp: `${HOME}/.cache/mast-eval/decomp/nest.db`,    file: './gold-set-nest.json',    oneDirectional: false },
];

// ---------------------------------------------------------------------------
// Metrics — identical to q1-final.mjs (unified matcher: symbol OR line containment)
// ---------------------------------------------------------------------------

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
    n, mean: +mean.toFixed(4), sd: +sd.toFixed(4), se: +se.toFixed(4),
    ci95: [+(mean - tcrit * se).toFixed(4), +(mean + tcrit * se).toFixed(4)],
    t: se > 0 ? +(mean / se).toFixed(3) : null,
    sig: se > 0 && Math.abs(mean / se) > tcrit,
  };
}

// ---------------------------------------------------------------------------
// The one pipeline. Mirrors hybridSearch's fusion exactly, generalised to N rankers.
// ---------------------------------------------------------------------------

/**
 * Rank-map order is PINNED (fts, decomp, vec) because `hybridSearch` builds its id set
 * as `new Set([...ftsMap.keys(), ...vecMap.keys()])` and V8's sort is stable — so ties
 * resolve by insertion order. Reordering would silently change results.
 */
async function runArm({ db, lance, chunkStore, decompDb, embedder, query, rankers }) {
  const maps = [];

  if (rankers.includes('fts')) {
    const rows = await searchFts(db, query, { limit: CANDIDATE_LIMIT, filePattern: null, language: null });
    const m = new Map();
    rows.forEach((r, i) => m.set(r.chunk_id, i + 1));
    maps.push(m);
  }

  if (rankers.includes('decomp')) {
    const expr = toDecompMatch(query);
    const m = new Map();
    if (expr !== null) {
      const rows = decompDb
        .prepare('SELECT chunk_id FROM decomp_fts WHERE decomp_fts MATCH ? ORDER BY bm25(decomp_fts) ASC LIMIT ?')
        .all(expr, LEXICAL_POOL);
      rows.forEach((r, i) => m.set(r.chunk_id, i + 1));
    }
    maps.push(m);
  }

  if (rankers.includes('vec')) {
    const m = new Map();
    if (embedder !== null) {
      // Same embed path as hybrid.ts:81 — embed() over a wrapped chunk, NOT
      // embedRawUncached (which q1-final's arm V used). Differing here silently
      // breaks the self-check.
      const [qv] = await embedder.embed([queryAsChunk(query)]);
      if (qv !== undefined) {
        const hits = await searchVectors(lance, qv.embedding, CANDIDATE_LIMIT);
        hits.forEach((h, i) => m.set(h.chunkId, i + 1));
      }
    }
    maps.push(m);
  }

  const allIds = new Set(maps.flatMap((m) => [...m.keys()]));
  const scored = [];
  for (const id of allIds) {
    let rrf = 0;
    for (const m of maps) {
      const rank = m.get(id);
      if (rank !== undefined) rrf += rrfScore(rank, RRF_K);
    }
    scored.push({ chunk_id: id, rrf });
  }
  scored.sort((a, b) => b.rrf - a.rrf);

  const topIds = scored.slice(0, CANDIDATE_LIMIT).map((s) => s.chunk_id);
  const records = await chunkStore.getChunksByIds(topIds);
  const rrfById = new Map(scored.map((s) => [s.chunk_id, s.rrf]));
  records.sort((a, b) => (rrfById.get(b.chunk_id) ?? 0) - (rrfById.get(a.chunk_id) ?? 0));
  return dedupShellMethodCollisions(records, LIMIT).map((k) => k.chunk);
}

function queryAsChunk(query) {
  return {
    chunk_id: '__query__', file_path: '__query__', start_line: 0, end_line: 0,
    content: query, chunk_type: 'block', symbol_name: null, parent_symbol: null,
    is_exported: false, language: 'typescript', file_mtime: 0,
  };
}

/** Strip the leading symbol-derived tokens for the self-retrieval canary. */
function canaryQuery(q) {
  const sym = q.relevant.find((t) => t.symbol != null)?.symbol;
  if (sym == null) return null;
  const symWords = new Set(
    sym.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
       .split(/[^A-Za-z0-9]+/).map((s) => s.toLowerCase()).filter((s) => s.length >= 3),
  );
  const kept = q.query.split(/\s+/).filter((w) => !symWords.has(w.toLowerCase().replace(/[^a-z0-9]/gi, '')));
  return kept.length >= 3 ? kept.join(' ') : null;
}

// ---------------------------------------------------------------------------

const ARMS = {
  L:     ['fts'],
  D:     ['decomp'],
  'L+D': ['fts', 'decomp'],
  H:     ['fts', 'vec'],
  'H+D': ['fts', 'decomp', 'vec'],
};

const report = {};
const selfCheck = {};

for (const set of SETS) {
  const gold = JSON.parse(readFileSync(new URL(set.file, import.meta.url), 'utf-8'));
  const db = openDatabase(set.state);
  const chunkStore = new SqliteChunkStore(db);
  const lance = await LanceStore.open(set.state);
  const decompDb = new Database(set.decomp, { readonly: true, fileMustExist: true });
  const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, set.state, 'fp32');
  await embedder.load();

  const nd = {}, rc = {};
  for (const a of Object.keys(ARMS)) { nd[a] = []; rc[a] = []; }
  const canaryNd = { L: [], D: [], 'L+D': [] };
  let scMismatch = 0, dEmpty = 0, docHits = 0, docTotal = 0, lDocHits = 0;
  let tsdocIn = 0, tsdocTotal = 0;
  const perQuery = [];

  for (const q of gold.queries) {
    const row = { id: q.id, query: q.query };

    for (const [arm, rankers] of Object.entries(ARMS)) {
      const ranked = await runArm({
        db, lance, chunkStore, decompDb,
        embedder: rankers.includes('vec') ? embedder : null,
        query: q.query, rankers,
      });
      const m = score(q, ranked);
      nd[arm].push(m.ndcg);
      rc[arm].push(m.recall);
      row[arm] = +m.ndcg.toFixed(4);
      if (arm === 'D') {
        if (ranked.length === 0) dEmpty++;
        docTotal += ranked.length;
        docHits += ranked.filter((c) => c.chunk_type === 'doc').length;
      }
      if (arm === 'L') lDocHits += ranked.filter((c) => c.chunk_type === 'doc').length;
    }

    // --- SELF-CHECK: the reimplemented pipeline must equal shipped hybridSearch ---
    for (const [arm, emb] of [['L', null], ['H', embedder]]) {
      const shipped = (await hybridSearch(db, lance, emb, { query: q.query, limit: LIMIT }, { rrf_k: RRF_K }, chunkStore)).results;
      const mine = await runArm({ db, lance, chunkStore, decompDb, embedder: emb, query: q.query, rankers: ARMS[arm] });
      const a = shipped.map((r) => `${r.file_path}:${r.start_line}`).join('|');
      const b = mine.map((r) => `${r.file_path}:${r.start_line}`).join('|');
      if (a !== b) { scMismatch++; if (scMismatch <= 3) console.log(`  SELF-CHECK MISMATCH ${set.name}/${q.id}/${arm}\n    shipped: ${a}\n    mine:    ${b}`); }
    }

    // --- TSDoc-in-chunk stratification (pre-committed; cuts toward the incumbent) ---
    const t0 = q.relevant[0];
    if (t0 != null) {
      const rows = t0.symbol != null
        ? await chunkStore.getChunksByFilePath(t0.file_path).then((cs) => cs.filter((c) => c.symbol_name === t0.symbol))
        : await chunkStore.getChunksByFilePath(t0.file_path).then((cs) => cs.filter((c) => t0.line >= c.start_line && t0.line <= c.end_line));
      if (rows.length > 0) {
        tsdocTotal++;
        const content = rows[0].content.toLowerCase();
        const qWords = q.query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
        const inChunk = qWords.filter((w) => content.includes(w)).length / Math.max(1, qWords.length);
        row.query_in_chunk = +inChunk.toFixed(2);
        if (inChunk >= 0.5) tsdocIn++;
      }
    }

    // --- Self-retrieval canary: strip symbol-derived tokens ---
    const cq = canaryQuery(q);
    row.canary_query = cq;
    if (cq !== null) {
      for (const arm of ['L', 'D', 'L+D']) {
        const ranked = await runArm({ db, lance, chunkStore, decompDb, embedder: null, query: cq, rankers: ARMS[arm] });
        canaryNd[arm].push(score(q, ranked).ndcg);
      }
    }
    perQuery.push(row);
  }

  const mean = (a) => (a.length === 0 ? null : +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(4));
  const diff = (x, y) => pairedStats(nd[x].map((v, i) => v - nd[y][i]));
  const rdiff = (x, y) => pairedStats(rc[x].map((v, i) => v - rc[y][i]));

  report[set.name] = {
    n: gold.queries.length,
    one_directional: set.oneDirectional,
    ndcg: Object.fromEntries(Object.keys(ARMS).map((a) => [a, mean(nd[a])])),
    recall: Object.fromEntries(Object.keys(ARMS).map((a) => [a, mean(rc[a])])),
    primary_HD_minus_LD: diff('H+D', 'L+D'),
    secondary_H_minus_LD: diff('H', 'L+D'),
    reference_H_minus_L: diff('H', 'L'),
    decomp_effect_LD_minus_L: diff('L+D', 'L'),
    recall_primary_HD_minus_LD: rdiff('H+D', 'L+D'),
    gate: {
      self_check_mismatches: scMismatch,
      arm_D_empty_queries: dEmpty,
      arm_D_doc_share: docTotal > 0 ? +(docHits / docTotal).toFixed(3) : null,
      arm_L_doc_count: lDocHits,
      any_arm_exactly_zero: Object.keys(ARMS).filter((a) => mean(nd[a]) === 0),
    },
    canary: {
      n: canaryNd.L.length,
      ndcg: { L: mean(canaryNd.L), D: mean(canaryNd.D), 'L+D': mean(canaryNd['L+D']) },
      decomp_effect: canaryNd.L.length > 1 ? pairedStats(canaryNd['L+D'].map((v, i) => v - canaryNd.L[i])) : null,
    },
    query_in_chunk_ge_half: tsdocTotal > 0 ? `${tsdocIn}/${tsdocTotal}` : null,
    per_query: perQuery,
  };

  const r = report[set.name];
  console.log(`\n=== ${set.name} (n=${r.n})${set.oneDirectional ? '  [ONE-DIRECTIONAL: may kill vectors, never justify]' : ''}`);
  console.log(`NDCG@10   ${Object.entries(r.ndcg).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`Recall@10 ${Object.entries(r.recall).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`PRIMARY   (H+D)-(L+D): mean=${r.primary_HD_minus_LD.mean} CI=[${r.primary_HD_minus_LD.ci95}] t=${r.primary_HD_minus_LD.t} sig=${r.primary_HD_minus_LD.sig}`);
  console.log(`SECONDARY  H-(L+D)   : mean=${r.secondary_H_minus_LD.mean} CI=[${r.secondary_H_minus_LD.ci95}] t=${r.secondary_H_minus_LD.t} sig=${r.secondary_H_minus_LD.sig}`);
  console.log(`REFERENCE  H-L       : mean=${r.reference_H_minus_L.mean} CI=[${r.reference_H_minus_L.ci95}] (q1-final recorded this)`);
  console.log(`DECOMP     (L+D)-L   : mean=${r.decomp_effect_LD_minus_L.mean} CI=[${r.decomp_effect_LD_minus_L.ci95}] t=${r.decomp_effect_LD_minus_L.t} sig=${r.decomp_effect_LD_minus_L.sig}`);
  console.log(`RECALL     (H+D)-(L+D): mean=${r.recall_primary_HD_minus_LD.mean} CI=[${r.recall_primary_HD_minus_LD.ci95}]`);
  console.log(`CANARY    n=${r.canary.n} L=${r.canary.ndcg.L} D=${r.canary.ndcg.D} L+D=${r.canary.ndcg['L+D']}  (L+D)-L=${r.canary.decomp_effect?.mean}`);
  console.log(`GATE      self-check mismatches=${scMismatch}  D-empty=${dEmpty}  D doc-share=${r.gate.arm_D_doc_share}  query-in-chunk>=0.5: ${r.query_in_chunk_ge_half}`);

  decompDb.close();
  await db.destroy();
}

mkdirSync(RESULTS_DIR, { recursive: true });
const f = join(RESULTS_DIR, 'q1-reserve-decomp.json');
writeFileSync(f, JSON.stringify({
  experiment: 'Q1 RESERVE — identifier decomposition (pre-registered, commit c5f4486)',
  ranAt: new Date().toISOString(), model: MODEL, rrf_k: RRF_K,
  pinned: { candidate_limit: CANDIDATE_LIMIT, lexical_pool: LEXICAL_POOL, ranker_order: 'fts,decomp,vec' },
  results: report,
}, null, 2));
console.log(`\nwrote ${f}`);
