// E1/E2/R5 — the scorers. Verdict logic only; the estimators live in e1-stats.mjs.
//
// Registration: IMPLEMENTATION_PLAN.md § E1/E2 PRE-REGISTRATION (AMENDMENTS 1-3).
// Gate 7 requires the known-answer tests in eval/__tests__/e1-score.test.mjs to be GREEN
// before this file sees real data. They run in the normal suite (`pnpm -F mast test`), not
// via a script someone has to remember to invoke — vitest.config.ts already includes
// `eval/**/*.test.mjs`.
//
// Why the verdict COMBINATOR is a separate exported function from the fitting: E1's
// AMBIGUOUS row has three independent feeding mechanisms (CI straddle, primary/sensitivity
// disagreement, adjusted/raw disagreement) plus trigger 1. Constructing synthetic data that
// happens to trigger each one is fragile and incomplete; testing the combinator directly is
// exhaustive. MAT-7 exists because the first draft of Gate 7 tested neither.

import { olsFit, hc3SlopeSe, studentTQuantile, wildClusterBootstrap, lackOfFit } from './e1-stats.mjs';

/** Registered at fd46152, unchanged through three amendments. */
export const THRESHOLD = 1.35;
/** §10.3.1's lower band edge. */
export const E2_BAND_LOW = 0.60;
/** Round 1's own instrument threshold (`wal_checkpoint_outliers_gt_1500ms`). */
export const R5_STALL_MS = 1500;
/** AMENDMENT 3 MAT-6: absolute, replacing the vacuous 2x-idle multiplier. */
export const R5_EXCESS_MS = 250;

/**
 * Where a confidence interval sits relative to the threshold.
 * @returns {'below'|'above'|'straddle'}
 */
export function classifyCi(ci, threshold = THRESHOLD) {
  if (ci[1] < threshold) return 'below';
  if (ci[0] > threshold) return 'above';
  return 'straddle';
}

/**
 * E1's verdict table, as a pure function of the four interval classifications and trigger 1.
 *
 * Registered rows:
 *   HOLDS         — CI upper < 1.35 on the HC3 primary AND the wild-cluster sensitivity,
 *                   AND on both the adjusted and the raw fit. All four must be 'below'.
 *   SUPER_LINEAR  — CI lower > 1.35 on the HC3 primary (adjusted).
 *   AMBIGUOUS     — anything else: a straddle, a primary/sensitivity disagreement, an
 *                   adjusted/raw disagreement, or trigger 1 firing.
 *
 * NOTE the asymmetry, and it is deliberate: HOLDS needs all four intervals; SUPER_LINEAR
 * needs only the primary. The discharge branch flatters the investigator's prior, so it
 * carries the harder requirement (the registration's direction-of-error rule).
 *
 * @param {{hc3Adj:string, bootAdj:string, hc3Raw:string, bootRaw:string, lackOfFitFires:boolean}} c
 */
export function combineE1Verdict({ hc3Adj, bootAdj, hc3Raw, bootRaw, lackOfFitFires }) {
  const reasons = [];

  if (hc3Adj === 'above') {
    // A4-FATAL-1. The registration contradicted itself here: the verdict table fires
    // SUPER-LINEAR on the HC3 primary alone, while three separate unconditional sentences
    // say trigger 1, a sensitivity disagreement, or an adjusted/raw disagreement each force
    // AMBIGUOUS. AMENDMENT 4 resolved it toward the table, on the principle that AMBIGUOUS
    // is for CONFLICTING evidence — not for concordant evidence of different flavours of
    // "not clean O(N)".
    //
    // The raw-fit case is the one that makes this concrete rather than pedantic: a large
    // `c` biases the raw exponent DOWN, so "adjusted above 1.35, raw straddling" is the
    // expected signature of true super-linearity. Downgrading there would make SUPER_LINEAR
    // nearly unreachable in exactly the condition it exists to detect, and route it into
    // AMBIGUOUS's "add more rungs or reps" escalation.
    const qualifiers = [];
    if (lackOfFitFires) qualifiers.push('lack_of_fit_mixture');
    if (hc3Raw !== 'above') qualifiers.push('raw_fit_not_above_threshold');
    if (bootAdj !== 'above') qualifiers.push('sensitivity_not_above_threshold');
    return { verdict: 'SUPER_LINEAR', reasons: ['hc3_primary_ci_lower_above_threshold'], qualifiers };
  }

  if (lackOfFitFires) reasons.push('lack_of_fit');
  if (hc3Adj === 'straddle') reasons.push('primary_ci_straddles_threshold');
  if (hc3Adj !== bootAdj) reasons.push('primary_sensitivity_disagree');
  if (hc3Adj !== hc3Raw) reasons.push('adjusted_raw_disagree');
  if (bootAdj !== bootRaw) reasons.push('adjusted_raw_disagree_bootstrap');
  if (bootAdj === 'straddle' || bootRaw === 'straddle' || hc3Raw === 'straddle') {
    reasons.push('a_reported_ci_straddles_threshold');
  }

  const allBelow = hc3Adj === 'below' && bootAdj === 'below' && hc3Raw === 'below' && bootRaw === 'below';
  // The discharge row admits no asterisks: anything that would have been a qualifier here
  // is, by construction, a disagreement, and a disagreement is already AMBIGUOUS above.
  if (allBelow && !lackOfFitFires) return { verdict: 'HOLDS', reasons: [], qualifiers: [] };

  return { verdict: 'AMBIGUOUS', reasons: [...new Set(reasons)], qualifiers: [] };
}

