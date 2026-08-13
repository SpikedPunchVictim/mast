// E1-PHASE — read the journal, score it, write the verdict artifact.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-PHASE PRE-REGISTRATION (2026-08-12).
//
// This file holds NO decision machinery. The classification comes from `scoreE1Phase`,
// whose thresholds were committed at `36c2f5a` before any measurement existed. What lives
// here is the seam between the journal and that scorer — run selection and printing — kept
// separate for the reason E1's R5 finding made concrete: a reporting seam written after the
// data exists has discretion, and the only defence is that it cannot reach the rules.
//
// Usage (run from packages/mast, never the repo root — HANDOFF §7):
//   node eval/e1-phase-report.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, writeResult } from './e1-common.mjs';
import { REPS } from './e1-schedule.mjs';
import { PHASE_TIERS, PHASE_TOTAL_RUNS, PHASES } from './e1-phase-schedule.mjs';
import { SERIES, scoreE1Phase } from './e1-phase-score.mjs';

/**
 * Select the 15 scored runs from a journal.
 *
 * The registration fixes the fit's membership, so a journal that cannot supply exactly the
 * five rungs at three repetitions is a defect, not an input. A resumed schedule appends and
 * `attempt_start` records outnumber runs whenever Gate 3 retakes, so neither "every record"
 * nor "the last 15" is a safe selector.
 */
export function selectPhaseRuns(records) {
  const runs = records.filter((r) => r.type === 'run');

  const seen = new Set();
  for (const r of runs) {
    const k = `${r.corpus}#${r.rep}`;
    if (seen.has(k)) {
      throw new Error(
        `selectPhaseRuns: duplicate run record for ${k}. A resumed journal appends, so a ` +
        `duplicate would enter the fit twice and silently over-weight that repetition.`
      );
    }
    seen.add(k);
  }

  if (runs.length !== PHASE_TOTAL_RUNS) {
    throw new Error(`selectPhaseRuns: expected ${PHASE_TOTAL_RUNS} runs, got ${runs.length}.`);
  }
  for (const t of PHASE_TIERS) {
    const n = runs.filter((r) => r.tier === t).length;
    if (n !== REPS) throw new Error(`selectPhaseRuns: rung ${t} has ${n} repetitions, expected ${REPS}.`);
  }
  return runs;
}

function readJson(name) {
  return JSON.parse(readFileSync(join(RESULTS_DIR, name), 'utf8'));
}

function main() {
  const records = readFileSync(join(RESULTS_DIR, 'e1-phase-runs.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const calibration = readJson('e1-phase-calibration.json');
  const summary = readJson('e1-phase-runs-summary.json');

  const c = calibration.c_ms;
  if (!Number.isFinite(c)) {
    throw new Error(`e1-phase-report: e1-phase-calibration.json has no finite c_ms (got ${c}).`);
  }

  const runs = selectPhaseRuns(records);
  const scored = scoreE1Phase(runs, { c });

  const record = {
    created: new Date().toISOString(),
    is_a_diagnostic:
      "E1-PHASE cannot confirm, overturn or soften E1's SUPER-LINEAR verdict, and no result " +
      'here may be reported as doing so. E1 answered how steeply cost grows; this answers ' +
      'where the time goes.',
    calibration_c_ms: c,
    driver_findings: summary.findings,
    ...scored,
  };

  const out = writeResult('e1-phase-verdict.json', record);

  const f = (x, d = 4) => (typeof x === 'number' ? x.toFixed(d) : String(x));
  console.log(`[E1-PHASE] c = ${c} ms   n = ${scored.n_runs} runs over ${scored.n_rungs} rungs`);
  console.log('');
  console.log('  series      b        HC3 95% (context only)      T9 share');
  for (const name of SERIES) {
    const e = scored.exponents[name];
    const share = scored.shares.at(-1).median_run[name];
    console.log(
      `  ${name.padEnd(10)} ${e.degenerate ? e.degenerate.padEnd(8) : f(e.b).padEnd(8)} ` +
      `${e.ci_hc3 ? `[${f(e.ci_hc3[0])}, ${f(e.ci_hc3[1])}]`.padEnd(26) : ''.padEnd(26)} ` +
      `${(share * 100).toFixed(2)}%`);
  }

  console.log('');
  console.log('  rung   chunks   ' + PHASES.map((p) => p.padStart(9)).join(''));
  for (const s of scored.shares) {
    console.log(`  ${s.tier.padEnd(6)} ${String(s.chunk_count).padStart(6)}   ` +
      PHASES.map((p) => `${(s.median_run[p] * 100).toFixed(2)}%`.padStart(9)).join(''));
  }

  console.log('');
  if (scored.void) {
    console.log(`[E1-PHASE] VOID — ${scored.void_reason}`);
  } else {
    for (const h of ['H1', 'H2', 'H3', 'H4']) {
      const v = scored.hypotheses[h];
      console.log(`[E1-PHASE] ${h}: ${v.fires ? 'FIRES' : `refuted by ${v.refuted_by.join(', ')}`}`);
    }
    console.log(`[E1-PHASE] OUTCOME  ${scored.hypotheses.outcome}`);
    console.log(`[E1-PHASE] next     ${scored.hypotheses.next_step}`);
  }

  const mr = scored.mini_replication;
  console.log('');
  console.log(`[E1-PHASE] mini-replication b = ${f(mr.b)} HC3 [${f(mr.ci_hc3?.[0])}, ${f(mr.ci_hc3?.[1])}] ` +
    `— ${mr.consistent_with_e1 ? 'consistent with' : 'NOT consistent with'} E1's ${mr.e1_b} (adjudicates nothing)`);

  for (const finding of scored.findings) console.log(`[E1-PHASE] FINDING: ${finding}`);
  console.log(`\nwrote ${out}`);
}

if (process.argv[1] && process.argv[1].endsWith('e1-phase-report.mjs')) main();
