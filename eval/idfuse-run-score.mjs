// Q1/IDFUSE — Step 4 scoring driver. NEW file, not a modification of any
// committed instrument script.
//
// DISCREPANCY WITH THE TASK BRIEFING, LOGGED HERE: the measurement-phase
// briefing ("Run everything from packages/mast ... node eval/idfuse-score.mjs
// per its documented CLI") assumes idfuse-score.mjs has a working CLI entry
// point the way idfuse-rank-check.mjs does (that file's header documents and
// implements `--self-check` / `--measure`, main()/argv parsing at its tail).
// idfuse-score.mjs does NOT: it is a pure module (scoreIdfuse, evaluateVerdict,
// VERDICTS, parseResultsFile, ...) with no process.argv handling and no
// `if (import.meta.url === ...)` invocation guard anywhere in the file — this
// was verified by grep, not assumed. Its own header says only "NOT run on
// real data by this session," mirroring scale-score.mjs's identical situation
// one experiment ago (HANDOFF_Q1.md §5: "scale-rank-check.mjs and
// scale-score.mjs ship with no working CLI entry points ... use the
// runner-authored driver scripts [scale-run-*.mjs], not the instrument files
// directly"). The defect the parent track logged and worked around
// (scale-run-score.mjs, same directory) recurred here for the new scorer.
// This file is that same kind of runner-authored driver, built the same way:
// it imports the committed scorer's exported functions and orchestrates them
// over the real measured rows — no scoring logic is re-derived here.
//
// It additionally computes what scoreIdfuse's own return value does NOT
// include (per-query descriptive bookkeeping the registration asks the
// "score" step to report, but which is orthogonal to the verdict machinery
// scoreIdfuse owns): per (arm, tier, stratum) censoring/suppression/mode-
// integrity ("void") counts, and F7 diagnostic aggregates (symbol-token vs
// TSDoc-rare-word match-rate split) over the L+I / H+I / L+Isym rows.
//
//   node eval/idfuse-run-score.mjs [--in <path>] [--out <path>]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreIdfuse, parseResultsFile } from './idfuse-score.mjs';
import { ARMS } from './idfuse-rank-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_RESULTS_DIR = join(__dirname, 'results');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const inFile = args.in ?? join(REPO_RESULTS_DIR, 'idfuse-measure-raw.json');
const outFile = args.out ?? join(REPO_RESULTS_DIR, 'idfuse-score-output.json');

const rawText = readFileSync(inFile, 'utf8');
const { rows, sha256 } = parseResultsFile(rawText);

const scored = scoreIdfuse(rows);

// ---------------------------------------------------------------------------
// Per (stratum, tier, arm) censoring / suppression / mode-integrity ("void")
// counts — registration: "any violation voids that tier-arm, report void
// counts" (Gate C). A tier-arm is VOIDED if ANY row in it fails mode
// integrity; void_row_count / voided cells are both reported so the reader
// can see whether a void, if any, affects a handful of rows or an entire cell.
// ---------------------------------------------------------------------------

const STRATA = ['s_ident', 's_approx', 's_prose', 'probe'];
const TIERS = ['T1', 'T2', 'T3', 'T4'];

const perCellCounts = {};
const voidedCells = [];
for (const s of STRATA) {
  perCellCounts[s] = {};
  for (const tier of TIERS) {
    perCellCounts[s][tier] = {};
    for (const arm of ARMS) {
      const rs = rows.filter((r) => r.stratum === s && r.tier === tier && r.arm === arm);
      if (rs.length === 0) continue;
      const modeIntegrityBad = rs.filter((r) => !r.mode_integrity_valid).length;
      perCellCounts[s][tier][arm] = {
        n: rs.length,
        censored_count: rs.filter((r) => r.rank === null).length,
        suppression_event_count: rs.filter((r) => r.suppression_event).length,
        mode_integrity_bad_count: modeIntegrityBad,
        in_window_10_count: rs.filter((r) => r.in_window_10).length,
        voided: modeIntegrityBad > 0,
      };
      if (modeIntegrityBad > 0) voidedCells.push({ stratum: s, tier, arm, bad_row_count: modeIntegrityBad, cell_n: rs.length });
    }
  }
}

// ---------------------------------------------------------------------------
// F7 diagnostic aggregate — symbol-token vs TSDoc-rare-word match-rate split,
// over the ranker-I-bearing arms' per-query f7_diagnostic (attached by the
// wrapper, not part of the validated ResultRow schema — registration:
// "Mandatory diagnostic (F7): per scored query, log which query terms matched
// ... classified symbol-token ... vs TSDoc-rare-word").
// ---------------------------------------------------------------------------

const F7_ARMS = ['L+I', 'H+I', 'L+Isym'];
const f7Aggregate = {};
for (const arm of F7_ARMS) {
  const rs = rows.filter((r) => r.arm === arm && r.f7_diagnostic !== undefined);
  const n = rs.length;
  const anyMatch = rs.filter((r) => r.f7_diagnostic.matched_terms.length > 0).length;
  const symbolTokenMatch = rs.filter((r) => r.f7_diagnostic.symbol_token_terms.length > 0).length;
  const tsdocRareWordMatch = rs.filter((r) => r.f7_diagnostic.tsdoc_rare_word_terms.length > 0).length;
  const bothMatch = rs.filter((r) => r.f7_diagnostic.symbol_token_terms.length > 0 && r.f7_diagnostic.tsdoc_rare_word_terms.length > 0).length;
  f7Aggregate[arm] = {
    n, any_match_count: anyMatch, symbol_token_match_count: symbolTokenMatch,
    tsdoc_rare_word_match_count: tsdocRareWordMatch, both_match_count: bothMatch,
    any_match_rate: n > 0 ? anyMatch / n : null,
    symbol_token_match_rate: n > 0 ? symbolTokenMatch / n : null,
    tsdoc_rare_word_match_rate: n > 0 ? tsdocRareWordMatch / n : null,
  };
}

// ---------------------------------------------------------------------------
// Assemble + write
// ---------------------------------------------------------------------------

const report = {
  ran_at: new Date().toISOString(),
  source_raw_file: inFile,
  source_row_count: rows.length,
  source_sha256: sha256,
  ...scored,
  per_cell_counts: perCellCounts,
  voided_cells: voidedCells,
  f7_diagnostic_aggregate: f7Aggregate,
};

mkdirSync(REPO_RESULTS_DIR, { recursive: true });
writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log(JSON.stringify(report, null, 2));
console.log(`\nwrote ${outFile}`);
console.log(`\n=== VERDICT: ${scored.verdict.verdict} (row ${scored.verdict.base_row}) ===`);
