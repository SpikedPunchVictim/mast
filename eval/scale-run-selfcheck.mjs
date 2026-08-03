// Q1/SCALE — Gate 2 driver. NEW file, not a modification of any committed
// instrument script. scale-rank-check.mjs's own CLI entry point
// (`node eval/scale-rank-check.mjs --self-check`) is guarded off — it prints
// "Refusing to run automatically from this entry point during instrument
// construction" and exits(2), even though its header comment documents that
// exact invocation as the Gate 2 command. Its header also says: "A later
// phase should import { runSelfCheck } and call it explicitly with the 10
// probe queries from scale-queries.json." This file IS that later phase,
// doing exactly what the header prescribes, without touching the guarded
// committed file.
//
// Additionally widens the pass/fail criterion beyond scale-rank-check.mjs's
// own `mismatches` counter, which only increments on `wrapper_reproduces_shipped`
// (a determinism check: calling shipped hybridSearch twice on the same query
// gives the same ordered list) and does NOT count a `reconstruction_matches_shipped`
// failure or an H-arm `mode_integrity.valid === false` as a mismatch, even though
// the registration's Gate 2 (F9) requires the reconstruction equivalence and the
// mode:"hybrid" assertion as PART OF the "0 mismatches required" bar. This driver
// computes gate2_pass = 0 across all three checks and reports the script's own
// undercounting `mismatches` figure alongside it for the record.
//
//   node eval/scale-run-selfcheck.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfCheck } from './scale-rank-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_RESULTS_DIR = join(__dirname, 'results');

const queriesPath = join(__dirname, 'scale-queries.json');
const queries = JSON.parse(readFileSync(queriesPath, 'utf8'));
const probeQueries = queries.strata.probes.queries;

console.log(`[gate2] loaded ${probeQueries.length} probe queries from scale-queries.json`);
console.log('[gate2] running runSelfCheck across T1-T4 x H/L ...');

const t0 = Date.now();
const { mismatches: scriptMismatches, rows } = await runSelfCheck(probeQueries);
const elapsedSec = (Date.now() - t0) / 1000;

// Full gate criterion: ALL of (wrapper determinism, reconstruction equivalence,
// H-arm mode:"hybrid") must hold on every row — not just the script's own
// undercounted `mismatches` field. See header note above.
let fullMismatches = 0;
const failingRows = [];
for (const r of rows) {
  const modeOk = r.arm === 'H' ? r.mode_integrity.valid === true : true;
  const ok = r.wrapper_reproduces_shipped === true && r.reconstruction_matches_shipped === true && modeOk;
  if (!ok) {
    fullMismatches++;
    failingRows.push({ ...r, mode_ok: modeOk });
  }
}

const hModeCount = rows.filter((r) => r.arm === 'H').length;
const hModeHybridCount = rows.filter((r) => r.arm === 'H' && r.mode_integrity.mode === 'hybrid').length;

const report = {
  ran_at: new Date().toISOString(),
  probe_count: probeQueries.length,
  tiers_x_arms_x_probes: rows.length,
  elapsed_sec: elapsedSec,
  script_reported_mismatches: scriptMismatches,
  full_gate2_mismatches: fullMismatches,
  h_probes_total: hModeCount,
  h_probes_mode_hybrid: hModeHybridCount,
  h_mode_assertion_pass: hModeCount === hModeHybridCount,
  gate2_pass: fullMismatches === 0 && hModeCount === hModeHybridCount,
  failing_rows: failingRows,
  rows,
};

mkdirSync(REPO_RESULTS_DIR, { recursive: true });
const outFile = join(REPO_RESULTS_DIR, 'scale-gate2-selfcheck.json');
writeFileSync(outFile, JSON.stringify(report, null, 2));

console.log(`[gate2] rows=${rows.length} script_mismatches=${scriptMismatches} full_gate2_mismatches=${fullMismatches}`);
console.log(`[gate2] H probes: ${hModeHybridCount}/${hModeCount} report mode:"hybrid"`);
console.log(`[gate2] GATE 2 -> ${report.gate2_pass ? 'PASS' : 'FAIL'}`);
console.log(`wrote ${outFile}`);

if (!report.gate2_pass) process.exit(1);
