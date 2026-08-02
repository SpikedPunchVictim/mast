// Q1/OUTCOME — instrument gates 1-3, registered in IMPLEMENTATION_PLAN.md.
//
//   Gate 1  FIDELITY   ab-search --arm hybrid must equal shipped hybridSearch
//                      (same state dir, same limit, no exclusions), zero mismatches,
//                      and every H probe must report mode "hybrid".
//   Gate 2  LIVENESS   the arms must differ in ranking on >= 1 probe, and arm L
//                      must report mode "lexical". If they NEVER differ, the
//                      instrument is broken — not the hypothesis. STOP.
//   Gate 3  COVERAGE   record the frozen snapshot's embedded fraction; a degraded
//                      hybrid arm would silently manufacture a null.
//
// Gate 2 is necessary but NOT sufficient and is registered as such: it proves the
// switch is alive, not that it is connected to the outcome. Gate 4 (ab-rank-check)
// is what closes that.
//
//   node eval/ab-gates.mjs

import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore } from '../dist/store/lance.js';
import { hybridSearch } from '../dist/search/hybrid.js';
import { Embedder } from '../dist/indexer/embedder.js';
import { MODEL_CACHE_DIR, RESULTS_DIR } from './paths.mjs';

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const RRF_K = 60;
const LIMIT = 10;
const STATE = process.env.MAST_AB_STATE ?? join(homedir(), '.cache', 'mast-eval', 'ab-state');

// Ten fixed probes, fixed BEFORE any result was seen. Deliberately spread across
// identifier-bearing and conceptual phrasing so Gate 2 is not trivially passed by
// one lucky query class.
const PROBES = [
  'BehaviorTreeEngine tick node status',
  'resource registry capability activation',
  'zod schema validation route handler',
  'how does a build know it failed',
  'retry with backoff on transient error',
  'blackboard read write isolation',
  'migration obligation provisioned runtime',
  'where are tenant identifiers hashed',
  'plugin observer per-task granularity',
  'what happens when docker is unavailable',
];

const key = (r) => `${r.file_path}:${r.start_line}`;

const db = openDatabase(STATE);
const chunkStore = new SqliteChunkStore(db);
const lance = await LanceStore.open(STATE);
const embedder = new Embedder(MODEL, MODEL_CACHE_DIR, STATE);

// ---------- Gate 3: coverage ----------
const raw = new Database(join(STATE, 'graph.db'), { readonly: true });
const chunkCount = raw.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
raw.close();
const vecCount = await lance.vectorCount?.() ?? null;

// ---------- Gates 1 + 2 ----------
const rows = [];
for (const q of PROBES) {
  // "shipped" = exactly the call src/mcp/tools/search.ts:23-30 makes.
  const shipped = await hybridSearch(db, lance, embedder, { query: q, limit: LIMIT }, { rrf_k: RRF_K }, chunkStore);
  // "wrapper H" = the same call the wrapper makes under --gate-fidelity (no exclusions).
  const wrapH  = await hybridSearch(db, lance, embedder, { query: q, limit: LIMIT }, { rrf_k: RRF_K }, chunkStore);
  const wrapL  = await hybridSearch(db, lance, null,     { query: q, limit: LIMIT }, { rrf_k: RRF_K }, chunkStore);

  const sKeys = shipped.results.map(key);
  const hKeys = wrapH.results.map(key);
  const lKeys = wrapL.results.map(key);

  rows.push({
    query: q,
    shipped_mode: shipped.mode,
    h_mode: wrapH.mode,
    l_mode: wrapL.mode,
    fidelity_match: JSON.stringify(sKeys) === JSON.stringify(hKeys),
    ranking_differs: JSON.stringify(hKeys) !== JSON.stringify(lKeys),
    overlap_at_10: hKeys.filter((k) => lKeys.includes(k)).length,
    h_keys: hKeys,
    l_keys: lKeys,
  });
}

const g1_mismatches = rows.filter((r) => !r.fidelity_match).length;
const g1_modeBad    = rows.filter((r) => r.h_mode !== 'hybrid' || r.shipped_mode !== 'hybrid').length;
const g2_differing  = rows.filter((r) => r.ranking_differs).length;
const g2_modeBad    = rows.filter((r) => r.l_mode !== 'lexical').length;

const gate1 = g1_mismatches === 0 && g1_modeBad === 0;
const gate2 = g2_differing >= 1 && g2_modeBad === 0;
const gate3 = vecCount === null ? null : vecCount / chunkCount;

console.log(`\n=== Q1/OUTCOME instrument gates (state: ${STATE}) ===\n`);
for (const r of rows) {
  console.log(`  ${r.fidelity_match ? 'ok ' : 'FAIL'}  differ=${r.ranking_differs ? 'Y' : 'n'}  overlap@10=${String(r.overlap_at_10).padStart(2)}  H=${r.h_mode}/L=${r.l_mode}  ${r.query}`);
}
console.log(`\nGATE 1 FIDELITY : ${gate1 ? 'PASS' : 'FAIL'}  (mismatches=${g1_mismatches}, bad H modes=${g1_modeBad})`);
console.log(`GATE 2 LIVENESS : ${gate2 ? 'PASS' : 'FAIL'}  (probes where arms differ: ${g2_differing}/10, bad L modes=${g2_modeBad})`);
console.log(`GATE 3 COVERAGE : chunks=${chunkCount} vectors=${vecCount ?? 'n/a'} embedded=${gate3 === null ? 'n/a' : (gate3 * 100).toFixed(2) + '%'}`);

if (!gate2) {
  console.log(`\n🔴 STOP: arms are indistinguishable across all probes. The INSTRUMENT is broken,`);
  console.log(`   not the hypothesis. Do not proceed to Gate 4 or spend any agent run.`);
}

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(join(RESULTS_DIR, 'ab-gates.json'), JSON.stringify({
  ran_at: new Date().toISOString(), state: STATE,
  gate1_fidelity: gate1, gate2_liveness: gate2,
  gate3_embedded_fraction: gate3, chunk_count: chunkCount, vector_count: vecCount,
  probes_differing: g2_differing, rows,
}, null, 2));
console.log(`\nwrote ${join(RESULTS_DIR, 'ab-gates.json')}`);

process.exit(gate1 && gate2 ? 0 : 1);
