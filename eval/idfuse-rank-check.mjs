// Q1/IDFUSE — the measurement wrapper (IMPLEMENTATION_PLAN.md § "Q1/IDFUSE ...
// PRE-REGISTRATION + AMENDMENT 1", commit bed7d48). BUILT AND UNIT-TESTED HERE
// (Gate A smoke-tested on ONE tier); the full Gate A 4-tier gate and every
// scored (query, tier, arm) measurement over s_ident/s_approx/s_prose are NOT
// run by this session — per the hard constraint, no comparison over the
// frozen scored query set happens until a later, explicitly-scored phase.
//
// Arms (registration table, IMPLEMENTATION_PLAN.md:3008-3013):
//   L       chunk_fts only                              (shipped lexical, RE-RUN in full — no f40f2bf row reuse, AMENDMENT 1 F3)
//   H       chunk_fts + vectors                          (shipped hybrid, RE-RUN in full)
//   L+I     chunk_fts + identifier_fts (ranker I)         NEW, decision-bearing (with L)
//   H+I     chunk_fts + vectors + identifier_fts          NEW, DESCRIPTIVE ONLY (arm-V precedent)
//   L+Isym  chunk_fts + identifier_fts (symbol-only mode)  NEW, DESCRIPTIVE ONLY (F7 sensitivity)
//
// L and H are UNMODIFIED shipped arms: `measureIdfuseCall` delegates them
// straight to scale-rank-check.mjs's own `measureOne` (imported, not
// reimplemented) — the identical shipped `hybridSearch` call the parent
// track validated. L+I/H+I/L+Isym add ONE new ranker (ranker I,
// idfuse-ranker.mjs) into the SAME RRF-fusion + dedup + hit-rule pipeline,
// built from the same exported building blocks the parent's own
// `reconstructPreDedup` uses (`searchFts`, `searchVectors`, `rrfScore`,
// `dedupShellMethodCollisions` — all imported from dist/, never copied).
//
// Per-call capture (registration): mode assertion (L/L+I/L+Isym lexical,
// H/H+I hybrid — extends scale-rank-check.mjs's checkModeIntegrity, which
// hardcodes ['H','L'] and cannot be reused unmodified for the 3 new arms
// without editing a committed parent file), pre-dedup rank, suppression
// events, censoring at 201 (all reused verbatim from scale-rank-check.mjs),
// and the F7 diagnostic (below) — per query, which query terms matched the
// target's own identifier_fts row, classified symbol-token vs
// TSDoc-rare-word.
//
// CLI (both paths below ACTUALLY WORK — no refusal stub. HANDOFF_Q1.md §5's
// logged lesson: the parent's committed instrument shipped with a
// header-documented CLI that printed a refusal and exit(2), forcing the
// runner to author scale-run-selfcheck.mjs / scale-run-measure.mjs /
// scale-run-score.mjs from scratch. That is not repeated here):
//
//   node eval/idfuse-rank-check.mjs --self-check [--tier T1]
//     Gate A: ranker I DISABLED, reproduces shipped hybridSearch (L/H arms)
//     on the probe set. Omit --tier for the full 4-tier gate (the runner
//     phase's job); pass --tier to scope it to one tier (this session's
//     smoke test — probes are excluded from scoring, so this is safe to run
//     here per the registration).
//
//   node eval/idfuse-rank-check.mjs --measure --tier T1 --arm L+I --stratum probe --index 0 [--out <path>]
//     One real (query, tier, arm) measurement call, written to --out (default
//     eval/results/idfuse-measure-smoke.json). Safe on --stratum probe
//     (excluded from scoring) — this is what this session exercises.
//
//   node eval/idfuse-rank-check.mjs --measure --tiers T1,T2,T3,T4 --arms L,H,L+I,H+I,L+Isym --strata s_ident,s_approx,s_prose --confirm-scored --out eval/results/idfuse-measure-raw.json
//     The full registered scored sweep (6,400 searches, AMENDMENT 1 F3) — the
//     runner phase's job. Omitting --index sweeps every query in --strata.
//     `--confirm-scored` is a deliberate, undocumented-by-default safety
//     rail: omitting it (or passing only --strata probe, the default) never
//     touches the scored query set, so an accidental bare --measure cannot
//     cross the hard-rule line.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { openDatabase } from '../dist/graph/db.js';
import { SqliteChunkStore } from '../dist/store/sqliteChunkStore.js';
import { LanceStore } from '../dist/store/lance.js';
import { hybridSearch, rrfScore, dedupShellMethodCollisions } from '../dist/search/hybrid.js';
import { searchFts } from '../dist/search/fts.js';
import { searchVectors } from '../dist/search/vector.js';
import { extractIdentifiers } from '../dist/ast/extractors/typescript.js';
import { HarnessEmbedder } from './harness-embedder.mjs';
import { MODEL_CACHE_DIR } from './paths.mjs';
import {
  RRF_K, DEPTH,
  findRank, censoredRank, inWindow, preDedupRank, sameOrderedResults,
  measureOne, runSelfCheck, reconstructPreDedup,
} from './scale-rank-check.mjs';
import {
  searchRankerI, deriveRankerITerms, deriveSymbolOnlyTerms,
} from './idfuse-ranker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_RESULTS_DIR = join(__dirname, 'results');

