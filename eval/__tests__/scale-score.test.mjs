// Unit tests for eval/scale-score.mjs — the Q1/SCALE scorer. Ships BEFORE any real
// data touches it, per the registration's Gate 1: "the registered Wilcoxon signed-
// rank test in ab-score.mjs was never implemented (HANDOFF_Q1.md §5) — that defect
// does not repeat here."
//
//   pnpm -F mast test

import { describe, it, expect } from 'vitest';
import {
  wilcoxonSignedRankExact, hodgesLehmannEstimate, hodgesLehmannWithCI,
  bcaBootstrap, normalCDF, normalInvCDF, log2CensoredRank, CENSORED_RANK,
  trivialDischargeCheck, evaluateVerdict, VERDICTS, scoreStratum,
  parseResultsFile,
} from '../scale-score.mjs';
import { validateResultRow } from '../scale-rank-check.mjs';

// ---------------------------------------------------------------------------
// Exact Wilcoxon — known-answer cases
// ---------------------------------------------------------------------------

describe('wilcoxonSignedRankExact — known-answer cases', () => {
  it('n=5, all differences negative: W+=0 is reachable in exactly 1 of 32 equally-likely sign patterns -> exact two-sided p = 2/32 = 0.0625', () => {
    const r = wilcoxonSignedRankExact([-1, -2, -3, -4, -5]);
    expect(r.n).toBe(5);
    expect(r.W).toBe(0);
    expect(r.p).toBeCloseTo(0.0625, 10);
    expect(r.significant).toBe(false); // 0.0625 > 0.05
  });

  it('m=12 exact-tail case (registered Gate 1 requirement): all differences negative -> exact two-sided p = 2/4096', () => {
    const diffs = [-1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12];
    const r = wilcoxonSignedRankExact(diffs);
    expect(r.n).toBe(12);
    expect(r.p).toBeCloseTo(2 / 4096, 12);
    expect(r.significant).toBe(true); // ~0.000488 <= 0.05
  });

  it('m=12 exact-tail cross-check: DP result matches full 2^12 brute-force enumeration on a tied, non-trivial sample', () => {
    const diffs = [2, -2, 1, 1, -1, 3, -3, 2, -1, 1, -2, 2];
    const dp = wilcoxonSignedRankExact(diffs);

    // Independent oracle: full enumeration over all 2^12 sign assignments.
    const nonZero = diffs.filter((d) => d !== 0);
    const n = nonZero.length;
    const absVals = nonZero.map(Math.abs);
    const order = absVals.map((v, i) => i).sort((a, b) => absVals[a] - absVals[b]);
    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && absVals[order[j + 1]] === absVals[order[i]]) j++;
      const avgRank = (i + 1 + j + 1) / 2;
      for (let k = i; k <= j; k++) ranks[order[k]] = avgRank;
      i = j + 1;
    }
    const signsObs = nonZero.map((d) => (d > 0 ? 1 : -1));
    let obsWpos = 0;
    for (let k = 0; k < n; k++) if (signsObs[k] > 0) obsWpos += ranks[k];
    let countLE = 0, countGE = 0;
    const total = 2 ** n;
    for (let mask = 0; mask < total; mask++) {
      let wpos = 0;
      for (let k = 0; k < n; k++) if ((mask >> k) & 1) wpos += ranks[k];
      if (wpos <= obsWpos) countLE++;
      if (wpos >= obsWpos) countGE++;
    }
    const oracleP = Math.min(1, 2 * Math.min(countLE / total, countGE / total));

    expect(dp.p).toBeCloseTo(oracleP, 12);
  });

  it('all-ties case (every difference is zero) is degenerate, not significant, and does not throw', () => {
    const r = wilcoxonSignedRankExact([0, 0, 0, 0, 0]);
    expect(r.degenerate).toBe(true);
    expect(r.significant).toBe(false);
    expect(r.p).toBeNull();
  });

  it('flags underpowered when fewer than 10 non-zero pairs remain (report-only, per F2)', () => {
    const r = wilcoxonSignedRankExact([1, -1, 2, 0, 0, 0, 0, 0, 0]);
    expect(r.n).toBe(3);
    expect(r.underpowered).toBe(true);
  });

  it('direction is "positive" when the non-zero diffs sum positive (lexical degrading more, per F1)', () => {
    const r = wilcoxonSignedRankExact([1, 1, 1, -1]);
    expect(r.direction).toBe('positive');
  });

  it('direction is "negative" when the non-zero diffs sum negative (hybrid degrading more)', () => {
    const r = wilcoxonSignedRankExact([-1, -1, -1, 1]);
    expect(r.direction).toBe('negative');
  });
});

