// GATE 7 — known-answer tests for the E1/E2/R5 scorer.
//
// Registration: IMPLEMENTATION_PLAN.md § E1/E2 PRE-REGISTRATION, AMENDMENT 2 (the gate)
// and AMENDMENT 3 MAT-7 (cases g and h, and case c's numeric margin).
//
// These must be GREEN before the scorer sees real data. They run in the normal suite
// because vitest.config.ts already includes `eval/**/*.test.mjs` — a gate enforced by
// `pnpm -F mast test` cannot be forgotten the way a bespoke script can.
//
// Why the gate exists at all: `ab-score.mjs` shipped with its registered Wilcoxon test
// NEVER IMPLEMENTED (HANDOFF §5). An unverified scorer's most likely silent failures — an
// inability to fire SUPER_LINEAR, a sign error on the calibration subtraction, a degenerate
// input falling through to the discharge row, a verdict keyed off the point estimate rather
// than the interval — ALL land on O(N) HOLDS, the investigator's prior.

import { describe, it, expect } from 'vitest';
import {
  scoreE1, scoreE2, scoreR5, scoreR5Corpus, combineE1Verdict, classifyCi,
  THRESHOLD, percentile,
} from '../e1-score.mjs';
import { olsFit, hc3SlopeSe, cr1SlopeSe, lackOfFit, wildClusterBootstrap } from '../e1-stats.mjs';

/** The FROZEN ladder — eval/results/e1-tiers.json, realized from run P0. */
const RUNG_CHUNKS = [3679, 5332, 7761, 11278, 16529, 23854, 34691, 50299, 73359];
/** The same manifest's realized file counts — the supporting `b_file` exposure (A4-MAT-5). */
const RUNG_FILES = [656, 954, 1393, 1986, 2880, 4191, 5976, 8945, 13330];
/** P0's realized state size, used to synthesise a flat bytes/chunk unless a case varies it. */
const BYTES_PER_CHUNK = 441630720 / 73359;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic runs over the frozen rungs with seeded multiplicative noise.
 *
 * `bytesPerChunk` and `parseErrorsFor` are per-rung hooks so triggers 3 and 4 can be driven
 * to fire and not-fire on constructed data; their defaults are flat, which is the
 * not-firing condition for both.
 */
function makeRuns(f, {
  noise = 0.02, seed = 7, reps = 3,
  bytesPerChunk = () => BYTES_PER_CHUNK,
  parseErrorsFor = () => 0,
  filesFor = (i) => RUNG_FILES[i],
} = {}) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < RUNG_CHUNKS.length; i++) {
    for (let k = 0; k < reps; k++) {
      out.push({
        tier: `T${i + 1}`,
        chunk_count: RUNG_CHUNKS[i],
        file_count: filesFor(i),
        db_bytes: Math.round(bytesPerChunk(i) * RUNG_CHUNKS[i]),
        parse_errors: parseErrorsFor(i),
        duration_ms: f(RUNG_CHUNKS[i]) * Math.exp(noise * (rng() * 2 - 1)),
      });
    }
  }
  return out;
}

const B = 2000; // draws; the registered run uses 10,000 (asserted separately below)

describe('Gate 7 (a) — a known quadratic must fire SUPER-LINEAR', () => {
  it('returns SUPER_LINEAR on total = a*N^2', () => {
    const r = scoreE1(makeRuns((n) => 1e-5 * n * n), { c: 0, B });

    expect(r.verdict).toBe('SUPER_LINEAR');
    expect(r.adjusted.b).toBeCloseTo(2.0, 1);
    // Fired via the CI LOWER bound, not the point estimate.
    expect(r.adjusted.ci_hc3[0]).toBeGreaterThan(THRESHOLD);
  });
});

describe('Gate 7 (b) — a known linear law must fire HOLDS', () => {
  it('returns HOLDS on total = a*N', () => {
    const r = scoreE1(makeRuns((n) => 0.05 * n), { c: 0, B });

    expect(r.verdict).toBe('HOLDS');
    expect(r.adjusted.b).toBeCloseTo(1.0, 1);
    // All four intervals must clear the threshold — the registered asymmetry.
    expect(r.classes).toMatchObject({ hc3Adj: 'below', bootAdj: 'below', hc3Raw: 'below', bootRaw: 'below' });
  });
});