export const MODEL = 'jinaai/jina-embeddings-v2-base-code';
export const ARMS = Object.freeze(['L', 'H', 'L+I', 'H+I', 'L+Isym']);
const TIERS = ['T1', 'T2', 'T3', 'T4'];
const ROOT = join(homedir(), '.cache', 'mast-eval');

// PROVENANCE: private helper, not exported by scale-rank-check.mjs
// (scale-rank-check.mjs:65-67) — replicated verbatim, same pattern as that
// file's own `queryAsChunk` replication (its header note, line ~30-34).
function tierStateDir(tier) {
  return tier === 'T4' ? join(ROOT, 'vscode-state-full') : join(ROOT, `vscode-state-${tier.toLowerCase()}`);
}

/**
 * The pinned SOURCE checkout each tier's chunks were indexed from — NOT the
 * same directory as `tierStateDir` (which holds graph.db/vectors.lance, not
 * source files). Per eval/ASSETS.md: T4 is the full vscode checkout; T1-T3
 * are the seed-153 file-subset worktrees. Needed only by the F7 diagnostic
 * (computeF7Diagnostic), which reads declaration-line source text.
 */
function tierProjectRoot(tier) {
  return tier === 'T4'
    ? join(homedir(), 'temp', 'enterprise-apps', 'vscode')
    : join(ROOT, `scale-corpus-${tier.toLowerCase()}`);
}

// PROVENANCE: private helper, replicated verbatim from
// hybrid.ts's un-exported queryAsChunk (same 10-line data-shaping wrapper the
// parent's own reconstructPreDedup already replicates, scale-rank-check.mjs:177-183).
function queryAsChunk(query) {
  return {
    chunk_id: '__query__', file_path: '__query__', start_line: 0, end_line: 0,
    content: query, chunk_type: 'block', symbol_name: null, parent_symbol: null,
    is_exported: false, language: 'typescript', file_mtime: 0,
  };
}

// ---------------------------------------------------------------------------
// Arm-aware mode integrity (extends scale-rank-check.mjs's checkModeIntegrity,
// scale-rank-check.mjs:154-158, to the 3 new arms — cannot reuse it directly:
// it throws on any arm outside ['H','L'] and is a committed parent file no
// modification is permitted to.)
// ---------------------------------------------------------------------------

export function checkModeIntegrityIdfuse(arm, mode) {
  if (arm === 'H' || arm === 'H+I') return { valid: mode === 'hybrid', arm, mode };
  if (arm === 'L' || arm === 'L+I' || arm === 'L+Isym') return { valid: mode === 'lexical', arm, mode };
  throw new Error(`unknown arm: ${arm}`);
}

