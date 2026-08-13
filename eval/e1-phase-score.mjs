// E1-PHASE — the scoring machinery: per-phase exponents, shares, and the H1-H4/H0 classification.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-PHASE PRE-REGISTRATION (2026-08-12).
//
// The four numeric thresholds here (1.6 / 1.25 / 0.60 / 1.7529) were committed at 36c2f5a,
// before any measurement existed — including the 60% write-share condition, which the Gate P
// attribution runs could otherwise have tuned (see the registration's "Declared peek"). The
// ESTIMATOR RULES built on them — point-estimate comparison, the median-run share, strict
// monotonicity, the mini-replication consistency test — arrived later, at ef02ef9, ~100
// seconds after that peek and ~90 minutes before the first scored run. The distinction is
// recorded because the results review found this file's first version claiming the stronger
// provenance for both (RR2). Nothing here may be edited now that the scored runs exist; a
// repaired rule is a new registration.
//
// This file holds the RULES. `e1-phase-report.mjs` holds the seam between the journal and
// these rules, kept separate for the same reason `e1-report.mjs` is: reading the data must
// not be able to reach the decision table.

import { PHASE_TIERS, PHASES, WALK_VOID_SHARE, REMAINDER_FINDING_SHARE } from './e1-phase-schedule.mjs';
import { REPS } from './e1-schedule.mjs';
import { olsFit, hc3SlopeSe, studentTQuantile } from './e1-stats.mjs';
import { fitOne } from './e1-score.mjs';

/** The one exponent bar, identical for every hypothesis. Registered. */
export const EXPONENT_BAR = 1.6;
/** H1's consistency check on parse. Registered. */
export const PARSE_CEILING = 1.25;
/** H1's one substantively free condition. Registered. */
export const WRITE_SHARE_FLOOR = 0.6;
/** E1's adjusted HC3 point estimate — the mini-replication's consistency target. */
export const E1_B = 1.7529;

/** The five phases plus the unattributed remainder, which is fitted as a sixth series. */
export const SERIES = [...PHASES, 'remainder'];

/** `durationMs - Sigma phase_ms` — teardown, including WAL's close-time checkpoint. */
export function remainderMs(run) {
  return run.duration_ms - PHASES.reduce((s, p) => s + run.phase_ms[p], 0);
}

const valueOf = (name) => (name === 'remainder' ? remainderMs : (r) => r.phase_ms[name]);

/**
 * The run a rung's shares are read from: "share at T9 is computed from T9's median run".
 *
 * Not the mean and not a pooled ratio-of-sums, both of which would mix attempts — the same
 * class of error `selectFitted` exists to prevent inside a single run.
 */
export function medianRun(runs) {
  if (runs.length === 0) throw new Error('medianRun: empty sample.');
  if (runs.length % 2 === 0) {
    throw new Error(
      `medianRun: ${runs.length} runs is an even sample and has no median RUN. Three ` +
      `repetitions are registered; averaging two runs' phase maps would fabricate a ` +
      `decomposition no run ever produced.`
    );
  }
  const sorted = runs.slice().sort((a, b) => a.duration_ms - b.duration_ms);
  return sorted[(sorted.length - 1) / 2];
}

/**
 * OLS of `ln(series_ms)` on `ln(chunk_count)` across all 15 runs, with an HC3 interval.
 *
 * The interval is CONTEXT: the registration puts every comparison on HC3 point estimates,
 * because at 5 rungs a cluster-level 95% interval is roughly +/-0.22 even at E1's realized
 * sigma, and permitting "the CI touches 1.6" would make every condition negotiable after
 * the data arrived.
 *
 * Both degenerate returns omit `b` deliberately where the fit is meaningless, so a caller
 * cannot read a point estimate off a fit that has none.
 */
export function fitSeries(runs, extract) {
  const bad = runs.filter((r) => !(extract(r) > 0));
  if (bad.length > 0) {
    return {
      degenerate: 'non_positive_values',
      n_non_positive: bad.length,
      offenders: bad.map((r) => ({ tier: r.tier, rep: r.rep, value: extract(r) })),
    };
  }

  const xs = runs.map((r) => Math.log(r.chunk_count));
  const ys = runs.map((r) => Math.log(extract(r)));
  const fit = olsFit(xs, ys);

  // Gate 7 case (e), carried over from `fitOne`: zero residual variance yields SE = 0 and a
  // zero-width interval, which reads as an infinitely precise measurement. It is degeneracy.
  if (fit.resid.reduce((s, r) => s + r * r, 0) === 0) {
    return { degenerate: 'zero_residual_variance', n: fit.n };
  }

  const se = hc3SlopeSe(fit, xs);
  const t = studentTQuantile(0.975, fit.n - 2);
  return {
    b: fit.slope,
    se_hc3: se,
    df: fit.n - 2,
    n: fit.n,
    ci_hc3: [fit.slope - t * se, fit.slope + t * se],
    ci_is_context_only: true,
  };
}

