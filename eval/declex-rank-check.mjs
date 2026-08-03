// Q1/DECLEX — the measurement wrapper (IMPLEMENTATION_PLAN.md § "Q1/DECLEX
// ... PRE-REGISTRATION" + AMENDMENT 1, commit dd10796). BUILT AND UNIT-TESTED
// HERE (Gate B fixtures + a probe-only smoke on ONE tier, per the task's hard
// rule); the full Gate A 4-tier gate and every scored (query, tier, arm)
// measurement over s_ident/s_approx/s_prose (either query set) are NOT run by
// this session — no comparison over a scored query set happens until a later,
// explicitly-scored phase.
//
// Arms (registration table, IMPLEMENTATION_PLAN.md:3589-3595):
//   L        chunk_fts only                                    baseline (shipped lexical, RE-RUN in full)
//   H        chunk_fts + vectors                                incumbent (shipped hybrid, RE-RUN in full)
//   L+D      chunk_fts + ranker D (symbol-gated)                DECISION ARM
//   H+D      chunk_fts + vectors + ranker D                     DESCRIPTIVE ONLY (keep-branch question)
//   L+D+esc  chunk_fts + ranker D with lowercase escape          DESCRIPTIVE sensitivity
//
// L and H are UNMODIFIED shipped arms: `measureDeclexCall` delegates them
// straight to scale-rank-check.mjs's own `measureOne` (imported, not
// reimplemented). L+D/H+D/L+D+esc add ranker D (declex-ranker.mjs) into the
// SAME RRF-fusion + dedup + hit-rule pipeline, built from the same exported
// building blocks idfuse-rank-check.mjs's `reconstructWithRankerI` uses
// (`searchFts`, `searchVectors`, `rrfScore`, `dedupShellMethodCollisions` —
// all imported from dist/, never copied).
//
// BOTH query sets are supported (registration: "Both query sets × 4 tiers ×
// 5 arms"): `eval/declex-queries.json` (FRESH, decision-bearing) and
// `eval/scale-queries.json` (ORIGINAL 400, descriptive comparability only —
// AMENDMENT 1, F-9's narrative firewall is a SCORER-side concern; this
// wrapper treats both files identically as a query source, selected via
// `--query-set fresh|original`).
//
// Per-call capture (registration): mode assertion (L/L+D/L+D+esc lexical,
// H/H+D hybrid), pre-dedup rank, suppression events, censoring at 201, and
// the ranker-D per-query diagnostic (fired?, match channel, candidate
// count — `declex-ranker.mjs`'s own `searchRankerD` diagnostics plus
// `classifyTargetReach` against the query's target).
//
// CLI (Gate G — both paths below ACTUALLY WORK, no refusal stub; the
// scorer-without-CLI defect has recurred twice, HANDOFF_Q1.md §5 /
// idfuse-run-score.mjs's header — a third occurrence is unacceptable):
//
//   node eval/declex-rank-check.mjs --self-check [--tier T1]
//     Gate A: ranker D DISABLED, reproduces shipped hybridSearch (L/H arms)
//     on the FRESH probe set (eval/declex-queries.json's 10 probes). Omit
//     --tier for the full 4-tier gate; pass --tier to scope to one tier
//     (this session's smoke test — probes are excluded from scoring).
//
//   node eval/declex-rank-check.mjs --measure --tier T1 --arm L+D --query-set fresh --stratum probe --index 0 [--out <path>]
//     One real (query, tier, arm) measurement call. Safe on --stratum probe
//     (excluded from scoring, either query set) — this is what this session
//     exercises (the task's "one probe measure per new arm" smoke).
//
//   node eval/declex-rank-check.mjs --measure --tiers T1,T2,T3,T4 --arms L,H,L+D,H+D,L+D+esc --strata s_ident,s_approx,s_prose --query-set fresh --confirm-scored --out eval/results/declex-measure-raw.json
//     The full registered scored sweep — the runner phase's job. `--confirm-
//     scored` is a deliberate, undocumented-by-default safety rail: omitting
//     it (or passing only --strata probe, the default) never touches the
//     scored query set, so an accidental bare --measure cannot cross the
//     hard-rule line.

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
import { HarnessEmbedder } from './harness-embedder.mjs';
import { MODEL_CACHE_DIR } from './paths.mjs';
import {
  RRF_K, DEPTH,
  findRank, censoredRank, inWindow, preDedupRank, sameOrderedResults,
  measureOne, reconstructPreDedup,
} from './scale-rank-check.mjs';
import {
  searchRankerD, classifyTargetReach, DEFAULT_ESCAPE_CAP,
} from './declex-ranker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_RESULTS_DIR = join(__dirname, 'results');