/**
 * Fit one clock and return its two intervals.
 *
 * @param {number[]} x  ln(chunk_count)
 * @param {number[]} y  ln(time)
 * @param {string[]} clusters tier labels
 */
export function fitOne(x, y, clusters, { B, seed }) {
  const fit = olsFit(x, y);
  const sse = fit.resid.reduce((s, r) => s + r * r, 0);
  if (sse === 0) {
    // Zero residual variance is not a tight measurement; it is a degenerate input. Left
    // unguarded it produces SE = 0, a zero-width CI below the threshold, and a silent
    // HOLDS — Gate 7 case (e), and the failure mode lands on the investigator's prior.
    return { degenerate: 'zero_residual_variance', b: fit.slope };
  }
  const se = hc3SlopeSe(fit, x);
  const t = studentTQuantile(0.975, fit.n - 2);
  const ciHc3 = [fit.slope - t * se, fit.slope + t * se];
  const boot = wildClusterBootstrap(x, y, clusters, { B, seed, h0: THRESHOLD });
  return {
    b: fit.slope,
    se_hc3: se,
    df: fit.n - 2,
    t_crit: t,
    ci_hc3: ciHc3,
    ci_boot: boot.ci,
    boot_p: boot.p,
    se_cr1: boot.se,
    boot_atoms: boot.atoms,
  };
}

/**
 * Score E1.
 *
 * @param {Array<{tier:string, chunk_count:number, duration_ms:number}>} runs
 * @param {{c?:number, B?:number, seed?:number}} opts  `c` is the calibration constant (ms)
 */
