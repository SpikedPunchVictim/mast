// Q1/OUTCOME — the arm-switchable search surface handed to task agents.
//
// Registered in IMPLEMENTATION_PLAN.md § "Q1/OUTCOME". This replicates
// src/mcp/tools/search.ts's call into the SHIPPED hybridSearch; the ONLY
// difference between arms is the embedder argument:
//
//   arm H (hybrid)  -> hybridSearch(db, lance, embedder, ...)
//   arm L (lexical) -> hybridSearch(db, lance, null,     ...)   // §13.11 --no-embeddings
//
// Arm comes from MAST_AB_ARM and is never printed to the agent.
//
// 🔴 THREE REGISTERED SAFEGUARDS ARE IMPLEMENTED HERE — do not "simplify" them away:
//
// 1. REDACTION (AMENDMENT 1 #3). A naive replication leaks the arm into every
//    response: search.ts:35 serialises `mode`, :43 puts it in `_stats`, and
//    hybrid.ts:153 makes `similarity_score` non-null only under hybrid. That
//    would put the arm in every transcript and make "graded blind" a false
//    claim. We strip mode / _stats / similarity_score / match_score from
//    agent-visible output, identically in both arms.
// 2. ARM-INTEGRITY LOG (AMENDMENT 1 #4). hybrid.ts:102-104 swallows embedder
//    failure and silently returns mode "lexical" — so arm H can decay into arm
//    L mid-experiment and manufacture the null the reframe predicts. Every call
//    logs its PRE-redaction mode; scoring voids any H-run containing a
//    non-hybrid call.
// 3. LEAKAGE EXCLUSION (AMENDMENT 1 #1). `chunk_type: 'doc'` is dropped in BOTH
//    arms (the registered question is whether the agent found the right *code*,
//    and 187 indexed .md files otherwise give a doc-mediated path that ceilings
//    both arms), plus any --exclude-file path (the task's own source document).
//
// Over-fetch note: exclusions are applied AFTER retrieval, so we fetch limit*5
// and truncate back to `limit`. This keeps the agent's window at a full 10
// results in both arms — filtering a limit=10 call instead would shrink the
// window asymmetrically whenever one arm happens to surface more doc chunks.
// The wider pool applies identically to both arms. Gate 1 (fidelity) compares
// an exclusion-free limit=10 call, which is byte-identical to shipped.
//
//   MAST_AB_ARM=hybrid node eval/ab-search.mjs --query "..." [--limit 10] [--exclude-file p]

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore } from '../dist/store/lance.js';
import { hybridSearch } from '../dist/search/hybrid.js';
import { Embedder } from '../dist/indexer/embedder.js';
import { MODEL_CACHE_DIR } from './paths.mjs';

const MODEL = 'jinaai/jina-embeddings-v2-base-code';
const RRF_K = 60;
const STATE = process.env.MAST_AB_STATE ?? join(homedir(), '.cache', 'mast-eval', 'ab-state');

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}
function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => { if (a === `--${name}`) out.push(process.argv[i + 1]); });
  return out;
}

const query = arg('query');
if (query === null) {
  console.error('usage: ab-search.mjs --query "<text>" [--limit 10] [--exclude-file <path>]');
  process.exit(2);
}
const limit = Number(arg('limit', '10'));
const excludeFiles = new Set(argAll('exclude-file'));
const keepDocs = process.argv.includes('--gate-fidelity'); // Gate 1 only: no exclusions
const arm = process.env.MAST_AB_ARM ?? 'hybrid';
if (arm !== 'hybrid' && arm !== 'lexical') {
  console.error(`FATAL: MAST_AB_ARM must be hybrid|lexical, got "${arm}"`);
  process.exit(2);
}

const db = openDatabase(STATE);
const chunkStore = new SqliteChunkStore(db);
const lance = await LanceStore.open(STATE);

// The one line that IS the experiment.
const embedder = arm === 'hybrid' ? new Embedder(MODEL, MODEL_CACHE_DIR, STATE) : null;

const fetchLimit = keepDocs ? limit : limit * 5;
const { mode, results, suggestions } = await hybridSearch(
  db,
  lance,
  embedder,
  { query, limit: fetchLimit },
  { rrf_k: RRF_K },
  chunkStore, // explicit: hybrid.ts:55's default is the RETIRED Lance chunk table
);

const kept = keepDocs
  ? results
  : results.filter((r) => r.chunk_type !== 'doc' && !excludeFiles.has(r.file_path)).slice(0, limit);

// --- arm-integrity + provenance log (PRE-redaction, never shown to the agent) ---
const logPath = process.env.MAST_AB_LOG;
if (logPath !== undefined) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({
    ts: new Date().toISOString(),
    run_id: process.env.MAST_AB_RUN ?? null,
    task: process.env.MAST_AB_TASK ?? null,
    arm,
    mode,                                  // AMENDMENT 1 #4 — the void check reads this
    arm_intact: arm === 'lexical' ? mode === 'lexical' : mode === 'hybrid',
    query,
    returned: kept.length,
    // SearchResult carries no chunk_id (ast/types.ts) — but chunk_id is
    // sha256(file_path + ":" + start_line), so this composite IS the identity,
    // one hash short. Gate 1 and Gate 4 both key off it.
    ranked_keys: results.map((r) => `${r.file_path}:${r.start_line}`),
    kept_keys: kept.map((r) => `${r.file_path}:${r.start_line}`),
    excluded_docs: results.filter((r) => r.chunk_type === 'doc').length,
    excluded_files: results.filter((r) => excludeFiles.has(r.file_path)).length,
  }) + '\n');
}

// --- redaction (AMENDMENT 1 #3): identical shape in both arms ---
const redacted = kept.map((r, i) => ({
  rank: i + 1,
  file_path: r.file_path,
  start_line: r.start_line,
  end_line: r.end_line,
  chunk_type: r.chunk_type,
  symbol_name: r.symbol_name,
  parent_symbol: r.parent_symbol,
  is_exported: r.is_exported,
  content: r.content,
  match_snippet: r.match_snippet,
}));

const out = { results: redacted };
if (suggestions !== undefined) out.suggestions = suggestions;
console.log(JSON.stringify(out, null, 2));