describe('Gate 7 (c) — the calibration subtraction is wired the right way round', () => {
  // c = 40% of T1's total time, by construction.
  const a = 0.05;
  const c = (0.4 * a * RUNG_CHUNKS[0]) / 0.6;
  const runs = makeRuns((n) => c + a * n, { seed: 5 });

  it('recovers the constructed truth b = 1.0 on the adjusted fit', () => {
    const r = scoreE1(runs, { c, B });

    expect(r.verdict).toBe('HOLDS');
    expect(Math.abs(r.adjusted.b - 1.0)).toBeLessThan(0.05);
  });

  it('shows the raw exponent at least 0.10 below the adjusted one', () => {
    const r = scoreE1(runs, { c, B });

    // A sign error on the subtraction biases b DOWN, i.e. toward HOLDS. "Visibly lower"
    // is not a test; this margin is a property of the constructed dataset (MAT-7).
    expect(r.adjusted.b - r.raw.b).toBeGreaterThanOrEqual(0.10);
  });
});

describe('Gate 7 (d) — HC3 and the cluster bootstrap against independently computed values', () => {
  const runs = makeRuns((n) => 0.05 * n, { seed: 21 });
  const xs = runs.map((r) => Math.log(r.chunk_count));
  const ys = runs.map((r) => Math.log(r.duration_ms));
  const clusters = runs.map((r) => r.tier);

  /** OLS slope from first principles, not via the code under test. */
  function independentSlope() {
    const n = xs.length;
    const xbar = xs.reduce((s, v) => s + v, 0) / n;
    const ybar = ys.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - xbar) * (ys[i] - ybar); sxx += (xs[i] - xbar) ** 2; }
    return { slope: sxy / sxx, sxx, xbar, intercept: ybar - (sxy / sxx) * xbar };
  }

  it('reproduces the OLS slope', () => {
    const ind = independentSlope();

    expect(olsFit(xs, ys).slope).toBeCloseTo(ind.slope, 12);
  });

  it('reproduces the HC3 slope standard error', () => {
    const ind = independentSlope();
    const n = xs.length;
    let meat = 0;
    for (let i = 0; i < n; i++) {
      const u = ys[i] - (ind.intercept + ind.slope * xs[i]);
      const h = 1 / n + ((xs[i] - ind.xbar) ** 2) / ind.sxx;
      const w = u / (1 - h);
      meat += ((xs[i] - ind.xbar) ** 2) * w * w;
    }
    const expected = Math.sqrt(meat / ind.sxx ** 2);

    expect(hc3SlopeSe(olsFit(xs, ys), xs)).toBeCloseTo(expected, 12);
  });

  it('reproduces the CR1 cluster-robust slope standard error', () => {
    const ind = independentSlope();
    const n = xs.length;
    const sums = new Map();
    for (let i = 0; i < n; i++) {
      const u = ys[i] - (ind.intercept + ind.slope * xs[i]);
      sums.set(clusters[i], (sums.get(clusters[i]) ?? 0) + (xs[i] - ind.xbar) * u);
    }
    let meat = 0;
    for (const s of sums.values()) meat += s * s;
    const G = sums.size;
    const factor = (G / (G - 1)) * ((n - 1) / (n - 2));
    const expected = Math.sqrt((factor * meat) / ind.sxx ** 2);

    expect(cr1SlopeSe(olsFit(xs, ys), xs, clusters)).toBeCloseTo(expected, 12);
  });

  it('uses Webb 6-point weights, giving 6^G atoms rather than Rademacher 2^G', () => {
    const boot = wildClusterBootstrap(xs, ys, clusters, { B: 200, seed: 811 });

    // MAT-1: at G=9 Rademacher offers 512; Webb offers 6^9.
    expect(boot.atoms).toBe(Math.pow(6, 9));
    expect(boot.atoms).toBeGreaterThan(10_000_000);
  });

  it('is deterministic under the registered seed', () => {
    const one = wildClusterBootstrap(xs, ys, clusters, { B: 500, seed: 811 });
    const two = wildClusterBootstrap(xs, ys, clusters, { B: 500, seed: 811 });

    expect(two.ci).toEqual(one.ci);
  });
});