export function scoreE1(runs, { c, B = 10000, seed = 811 } = {}) {
  // A4-MAT-1. `c` was defaulted to 0, so a driver that forgot to thread
  // `e1-calibration.json` through produced adjusted === raw with NO error — and the
  // registered "adjusted and raw disagree => AMBIGUOUS" protection then self-satisfied
  // trivially. Gate 7 case (c) proves the subtraction is wired correctly, but only when `c`
  // is passed; the production call site was the one seam no test covered. An omitted
  // additive constant biases `b` downward, i.e. toward HOLDS.
  if (!Number.isFinite(c) || c < 0) {
    throw new Error(
      `scoreE1: the calibration constant c must be an explicit finite value >= 0, got ${c}. ` +
      `Pass the measured median from eval/results/e1-calibration.json, or an explicit 0 for ` +
      `synthetic data with no additive constant.`
    );
  }

  if (runs.length < 3) throw new Error(`scoreE1: need at least 3 runs, got ${runs.length}`);

  // A4-MAT-7. Trigger 2 says "Diagnose, then re-run", so a VOID run is an open question,
  // not a data point to quietly omit. Fitting around one silently drops a repetition — and
  // a lost T9 rep specifically weakens the top of the ladder.
  const voided = runs.filter((r) => r.void === true);
  if (voided.length > 0) {
    throw new Error(
      `scoreE1: ${voided.length} run(s) are VOID and unadjudicated ` +
      `(${voided.map((r) => r.tier).join(', ')}). Trigger 2 requires diagnosis and a re-run ` +
      `before this ladder is scored.`
    );
  }

  const clusters = runs.map((r) => r.tier);
  const groups = new Set(clusters);
  if (groups.size < 3) {
    throw new Error(
      `scoreE1: need at least 3 tiers for a lack-of-fit test and a cluster bootstrap, ` +
      `got ${groups.size}. A single-tier dataset cannot identify a slope at all.`
    );
  }

  for (const r of runs) {
    // Registered supporting outputs (A4-MAT-5) need these; a missing field must fail loudly
    // rather than produce a NaN exponent that reads like a measurement. Checked after the
    // structural guards above, so a degenerate dataset reports the reason it is degenerate.
    for (const field of ['file_count', 'db_bytes', 'parse_errors']) {
      if (!Number.isFinite(r[field])) {
        throw new Error(`scoreE1: run ${r.tier} is missing '${field}'; triggers 3-5 and b_file need it.`);
      }
    }
  }

  const x = runs.map((r) => Math.log(r.chunk_count));

  const adjusted = runs.map((r) => r.duration_ms - c);
  if (adjusted.some((v) => v <= 0)) {
    throw new Error(
      `scoreE1: calibration constant c=${c}ms exceeds a run's duration; the adjusted fit ` +
      `is undefined. Check the calibration run.`
    );
  }
  const yAdj = adjusted.map(Math.log);
  const yRaw = runs.map((r) => Math.log(r.duration_ms));

  const adj = fitOne(x, yAdj, clusters, { B, seed });
  const raw = fitOne(x, yRaw, clusters, { B, seed });

  if (adj.degenerate || raw.degenerate) {
    return {
      verdict: 'UNDEFINED',
      reasons: [adj.degenerate ?? raw.degenerate],
      adjusted: adj,
      raw,
    };
  }

  const lof = lackOfFit(x, yAdj, clusters);
  const lofRaw = lackOfFit(x, yRaw, clusters);

  const classes = {
    hc3Adj: classifyCi(adj.ci_hc3),
    bootAdj: classifyCi(adj.ci_boot),
    hc3Raw: classifyCi(raw.ci_hc3),
    bootRaw: classifyCi(raw.ci_boot),
    lackOfFitFires: lof.fires === true,
  };

  const { verdict, reasons, qualifiers } = combineE1Verdict(classes);

  // Supporting file-count exponent, on the same adjusted clock (A4-MAT-5). Registered as
  // "Both are reported"; it was not being computed at all, so trigger 5 could only ever
  // have been evaluated by hand after the verdict was already visible.
  const xFile = runs.map((r) => Math.log(r.file_count));
  const adjFile = fitOne(xFile, yAdj, clusters, { B, seed });

  return {
    verdict,
    reasons,
    qualifiers,
    b_file: adjFile.degenerate ? null : adjFile.b,
    file_fit: adjFile,
    triggers: {
      t3: trigger3(runs),
      t4: trigger4(runs),
      t5: trigger5(adj.b, adjFile.degenerate ? null : adjFile.b),
    },
    threshold: THRESHOLD,
    calibration_c_ms: c,
    n_runs: runs.length,
    n_tiers: groups.size,
    classes,
    adjusted: adj,
    raw,
    // Registered on the ADJUSTED fit only: the raw fit's known omitted additive constant
    // guarantees curvature, so a raw lack-of-fit test would fire by construction.
    lack_of_fit: lof,
    lack_of_fit_raw_descriptive: lofRaw,
  };
}

/** Per-tier aggregate over that tier's repetitions. */
function byTier(runs) {
  const m = new Map();
  for (const r of runs) {
    const t = m.get(r.tier) ?? { tier: r.tier, chunks: 0, files: 0, bytes: 0, parse_errors: 0, n: 0 };
    t.chunks += r.chunk_count;
    t.files += r.file_count;
    t.bytes += r.db_bytes;
    t.parse_errors += r.parse_errors;
    t.n += 1;
    m.set(r.tier, t);
  }
  return [...m.values()].sort((a, b) => a.chunks / a.n - b.chunks / b.n);
}

/** Registered trigger 3 (A4-MAT-5): bytes/chunk at the largest tier vs the smallest. */
export const T3_RATIO = 1.5;
export function trigger3(runs) {
  const tiers = byTier(runs);
  const small = tiers[0], large = tiers[tiers.length - 1];
  const bpcSmall = small.bytes / small.chunks;
  const bpcLarge = large.bytes / large.chunks;
  const ratio = bpcLarge / bpcSmall;
  return {
    fires: ratio > T3_RATIO,
    ratio,
    threshold: T3_RATIO,
    smallest_tier: small.tier,
    largest_tier: large.tier,
    bytes_per_chunk_smallest: bpcSmall,
    bytes_per_chunk_largest: bpcLarge,
    // Registered: flagged and discussed, never a verdict on its own — state overhead has a
    // fixed component that amortizes differently across a 20x span.
    reading: 'descriptive; flagged and discussed in the result, never forces AMBIGUOUS alone',
  };
}

/**
 * Registered trigger 4 (A1-F12): a parse-error RATE that rises with tier size.
 *
 * Rate, not count. Files that fail to parse consume walk/read/parse time and contribute
 * ZERO chunks, so a rate rising with `N` inflates ms/chunk through a channel the model does
 * not represent. Registered consequence: it "must be discussed before the verdict is
 * recorded" — which is why it is emitted here rather than computed by hand afterwards.
 */