export const MODEL = 'jinaai/jina-embeddings-v2-base-code';
export const ARMS = Object.freeze(['L', 'H', 'L+D', 'H+D', 'L+D+esc']);
const TIERS = ['T1', 'T2', 'T3', 'T4'];
const ROOT = join(homedir(), '.cache', 'mast-eval');

// PROVENANCE: private helper, not exported by scale-rank-check.mjs
// (scale-rank-check.mjs:65-67) — replicated verbatim, same pattern
// idfuse-rank-check.mjs's own tierStateDir already uses.
function tierStateDir(tier) {
  return tier === 'T4' ? join(ROOT, 'vscode-state-full') : join(ROOT, `vscode-state-${tier.toLowerCase()}`);
}

// PROVENANCE: private helper, replicated verbatim from hybrid.ts's
// un-exported queryAsChunk (same pattern scale-rank-check.mjs and
// idfuse-rank-check.mjs already replicate).
function queryAsChunk(query) {
  return {
    chunk_id: '__query__', file_path: '__query__', start_line: 0, end_line: 0,
    content: query, chunk_type: 'block', symbol_name: null, parent_symbol: null,
    is_exported: false, language: 'typescript', file_mtime: 0,
  };
}

// ---------------------------------------------------------------------------
// Arm-aware mode integrity (extends scale-rank-check.mjs's checkModeIntegrity
// to the 3 new arms — cannot reuse it directly: it throws on any arm outside
// ['H','L'] and is a committed parent file no modification is permitted to).
// ---------------------------------------------------------------------------

export function checkModeIntegrityDeclex(arm, mode) {
  if (arm === 'H' || arm === 'H+D') return { valid: mode === 'hybrid', arm, mode };
  if (arm === 'L' || arm === 'L+D' || arm === 'L+D+esc') return { valid: mode === 'lexical', arm, mode };
  throw new Error(`unknown arm: ${arm}`);
}

// ---------------------------------------------------------------------------
// Results-row schema — extends scale-rank-check.mjs's RESULTS_SCHEMA_VERSION /
// validateResultRow to the 5-arm set (cannot reuse the parent's, which
// hardcodes arm ∈ ['H','L'], a committed file).
// ---------------------------------------------------------------------------

export const RESULTS_SCHEMA_VERSION = '1.0.0-declex';

