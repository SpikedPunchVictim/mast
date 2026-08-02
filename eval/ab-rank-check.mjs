// Q1/OUTCOME — GATE 4, the SPEND GATE (AMENDMENT 1 #2).
//
// For each task, compute the rank of the ground-truth chunk under arm H and arm L.
// No agents, no tokens, minutes of compute.
//
// REGISTERED DECISION RULE:
//   - If H and L place the ground truth at the SAME rank on every task, the arms
//     cannot discriminate on this task set and the 24 agent runs MUST NOT be spent
//     — the task set is replaced, not the hypothesis resolved.
//   - If ranks DO differ, the causal precondition is established, and any later
//     outcome concordance is genuinely informative: it is the reframe's exact
//     prediction (rank moves, outcome doesn't) rather than an artifact.
//
// Retrieval config matches the task-run config exactly: doc chunks excluded in both
// arms, plus each task's own source document (leakage exclusion, AMENDMENT 1 #1).
// DEPTH is deliberately deeper than the agent's window so "not in top 10" can be
// distinguished from "not retrievable at all".
//
//   node eval/ab-rank-check.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
const WINDOW = 10;   // the agent's actual window
const DEPTH = 100;   // deep probe: separates "below the window" from "unretrievable"
const STATE = process.env.MAST_AB_STATE ?? join(homedir(), '.cache', 'mast-eval', 'ab-state');

const doc = JSON.parse(readFileSync('./eval/ab-tasks.json', 'utf8'));
const db = openDatabase(STATE);
const chunkStore = new SqliteChunkStore(db);
const lance = await LanceStore.open(STATE);
const embedder = new Embedder(MODEL, MODEL_CACHE_DIR, STATE);

/** Rank (1-indexed) of the chunk containing the ground-truth line, after exclusions. */
async function rankOf(query, target, sourceDoc, useVectors) {
  const { mode, results } = await hybridSearch(
    db, lance, useVectors ? embedder : null,
    { query, limit: DEPTH }, { rrf_k: RRF_K }, chunkStore,
  );
  const kept = results.filter((r) => r.chunk_type !== 'doc' && r.file_path !== sourceDoc);
  const idx = kept.findIndex(
    (r) => r.file_path === target.file_path && r.start_line <= target.line && r.end_line >= target.line,
  );
  // File-level fallback: the agent only needs the right FILE to succeed at the task.
  const fileIdx = kept.findIndex((r) => r.file_path === target.file_path);
  return {
    mode,
    rank: idx === -1 ? null : idx + 1,
    file_rank: fileIdx === -1 ? null : fileIdx + 1,
  };
}

const rows = [];
for (const t of doc.tasks) {
  const q = t.query;
  if (q === null) { console.error(`FATAL: task ${t.id} has no query — run the paraphrase merge first.`); process.exit(1); }
  const H = await rankOf(q, t.target, t.source_doc, true);
  const L = await rankOf(q, t.target, t.source_doc, false);
  rows.push({
    id: t.id, stratum: t.stratum, query: q,
    target: `${t.target.file_path}:${t.target.line}`,
    h_mode: H.mode, l_mode: L.mode,
    rank_h: H.rank, rank_l: L.rank,
    file_rank_h: H.file_rank, file_rank_l: L.file_rank,
    in_window_h: H.rank !== null && H.rank <= WINDOW,
    in_window_l: L.rank !== null && L.rank <= WINDOW,
    file_in_window_h: H.file_rank !== null && H.file_rank <= WINDOW,
    file_in_window_l: L.file_rank !== null && L.file_rank <= WINDOW,
    rank_differs: H.rank !== L.rank,
    window_membership_differs: (H.rank !== null && H.rank <= WINDOW) !== (L.rank !== null && L.rank <= WINDOW),
  });
}

const fmt = (v) => (v === null ? ' —' : String(v).padStart(2));
console.log(`\n=== GATE 4 — target-rank pre-check (window=${WINDOW}, depth=${DEPTH}) ===\n`);
console.log(`  id   stratum    rank_H rank_L   file_H file_L  differs  target`);
for (const r of rows) {
  console.log(
    `  ${r.id}  ${r.stratum.padEnd(9)}  ${fmt(r.rank_h)}     ${fmt(r.rank_l)}      ${fmt(r.file_rank_h)}     ${fmt(r.file_rank_l)}    ${r.rank_differs ? 'Y' : 'n'}      ${r.target}`,
  );
}

const differing = rows.filter((r) => r.rank_differs).length;
const windowDiff = rows.filter((r) => r.window_membership_differs).length;
const hWin = rows.filter((r) => r.in_window_h).length;
const lWin = rows.filter((r) => r.in_window_l).length;
const hFileWin = rows.filter((r) => r.file_in_window_h).length;
const lFileWin = rows.filter((r) => r.file_in_window_l).length;
const badMode = rows.filter((r) => r.h_mode !== 'hybrid' || r.l_mode !== 'lexical').length;

console.log(`\n  ranks differ                    : ${differing}/${rows.length}`);
console.log(`  top-${WINDOW} MEMBERSHIP differs        : ${windowDiff}/${rows.length}   <- what the agent can actually see`);
console.log(`  target chunk in top-${WINDOW}  H / L    : ${hWin} / ${lWin}`);
console.log(`  target FILE  in top-${WINDOW}  H / L    : ${hFileWin} / ${lFileWin}`);
console.log(`  arm-integrity failures          : ${badMode}`);

const pass = differing > 0 && badMode === 0;
console.log(`\nGATE 4: ${pass ? 'PASS — arms discriminate; agent runs are justified.' : 'FAIL'}`);
if (differing === 0) {
  console.log(`  🔴 Arms rank the ground truth identically on EVERY task. They cannot`);
  console.log(`     discriminate here. Do NOT spend the agent runs — replace the task set.`);
}

mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(join(RESULTS_DIR, 'ab-rank-check.json'), JSON.stringify({
  ran_at: new Date().toISOString(), state: STATE, window: WINDOW, depth: DEPTH,
  gate4_pass: pass, ranks_differing: differing, window_membership_differing: windowDiff,
  target_in_window: { h: hWin, l: lWin }, target_file_in_window: { h: hFileWin, l: lFileWin },
  rows,
}, null, 2));
console.log(`\nwrote ${join(RESULTS_DIR, 'ab-rank-check.json')}`);
process.exit(pass ? 0 : 1);