export const T4_RATIO = 2;
export function trigger4(runs) {
  const tiers = byTier(runs).map((t) => ({ tier: t.tier, rate: t.files > 0 ? t.parse_errors / t.files : 0 }));
  const med = percentile(tiers.map((t) => t.rate), 0.5);
  const worst = tiers.reduce((a, b) => (b.rate > a.rate ? b : a));
  // A zero median is the clean case, and dividing by it would give Infinity for any
  // non-zero tier. The honest rule at zero: any tier that fails at all stands out from a
  // ladder where nothing else does, so it is flagged for discussion.
  const fires = med === 0 ? worst.rate > 0 : worst.rate > T4_RATIO * med;
  return { fires, median_rate: med, worst_tier: worst.tier, worst_rate: worst.rate, threshold_multiple: T4_RATIO, per_tier: tiers };
}

/**
 * Registered trigger 5 (A1-F10): the supporting file exponent and the decision-bearing
 * chunk exponent landing on opposite sides of 1.35.
 *
 * Measured limitation, recorded here because the registration offers this as a check:
 * across the frozen ladder chunks-per-file runs 5.50-5.81, giving
 * d ln(chunks)/d ln(files) = 0.9937 — so `b_file` is pinned within ~0.6% of `b_chunk` BY
 * THE CORPUS, and this trigger has almost no power on the nested axis. It is the panel,
 * where vendored/fixture density genuinely varies, that could move them apart.
 */
export function trigger5(bChunk, bFile) {
  if (bFile === null) return { fires: false, b_chunk: bChunk, b_file: null, reason: 'file fit degenerate' };
  const side = (b) => (b > THRESHOLD ? 'above' : 'below');
  return {
    fires: side(bChunk) !== side(bFile),
    b_chunk: bChunk,
    b_file: bFile,
    reading: 'reported and discussed — it means chunks-per-file is itself varying with ' +
      'scale — but it never overrides the registered exposure choice',
  };
}

/**
 * Score E2 — §10.3.1's coverage band on `nest`.
 *
 * AMENDMENT 3 MAT-2 softened the miss: a sub-60% result is "the band is not attained on the
 * closest available Fastify+DI corpus", evidence for a spec revisit, NOT a mandate to
 * rescope or remove the figure. n = 1, and the corpus is a DI framework rather than the DI
 * service the spec names.
 */
export function scoreE2(edgeEmitted, totalVisited) {
  if (!Number.isFinite(totalVisited) || totalVisited <= 0) {
    throw new Error(`scoreE2: denominator must be a positive count, got ${totalVisited}`);
  }
  const ratio = edgeEmitted / totalVisited;
  return {
    yield: ratio,
    edge_emitted: edgeEmitted,
    total_visited: totalVisited,
    verdict: ratio >= E2_BAND_LOW ? 'SUPPORTED' : 'NOT_ATTAINED',
    reading: ratio >= E2_BAND_LOW
      ? "§10.3.1's band holds on the closest available Fastify+DI corpus."
      : 'The band is not attained on the closest available Fastify+DI corpus. Evidence for ' +
        'a spec revisit; NOT a mandate to rescope §10.3.1 or remove the figure (n = 1, and ' +
        'nest is a DI framework rather than a DI service).',
  };
}

/** Percentile of a numeric array (nearest-rank). */
export function percentile(values, p) {
  if (values.length === 0) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}

/** One corpus's R5 reading. `calls` are SCORED calls only (overlapping write activity). */
export function scoreR5Corpus({ calls, idle_p99 }) {
  const n = calls.length;
  const over = calls.filter((ms) => ms > R5_STALL_MS).length;
  const p99 = percentile(calls, 0.99);
  const excess = p99 - idle_p99;

  let verdict;
  if (n > 0 && over / n >= 0.01) verdict = 'PRESENT';
  else if (over === 0 && excess <= R5_EXCESS_MS) verdict = 'ABSENT';
  else verdict = 'INDETERMINATE';

  return { scored_calls: n, over_threshold: over, pct_over: n > 0 ? over / n : 0, p99, idle_p99, excess_ms: excess, verdict };
}

/**
 * R5 overall. Both corpora must land in the same row; a split is INDETERMINATE overall,
 * because scale is exactly the axis this row exists to probe.
 *
 * AMENDMENT 3 MAT-4 resolved the falsification/table contradiction in the TABLE's favour,
 * so a single-corpus PRESENT is NOT dispositive.
 */
export function scoreR5({ T1, T9 }) {
  const a = scoreR5Corpus(T1);
  const b = scoreR5Corpus(T9);
  const agree = a.verdict === b.verdict;
  return {
    T1: a,
    T9: b,
    verdict: agree ? a.verdict : 'INDETERMINATE',
    split: !agree,
    reasons: agree ? [] : [`split verdict: T1=${a.verdict}, T9=${b.verdict}`],
  };
}