export function validateResultRow(row) {
  // `query_set` is required (not just informational): the scorer's F-9
  // narrative firewall (declex-score.mjs) partitions rows into
  // fresh-vs-original blocks by this field alone — an unlabeled row would
  // silently vanish from BOTH partitions rather than raising, which is worse
  // than a loud validation failure here.
  const required = ['query_id', 'stratum', 'tier', 'arm', 'query_set', 'mode', 'in_window_10', 'censored_rank'];
  for (const key of required) {
    if (!(key in row)) throw new Error(`ResultRow missing required field "${key}": ${JSON.stringify(row)}`);
  }
  if (!['fresh', 'original'].includes(row.query_set)) {
    throw new Error(`ResultRow has unknown query_set "${row.query_set}" (expected "fresh" or "original")`);
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
// RRF-fusion reconstruction for the 3 NEW arms (L+D, H+D, L+D+esc) — built
// from the SAME exported building blocks idfuse-rank-check.mjs's
// reconstructWithRankerI uses, with ranker D's map as a third fusion input.
// ---------------------------------------------------------------------------

export async function reconstructWithRankerD({ db, lance, chunkStore, embedder, query, limit, arm, escapeCap = DEFAULT_ESCAPE_CAP }) {
  const candidateLimit = limit * 4; // hybrid.ts:59

  const ftsRows = await searchFts(db, query, { limit: candidateLimit, filePattern: null, language: null });
  const ftsMap = new Map();
  ftsRows.forEach((r, i) => ftsMap.set(r.chunk_id, i + 1));

  let mode = 'lexical';
  const vecMap = new Map();
  if (arm === 'H+D') {
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
      // fallback to lexical; H+D inherits the same integrity risk H has,
      // which is exactly why mode is asserted per call (checkModeIntegrityDeclex).
    }
  }

  const { rows: dRows, diagnostics: dDiagnostics } = await searchRankerD(db, query, {
    limit: candidateLimit, escape: arm === 'L+D+esc', escapeCap,
  });
  const dMap = new Map();
  dRows.forEach((r, i) => dMap.set(r.chunk_id, i + 1));

  const allIds = new Set([...ftsMap.keys(), ...vecMap.keys(), ...dMap.keys()]);
  const scored = [];
  for (const id of allIds) {
    let rrf = 0;
    if (ftsMap.has(id)) rrf += rrfScore(ftsMap.get(id), RRF_K);
    if (vecMap.has(id)) rrf += rrfScore(vecMap.get(id), RRF_K);
    if (dMap.has(id)) rrf += rrfScore(dMap.get(id), RRF_K);
    scored.push({ chunk_id: id, rrf });
  }
  scored.sort((a, b) => b.rrf - a.rrf);

  const topIds = scored.slice(0, candidateLimit).map((s) => s.chunk_id);
  const records = await chunkStore.getChunksByIds(topIds);
  const rrfById = new Map(scored.map((s) => [s.chunk_id, s.rrf]));
  records.sort((a, b) => (rrfById.get(b.chunk_id) ?? 0) - (rrfById.get(a.chunk_id) ?? 0));

  return { mode, preDedupRecords: records, dRows, dDiagnostics };
}

/** Reshape deduped `{chunk, related}` entries into the SearchResult-like
 * objects `findRank` (scale-rank-check.mjs) expects — mirrors
 * idfuse-rank-check.mjs's own `toSearchResults` (presentation fields only). */
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

/** One (query, tier, arm) measurement for a NEW arm (L+D / H+D / L+D+esc). */
export async function measureDeclexOne({ db, lance, chunkStore, embedder, target, query, arm, limit = DEPTH, escapeCap = DEFAULT_ESCAPE_CAP }) {
  const { mode, preDedupRecords, dRows, dDiagnostics } = await reconstructWithRankerD({ db, lance, chunkStore, embedder, query, limit, arm, escapeCap });
  const integrity = checkModeIntegrityDeclex(arm, mode);

  const deduped = dedupShellMethodCollisions(preDedupRecords, limit);
  const results = toSearchResults(deduped);

  const { rank, case: hitCase, suppression_event } = findRank(target, results);
  const preRank = preDedupRank(target, preDedupRecords);
  const reach = classifyTargetReach(dRows, target);

  return {
    arm, mode, mode_integrity: integrity,
    rank, hit_case: hitCase, suppression_event,
    censored_rank: censoredRank(rank),
    in_window_10: inWindow(rank),
    pre_dedup_rank: preRank,
    d_diagnostic: {
      fired: dDiagnostics.fired,
      top_match_channel: dDiagnostics.top_match_channel,
      candidate_count: dDiagnostics.candidate_count,
      target_reach: reach,
      ...(dDiagnostics.escape_eligible_terms !== undefined ? {
        escape_eligible_terms: dDiagnostics.escape_eligible_terms,
        lowercase_token_match_counts: dDiagnostics.lowercase_token_match_counts,
      } : {}),
    },
  };
}

/**
 * Single measurement entry point for ALL 5 arms. L/H delegate straight to the
 * parent's own `measureOne` (unmodified shipped arms, re-run in full — no row
 * reuse); L+D/H+D/L+D+esc go through `measureDeclexOne`.
 */
export async function measureDeclexCall({ db, lance, chunkStore, embedder, target, query, arm, limit = DEPTH, escapeCap = DEFAULT_ESCAPE_CAP }) {
  if (arm === 'L' || arm === 'H') {
    return measureOne({ db, lance, chunkStore, embedder, target, query, arm });
  }
  if (arm === 'L+D' || arm === 'H+D' || arm === 'L+D+esc') {
    return measureDeclexOne({ db, lance, chunkStore, embedder, target, query, arm, limit, escapeCap });
  }
  throw new Error(`unknown arm: ${arm}`);
}

// ---------------------------------------------------------------------------
// Gate A self-check — ranker D DISABLED, reproduces shipped hybridSearch
// (L/H arms) exactly, over the FRESH probe set (registration: "fresh probes
// × 4 tiers × 2 arms, limit 200, full-list, 0 mismatches").
// ---------------------------------------------------------------------------

/** PROVENANCE: private helper, replicated verbatim from scale-rank-check.mjs's
 * un-exported sameOrderedResultsToChunkRecords (same pattern
 * idfuse-rank-check.mjs already replicates). */
function sameOrderedResultsToChunkRecords(searchResults, chunkRecords) {
  if (searchResults.length !== chunkRecords.length) return false;
  for (let i = 0; i < searchResults.length; i++) {
    if (searchResults[i].file_path !== chunkRecords[i].file_path || searchResults[i].start_line !== chunkRecords[i].start_line) return false;
  }
  return true;
}

/** Gate A, scoped to ONE tier — full ordered-list comparison ("full-list" per
 * the registration), ranker D never invoked. */
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
      const integrity = checkModeIntegrityDeclex(arm, first.mode);

      const { mode: reconMode, preDedupRecords } = await reconstructPreDedup({ db, lance, chunkStore, embedder: arm === 'H' ? embedder : null, query: pq.query, limit: DEPTH });
      const deduped = dedupShellMethodCollisions(preDedupRecords, DEPTH).map((k) => k.chunk);
      const reconMatchesShipped = sameOrderedResultsToChunkRecords(first.results, deduped);

      report.push({ tier, arm, query: pq.query, wrapper_reproduces_shipped: match, mode_integrity: integrity, reconstruction_matches_shipped: reconMatchesShipped, recon_mode: reconMode });
    }
  }
  await db.destroy();
  return { mismatches, rows: report };
}