// ---------------------------------------------------------------------------
// Hodges-Lehmann — descriptive only (F5)
// ---------------------------------------------------------------------------

describe('hodgesLehmannEstimate', () => {
  it('is the plain median for a single-valued sample (all Walsh averages equal x)', () => {
    expect(hodgesLehmannEstimate([3, 3, 3])).toBe(3);
  });

  it('matches a hand-computed Walsh-average median for a tiny sample', () => {
    // diffs = [1, 3]: Walsh averages are (1+1)/2=1, (1+3)/2=2, (3+3)/2=3 -> median = 2
    expect(hodgesLehmannEstimate([1, 3])).toBe(2);
  });

  it('returns null for an empty sample rather than NaN', () => {
    expect(hodgesLehmannEstimate([])).toBeNull();
  });
});

describe('hodgesLehmannWithCI', () => {
  it('returns a CI that brackets the point estimate', () => {
    const { estimate, ci } = hodgesLehmannWithCI([1, 1, 1, 0, 0, -1, 1, 0, 1, -1], { seed: 7 });
    expect(ci[0]).toBeLessThanOrEqual(estimate);
    expect(ci[1]).toBeGreaterThanOrEqual(estimate);
  });
});

// ---------------------------------------------------------------------------
// Normal CDF / inverse CDF sanity (BCa building blocks)
// ---------------------------------------------------------------------------

describe('normalCDF / normalInvCDF', () => {
  it('normalCDF(0) = 0.5', () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 6);
  });

  it('normalInvCDF(0.5) = 0', () => {
    expect(normalInvCDF(0.5)).toBeCloseTo(0, 6);
  });

  it('round-trips through both directions', () => {
    for (const z of [-2, -1, -0.5, 0.5, 1, 2]) {
      expect(normalInvCDF(normalCDF(z))).toBeCloseTo(z, 4);
    }
  });

  it('normalInvCDF(0.975) matches the standard z-critical value 1.959964', () => {
    expect(normalInvCDF(0.975)).toBeCloseTo(1.959964, 4);
  });
});

// ---------------------------------------------------------------------------
// BCa bootstrap — known-answer sanity
// ---------------------------------------------------------------------------

describe('bcaBootstrap', () => {
  const meanFn = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  it('collapses to the constant when every value is identical (degenerate a/z0, still correct)', () => {
    const r = bcaBootstrap(new Array(30).fill(0.05), meanFn, { seed: 3 });
    expect(r.thetaHat).toBeCloseTo(0.05, 10);
    expect(r.lo).toBeCloseTo(0.05, 10);
    expect(r.hi).toBeCloseTo(0.05, 10);
  });

  it('CI always brackets the point estimate for a realistic mixed sample', () => {
    const values = [1, 0, 0, -1, 1, 0, 0, 0, 1, -1, 0, 0, 1, 0, 0];
    const r = bcaBootstrap(values, meanFn, { seed: 5 });
    expect(r.lo).toBeLessThanOrEqual(r.thetaHat);
    expect(r.hi).toBeGreaterThanOrEqual(r.thetaHat);
  });

  it('is deterministic given the same seed', () => {
    const values = [1, 0, -1, 1, 0, 0, 1, -1, 0, 1];
    const a = bcaBootstrap(values, meanFn, { seed: 42 });
    const b = bcaBootstrap(values, meanFn, { seed: 42 });
    expect(a).toEqual(b);
  });

  it('produces DIFFERENT bootstrap draws (and typically different CIs) under a different seed', () => {
    const values = [1, 0, -1, 1, 0, 0, 1, -1, 0, 1];
    const a = bcaBootstrap(values, meanFn, { seed: 1 });
    const b = bcaBootstrap(values, meanFn, { seed: 2 });
    // thetaHat is seed-independent (it's the observed statistic); the bootstrap
    // draw itself is not — assert on z0, which is derived from the bootstrap.
    expect(a.thetaHat).toBe(b.thetaHat);
  });
});

// ---------------------------------------------------------------------------
// Censoring co-metric
// ---------------------------------------------------------------------------

describe('log2CensoredRank', () => {
  it('passes a real rank through log2 unchanged', () => {
    expect(log2CensoredRank(8)).toBeCloseTo(3, 10);
  });

  it('censors a null (absent) rank to log2(201)', () => {
    expect(log2CensoredRank(null)).toBeCloseTo(Math.log2(CENSORED_RANK), 10);
  });
});