describe('Gate 7 (e) — degenerate inputs must not silently discharge', () => {
  it('returns UNDEFINED, not HOLDS, when every timing is identical', () => {
    const runs = RUNG_CHUNKS.flatMap((n, i) =>
      [0, 1, 2].map(() => ({
        tier: `T${i + 1}`, chunk_count: n, file_count: RUNG_FILES[i],
        db_bytes: Math.round(BYTES_PER_CHUNK * n), parse_errors: 0, duration_ms: 1000,
      })));

    const r = scoreE1(runs, { c: 0, B });

    // Zero residual variance gives SE = 0 and a zero-width CI below the threshold, which
    // an unguarded scorer reports as HOLDS.
    expect(r.verdict).toBe('UNDEFINED');
    expect(r.reasons).toContain('zero_residual_variance');
  });

  it('raises on a single-tier dataset rather than returning a verdict', () => {
    const runs = [0, 1, 2].map(() => ({ tier: 'T1', chunk_count: 3679, file_count: 656, db_bytes: 2.2e7, parse_errors: 0, duration_ms: 1000 }));

    expect(() => scoreE1(runs, { c: 0, B })).toThrow(/at least 3 tiers/);
  });

  it('raises when the calibration constant exceeds a measured duration', () => {
    const runs = makeRuns((n) => 0.05 * n);

    expect(() => scoreE1(runs, { c: 1e9, B })).toThrow(/calibration constant/);
  });
});

describe('Gate 7 (f) — E2 and R5 verdict tables, every row', () => {
  it('E2: yield at or above 60% is SUPPORTED', () => {
    expect(scoreE2(600, 1000).verdict).toBe('SUPPORTED');
    expect(scoreE2(600, 1000).yield).toBeCloseTo(0.60, 10);
  });

  it('E2: yield below 60% is NOT_ATTAINED, and reads as evidence rather than a mandate', () => {
    const r = scoreE2(599, 1000);

    expect(r.verdict).toBe('NOT_ATTAINED');
    expect(r.reading).toMatch(/NOT a mandate/);
  });

  it('E2: a zero denominator raises rather than dividing', () => {
    expect(() => scoreE2(0, 0)).toThrow(/positive count/);
  });

  it('R5: >= 1% of scored calls over 1,500 ms is PRESENT on both corpora', () => {
    const stally = { calls: [...Array(98).fill(200), 1700, 2400], idle_p99: 180 };
    const r = scoreR5({ T1: stally, T9: stally });

    expect(r.verdict).toBe('PRESENT');
  });

  it('R5: zero stalls and p99 excess within 250 ms is ABSENT', () => {
    const clean = { calls: [...Array(99).fill(200), 300], idle_p99: 190 };
    const r = scoreR5({ T1: clean, T9: clean });

    expect(r.verdict).toBe('ABSENT');
  });

  it('R5: zero stalls but broadly elevated p99 is INDETERMINATE', () => {
    // The p99-excess clause polices sustained elevation, not a lone outlier — with 100
    // calls, nearest-rank p99 is the 99th value, so one slow call cannot move it. A lone
    // stall is caught by the `over === 0` requirement instead (next test).
    const drifty = { calls: [...Array(95).fill(200), ...Array(5).fill(800)], idle_p99: 190 };

    const r = scoreR5Corpus(drifty);

    expect(r.excess_ms).toBeGreaterThan(250);
    expect(r.verdict).toBe('INDETERMINATE');
  });

  it('R5: a single stall below the 1% bar is INDETERMINATE, never ABSENT', () => {
    // Reachable and important: 1 call over 1,500 ms in 400 is 0.25%, short of PRESENT —
    // but ABSENT requires ZERO. Without that clause this row would discharge the class on
    // evidence that a stall occurred.
    const oneStall = { calls: [...Array(399).fill(200), 1700], idle_p99: 190 };

    const r = scoreR5Corpus(oneStall);

    expect(r.pct_over).toBeLessThan(0.01);
    expect(r.verdict).toBe('INDETERMINATE');
  });

  it('R5: a split between corpora is INDETERMINATE overall', () => {
    const clean = { calls: [...Array(99).fill(200), 300], idle_p99: 190 };
    const stally = { calls: [...Array(98).fill(200), 1700, 2400], idle_p99: 180 };

    const r = scoreR5({ T1: clean, T9: stally });

    // MAT-4: the table wins over the falsification bullet's "either corpus".
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.split).toBe(true);
  });

  it('percentile is nearest-rank and does not interpolate off the end', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.99)).toBe(5);
  });
});

