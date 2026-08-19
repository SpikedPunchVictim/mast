// Fits the series that FINDINGS.md § 1.2 and § 1.4 record as committed-but-unread.
//
// DESCRIPTIVE, NOT REGISTERED. No hypothesis, no threshold, no verdict, no NULL. This
// script adjudicates nothing — it turns hand analysis and hardcoded prose constants into
// a scored artifact so that the next registration starts from numbers a reader can check
// rather than from numbers someone remembers.
//
// It exists because of the E1-EDGES retirement: a 30-run experiment was registered against
// a question its own corpus had already answered in a committed journal that no scorer
// read. FINDINGS.md § 1 is the register of what is still in that state; this closes the
// rows that can be closed by arithmetic alone.
//
// WHAT IT DOES NOT DO. It fits no new corpus and runs no build. Every number here comes
// from a journal that was committed days ago. In particular it cannot settle the edges
// phase — a fitted exponent describes the curve, it does not name the mechanism, and this
// program's own rule is that the phase must be instrumented before it is A/B'd.
//
// TWO ESTIMATORS, DELIBERATELY. `all_runs` fits every scoreable run; `rung_medians` fits
// one median point per rung. E1's scorers use the former. The constants in
// `vscode-build.mjs` were produced by the latter. They are close but not equal, and which
// one a claim uses has to be stated — see the SELF-CHECK block below, which pins both.
//
// Run from `packages/mast`, never the repo root.
//
//   node eval/e1-unread-fit.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { olsFit, hc3SlopeSe, studentTQuantile } from './e1-stats.mjs';
import { RESULTS_DIR, writeResult } from './e1-common.mjs';
import { selectAbRuns } from './e1-ab-report.mjs';
import { selectFtsRuns } from './e1-fts-report.mjs';
import { median } from './e1-schedule.mjs';

const PHASES = ['walk', 'parse', 'write', 'edges', 'finalise'];
const SPANS = ['fts_del', 'fts_ins', 'commit', 'rest', 'txn', 'lock'];

/**
 * The constants this fit must reproduce, and where each is recorded.
 *
 * These are the script's test. Each was produced independently — by hand during an earlier
 * session, or by a scorer that ships — and each is quoted somewhere that acts on it. If a
 * fit here disagrees with the source, one of the two is wrong and the disagreement is the
 * finding. Nothing is silently rounded into agreement.
 */
const SELF_CHECK = [
  // `eval/vscode-build.mjs:60-64` — the per-phase projection to the 150k target. Produced
  // by the median estimator, so that is the family they are checked against.
  // Every tolerance is 1e-4 — the width of the 4-dp rounding in the recorded constants, and
  // nothing more. Observed deviations are all <= 4.9e-5, so each check has about 2x headroom.
  //
  // `write` and `duration` briefly carried 0.0020 and 0.0005, on the belief that they did not
  // reproduce. They do. Those tolerances were not merely stale, they were harmful: 0.0020
  // would have PASSED the erroneous 1.1117 that FINDINGS.md § 1.3 records (|1.1117 - 1.1136|
  // = 0.0019), which is the precise error this check exists to catch. A tolerance sized to
  // an assumed discrepancy tests nothing once the assumption is withdrawn.
  { id: 'vscode_walk', expect: 0.6108, tol: 0.0001, from: 'vscode-build.mjs:61' },
  { id: 'vscode_parse', expect: 0.9929, tol: 0.0001, from: 'vscode-build.mjs:62' },
  { id: 'vscode_edges', expect: 1.3949, tol: 0.0001, from: 'vscode-build.mjs:64' },
  { id: 'vscode_write', expect: 1.1136, tol: 0.0001, from: 'vscode-build.mjs:63' },
  { id: 'vscode_duration', expect: 1.0789, tol: 0.0001, from: 'vscode-build.mjs:60' },
  // `e1-fts-verdict.json` condition 4 — a shipped scorer's output, all-runs family.
  { id: 'fts_b_write_g', expect: 1.0956, tol: 0.0001, from: 'e1-fts-verdict.json b_write_g' },
];