/** Full 4-tier Gate A. */
export async function runSelfCheckAllTiers(probeQueries) {
  let allMismatches = 0;
  const allRows = [];
  for (const tier of TIERS) {
    const { mismatches, rows } = await runSelfCheckOneTier(tier, probeQueries);
    allMismatches += mismatches;
    allRows.push(...rows);
  }
  return { mismatches: allMismatches, rows: allRows };
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

function loadQueries(querySet) {
  const fileName = querySet === 'original' ? 'scale-queries.json' : 'declex-queries.json';
  const queriesPath = join(__dirname, fileName);
  return JSON.parse(readFileSync(queriesPath, 'utf8'));
}

async function runSelfCheckCli(args) {
  const queries = loadQueries('fresh'); // Gate A registered against the FRESH probe set.
  const probeQueries = queries.strata.probes.queries;

  const tier = typeof args.tier === 'string' ? args.tier : null;
  console.log(`[declex-self-check] ranker D DISABLED — reproducing shipped hybridSearch (L/H) on ${probeQueries.length} FRESH probes${tier ? ` (tier ${tier} only — SMOKE TEST)` : ' across all 4 tiers'}.`);

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

  console.log(`[declex-self-check] rows=${rows.length} script_mismatches=${mismatches} full_mismatches=${fullMismatches} elapsed=${elapsedSec.toFixed(1)}s`);
  console.log(`[declex-self-check] GATE A -> ${pass ? 'PASS' : 'FAIL'}`);

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify({ ran_at: new Date().toISOString(), tier, mismatches, full_mismatches: fullMismatches, pass, rows }, null, 2));
    console.log(`wrote ${args.out}`);
  }

  process.exit(pass ? 0 : 1);
}