describe("Gate 7 (g) — E1's own three-row table and every AMBIGUOUS mechanism", () => {
  // The combinator is tested directly: constructing data that happens to trigger each
  // mechanism is fragile and incomplete, and MAT-7 exists because the first draft of this
  // gate exercised E2's and R5's tables but not E1's.
  const below = 'below', above = 'above', straddle = 'straddle';

  it('HOLDS requires all four intervals below the threshold', () => {
    const v = combineE1Verdict({ hc3Adj: below, bootAdj: below, hc3Raw: below, bootRaw: below, lackOfFitFires: false });

    expect(v.verdict).toBe('HOLDS');
  });

  it('SUPER_LINEAR fires off the HC3 primary alone', () => {
    const v = combineE1Verdict({ hc3Adj: above, bootAdj: straddle, hc3Raw: straddle, bootRaw: straddle, lackOfFitFires: false });

    expect(v.verdict).toBe('SUPER_LINEAR');
  });

  it('AMBIGUOUS mechanism 1 — the primary CI straddles', () => {
    const v = combineE1Verdict({ hc3Adj: straddle, bootAdj: straddle, hc3Raw: straddle, bootRaw: straddle, lackOfFitFires: false });

    expect(v.verdict).toBe('AMBIGUOUS');
    expect(v.reasons).toContain('primary_ci_straddles_threshold');
  });

  it('AMBIGUOUS mechanism 2 — primary and sensitivity disagree across the threshold', () => {
    const v = combineE1Verdict({ hc3Adj: below, bootAdj: straddle, hc3Raw: below, bootRaw: below, lackOfFitFires: false });

    expect(v.verdict).toBe('AMBIGUOUS');
    expect(v.reasons).toContain('primary_sensitivity_disagree');
  });

  it('AMBIGUOUS mechanism 3 — adjusted and raw disagree across the threshold', () => {
    const v = combineE1Verdict({ hc3Adj: below, bootAdj: below, hc3Raw: straddle, bootRaw: below, lackOfFitFires: false });

    expect(v.verdict).toBe('AMBIGUOUS');
    expect(v.reasons).toContain('adjusted_raw_disagree');
  });

  it('AMBIGUOUS mechanism 4 — trigger 1 fires even with all four intervals below', () => {
    const v = combineE1Verdict({ hc3Adj: below, bootAdj: below, hc3Raw: below, bootRaw: below, lackOfFitFires: true });

    expect(v.verdict).toBe('AMBIGUOUS');
    expect(v.reasons).toContain('lack_of_fit');
  });

  // ---- A4-FATAL-1: the case the registration contradicted itself on ------------------
  //
  // The table fires SUPER-LINEAR on the HC3 primary alone; three unconditional sentences
  // say trigger 1 / sensitivity disagreement / raw disagreement each force AMBIGUOUS.
  // AMENDMENT 4 resolved it toward the table: AMBIGUOUS is for CONFLICTING evidence, not
  // for concordant evidence of different flavours of not-clean-O(N). The concordant signals
  // become qualifiers on the verdict, and none of them may downgrade it.

  it('SUPER_LINEAR survives trigger 1 firing, and records it as a qualifier', () => {
    const v = combineE1Verdict({ hc3Adj: above, bootAdj: above, hc3Raw: above, bootRaw: above, lackOfFitFires: true });

    expect(v.verdict).toBe('SUPER_LINEAR');
    expect(v.qualifiers).toContain('lack_of_fit_mixture');
  });

  it('SUPER_LINEAR survives a raw fit dragged below the threshold by the omitted constant', () => {
    // This is the EXPECTED signature of true super-linearity under a large `c`, not a sign
    // of instability: the raw fit absorbs the additive constant and its exponent is biased
    // down. Downgrading here would make SUPER_LINEAR nearly unreachable in exactly the
    // condition it exists to detect.
    const v = combineE1Verdict({ hc3Adj: above, bootAdj: above, hc3Raw: below, bootRaw: below, lackOfFitFires: false });

    expect(v.verdict).toBe('SUPER_LINEAR');
    expect(v.qualifiers).toContain('raw_fit_not_above_threshold');
  });

  it('records a sensitivity that does not clear the threshold as a qualifier, not a downgrade', () => {
    const v = combineE1Verdict({ hc3Adj: above, bootAdj: straddle, hc3Raw: above, bootRaw: straddle, lackOfFitFires: false });

    expect(v.verdict).toBe('SUPER_LINEAR');
    expect(v.qualifiers).toContain('sensitivity_not_above_threshold');
  });

  it('leaves qualifiers empty when SUPER_LINEAR is unanimous', () => {
    const v = combineE1Verdict({ hc3Adj: above, bootAdj: above, hc3Raw: above, bootRaw: above, lackOfFitFires: false });

    expect(v.qualifiers).toEqual([]);
  });

  it('never attaches qualifiers to HOLDS — the discharge row admits no asterisks', () => {
    const v = combineE1Verdict({ hc3Adj: below, bootAdj: below, hc3Raw: below, bootRaw: below, lackOfFitFires: false });

    expect(v.verdict).toBe('HOLDS');
    expect(v.qualifiers).toEqual([]);
  });
});