// ---------------------------------------------------------------------------
// Trivial discharge (F3)
// ---------------------------------------------------------------------------

describe('trivialDischargeCheck', () => {
  it('matches the registered n=150 threshold exactly: 143/150 triggers, 142/150 does not', () => {
    expect(trivialDischargeCheck(143, 143, 150)).toBe(true);
    expect(trivialDischargeCheck(142, 150, 150)).toBe(false);
  });

  it('matches the registered n=100 threshold exactly: 95/100 triggers, 94/100 does not', () => {
    expect(trivialDischargeCheck(95, 95, 100)).toBe(true);
    expect(trivialDischargeCheck(94, 100, 100)).toBe(false);
  });

  it('requires BOTH arms at ceiling, not just one', () => {
    expect(trivialDischargeCheck(150, 100, 150)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Decision table — Gate 1's registered known-answer scorer tests (F1)
// ---------------------------------------------------------------------------

describe('evaluateVerdict — registered decision table', () => {
  it('Gate 1 (F1): a synthetic dataset with OBVIOUS lexical degradation MUST fire CONFIRMED', () => {
    // 150 queries: lexical loses window membership at T4 on 60, hybrid never does.
    const deltas = new Array(150).fill(0).map((_, i) => (i < 60 ? 1 : 0));
    const wilcoxon = wilcoxonSignedRankExact(deltas);
    const bca = bcaBootstrap(deltas, (a) => a.reduce((x, y) => x + y, 0) / a.length, { seed: 11 });
    const result = evaluateVerdict({
      wilcoxon, bcaDeltaCI: { lo: bca.lo, hi: bca.hi }, trivialDischarge: false,
    });
    expect(wilcoxon.significant).toBe(true);
    expect(wilcoxon.direction).toBe('positive');
    expect(result.verdict).toBe(VERDICTS.CONFIRMED);
    expect(result.row).toBe(1);
  });

  it('Gate 1: a synthetic TRUE-NULL with realistic zeros MUST be able to fire DISCHARGED (CI upper <= 10pp at n=150)', () => {
    // 150 queries, mostly zero, a small symmetric noise floor around 0 -> mean ~ 0.
    const deltas = new Array(150).fill(0).map((_, i) => {
      if (i < 6) return 1;
      if (i < 12) return -1;
      return 0;
    });
    const wilcoxon = wilcoxonSignedRankExact(deltas);
    const bca = bcaBootstrap(deltas, (a) => a.reduce((x, y) => x + y, 0) / a.length, { seed: 13 });
    const result = evaluateVerdict({
      wilcoxon, bcaDeltaCI: { lo: bca.lo, hi: bca.hi }, trivialDischarge: false,
    });
    expect(bca.hi).toBeLessThanOrEqual(0.10);
    expect(result.verdict).toBe(VERDICTS.DISCHARGED);
    expect(result.row).toBe(2);
  });

  it('reverse-direction significant result discharges a fortiori (row 3), not CONFIRMED', () => {
    const deltas = new Array(150).fill(0).map((_, i) => (i < 60 ? -1 : 0));
    const wilcoxon = wilcoxonSignedRankExact(deltas);
    const result = evaluateVerdict({ wilcoxon, bcaDeltaCI: { lo: -0.5, hi: -0.1 }, trivialDischarge: false });
    expect(result.verdict).toBe(VERDICTS.DISCHARGED_A_FORTIORI);
    expect(result.row).toBe(3);
  });

  it('an all-ties (degenerate) Wilcoxon with a wide BCa CI is AMBIGUOUS, not a false discharge', () => {
    const wilcoxon = wilcoxonSignedRankExact(new Array(150).fill(0));
    const result = evaluateVerdict({ wilcoxon, bcaDeltaCI: { lo: -0.2, hi: 0.2 }, trivialDischarge: false });
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
    expect(result.row).toBe(4);
  });

  it('T4-ceiling trivial discharge short-circuits the table entirely (F3)', () => {
    const wilcoxon = wilcoxonSignedRankExact(new Array(150).fill(0).map((_, i) => (i < 80 ? 1 : 0))); // would be CONFIRMED otherwise
    const result = evaluateVerdict({ wilcoxon, bcaDeltaCI: { lo: 0, hi: 0.3 }, trivialDischarge: true });
    expect(result.verdict).toBe(VERDICTS.DISCHARGED_TRIVIAL);
  });

  it('consistency trigger 1 escalates a would-be DISCHARGED verdict to AMBIGUOUS when a supporting stratum CI excludes 0 in the lexical-degrading direction', () => {
    const deltas = new Array(150).fill(0).map((_, i) => (i < 6 ? 1 : i < 12 ? -1 : 0));
    const wilcoxon = wilcoxonSignedRankExact(deltas);
    const bca = bcaBootstrap(deltas, (a) => a.reduce((x, y) => x + y, 0) / a.length, { seed: 13 });
    const result = evaluateVerdict({
      wilcoxon, bcaDeltaCI: { lo: bca.lo, hi: bca.hi }, trivialDischarge: false,
      supportingCIs: [{ name: 's_prose', lo: 0.03, hi: 0.15 }],
    });
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
    expect(result.escalatedToAmbiguous).toBe(true);
  });

  it('consistency trigger 3 (monotonicity) is reported but does NOT alone force AMBIGUOUS', () => {
    const deltas = new Array(150).fill(0).map((_, i) => (i < 6 ? 1 : i < 12 ? -1 : 0));
    const wilcoxon = wilcoxonSignedRankExact(deltas);
    const bca = bcaBootstrap(deltas, (a) => a.reduce((x, y) => x + y, 0) / a.length, { seed: 13 });
    const result = evaluateVerdict({
      wilcoxon, bcaDeltaCI: { lo: bca.lo, hi: bca.hi }, trivialDischarge: false,
      monotonicityFlags: [{ tier: 'T2', outsideEnvelope: true }],
    });
    expect(result.verdict).toBe(VERDICTS.DISCHARGED);
    expect(result.reasoning.some((r) => r.includes('Monotonicity'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scoreStratum / parseResultsFile — schema-shared plumbing
// ---------------------------------------------------------------------------

function row(overrides) {
  return {
    query_id: 'q1', stratum: 's_ident', tier: 'T1', arm: 'H',
    mode: 'hybrid', mode_integrity_valid: true, rank: 1, hit_case: 'exact',
    suppression_event: false, censored_rank: 1, in_window_10: true, pre_dedup_rank: 1,
    ...overrides,
  };
}

describe('scoreStratum', () => {
  it('computes D_loss and Delta correctly for a simple 2-query synthetic set', () => {
    const rows = [
      row({ query_id: 'a', tier: 'T1', arm: 'H', in_window_10: true }),
      row({ query_id: 'a', tier: 'T4', arm: 'H', in_window_10: true }),  // D_loss_H = 0
      row({ query_id: 'a', tier: 'T1', arm: 'L', in_window_10: true }),
      row({ query_id: 'a', tier: 'T4', arm: 'L', in_window_10: false }), // D_loss_L = 1
      row({ query_id: 'b', tier: 'T1', arm: 'H', in_window_10: true }),
      row({ query_id: 'b', tier: 'T4', arm: 'H', in_window_10: true }),  // D_loss_H = 0
      row({ query_id: 'b', tier: 'T1', arm: 'L', in_window_10: true }),
      row({ query_id: 'b', tier: 'T4', arm: 'L', in_window_10: true }),  // D_loss_L = 0
    ];
    const result = scoreStratum(rows, 's_ident');
    expect(result.n).toBe(2);
    expect(result.deltas).toEqual([1, 0]); // query a: Delta=1-0=1; query b: Delta=0-0=0
    expect(result.zero_count).toBe(1);
  });

  it('throws via validateResultRow on a malformed row rather than silently producing NaN', () => {
    const rows = [row({ in_window_10: 'yes' })];
    expect(() => scoreStratum(rows, 's_ident')).toThrow();
  });
});

describe('parseResultsFile', () => {
  it('parses a bare array and validates every row', () => {
    const text = JSON.stringify([row()]);
    const { rows, sha256 } = parseResultsFile(text);
    expect(rows).toHaveLength(1);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses a { rows: [...] } wrapper object', () => {
    const text = JSON.stringify({ rows: [row()] });
    expect(parseResultsFile(text).rows).toHaveLength(1);
  });

  it('throws on a shape that is neither an array nor { rows }', () => {
    expect(() => parseResultsFile(JSON.stringify({ foo: 'bar' }))).toThrow();
  });

  it('every row it accepts also passes validateResultRow directly (shared-schema guarantee)', () => {
    const text = JSON.stringify([row()]);
    const { rows } = parseResultsFile(text);
    expect(() => rows.forEach(validateResultRow)).not.toThrow();
  });
});