// ---------------------------------------------------------------------------
// Results-row schema — extends scale-rank-check.mjs's RESULTS_SCHEMA_VERSION /
// validateResultRow to the 5-arm set. Cannot reuse the parent's
// validateResultRow unmodified: it hardcodes `arm ∈ ['H','L']` (a committed
// file; no edits permitted). Same required-field set and error-message shape
// otherwise, so the two schemas stay structurally aligned by inspection.
// ---------------------------------------------------------------------------

export const RESULTS_SCHEMA_VERSION = '1.0.0-idfuse';

export function validateResultRow(row) {
  const required = ['query_id', 'stratum', 'tier', 'arm', 'mode', 'in_window_10', 'censored_rank'];
  for (const key of required) {
    if (!(key in row)) throw new Error(`ResultRow missing required field "${key}": ${JSON.stringify(row)}`);
  }
  if (!['s_ident', 's_approx', 's_prose', 'probe'].includes(row.stratum)) {
    throw new Error(`ResultRow has unknown stratum "${row.stratum}"`);
  }
  if (!TIERS.includes(row.tier)) {
    throw new Error(`ResultRow has unknown tier "${row.tier}"`);
  }
  if (!ARMS.includes(row.arm)) {
    throw new Error(`ResultRow has unknown arm "${row.arm}"`);
  }
  if (typeof row.in_window_10 !== 'boolean') {
    throw new Error(`ResultRow.in_window_10 must be boolean, got ${typeof row.in_window_10}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// RRF-fusion reconstruction for the 3 NEW arms (L+I, H+I, L+Isym) — built from
// the SAME exported building blocks the parent's reconstructPreDedup uses
// (searchFts, searchVectors, rrfScore, dedupShellMethodCollisions), with
// ranker I's map added as a third fusion input. Pool: candidateLimit =
// limit*4 is computed ONCE (hybrid.ts:59's own convention) and passed
// directly to searchVectors AND to searchRankerI (AMENDMENT 1 F8 — both take
// the caller's already-multiplied limit with no further internal
// multiplication); chunk_fts additionally doubles internally (fts.ts:92),
// unchanged shipped behaviour.
// ---------------------------------------------------------------------------

export async function reconstructWithRankerI({ db, lance, chunkStore, embedder, query, limit, arm }) {
  const candidateLimit = limit * 4; // hybrid.ts:59

  const ftsRows = await searchFts(db, query, { limit: candidateLimit, filePattern: null, language: null });
  const ftsMap = new Map();
  ftsRows.forEach((r, i) => ftsMap.set(r.chunk_id, i + 1));

  let mode = 'lexical';
  const vecMap = new Map();
  if (arm === 'H+I') {
    try {
      await embedder.load();
      const [qv] = await embedder.embed([queryAsChunk(query)]);
      if (qv !== undefined) {
        const hits = await searchVectors(lance, qv.embedding, candidateLimit);
        if (hits.length > 0) {
          mode = 'hybrid';
          hits.forEach((h, i) => vecMap.set(h.chunkId, i + 1));
        }
      }
    } catch {
      // Mirrors hybrid.ts:102-104's swallowed embedder failure -> silent
      // fallback to lexical; H+I inherits the same integrity risk H has,
      // which is exactly why mode is asserted per call (checkModeIntegrityIdfuse).
    }
  }

  const idRows = await searchRankerI(db, query, { limit: candidateLimit, symbolOnly: arm === 'L+Isym' });
  const idMap = new Map();
  idRows.forEach((r, i) => idMap.set(r.chunk_id, i + 1));

  const allIds = new Set([...ftsMap.keys(), ...vecMap.keys(), ...idMap.keys()]);
  const scored = [];
  for (const id of allIds) {
    let rrf = 0;
    if (ftsMap.has(id)) rrf += rrfScore(ftsMap.get(id), RRF_K);
    if (vecMap.has(id)) rrf += rrfScore(vecMap.get(id), RRF_K);
    if (idMap.has(id)) rrf += rrfScore(idMap.get(id), RRF_K);
    scored.push({ chunk_id: id, rrf });
  }
  scored.sort((a, b) => b.rrf - a.rrf);

  const topIds = scored.slice(0, candidateLimit).map((s) => s.chunk_id);
  const records = await chunkStore.getChunksByIds(topIds);
  const rrfById = new Map(scored.map((s) => [s.chunk_id, s.rrf]));
  records.sort((a, b) => (rrfById.get(b.chunk_id) ?? 0) - (rrfById.get(a.chunk_id) ?? 0));

  return { mode, preDedupRecords: records };
}

/** Reshape deduped `{chunk, related}` entries (dedupShellMethodCollisions's
 * own return shape, hybrid.ts:246-252) into the SearchResult-like objects
 * `findRank` (scale-rank-check.mjs) expects — mirrors hybridSearch's own
 * `results` mapping (hybrid.ts:141-160), presentation fields only. */
function toSearchResults(deduped) {
  return deduped.map(({ chunk, related }) => ({
    file_path: chunk.file_path,
    start_line: chunk.start_line,
    end_line: chunk.end_line,
    chunk_type: chunk.chunk_type,
    symbol_name: chunk.symbol_name,
    parent_symbol: chunk.parent_symbol,
    ...(related !== undefined ? { related } : {}),
  }));
}

/** One (query, tier, arm) measurement for a NEW arm (L+I / H+I / L+Isym). */
export async function measureIdfuseOne({ db, lance, chunkStore, embedder, target, query, arm, limit = DEPTH }) {
  const { mode, preDedupRecords } = await reconstructWithRankerI({ db, lance, chunkStore, embedder, query, limit, arm });
  const integrity = checkModeIntegrityIdfuse(arm, mode);

  const deduped = dedupShellMethodCollisions(preDedupRecords, limit);
  const results = toSearchResults(deduped);

  const { rank, case: hitCase, suppression_event } = findRank(target, results);
  const preRank = preDedupRank(target, preDedupRecords);

  return {
    arm, mode, mode_integrity: integrity,
    rank, hit_case: hitCase, suppression_event,
    censored_rank: censoredRank(rank),
    in_window_10: inWindow(rank),
    pre_dedup_rank: preRank,
  };
}

/**
 * Single measurement entry point for ALL 5 arms. L/H delegate straight to the
 * parent's own `measureOne` (unmodified shipped arms, re-run in full — no row
 * reuse, AMENDMENT 1 F3); L+I/H+I/L+Isym go through `measureIdfuseOne`.
 */
export async function measureIdfuseCall({ db, lance, chunkStore, embedder, target, query, arm, limit = DEPTH }) {
  if (arm === 'L' || arm === 'H') {
    return measureOne({ db, lance, chunkStore, embedder, target, query, arm });
  }
  if (arm === 'L+I' || arm === 'H+I' || arm === 'L+Isym') {
    return measureIdfuseOne({ db, lance, chunkStore, embedder, target, query, arm, limit });
  }
  throw new Error(`unknown arm: ${arm}`);
}

// ---------------------------------------------------------------------------
// F7 mandatory diagnostic — descriptive only, never gating (AMENDMENT 1, F7).
// ---------------------------------------------------------------------------

/**
 * Read the raw content at `[startLine, endLine]` (1-indexed, inclusive) from
 * the pinned source checkout — needed to distinguish the declaration's OWN
 * tokens from the context-expansion prefix (`context_lines: 3`,
 * `src/store/config.ts:38`) baked into the chunk's indexed `identifiers` bag.
 * Chunk records' own `start_line`/`end_line` are AST boundaries, NOT the
 * expanded region (`src/ast/extractors/typescript.ts:1007-1010`), so this
 * slice is strictly narrower than what `identifier_fts` indexed for the chunk.
 */
function readDeclarationSource(projectRoot, filePath, startLine, endLine) {
  const abs = join(projectRoot, filePath);
  const lines = readFileSync(abs, 'utf8').split('\n');
  return lines.slice(startLine - 1, endLine).join('\n');
}

/**
 * Per-query F7 diagnostic: which of ranker I's derived terms matched the
 * TARGET's own `identifier_fts` row, classified symbol-token (present in the
 * declaration's own source lines) vs TSDoc-rare-word (present only via the
 * context-expansion prefix — i.e. matched but NOT a declaration-line token).
 *
 * `projectRoot` is the pinned source checkout the tier's chunks were indexed
 * from (ASSETS.md documents one per tier — `~/temp/enterprise-apps/vscode`
 * for T4, the `scale-corpus-tN` worktrees for T1-T3); passed explicitly so
 * this function has no hardcoded path and stays testable against a fixture
 * file (see idfuse-rank-check's own test file for the pure-logic coverage of
 * the classification step; this function's DB+FS round trip is exercised by
 * the runner phase, which has the real tier assets).
 */
export async function computeF7Diagnostic({ db, target, query, symbolOnly, projectRoot }) {
  const terms = symbolOnly ? deriveSymbolOnlyTerms(query) : deriveRankerITerms(query);
  const empty = { matched_terms: [], symbol_token_terms: [], tsdoc_rare_word_terms: [] };
  if (terms.length === 0) return empty;

  const row = await db
    .selectFrom('identifier_fts')
    .select('identifiers')
    .where('chunk_id', '=', target.chunk_id)
    .executeTakeFirst();
  if (row === undefined) return empty;

  // unicode61 case-folds at match time (db.ts:286-292) — compare case-insensitively.
  const bag = new Set(row.identifiers.split(' ').map((t) => t.toLowerCase()));
  const matched = terms.filter((t) => bag.has(t.toLowerCase()));
  if (matched.length === 0) return empty;

  const declarationSource = readDeclarationSource(projectRoot, target.file_path, target.start_line, target.end_line);
  const declarationBag = new Set(extractIdentifiers(declarationSource).split(' ').map((t) => t.toLowerCase()));

  return {
    matched_terms: matched,
    symbol_token_terms: matched.filter((t) => declarationBag.has(t.toLowerCase())),
    tsdoc_rare_word_terms: matched.filter((t) => !declarationBag.has(t.toLowerCase())),
  };
}

// ---------------------------------------------------------------------------
// Gate A self-check — ranker I DISABLED, reproduces shipped hybridSearch
// (L/H arms) exactly. Full 4-tier version reuses the parent's own
// `runSelfCheck` (imported, unmodified). A tier-scoped variant is provided
// because the parent's `runSelfCheck` hardcodes all 4 tiers with no
// parameter to narrow it — extracted here (not a modification of the
// committed file) so this session's smoke test does not have to run the full
// 4-tier gate, per the task's own scope instruction.
// ---------------------------------------------------------------------------

/** PROVENANCE: private helper, replicated verbatim from scale-rank-check.mjs's
 * un-exported sameOrderedResultsToChunkRecords (scale-rank-check.mjs:344-350). */
function sameOrderedResultsToChunkRecords(searchResults, chunkRecords) {
  if (searchResults.length !== chunkRecords.length) return false;
  for (let i = 0; i < searchResults.length; i++) {
    if (searchResults[i].file_path !== chunkRecords[i].file_path || searchResults[i].start_line !== chunkRecords[i].start_line) return false;
  }
  return true;
}

/** Gate A, scoped to ONE tier — same checks as scale-rank-check.mjs's
 * runSelfCheck (wrapper determinism, reconstruction equivalence, H-arm
 * mode:"hybrid"), ranker I never invoked. */
export async function runSelfCheckOneTier(tier, probeQueries) {
  const stateDir = tierStateDir(tier);
  const db = openDatabase(stateDir);
  const chunkStore = new SqliteChunkStore(db);
  const lance = await LanceStore.open(stateDir);
  const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, stateDir, 'fp32');

  const report = [];
  let mismatches = 0;
  for (const pq of probeQueries) {
    for (const arm of ['H', 'L']) {
      const first = await hybridSearch(db, lance, arm === 'H' ? embedder : null, { query: pq.query, limit: DEPTH }, { rrf_k: RRF_K }, chunkStore);
      const second = await hybridSearch(db, lance, arm === 'H' ? embedder : null, { query: pq.query, limit: DEPTH }, { rrf_k: RRF_K }, chunkStore);
      const match = sameOrderedResults(first.results, second.results);
      if (!match) mismatches++;
      const integrity = checkModeIntegrityIdfuse(arm, first.mode);

      const { mode: reconMode, preDedupRecords } = await reconstructPreDedup({ db, lance, chunkStore, embedder: arm === 'H' ? embedder : null, query: pq.query, limit: DEPTH });
      const deduped = dedupShellMethodCollisions(preDedupRecords, DEPTH).map((k) => k.chunk);
      const reconMatchesShipped = sameOrderedResultsToChunkRecords(first.results, deduped);

      report.push({ tier, arm, query: pq.query, wrapper_reproduces_shipped: match, mode_integrity: integrity, reconstruction_matches_shipped: reconMatchesShipped, recon_mode: reconMode });
    }
  }
  await db.destroy();
  return { mismatches, rows: report };
}

/** Full 4-tier Gate A — thin wrapper over the parent's own runSelfCheck
 * (imported, unmodified). Provided so the runner phase has one CLI surface
 * (`--self-check` with no `--tier`) instead of reaching into two files. */
export async function runSelfCheckAllTiers(probeQueries) {
  return runSelfCheck(probeQueries);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function runSelfCheckCli(args) {
  const queriesPath = join(__dirname, 'scale-queries.json');
  const queries = JSON.parse(readFileSync(queriesPath, 'utf8'));
  const probeQueries = queries.strata.probes.queries;

  const tier = typeof args.tier === 'string' ? args.tier : null;
  console.log(`[idfuse-self-check] ranker I DISABLED — reproducing shipped hybridSearch (L/H) on ${probeQueries.length} probes${tier ? ` (tier ${tier} only — SMOKE TEST)` : ' across all 4 tiers'}.`);

  const t0 = Date.now();
  const { mismatches, rows } = tier !== null
    ? await runSelfCheckOneTier(tier, probeQueries)
    : await runSelfCheckAllTiers(probeQueries);
  const elapsedSec = (Date.now() - t0) / 1000;

  let fullMismatches = 0;
  for (const r of rows) {
    const modeOk = r.arm === 'H' ? r.mode_integrity.valid === true : true;
    const ok = r.wrapper_reproduces_shipped === true && r.reconstruction_matches_shipped === true && modeOk;
    if (!ok) fullMismatches++;
  }
  const pass = fullMismatches === 0;

  console.log(`[idfuse-self-check] rows=${rows.length} script_mismatches=${mismatches} full_mismatches=${fullMismatches} elapsed=${elapsedSec.toFixed(1)}s`);
  console.log(`[idfuse-self-check] GATE A -> ${pass ? 'PASS' : 'FAIL'}`);

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify({ ran_at: new Date().toISOString(), tier, mismatches, full_mismatches: fullMismatches, pass, rows }, null, 2));
    console.log(`wrote ${args.out}`);
  }

  process.exit(pass ? 0 : 1);
}

async function runMeasureCli(args) {
  const queriesPath = join(__dirname, 'scale-queries.json');
  const queries = JSON.parse(readFileSync(queriesPath, 'utf8'));

  const tiersArg = typeof args.tiers === 'string' ? args.tiers.split(',') : (typeof args.tier === 'string' ? [args.tier] : null);
  const armsArg = typeof args.arms === 'string' ? args.arms.split(',') : (typeof args.arm === 'string' ? [args.arm] : null);
  const strataArg = typeof args.strata === 'string' ? args.strata.split(',') : (typeof args.stratum === 'string' ? [args.stratum] : ['probe']);

  if (tiersArg === null || armsArg === null) {
    console.error('[idfuse-measure] --tier/--tiers and --arm/--arms are required.');
    process.exit(2);
  }
  for (const a of armsArg) {
    if (!ARMS.includes(a)) { console.error(`[idfuse-measure] unknown arm "${a}" (expected one of ${ARMS.join(', ')})`); process.exit(2); }
  }

  // Safety rail: touching a scored stratum requires an explicit
  // acknowledgement flag. Silent-by-default protection against an
  // accidental bare --sweep crossing the hard-rule line.
  const touchesScored = strataArg.some((s) => s !== 'probe');
  if (touchesScored && !args['confirm-scored']) {
    console.error('[idfuse-measure] refusing: --strata includes a SCORED stratum (s_ident/s_approx/s_prose) without --confirm-scored.');
    console.error('[idfuse-measure] this is the runner phase\'s job, not the instrument-construction phase (see this file\'s header).');
    process.exit(2);
  }

  const rows = [];
  for (const tier of tiersArg) {
    const stateDir = tierStateDir(tier);
    const db = openDatabase(stateDir);
    const chunkStore = new SqliteChunkStore(db);
    const lance = await LanceStore.open(stateDir);
    const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, stateDir, 'fp32');
    if (armsArg.some((a) => a === 'H' || a === 'H+I')) await embedder.load();

    for (const stratum of strataArg) {
      // scale-queries.json keys the probe stratum as "probes" (plural) while
      // every ResultRow/CLI-facing label uses the singular "probe" (matching
      // validateResultRow's stratum enum) — map the one irregular key here
      // rather than silently mismatching (this is the bug the smoke-test
      // exercise below caught before commit).
      const jsonKey = stratum === 'probe' ? 'probes' : stratum;
      const stratumQueries = queries.strata[jsonKey].queries;
      const indices = typeof args.index === 'string' ? [Number(args.index)] : stratumQueries.map((_, i) => i);

      for (const i of indices) {
        const q = stratumQueries[i];
        const queryId = `${stratum}_${i}`;
        for (const arm of armsArg) {
          const result = await measureIdfuseCall({ db, lance, chunkStore, embedder, target: q.target, query: q.query, arm });
          const row = {
            query_id: queryId, stratum, tier, arm,
            mode: result.mode, mode_integrity_valid: result.mode_integrity.valid,
            rank: result.rank, hit_case: result.hit_case, suppression_event: result.suppression_event,
            censored_rank: result.censored_rank, in_window_10: result.in_window_10, pre_dedup_rank: result.pre_dedup_rank,
          };
          validateResultRow(row);

          // F7 mandatory diagnostic (AMENDMENT 1) — ranker-I arms only;
          // descriptive, attached alongside the validated row rather than
          // inside it (not part of the ResultRow schema validateResultRow
          // enforces, so it can never cause a spurious validation failure).
          if (arm === 'L+I' || arm === 'H+I' || arm === 'L+Isym') {
            row.f7_diagnostic = await computeF7Diagnostic({
              db, target: q.target, query: q.query, symbolOnly: arm === 'L+Isym',
              projectRoot: tierProjectRoot(tier),
            });
          }

          rows.push(row);
          console.log(`[idfuse-measure] ${tier}/${arm}/${queryId}: rank=${row.rank} in_window_10=${row.in_window_10} mode=${row.mode}`);
        }
      }
    }
    await db.destroy();
  }

  const outFile = args.out ?? join(REPO_RESULTS_DIR, 'idfuse-measure-smoke.json');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ ran_at: new Date().toISOString(), schema_version: RESULTS_SCHEMA_VERSION, rows }, null, 2));
  console.log(`[idfuse-measure] wrote ${rows.length} rows to ${outFile}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args['self-check']) {
    await runSelfCheckCli(args);
    return;
  }
  if (args.measure) {
    await runMeasureCli(args);
    return;
  }

  console.log('Usage:');
  console.log('  node eval/idfuse-rank-check.mjs --self-check [--tier T1] [--out <path>]');
  console.log('  node eval/idfuse-rank-check.mjs --measure --tier T1 --arm L+I --stratum probe --index 0 [--out <path>]');
  console.log('  node eval/idfuse-rank-check.mjs --measure --tiers T1,T2,T3,T4 --arms L,H,L+I,H+I,L+Isym --strata s_ident,s_approx,s_prose --confirm-scored --out eval/results/idfuse-measure-raw.json');
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