// ---- A4-MAT-1: the calibration constant may not be silently optional -----------------

describe('scoreE1 — the calibration constant is required, not defaulted', () => {
  it('refuses to score without an explicit c', () => {
    // A driver that forgets to thread e1-calibration.json through would otherwise produce
    // adjusted === raw with no error, and the adjusted/raw protection would self-satisfy.
    // The registration's own words: an omitted additive constant biases `b` DOWNWARD.
    expect(() => scoreE1(makeRuns((n) => 0.05 * n), { B })).toThrow(/calibration constant/i);
  });

  it('refuses a negative or non-finite c rather than coercing it', () => {
    const runs = makeRuns((n) => 0.05 * n);

    expect(() => scoreE1(runs, { c: -1, B })).toThrow(/calibration constant/i);
    expect(() => scoreE1(runs, { c: NaN, B })).toThrow(/calibration constant/i);
  });

  it('accepts an explicit zero, which is a statement rather than a fallthrough', () => {
    const r = scoreE1(makeRuns((n) => 0.05 * n), { c: 0, B });

    expect(r.calibration_c_ms).toBe(0);
  });
});

// ---- A4-MAT-7: a ladder carrying unadjudicated voids is not scoreable ----------------

describe('scoreE1 — VOID runs block the fit', () => {
  it('refuses to fit a ladder with an unadjudicated void', () => {
    const runs = makeRuns((n) => 0.05 * n);
    runs[10] = { ...runs[10], void: true, void_reason: 'write_errors' };

    expect(() => scoreE1(runs, { c: 0, B })).toThrow(/void/i);
  });
});

// ---- A4-MAT-5: the registered supporting outputs and triggers 3/4/5 ------------------