async function runMeasureCli(args) {
  const querySet = typeof args['query-set'] === 'string' ? args['query-set'] : null;
  if (querySet === null || !['fresh', 'original'].includes(querySet)) {
    console.error('[declex-measure] --query-set fresh|original is required.');
    process.exit(2);
  }
  const queries = loadQueries(querySet);

  const tiersArg = typeof args.tiers === 'string' ? args.tiers.split(',') : (typeof args.tier === 'string' ? [args.tier] : null);
  const armsArg = typeof args.arms === 'string' ? args.arms.split(',') : (typeof args.arm === 'string' ? [args.arm] : null);
  const strataArg = typeof args.strata === 'string' ? args.strata.split(',') : (typeof args.stratum === 'string' ? [args.stratum] : ['probe']);
  const escapeCap = typeof args['escape-cap'] === 'string' ? Number(args['escape-cap']) : DEFAULT_ESCAPE_CAP;

  if (tiersArg === null || armsArg === null) {
    console.error('[declex-measure] --tier/--tiers and --arm/--arms are required.');
    process.exit(2);
  }
  for (const a of armsArg) {
    if (!ARMS.includes(a)) { console.error(`[declex-measure] unknown arm "${a}" (expected one of ${ARMS.join(', ')})`); process.exit(2); }
  }

  // Safety rail: touching a scored stratum requires an explicit
  // acknowledgement flag. Silent-by-default protection against an
  // accidental bare --measure crossing the hard-rule line.
  const touchesScored = strataArg.some((s) => s !== 'probe');
  if (touchesScored && !args['confirm-scored']) {
    console.error('[declex-measure] refusing: --strata includes a SCORED stratum (s_ident/s_approx/s_prose) without --confirm-scored.');
    console.error('[declex-measure] this is the runner phase\'s job, not the instrument-construction phase (see this file\'s header).');
    process.exit(2);
  }

  const rows = [];
  for (const tier of tiersArg) {
    const stateDir = tierStateDir(tier);
    const db = openDatabase(stateDir);
    const chunkStore = new SqliteChunkStore(db);
    const lance = await LanceStore.open(stateDir);
    const embedder = new HarnessEmbedder(MODEL, MODEL_CACHE_DIR, stateDir, 'fp32');
    if (armsArg.some((a) => a === 'H' || a === 'H+D')) await embedder.load();

    for (const stratum of strataArg) {
      // Both query files key the probe stratum as "probes" (plural) while
      // every ResultRow/CLI-facing label uses the singular "probe" — same
      // mapping idfuse-rank-check.mjs applies (HANDOFF_Q1.md §5's logged bug).
      const jsonKey = stratum === 'probe' ? 'probes' : stratum;
      const stratumQueries = queries.strata[jsonKey].queries;
      const indices = typeof args.index === 'string' ? [Number(args.index)] : stratumQueries.map((_, i) => i);

      for (const i of indices) {
        const q = stratumQueries[i];
        const queryId = `${stratum}_${i}`;
        for (const arm of armsArg) {
          const result = await measureDeclexCall({ db, lance, chunkStore, embedder, target: q.target, query: q.query, arm, escapeCap });
          const row = {
            query_id: queryId, stratum, tier, arm, query_set: querySet,
            mode: result.mode, mode_integrity_valid: result.mode_integrity.valid,
            rank: result.rank, hit_case: result.hit_case, suppression_event: result.suppression_event,
            censored_rank: result.censored_rank, in_window_10: result.in_window_10, pre_dedup_rank: result.pre_dedup_rank,
          };
          validateResultRow(row);

          if (arm === 'L+D' || arm === 'H+D' || arm === 'L+D+esc') {
            row.d_diagnostic = result.d_diagnostic;
          }
          // escape_cap is attached (not just carried at the file level) so
          // the scorer's cap sweep (declex-score.mjs's computeEscapeCapSweep)
          // can group rows from multiple merged measurement runs by whatever
          // cap each row was actually measured under.
          if (arm === 'L+D+esc') {
            row.escape_cap = escapeCap;
          }

          rows.push(row);
          console.log(`[declex-measure] ${tier}/${arm}/${queryId} (${querySet}): rank=${row.rank} in_window_10=${row.in_window_10} mode=${row.mode}`);
        }
      }
    }
    await db.destroy();
  }

  const outFile = args.out ?? join(REPO_RESULTS_DIR, 'declex-measure-smoke.json');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify({ ran_at: new Date().toISOString(), schema_version: RESULTS_SCHEMA_VERSION, query_set: querySet, escape_cap: escapeCap, rows }, null, 2));
  console.log(`[declex-measure] wrote ${rows.length} rows to ${outFile}`);
}

function printUsage() {
  console.log('Usage:');
  console.log('  node eval/declex-rank-check.mjs --self-check [--tier T1] [--out <path>]');
  console.log('  node eval/declex-rank-check.mjs --measure --tier T1 --arm L+D --query-set fresh --stratum probe --index 0 [--out <path>]');
  console.log('  node eval/declex-rank-check.mjs --measure --tiers T1,T2,T3,T4 --arms L,H,L+D,H+D,L+D+esc --strata s_ident,s_approx,s_prose --query-set fresh --confirm-scored --out eval/results/declex-measure-raw.json');
  console.log('  node eval/declex-rank-check.mjs --help');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Gate G (IMPLEMENTATION_PLAN.md, "CLI gate (new — the twice-recurred
  // defect)"): an explicit --help path that touches no DB/state and exits 0
  // is what the automated spawn test asserts against — the bare-invocation
  // fallback below intentionally still exits 2 (unrecognized invocation,
  // same convention idfuse-rank-check.mjs uses for its own usage printout).
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (args['self-check']) {
    await runSelfCheckCli(args);
    return;
  }
  if (args.measure) {
    await runMeasureCli(args);
    return;
  }

  printUsage();
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
