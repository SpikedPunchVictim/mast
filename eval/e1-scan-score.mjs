// E1-SCAN — the scorer.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-SCAN PRE-REGISTRATION (2026-08-17).
// Every threshold below is quoted from it. Nothing here may be tuned to the data.
//
// Usage (run from packages/mast, never the repo root — HANDOFF §7):
//   node eval/e1-scan-score.mjs
//
// Reads `eval/results/e1-scan-runs.jsonl` and writes `eval/results/e1-scan-verdict.json`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR, writeResult } from './e1-common.mjs';
import { SCAN_ARMS, SCAN_TIERS, SCAN_TOTAL_RUNS } from './e1-scan-schedule.mjs';
import { median } from './e1-schedule.mjs';

const JOURNAL = join(RESULTS_DIR, 'e1-scan-runs.jsonl');

/** Registered thresholds. Named as constants so a reader can diff them against the plan. */
const H1_T9_RATIO_BAR = 2.0;
const H1_FALSIFY_BELOW = 1.2;
const H2_CONTROL_BAND = [0.90, 1.15];
const H3_SLOPE_BAND = [1.15, 1.55];

/** The counts Gate C requires to agree across arms. */
const GATE_C_COUNTS = ['file_count', 'chunk_count', 'symbol_count', 'edge_count', 'potential_call_count'];


function loadRuns() {
  if (!existsSync(JOURNAL)) throw new Error(`No journal at ${JOURNAL} — nothing to score.`);
  return readFileSync(JOURNAL, 'utf-8')
    .split('\n').filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === 'run');
}

/**
 * GATE C — the arms must build an identical graph at every rung.
 *
 * Scored BEFORE any timing, and reported first, because the range query is a
 * deliberate semantics change: case-insensitive path matching was withdrawn, and a
 * mis-cased import on a case-insensitive filesystem is the named residual risk. A
 * divergence here is a correctness finding that outranks the whole timing result.
 */
function gateC(runs) {
  const rows = [];
  for (const tier of SCAN_TIERS) {
    const byArm = {};
    for (const a of SCAN_ARMS) {
      const rs = runs.filter((r) => r.tier === tier && r.arm === a.id);
      if (rs.length) byArm[a.id] = rs;
    }
    if (Object.keys(byArm).length < SCAN_ARMS.length) continue;

    const mismatches = [];
    const values = {};
    for (const c of GATE_C_COUNTS) {
      const perArm = Object.fromEntries(SCAN_ARMS.map((a) => [a.id, [...new Set(byArm[a.id].map((r) => r[c]))]]));
      values[c] = perArm;
      const flat = [...new Set(Object.values(perArm).flat())];
      if (flat.length !== 1) mismatches.push({ count: c, by_arm: perArm });
    }
    rows.push({ tier, ok: mismatches.length === 0, values, mismatches });
  }
  return { ok: rows.length > 0 && rows.every((r) => r.ok), rows };
}

/** Per-rung medians and the no-fix ÷ fix ratio — the primary series. */
function perRung(runs) {
  const rows = [];
  for (const tier of SCAN_TIERS) {
    const n = runs.filter((r) => r.tier === tier && r.arm === 'N');
    const f = runs.filter((r) => r.tier === tier && r.arm === 'R');
    if (n.length === 0 || f.length === 0) continue;
    const nEdges = median(n.map((r) => r.edges_ms));
    const rEdges = median(f.map((r) => r.edges_ms));
    rows.push({
      tier,
      chunks: n[0].chunk_count,
      files: n[0].file_count,
      potential_calls: median(n.map((r) => r.potential_call_count)),
      n_reps: { N: n.length, R: f.length },
      edges_ms: { N: nEdges, R: rEdges },
      edges_ms_all: { N: n.map((r) => r.edges_ms), R: f.map((r) => r.edges_ms) },
      ratio: nEdges / rEdges,
      duration_ms: { N: median(n.map((r) => r.duration_ms)), R: median(f.map((r) => r.duration_ms)) },
      duration_ratio: median(n.map((r) => r.duration_ms)) / median(f.map((r) => r.duration_ms)),
      edges_share_of_duration: {
        N: nEdges / median(n.map((r) => r.duration_ms)),
        R: rEdges / median(f.map((r) => r.duration_ms)),
      },
    });
  }
  return rows;
}

/** Local log-log slope of `edges_ms` in chunks, between two rungs, within one arm. */
function localSlope(rows, loTier, hiTier, arm) {
  const lo = rows.find((r) => r.tier === loTier);
  const hi = rows.find((r) => r.tier === hiTier);
  if (!lo || !hi) return null;
  return Math.log(hi.edges_ms[arm] / lo.edges_ms[arm]) / Math.log(hi.chunks / lo.chunks);
}