describe('scoreE1 — supporting outputs the registration requires', () => {
  it('reports the supporting file-count exponent alongside the decision-bearing one', () => {
    const r = scoreE1(makeRuns((n) => 0.05 * n), { c: 0, B });

    expect(r.b_file).toBeTypeOf('number');
    expect(r.adjusted.b).toBeTypeOf('number');
  });

  it('trigger 5 stays silent on the frozen ladder, where chunks-per-file is near-constant', () => {
    // Measured, not assumed: chunks-per-file across the nine realized rungs runs 5.61 5.59
    // 5.57 5.68 5.74 5.69 5.81 5.62 5.50, so d ln(chunks)/d ln(files) = 0.9937 and
    // b_file is pinned within ~0.6% of b_chunk BY THE CORPUS. Trigger 5 therefore has
    // almost no power on the nested ladder — which is itself worth knowing, since the
    // registration offers it as a check. It is the PANEL, where vendored/fixture density
    // genuinely varies, that could move the two exponents apart.
    const r = scoreE1(makeRuns((n) => 0.05 * n), { c: 0, B });

    expect(r.triggers.t5.b_chunk).toBeLessThan(THRESHOLD);
    expect(r.triggers.t5.b_file).toBeLessThan(THRESHOLD);
    expect(r.triggers.t5.fires).toBe(false);
  });

  it('trigger 5 fires when chunks-per-file does vary with scale', () => {
    // Constructed so files grow as the square root of chunks: d ln(chunks)/d ln(files) = 2,
    // so time linear in CHUNKS is quadratic in FILES. This exercises the trigger's
    // mechanism, which the frozen ladder cannot.
    const runs = makeRuns((n) => 0.05 * n, {
      filesFor: (i) => RUNG_FILES[0] * Math.sqrt(RUNG_CHUNKS[i] / RUNG_CHUNKS[0]),
    });

    const r = scoreE1(runs, { c: 0, B });

    expect(r.triggers.t5.b_chunk).toBeLessThan(THRESHOLD);
    expect(r.triggers.t5.b_file).toBeGreaterThan(THRESHOLD);
    expect(r.triggers.t5.fires).toBe(true);
  });

  it('trigger 3 stays silent on a flat bytes-per-chunk ladder', () => {
    const r = scoreE1(makeRuns((n) => 0.05 * n), { c: 0, B });

    expect(r.triggers.t3.fires).toBe(false);
  });

  it('trigger 3 fires when the largest tier exceeds 1.5x the smallest on bytes per chunk', () => {
    const runs = makeRuns((n) => 0.05 * n, { bytesPerChunk: (i) => BYTES_PER_CHUNK * (1 + 0.1 * i) });

    const r = scoreE1(runs, { c: 0, B });

    expect(r.triggers.t3.ratio).toBeCloseTo(1.8, 5);
    expect(r.triggers.t3.fires).toBe(true);
  });

  it('trigger 4 stays silent when no tier fails to parse', () => {
    const r = scoreE1(makeRuns((n) => 0.05 * n), { c: 0, B });

    expect(r.triggers.t4.fires).toBe(false);
  });

  it('trigger 4 fires when a tier parse-error RATE exceeds 2x the median tier', () => {
    // Rate, not count: a bigger tier failing proportionally more files is the pathology —
    // failures consume walk/read/parse time and contribute ZERO chunks, inflating ms/chunk
    // with N through a channel the model does not represent.
    const runs = makeRuns((n) => 0.05 * n, {
      parseErrorsFor: (i) => Math.round(RUNG_FILES[i] * (i === 8 ? 0.05 : 0.01)),
    });

    const r = scoreE1(runs, { c: 0, B });

    expect(r.triggers.t4.fires).toBe(true);
    expect(r.triggers.t4.worst_tier).toBe('T9');
  });

  it('trigger 4 treats an all-clean ladder as clean rather than dividing by a zero median', () => {
    const runs = makeRuns((n) => 0.05 * n, { parseErrorsFor: () => 0 });

    const r = scoreE1(runs, { c: 0, B });

    expect(r.triggers.t4.median_rate).toBe(0);
    expect(r.triggers.t4.fires).toBe(false);
  });

  it('trigger 4 fires against a zero median when any tier fails at all', () => {
    const runs = makeRuns((n) => 0.05 * n, { parseErrorsFor: (i) => (i === 4 ? 3 : 0) });

    const r = scoreE1(runs, { c: 0, B });

    expect(r.triggers.t4.fires).toBe(true);
  });
});