/**
 * Per-rung shares of `durationMs`, under BOTH readings the registration uses.
 *
 * `median_run` — the shares of the rung's median run, which H1's T9 share condition reads.
 * `median_of_shares` — the median of the rung's three per-run shares, which H2's
 * monotonicity reads.
 *
 * They are different statistics and are both published because on real data they need not
 * coincide; publishing one would leave the choice between them available after the fact.
 */
export function tierShares(runs) {
  const med = (vs) => vs.slice().sort((a, b) => a - b)[(vs.length - 1) / 2];

  return PHASE_TIERS.map((tier) => {
    const rungRuns = runs.filter((r) => r.tier === tier);
    const centre = medianRun(rungRuns);
    const medianRunShares = {};
    const medianOfShares = {};
    for (const name of SERIES) {
      medianRunShares[name] = valueOf(name)(centre) / centre.duration_ms;
      medianOfShares[name] = med(rungRuns.map((r) => valueOf(name)(r) / r.duration_ms));
    }
    return {
      tier,
      chunk_count: centre.chunk_count,
      n: rungRuns.length,
      median_run_rep: centre.rep,
      median_run: medianRunShares,
      median_of_shares: medianOfShares,
    };
  });
}

/** One registered condition, recorded with its value so a near-miss is auditable. */
const cond = (name, value, pass, test) => ({ name, value, test, pass });

/**
 * The registered classification. H1-H4 with H0 as the exhaustive residual.
 *
 * H1 and H2 are not exclusive; both firing is a reportable outcome, not an ambiguity to be
 * resolved by choosing one. H0 fires only when all four are refuted, and it escalates
 * exactly as H4 — the registration fixes that so a diffuse or unclassified result cannot be
 * quietly re-analysed into a localisation.
 */
export function evaluateHypotheses({ b, writeShareT9, edgeMedianShares }) {
  for (const p of PHASES) {
    if (typeof b[p] !== 'number' || !Number.isFinite(b[p])) {
      throw new Error(
        `evaluateHypotheses: exponent for '${p}' is ${b[p]}. A degenerate or missing fit is ` +
        `an open question, not a failed condition — treating it as "did not reach 1.6" ` +
        `would refute H1/H2/H3 and fire H4 on missing data.`
      );
    }
  }
  if (edgeMedianShares.length !== PHASE_TIERS.length) {
    throw new Error(
      `evaluateHypotheses: monotonicity needs one share per rung, got ${edgeMedianShares.length}.`);
  }

  const strictlyRising = edgeMedianShares.every((v, i) => i === 0 || v > edgeMedianShares[i - 1]);

  const build = (conditions) => {
    const refuted = conditions.filter((c) => !c.pass).map((c) => c.name);
    return { fires: refuted.length === 0, conditions, refuted_by: refuted };
  };

  const H1 = build([
    cond('b_write', b.write, b.write >= EXPONENT_BAR, `>= ${EXPONENT_BAR}`),
    cond('b_parse', b.parse, b.parse <= PARSE_CEILING, `<= ${PARSE_CEILING}`),
    cond('write_share_t9', writeShareT9, writeShareT9 >= WRITE_SHARE_FLOOR, `>= ${WRITE_SHARE_FLOOR}`),
  ]);
  const H2 = build([
    cond('b_edges', b.edges, b.edges >= EXPONENT_BAR, `>= ${EXPONENT_BAR}`),
    cond('edge_share_monotonic', edgeMedianShares, strictlyRising, 'strictly rising T1->T9'),
  ]);
  const H3 = build([
    cond('b_parse', b.parse, b.parse >= EXPONENT_BAR, `>= ${EXPONENT_BAR}`),
  ]);
  // Evaluated over the five PHASES only. The remainder is not a phase; if it alone reaches
  // the bar, H4 still fires as registered and the remainder's exponent is reported beside it.
  const reached = PHASES.filter((p) => b[p] >= EXPONENT_BAR);
  const H4 = build([
    cond('no_phase_reaches_bar', reached, reached.length === 0, `no phase >= ${EXPONENT_BAR}`),
  ]);

  const fired = [['H1', H1], ['H2', H2], ['H3', H3], ['H4', H4]]
    .filter(([, h]) => h.fires).map(([name]) => name);

  const H0 = {
    fires: fired.length === 0,
    escalates_as: 'H4',
    reading: 'localised, unclassified — report every exponent and share, adjudicate nothing',
  };

  return {
    H1, H2, H3, H4, H0,
    fired,
    outcome: fired.length === 0 ? 'H0' : fired.join('+'),
    next_step: (H0.fires || H4.fires)
      ? 'Not another ladder: statement-level profiling inside the highest-share phase.'
      : 'A cache_size / mmap_size A/B at a single rung, run before any shipped fix.',
  };
}