const readJournal = (name) =>
  readFileSync(join(RESULTS_DIR, name), 'utf-8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));


/**
 * OLS of `ln(y)` on `ln(chunk_count)`, with an HC3 interval.
 *
 * Reimplemented here rather than imported from `e1-phase-score.mjs` because that module's
 * `fitSeries` reports its degenerate cases keyed on `r.tier`, and E1-VERIFY's rows carry
 * `corpus` instead — the offender list would come back as a column of `undefined` on the
 * one journal this script most needs to read. The arithmetic is identical.
 *
 * @param {Array<{x: number, y: number}>} pts
 * @returns {object} a fit, or a `degenerate` marker — never a silently dropped point.
 */
function fitLogLog(pts) {
  const bad = pts.filter((p) => !(p.y > 0) || !(p.x > 0));
  if (bad.length > 0) {
    return { degenerate: 'non_positive_values', n_total: pts.length, n_non_positive: bad.length };
  }
  const xs = pts.map((p) => Math.log(p.x));
  const ys = pts.map((p) => Math.log(p.y));
  const fit = olsFit(xs, ys);
  if (fit.resid.reduce((s, r) => s + r * r, 0) === 0) {
    return { degenerate: 'zero_residual_variance', n: fit.n };
  }
  const se = hc3SlopeSe(fit, xs);
  const t = studentTQuantile(0.975, fit.n - 2);
  return {
    b: fit.slope,
    se_hc3: se,
    n: fit.n,
    df: fit.n - 2,
    ci_hc3: [fit.slope - t * se, fit.slope + t * se],
    ci_is_context_only: true,
  };
}

/**
 * Both estimators over one series, plus the raw per-rung medians they were fitted on.
 *
 * The medians are published, not just the slope: a single exponent over a series with a
 * knee in it is a summary that hides the thing worth looking at, and the edges series has
 * one (FINDINGS.md § 2.3).
 *
 * @param {object[]} runs   scoreable runs, each carrying `chunk_count`
 * @param {Function} rungOf run -> rung label (`tier` on most journals, `corpus` on verify)
 * @param {Function} extract run -> the value being fitted
 */
function fitBoth(runs, rungOf, extract) {
  const byRung = new Map();
  for (const r of runs) {
    const k = rungOf(r);
    if (!byRung.has(k)) byRung.set(k, []);
    byRung.get(k).push(r);
  }
  const rungs = [...byRung.entries()]
    .map(([rung, rs]) => ({
      rung,
      chunks: rs[0].chunk_count,
      n: rs.length,
      median_ms: median(rs.map(extract)),
    }))
    .sort((a, b) => a.chunks - b.chunks);

  return {
    all_runs: fitLogLog(runs.map((r) => ({ x: r.chunk_count, y: extract(r) }))),
    rung_medians: fitLogLog(rungs.map((r) => ({ x: r.chunks, y: r.median_ms }))),
    rungs,
  };
}

// ---------------------------------------------------------------------------
// § 1.2 / § 1.4 — E1-VERIFY: the only nine-rung per-phase ladder measured against
// the shipped binary. 27 runs, no scorer reads them.
// ---------------------------------------------------------------------------

function fitVerify() {
  const records = readJournal('e1-verify-runs.jsonl');
  // The verify scorer's own selection rule (`e1-verify-score.mjs:29-36`): last write per
  // `corpus#rep` wins, a `void` removes the key. Reproduced rather than imported because
  // that scorer does the fold inline in `main()`.
  const done = new Map();
  const voids = new Map();
  for (const r of records) {
    const k = `${r.corpus}#r${r.rep}`;
    if (r.type === 'run') { done.set(k, r); voids.delete(k); }
    else if (r.type === 'void') { voids.set(k, r); done.delete(k); }
  }
  if (voids.size > 0) throw new Error(`E1-VERIFY has ${voids.size} unresolved voids; not fittable.`);
  const runs = [...done.values()];

  const rungOf = (r) => r.corpus;
  const phases = {};
  for (const p of PHASES) phases[p] = fitBoth(runs, rungOf, (r) => r.phase_ms[p]);
  const spans = {};
  for (const s of SPANS) spans[s] = fitBoth(runs, rungOf, (r) => r.write_spans[s]);

  // The knee (§ 2.3). Per-edge cost is what a mechanism has to explain; the exponent is
  // only its summary, and on this series the summary is misleading — see the note in the
  // emitted record.
  const perEdge = fitBoth(runs, rungOf, (r) => r.phase_ms.edges / r.edge_count);
  const density = fitBoth(runs, rungOf, (r) => r.edge_count / r.chunk_count);
  // `potential_call_count` is recorded ONLY under `measurement` — unlike `edge_count` and
  // `chunk_count`, it is not lifted to the top level of the journal row. Reading it from
  // the top level yields `undefined`, and the fit then reports `non_positive_values`
  // rather than a plausible number. That is the guard doing its job, not a passing test.
  const potentialShare = fitBoth(runs, rungOf, (r) => r.measurement.potential_call_count / r.edge_count);
  const potentialPerChunk = fitBoth(runs, rungOf, (r) => r.measurement.potential_call_count / r.chunk_count);

  return {
    n_runs: runs.length,
    n_rungs: new Set(runs.map(rungOf)).size,
    rung_key: 'corpus (this journal has no `tier` field — FINDINGS.md § 1)',
    duration: fitBoth(runs, rungOf, (r) => r.duration_ms),
    phases,
    spans,
    edges_detail: {
      ms_per_edge: perEdge,
      edges_per_chunk: density,
      potential_call_share: potentialShare,
      potential_call_per_chunk: potentialPerChunk,
    },
  };
}

/**
 * The edges phase's exponent is the sum of three: per-edge cost, edge density, and the
 * corpus itself.
 *
 *   edges_ms = (ms/edge) * (edges/chunk) * chunks
 *   =>  b_edges = b_msPerEdge + b_edgesPerChunk + 1
 *
 * An exact identity under OLS on the same points, so it is a check on the arithmetic
 * rather than a result. It earns its place because it also says where the exponent comes
 * from: an edges phase that is super-linear because it emits more edges per chunk is a
 * different problem from one that is super-linear because each edge got dearer, and the
 * single fitted number cannot tell them apart.
 */
function decompositionCheck(detail, edgesFit) {
  const rows = [];
  for (const fam of ['all_runs', 'rung_medians']) {
    const parts = [detail.ms_per_edge[fam], detail.edges_per_chunk[fam]];
    if (parts.some((p) => p.degenerate)) continue;
    const sum = parts[0].b + parts[1].b + 1;
    rows.push({
      family: fam,
      b_ms_per_edge: parts[0].b,
      b_edges_per_chunk: parts[1].b,
      implied_b_edges: sum,
      actual_b_edges: edgesFit[fam].b,
      residual: sum - edgesFit[fam].b,
      holds: Math.abs(sum - edgesFit[fam].b) < 1e-9,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// § 1.2 — E1-AB (30 runs, 3 rungs, a 512x cache range) and E1-FTS (30 runs, 5 rungs,
// guard off/on). Both are fitted per arm: pooling arms would fit a curve through two
// different binaries, or two different pragmas, and call the result an exponent.
// ---------------------------------------------------------------------------

function fitByArm(journalName, selector, arms, extras = {}) {
  const sel = selector(readJournal(journalName));
  const out = { n_runs: sel.runs.length, complete: sel.complete, arms: {} };
  for (const arm of arms) {
    const runs = sel.runs.filter((r) => r.arm === arm);
    const phases = {};
    for (const p of PHASES) phases[p] = fitBoth(runs, (r) => r.tier, (r) => r.phase_ms[p]);
    const detail = {};
    for (const [k, extract] of Object.entries(extras)) {
      detail[k] = fitBoth(runs, (r) => r.tier, extract);
    }
    out.arms[arm] = { n: runs.length, phases, ...(Object.keys(detail).length ? { detail } : {}) };
  }
  return out;
}

function runSelfCheck(verify, fts) {
  const got = {
    vscode_walk: verify.phases.walk.rung_medians.b,
    vscode_parse: verify.phases.parse.rung_medians.b,
    vscode_edges: verify.phases.edges.rung_medians.b,
    vscode_write: verify.phases.write.rung_medians.b,
    vscode_duration: verify.duration.rung_medians.b,
    fts_b_write_g: fts.arms.G.phases.write.all_runs.b,
  };
  return SELF_CHECK.map((c) => {
    const actual = got[c.id];
    const delta = typeof actual === 'number' ? actual - c.expect : null;
    return {
      id: c.id,
      source: c.from,
      expected: c.expect,
      actual,
      delta,
      within_tolerance: delta !== null && Math.abs(delta) <= c.tol,
      tolerance: c.tol,
    };
  });
}

function main() {
  const verify = fitVerify();
  const ab = fitByArm('e1-ab-runs.jsonl', selectAbRuns, ['A', 'B', 'D'], {
    ms_per_edge: (r) => r.phase_ms.edges / r.edge_count,
  });
  const fts = fitByArm('e1-fts-runs.jsonl', selectFtsRuns, ['A', 'G'], {
    ms_per_edge: (r) => r.phase_ms.edges / r.edge_count,
  });

  const checks = runSelfCheck(verify, fts);
  const decomp = decompositionCheck(verify.edges_detail, verify.phases.edges);
  const failed = checks.filter((c) => !c.within_tolerance)
    .concat(decomp.filter((d) => !d.holds).map((d) => ({ id: `decomposition_${d.family}` })));

  const record = {
    created: new Date().toISOString(),
    what_this_is:
      'Descriptive fits of the series FINDINGS.md § 1.2 and § 1.4 record as committed but ' +
      'read by no scorer. NOT REGISTERED: no hypothesis, no threshold, no verdict. It ' +
      'adjudicates nothing and licenses no change — it exists so the next registration ' +
      'starts from checkable numbers instead of prose constants.',
    not_a_mechanism:
      'A fitted exponent describes a curve; it does not name a cause. In particular the ' +
      'edges phase remains unexplained, and this program\'s rule stands: instrument before ' +
      'you A/B. Registering a lever against an unidentified mechanism is what produced and ' +
      'then retired E1-EDGES.',
    estimators:
      'all_runs = OLS over every scoreable run (what E1\'s scorers use). rung_medians = OLS ' +
      'over one median point per rung (what produced vscode-build.mjs\'s constants). They ' +
      'differ; any claim must say which family it quotes.',
    self_check: checks,
    edges_decomposition: decomp,
    self_check_passed: failed.length === 0,
    e1_verify: verify,
    e1_ab: ab,
    e1_fts: fts,
  };
  const out = writeResult('e1-unread-fit.json', record);

  const f = (x, d = 4) => (typeof x === 'number' ? x.toFixed(d) : String(x));
  const bOf = (fit) => (fit.degenerate ? `[${fit.degenerate}]` : f(fit.b));

  console.log('\n=== SELF-CHECK — must reproduce independently recorded constants ===');
  for (const c of checks) {
    console.log(`  ${c.within_tolerance ? 'ok  ' : 'FAIL'} ${c.id.padEnd(16)} ` +
      `expected ${f(c.expected)}  got ${f(c.actual, 6)}  delta ${f(c.delta, 7).padStart(10)}   (${c.source})`);
  }

  console.log('\n  edges exponent decomposition — b_edges = b_msPerEdge + b_edgesPerChunk + 1:');
  for (const d of decomp) {
    console.log(`    ${d.holds ? 'ok  ' : 'FAIL'} ${d.family.padEnd(13)} ` +
      `${f(d.b_ms_per_edge)} + ${f(d.b_edges_per_chunk)} + 1 = ${f(d.implied_b_edges)} ` +
      `vs ${f(d.actual_b_edges)}`);
  }

  console.log(`\n=== E1-VERIFY — ${verify.n_runs} runs, ${verify.n_rungs} rungs, post-guard, previously unscored ===`);
  console.log('  series          all_runs   HC3 interval            rung_medians');
  const line = (name, o) => console.log('  ' + name.padEnd(15) + bOf(o.all_runs).padStart(8) +
    '   ' + (o.all_runs.ci_hc3 ? `[${f(o.all_runs.ci_hc3[0])}, ${f(o.all_runs.ci_hc3[1])}]` : '—').padEnd(22) +
    '  ' + bOf(o.rung_medians));
  line('duration', verify.duration);
  for (const p of PHASES) line(`phase.${p}`, verify.phases[p]);
  for (const s of SPANS) line(`span.${s}`, verify.spans[s]);
  line('ms/edge', verify.edges_detail.ms_per_edge);
  line('edges/chunk', verify.edges_detail.edges_per_chunk);
  line('POTENTIAL/edge', verify.edges_detail.potential_call_share);
  line('POTENTIAL/chunk', verify.edges_detail.potential_call_per_chunk);

  console.log('\n  edges phase, per rung (the knee — the exponent above is its summary):');
  const er = verify.edges_detail.ms_per_edge.rungs;
  const dr = verify.phases.edges.rungs;
  console.log('    rung      chunks   edges_ms   ms/edge');
  for (let i = 0; i < er.length; i++) {
    console.log(`    ${String(er[i].rung).padEnd(6)}${String(er[i].chunks).padStart(8)}` +
      `${String(Math.round(dr[i].median_ms)).padStart(11)}${f(er[i].median_ms, 5).padStart(10)}`);
  }

  for (const [name, res] of [['E1-AB', ab], ['E1-FTS', fts]]) {
    console.log(`\n=== ${name} — ${res.n_runs} runs, per arm, previously unscored ===`);
    console.log('  arm   n   ' + PHASES.map((p) => p.padStart(9)).join('') + '   ms/edge');
    for (const [arm, a] of Object.entries(res.arms)) {
      console.log(`  ${arm.padEnd(5)}${String(a.n).padStart(2)}   ` +
        PHASES.map((p) => bOf(a.phases[p].all_runs).padStart(9)).join('') +
        '  ' + bOf(a.detail.ms_per_edge.all_runs).padStart(8));
    }
  }

  console.log(`\nwrote ${out}`);
  if (failed.length > 0) {
    console.error(`\nSELF-CHECK FAILED for ${failed.length} constant(s). A fit here disagrees ` +
      `with a number that is recorded and acted on elsewhere. That disagreement is the finding — ` +
      `do not adopt either value until it is resolved.`);
    process.exitCode = 1;
  }
}

main();