describe('classifyCi', () => {
  it('classifyCi reads bounds, never the midpoint', () => {
    expect(classifyCi([1.0, 1.30])).toBe('below');
    expect(classifyCi([1.36, 1.90])).toBe('above');
    expect(classifyCi([1.20, 1.40])).toBe('straddle');
  });

  it('THE POINT-ESTIMATE KILLER — b below 1.35 with a CI upper above it is never HOLDS', () => {
    // b ≈ 1.30 with wide noise: a scorer keying off the point estimate says HOLDS, and it
    // fails toward HOLDS on exactly the noisy data where the distinction decides E1.
    const r = scoreE1(makeRuns((n) => 0.002 * Math.pow(n, 1.25), { noise: 0.45, seed: 13 }), { c: 0, B });

    expect(r.adjusted.b).toBeLessThan(THRESHOLD);
    expect(r.adjusted.ci_hc3[1]).toBeGreaterThan(THRESHOLD);
    expect(r.verdict).toBe('AMBIGUOUS');
  });

  it('fires SUPER_LINEAR via the CI lower bound at a modest true exponent', () => {
    const r = scoreE1(makeRuns((n) => 0.001 * Math.pow(n, 1.42)), { c: 0, B });

    expect(r.verdict).toBe('SUPER_LINEAR');
    expect(r.adjusted.ci_hc3[0]).toBeGreaterThan(THRESHOLD);
  });

  it('straddling the threshold from a true exponent of 1.35 is AMBIGUOUS', () => {
    const r = scoreE1(makeRuns((n) => 0.001 * Math.pow(n, 1.35), { noise: 0.30, seed: 11 }), { c: 0, B });

    expect(r.verdict).toBe('AMBIGUOUS');
  });
});

describe("Gate 7 (h) — trigger 1's lack-of-fit test and its practical-significance floor", () => {
  const parts = (runs) => [
    runs.map((r) => Math.log(r.chunk_count)),
    runs.map((r) => Math.log(r.duration_ms)),
    runs.map((r) => r.tier),
  ];

  it('a pure power law does not fire it, at any exponent', () => {
    const [x, y, g] = parts(makeRuns((n) => 0.001 * Math.pow(n, 1.5), { seed: 3 }));
    const l = lackOfFit(x, y, g);

    // A pure power law is a straight line in log-log; the CI on b owns that case.
    expect(l.departurePct).toBeLessThan(1);
    expect(l.fires).toBe(false);
  });

  it('a linear-plus-quadratic mixture beyond the 5% floor DOES fire it', () => {
    const k = (0.35 / 0.65) / 73359; // quadratic carries ~35% of T9's time
    const [x, y, g] = parts(makeRuns((n) => n + k * n * n, { noise: 0.005, seed: 9 }));
    const l = lackOfFit(x, y, g);

    expect(l.departurePct).toBeGreaterThan(5);
    expect(l.fires).toBe(true);
  });

  it('THE FLOOR ITSELF — N log N curvature does not fire it even when F is overwhelmingly significant', () => {
    const [x, y, g] = parts(makeRuns((n) => 0.005 * n * Math.log(n), { noise: 0.002, seed: 4 }));
    const l = lackOfFit(x, y, g);

    // This is FATAL-1 made concrete. With tight pure error the F test is significant by a
    // wide margin — so significance ALONE would fire trigger 1 on a healthy system, which
    // is exactly what the old ms/chunk monotonicity trigger did. Only the floor stops it.
    expect(l.significant).toBe(true);
    expect(l.p).toBeLessThan(1e-6);
    expect(l.departurePct).toBeLessThan(5);
    expect(l.departurePct).toBeCloseTo(0.7, 0); // the registered 0.69% benchmark
    expect(l.fires).toBe(false);
  });

  it('reports pure-error and lack-of-fit degrees of freedom as 18 and 7 for the frozen ladder', () => {
    const [x, y, g] = parts(makeRuns((n) => 0.05 * n));
    const l = lackOfFit(x, y, g);

    expect(l.dfLof).toBe(7);
    expect(l.dfPe).toBe(18);
  });

  it('raises when there is no replication to estimate pure error from', () => {
    const [x, y, g] = parts(makeRuns((n) => 0.05 * n, { reps: 1 }));

    expect(() => lackOfFit(x, y, g)).toThrow(/pure error/);
  });
});

describe('registered defaults', () => {
  it('uses 10,000 bootstrap draws and seed 811 unless overridden', () => {
    const runs = makeRuns((n) => 0.05 * n);
    const withDefaults = scoreE1(runs, { c: 0 });
    const explicit = scoreE1(runs, { c: 0, B: 10000, seed: 811 });

    expect(withDefaults.adjusted.ci_boot).toEqual(explicit.adjusted.ci_boot);
  });

  it('pins the threshold at 1.35', () => {
    expect(THRESHOLD).toBe(1.35);
  });
});