/**
 * The free confirmatory signal: a total-clock exponent on the phase-timed binary.
 *
 * Registered as a mini-replication of E1's 1.75 and NOTHING more — 5 rungs is a weaker
 * design than 9, so a discrepancy is a finding about this instrument, not about `b`. It may
 * not soften E1's verdict and may not be claimed as strengthening it.
 */
export function miniReplication(runs, { c, B = 10000, seed = 811 } = {}) {
  // A4-MAT-1: `c` defaulted to 0 once, and the omission biases `b` downward — toward HOLDS.
  if (!Number.isFinite(c) || c < 0) {
    throw new Error(
      `miniReplication: the calibration constant c must be an explicit finite value >= 0, ` +
      `got ${c}. Pass the measured median from eval/results/e1-phase-calibration.json.`
    );
  }
  const adjusted = runs.map((r) => r.duration_ms - c);
  if (adjusted.some((v) => v <= 0)) {
    throw new Error(`miniReplication: c=${c}ms exceeds a run duration; ln is undefined.`);
  }

  const xs = runs.map((r) => Math.log(r.chunk_count));
  const fit = fitOne(xs, adjusted.map(Math.log), runs.map((r) => r.tier), { B, seed });
  const covers = fit.ci_hc3 !== undefined && fit.ci_hc3[0] <= E1_B && E1_B <= fit.ci_hc3[1];

  return {
    ...fit,
    e1_b: E1_B,
    consistent_with_e1: covers,
    adjudicates: false,
    reading:
      'A mini-replication on a different binary, at 5 rungs rather than 9. Consistent iff ' +
      "the 95% HC3 interval covers E1's 1.7529. It adjudicates nothing in either direction.",
  };
}

/**
 * Score the completed E1-PHASE ladder.
 *
 * @param {Array<{tier:string, rep:number, chunk_count:number, duration_ms:number, phase_ms:object}>} runs
 * @param {{c:number, B?:number, seed?:number}} opts
 */
export function scoreE1Phase(runs, { c, B = 10000, seed = 811 } = {}) {
  const tiers = new Set(runs.map((r) => r.tier));
  if (tiers.size !== PHASE_TIERS.length || PHASE_TIERS.some((t) => !tiers.has(t))) {
    throw new Error(
      `scoreE1Phase: expected the five registered rungs ${PHASE_TIERS.join(', ')}, got ` +
      `${[...tiers].sort().join(', ')}. The even ln-spacing that gives Sxx_cluster = 5.598 ` +
      `is a property of THAT set; a different one is a different design.`
    );
  }
  for (const t of PHASE_TIERS) {
    const n = runs.filter((r) => r.tier === t).length;
    if (n !== REPS) throw new Error(`scoreE1Phase: rung ${t} has ${n} repetitions, expected ${REPS}.`);
  }

  const exponents = {};
  for (const name of SERIES) exponents[name] = fitSeries(runs, valueOf(name));

  const shares = tierShares(runs);
  const t9 = shares.at(-1);

  const findings = [];
  for (const s of shares) {
    if (s.median_run.remainder > REMAINDER_FINDING_SHARE) {
      findings.push(
        `REMAINDER ${s.tier}: unattributed share ${(s.median_run.remainder * 100).toFixed(2)}% ` +
        `exceeds the ${REMAINDER_FINDING_SHARE * 100}% reporting threshold (T1 measured 0.09%).`);
    }
  }
  if (exponents.remainder.degenerate) {
    findings.push(
      `REMAINDER: the sixth series is not fittable (${exponents.remainder.degenerate}); ` +
      `its exponent is unavailable and the T9 remainder share carries the reading alone.`);
  }

  // The registered void condition: `walk` above 10% of the clock at T9 would mean the phase
  // split is mis-drawn and the fit is measuring startup.
  const walkVoid = t9.median_run.walk > WALK_VOID_SHARE;

  const hypotheses = walkVoid ? null : evaluateHypotheses({
    b: Object.fromEntries(PHASES.map((p) => [p, exponents[p].b])),
    writeShareT9: t9.median_run.write,
    edgeMedianShares: shares.map((s) => s.median_of_shares.edges),
  });

  return {
    n_runs: runs.length,
    n_rungs: PHASE_TIERS.length,
    calibration_c_ms: c,
    void: walkVoid,
    void_reason: walkVoid
      ? `walk is ${(t9.median_run.walk * 100).toFixed(2)}% of durationMs at T9, above the ` +
        `registered ${WALK_VOID_SHARE * 100}% ceiling — the phase split is mis-drawn.`
      : null,
    exponents,
    shares,
    hypotheses,
    mini_replication: miniReplication(runs, { c, B, seed }),
    findings,
  };
}