function main() {
  const runs = loadRuns();
  const gc = gateC(runs);
  const rows = perRung(runs);
  const at = (t) => rows.find((r) => r.tier === t);

  const t1 = at('T1'), t5 = at('T5'), t8 = at('T8'), t9 = at('T9');
  const complete = runs.length === SCAN_TOTAL_RUNS;

  // H1 — the scan is the dominant cost in the edges knee.
  const h1 = {
    statement: 'Removing the files full scan removes the bulk of the edges knee.',
    bar: `T9 no-fix/fix ratio >= ${H1_T9_RATIO_BAR}`,
    point_forecast: 2.74,
    observed: t9?.ratio ?? null,
    fires: t9 ? t9.ratio >= H1_T9_RATIO_BAR : null,
    falsified: t9 ? t9.ratio < H1_FALSIFY_BELOW : null,
  };

  // H2 — dose-response: the effect must scale with F and vanish where F is small.
  const monotone = t5 && t8 && t9 ? t9.ratio > t8.ratio && t8.ratio > t5.ratio : null;
  const inBand = (x) => x >= H2_CONTROL_BAND[0] && x <= H2_CONTROL_BAND[1];
  const controlsNull = t1 && t5 ? inBand(t1.ratio) && inBand(t5.ratio) : null;
  const h2 = {
    statement: 'The effect scales with file count and is absent where F is small.',
    bar: `ratio(T9) > ratio(T8) > ratio(T5), and ratio(T1), ratio(T5) both in [${H2_CONTROL_BAND.join(', ')}]`,
    point_forecasts: { T1: 1.04, T5: 0.97, T8: 1.79, T9: 2.74 },
    observed: Object.fromEntries(rows.map((r) => [r.tier, r.ratio])),
    monotone_in_F: monotone,
    controls_null: controlsNull,
    fires: monotone === null || controlsNull === null ? null : monotone && controlsNull,
  };

  // H3 — the residual: removing the scan does NOT make edges linear.
  const postFixSlope = localSlope(rows, 'T8', 'T9', 'R');
  const noFixSlope = localSlope(rows, 'T8', 'T9', 'N');
  const h3 = {
    statement: 'Removing the scan does not make the edges phase linear.',
    bar: `post-fix T8->T9 local slope in [${H3_SLOPE_BAND.join(', ')}]`,
    point_forecast: 1.3072,
    rationale:
      'POTENTIAL_CALL rows grow super-linearly in chunks (FINDINGS §1.1 endpoint slope 1.12 ' +
      'across T1->T9; 1.3072 locally over T8->T9), so a cost per surviving row that is flat in ' +
      'F still leaves that slope behind.',
    observed_post_fix: postFixSlope,
    observed_no_fix: noFixSlope,
    baseline_no_fix_e1_verify: 2.4276,
    fires: postFixSlope === null ? null : postFixSlope >= H3_SLOPE_BAND[0] && postFixSlope <= H3_SLOPE_BAND[1],
  };

  // The descriptive plateau normaliser. Labelled, per FINDINGS §1.1, as a
  // normalisation and NOT a per-invocation cost — the invocation count is unmeasured.
  const plateau = rows.map((r) => ({
    tier: r.tier,
    us_per_surviving_row: {
      N: (1000 * r.edges_ms.N) / r.potential_calls,
      R: (1000 * r.edges_ms.R) / r.potential_calls,
    },
  }));

  const verdict = {
    created: new Date().toISOString(),
    registration: 'IMPLEMENTATION_PLAN.md § E1-SCAN PRE-REGISTRATION (2026-08-17)',
    complete,
    runs_scored: runs.length,
    total_expected: SCAN_TOTAL_RUNS,
    gate_c: gc,
    per_rung: rows,
    h1, h2, h3,
    plateau_descriptive: plateau,
    caveat_potential_call_count:
      'potential_call_count is a surviving-row count after primary-key dedup (FINDINGS §1.1), ' +
      'not a work counter. us_per_surviving_row is a normalisation, never a per-call cost.',
    query_plan_sample: Object.fromEntries(
      SCAN_ARMS.map((a) => [a.id, runs.find((r) => r.arm === a.id)?.query_plan ?? null]),
    ),
    scoreable: complete && gc.ok,
  };
  writeResult('e1-scan-verdict.json', verdict);

  // --- report ---
  console.log('[E1-SCAN] VERDICT');
  console.log(`  runs scored: ${runs.length}/${SCAN_TOTAL_RUNS}`);
  console.log('');
  console.log('  GATE C (arms build an identical graph)');
  for (const r of gc.rows) {
    console.log(`    ${r.tier}: ${r.ok ? 'PASS' : 'FAIL'}` +
      (r.ok ? '' : ` — ${r.mismatches.map((m) => `${m.count} ${JSON.stringify(m.by_arm)}`).join('; ')}`));
  }
  if (!gc.ok) {
    console.log('    *** CORRECTNESS FINDING — this outranks every timing number below. ***');
  }
  console.log('');
  console.log('  tier  chunks  files   edges_ms N   edges_ms R   ratio   dur_ratio');
  for (const r of rows) {
    console.log(`    ${r.tier}  ${String(r.chunks).padStart(6)}  ${String(r.files).padStart(5)}  ` +
      `${String(r.edges_ms.N).padStart(10)}   ${String(r.edges_ms.R).padStart(10)}   ` +
      `${r.ratio.toFixed(3).padStart(6)}   ${r.duration_ratio.toFixed(3).padStart(6)}`);
  }
  console.log('');
  for (const [name, h] of [['H1', h1], ['H2', h2], ['H3', h3]]) {
    console.log(`  ${name}: ${h.fires === null ? 'INCOMPLETE' : h.fires ? 'FIRES' : 'DOES NOT FIRE'} — ${h.bar}`);
  }
  if (h1.falsified) {
    console.log('  *** H1 FALSIFIED (T9 ratio < 1.2): the scan is NOT the mechanism. ***');
  }
  console.log(`  H3 slopes: no-fix ${noFixSlope?.toFixed(4)} -> post-fix ${postFixSlope?.toFixed(4)}`);
  console.log('');
  console.log(`  scoreable: ${verdict.scoreable}`);
}

main();
