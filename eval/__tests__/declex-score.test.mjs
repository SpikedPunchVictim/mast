// Unit tests for eval/declex-score.mjs — the Q1/DECLEX amended-table scorer.
// Ships BEFORE any real data touches it, per the registration's Gate B/Gate 1
// discipline this program follows throughout (HANDOFF_Q1.md §5's ab-score.mjs
// defect — a registered-but-never-implemented statistical test — must not
// repeat for the amended decision table either).
//
// Two test styles, matching the parent's/idfuse's own precedent:
// `evaluateVerdict` is tested with DIRECTLY CONSTRUCTED wilcoxon-shaped/CI/
// harm objects (fast, precise, exactly hits each threshold); `scoreDeclex`
// is tested end-to-end with small hand-built ResultRow arrays to verify the
// D_loss / Delta' / efficacy / harm-gate plumbing itself.
//
//   pnpm -F mast test

import { describe, it, expect } from 'vitest';
import {
  evaluateVerdict, scoreDeclex, parseResultsFile, VERDICTS, PRECISION_FLOOR_PP,
  HARM_FIRE_RATE_FLOOR, HARM_STATES, bcaBootstrapByQuery, perQueryTierDiffs,
  fireRate, computeEscapeCapSweep, F_R2_PROJECTION,
} from '../declex-score.mjs';
import { validateResultRow } from '../declex-rank-check.mjs';

// ---------------------------------------------------------------------------
// evaluateVerdict — constructed wilcoxon/CI/harm inputs, one test per
// registered verdict row + the efficacy 2x2 gate + the harm gate + the
// symmetric consistency triggers.
// ---------------------------------------------------------------------------

function wilcoxon(overrides) {
  return { significant: false, direction: 'zero', degenerate: false, p: 1, ...overrides };
}

const HARM_NULL_BOTH = { s_approx: { state: HARM_STATES.HARM_NULL, fire_rate: 0.02, ci: null }, s_prose: { state: HARM_STATES.HARM_NULL, fire_rate: 0.01, ci: null } };
const HARM_CLEAN_APPROX = { s_approx: { state: HARM_STATES.HARM_CLEAN, fire_rate: 0.3, ci: { thetaHat: 0.01, lo: -0.02, hi: 0.04 } }, s_prose: { state: HARM_STATES.HARM_NULL, fire_rate: 0.01, ci: null } };
const HARM_FAIL_PROSE = { s_approx: { state: HARM_STATES.HARM_NULL, fire_rate: 0.01, ci: null }, s_prose: { state: HARM_STATES.HARM_FAIL, fire_rate: 0.4, ci: { thetaHat: -0.1, lo: -0.2, hi: -0.03 } } };

describe('evaluateVerdict — efficacy PASSES branch, HARM-NULL both off-strata (harm UNTESTED)', () => {
  const efficacyPasses = { lo: 0.1, hi: 0.3 };

  it('row: not significant AND CI upper <= 5pp AND both off-strata HARM-NULL -> GAP CLOSED, harm UNTESTED', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      offStratumHarm: HARM_NULL_BOTH,
    });
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED_HARM_UNTESTED);
    expect(result.escalated_to_ambiguous).toBe(false);
  });

  it('degenerate Wilcoxon (all-zero Delta\', perfect closure) counts as "not significant"', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false, degenerate: true, p: null }),
      bcaDeltaCI: { lo: 0, hi: 0 },
      offStratumHarm: HARM_NULL_BOTH,
    });
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED_HARM_UNTESTED);
  });

  it('significant in the REVERSE direction (L+D degrades LESS than H) -> CLOSED A FORTIORI, harm UNTESTED', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'negative', p: 0.001 }),
      bcaDeltaCI: { lo: -0.5, hi: -0.1 },
      offStratumHarm: HARM_NULL_BOTH,
    });
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED_A_FORTIORI_HARM_UNTESTED);
  });

  it('significant, L+D degrades more, CI upper > 5pp -> GAP SURVIVES (harm gate irrelevant to SURVIVES)', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'positive', p: 0.001 }),
      bcaDeltaCI: { lo: 0.1, hi: 0.3 },
      offStratumHarm: HARM_NULL_BOTH,
    });
    expect(result.verdict).toBe(VERDICTS.GAP_SURVIVES);
  });

  it('significant, L+D degrades more, CI upper <= 5pp -> GAP SURVIVES (marginal, sub-precision-floor)', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'positive', p: 0.02 }),
      bcaDeltaCI: { lo: 0.01, hi: 0.04 },
      offStratumHarm: HARM_NULL_BOTH,
    });
    expect(result.verdict).toBe(VERDICTS.GAP_SURVIVES_MARGINAL);
  });

  it('neither the closed nor the survives condition is met -> AMBIGUOUS', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'positive', p: 0.03 }),
      bcaDeltaCI: { lo: null, hi: null },
      offStratumHarm: HARM_NULL_BOTH,
    });
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
  });

  it('the 5pp precision floor constant matches the registration', () => {
    expect(PRECISION_FLOOR_PP).toBe(0.05);
  });

  it('the 10% harm fire-rate floor constant matches the registration', () => {
    expect(HARM_FIRE_RATE_FLOOR).toBe(0.10);
  });
});

describe('evaluateVerdict — HARM-CLEAN split ("harm-tested" language)', () => {
  const efficacyPasses = { lo: 0.1, hi: 0.3 };

  it('row 1-shaped closure AND >= 1 off-stratum HARM-CLEAN -> GAP CLOSED, harm TESTED', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      offStratumHarm: HARM_CLEAN_APPROX,
    });
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED_HARM_TESTED);
  });

  it('a-fortiori-shaped closure AND >= 1 off-stratum HARM-CLEAN -> CLOSED A FORTIORI, harm TESTED', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'negative', p: 0.001 }),
      bcaDeltaCI: { lo: -0.5, hi: -0.1 },
      offStratumHarm: HARM_CLEAN_APPROX,
    });
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED_A_FORTIORI_HARM_TESTED);
  });
});

describe('evaluateVerdict — CLOSED-BUT-HARMFUL (AMENDMENT 1, F-7(i))', () => {
  const efficacyPasses = { lo: 0.1, hi: 0.3 };

  it('row 1-shaped closure AND a HARM-CLEAN-floor stratum shows harm -> CLOSED-BUT-HARMFUL', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      offStratumHarm: HARM_FAIL_PROSE,
    });
    expect(result.verdict).toBe(VERDICTS.CLOSED_BUT_HARMFUL);
  });

  it('a-fortiori-shaped closure ("stronger closure") AND harm-fail ALSO routes to CLOSED-BUT-HARMFUL, not AMBIGUOUS (F-7(i)\'s explicit fix)', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'negative', p: 0.001 }),
      bcaDeltaCI: { lo: -0.5, hi: -0.1 },
      offStratumHarm: HARM_FAIL_PROSE,
    });
    expect(result.verdict).toBe(VERDICTS.CLOSED_BUT_HARMFUL);
  });

  it('harm-fail on the OTHER stratum (approx, when prose is harm-clean) still routes to CLOSED-BUT-HARMFUL — any HARM-CLEAN-floor stratum showing harm overrides', () => {
    const bothExposedOneFails = {
      s_approx: { state: HARM_STATES.HARM_FAIL, fire_rate: 0.5, ci: { thetaHat: -0.08, lo: -0.15, hi: -0.01 } },
      s_prose: { state: HARM_STATES.HARM_CLEAN, fire_rate: 0.3, ci: { thetaHat: 0.01, lo: -0.02, hi: 0.05 } },
    };
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      offStratumHarm: bothExposedOneFails,
    });
    expect(result.verdict).toBe(VERDICTS.CLOSED_BUT_HARMFUL);
  });
});

describe('evaluateVerdict — efficacy 2x2 precondition gate (precedence over the harm gate and the closure table)', () => {
  const efficacyFails = { lo: -0.01, hi: 0.03 }; // includes 0
  const efficacyReverseSig = { lo: -0.3, hi: -0.05 }; // excludes 0, reverse direction

  it('efficacy FAILS + Delta\' meets the GAP CLOSED criteria -> AMBIGUOUS (registered collision cell)', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyFails,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.01, hi: 0.02 },
      offStratumHarm: HARM_NULL_BOTH,
    });
    expect(result.efficacy.passes).toBe(false);
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
    expect(result.reasoning.some((r) => r.includes('collision'))).toBe(true);
  });

  it('efficacy FAILS (not reverse-significant) + Delta\' does NOT meet the GAP CLOSED criteria -> INERT-LEVER', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyFails,
      wilcoxon: wilcoxon({ significant: true, direction: 'positive', p: 0.001 }),
      bcaDeltaCI: { lo: 0.1, hi: 0.3 },
      offStratumHarm: HARM_NULL_BOTH,
    });
    expect(result.verdict).toBe(VERDICTS.INERT_LEVER);
  });

  it('efficacy REVERSE-SIGNIFICANT (D hurts L on-stratum) + Delta\' does NOT meet closure -> HARMFUL-LEVER (on-stratum), NOT INERT-LEVER (AMENDMENT 1, F-7(ii))', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyReverseSig,
      wilcoxon: wilcoxon({ significant: true, direction: 'positive', p: 0.001 }),
      bcaDeltaCI: { lo: 0.1, hi: 0.3 },
      offStratumHarm: HARM_NULL_BOTH,
    });
    expect(result.verdict).toBe(VERDICTS.HARMFUL_LEVER_ON_STRATUM);
    expect(result.efficacy.reverse_significant).toBe(true);
  });

  it('efficacy FAILS + Delta\' is a-fortiori-shaped -> AMBIGUOUS, not INERT-LEVER or HARMFUL-LEVER (a-fortiori counts as "meets closed criteria" for the collision cell)', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyFails,
      wilcoxon: wilcoxon({ significant: true, direction: 'negative', p: 0.001 }),
      bcaDeltaCI: { lo: -0.5, hi: -0.1 },
      offStratumHarm: HARM_NULL_BOTH,
    });
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
  });

  it('efficacy exactly at the boundary (lo=0) FAILS (strict > 0 required)', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: { lo: 0, hi: 0.05 },
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.01, hi: 0.02 },
      offStratumHarm: HARM_NULL_BOTH,
    });
    expect(result.efficacy.passes).toBe(false);
  });
});

describe('evaluateVerdict — symmetric consistency triggers (both directions), verdict-bearing only on CLOSED/SURVIVES rows', () => {
  const efficacyPasses = { lo: 0.1, hi: 0.3 };

  it('trigger (closure direction): a supporting cell shows L+D significantly WORSE than H while the decision test closed -> escalate to AMBIGUOUS', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      offStratumHarm: HARM_NULL_BOTH,
      supportingCIs: [{ name: 's_approx', lo: 0.05, hi: 0.15 }],
    });
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
    expect(result.escalated_to_ambiguous).toBe(true);
  });

  it('trigger (survives direction): a supporting cell shows L+D significantly BETTER than H while the decision test survived -> escalate to AMBIGUOUS', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'positive', p: 0.001 }),
      bcaDeltaCI: { lo: 0.1, hi: 0.3 },
      offStratumHarm: HARM_NULL_BOTH,
      supportingCIs: [{ name: 's_prose', lo: -0.2, hi: -0.05 }],
    });
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
    expect(result.escalated_to_ambiguous).toBe(true);
  });

  it('the Delta-log2(rank) co-metric participates in the same trigger as the supporting strata', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      offStratumHarm: HARM_NULL_BOTH,
      deltaLog2CI: { lo: 0.2, hi: 0.6 },
    });
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
    expect(result.escalated_to_ambiguous).toBe(true);
  });

  it('a supporting cell CI that INCLUDES 0 does not trigger escalation', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      offStratumHarm: HARM_NULL_BOTH,
      supportingCIs: [{ name: 's_approx', lo: -0.05, hi: 0.05 }],
    });
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED_HARM_UNTESTED);
    expect(result.escalated_to_ambiguous).toBe(false);
  });

  it('monotonicity flags are reported but do NOT alone force AMBIGUOUS', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      offStratumHarm: HARM_NULL_BOTH,
      monotonicityFlags: [{ tier: 'T2', arm: 'L+D', outsideEnvelope: true }],
    });
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED_HARM_UNTESTED);
    expect(result.reasoning.some((r) => r.includes('Monotonicity'))).toBe(true);
  });

  it('a consistency trigger is reported (in reasoning) but NOT verdict-bearing on a CLOSED-BUT-HARMFUL row', () => {
    // Constructed so a supporting cell WOULD trigger closure-direction escalation,
    // but the row is already CLOSED-BUT-HARMFUL — the trigger must not further
    // change the verdict away from CLOSED-BUT-HARMFUL.
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      offStratumHarm: HARM_FAIL_PROSE,
      supportingCIs: [{ name: 's_approx', lo: 0.05, hi: 0.15 }],
    });
    expect(result.verdict).toBe(VERDICTS.CLOSED_BUT_HARMFUL);
  });
});

// ---------------------------------------------------------------------------
// bcaBootstrapByQuery — the per-query block-bootstrap primitive (AMENDMENT 1,
// F-7(v)): correlated tier rows must widen the CI vs naive per-row pooling.
// ---------------------------------------------------------------------------

describe('bcaBootstrapByQuery — the harm contrast\'s per-query resampling unit', () => {
  const mean = (arr) => (arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length);

  it('a degenerate all-zero input collapses to a point CI at 0', () => {
    const perQuery = Array.from({ length: 10 }, () => [0, 0, 0, 0]);
    const result = bcaBootstrapByQuery(perQuery, mean, { seed: 1 });
    expect(result.thetaHat).toBe(0);
    expect(result.lo).toBe(0);
    expect(result.hi).toBe(0);
  });

  it('reports n_queries as the number of QUERIES (resampling units), not the number of flattened values', () => {
    const perQuery = Array.from({ length: 15 }, () => [1, 1, 1, 1]); // 15 queries x 4 tier rows = 60 flattened values
    const result = bcaBootstrapByQuery(perQuery, mean, { seed: 1 });
    expect(result.n_queries).toBe(15);
  });

  it('returns a null-CI shape for an empty input rather than crashing', () => {
    const result = bcaBootstrapByQuery([], mean, { seed: 1 });
    expect(result.thetaHat).toBeNull();
    expect(result.lo).toBeNull();
    expect(result.n_queries).toBe(0);
  });

  it('CORRELATED tier rows (identical within each query, varying ACROSS queries) produce a WIDER per-query-unit CI than naive per-row pooling of the same flattened values — the exact overstated-precision defect F-7(v) exists to prevent', () => {
    // Half the queries have all 4 tier-rows = +1; half have all 4 tier-rows =
    // -1 — the TRUE variability is entirely at the query level (n=20 queries
    // worth of information), even though there are 80 flattened rows. A naive
    // per-VALUE bootstrap (bcaBootstrap, resampling from the 80 flattened
    // values as if independent) sees 80 "observations" and under-estimates
    // the true sampling variance; the per-QUERY bootstrap sees the true 20
    // independent units and must report a wider interval.
    const rng = (seed) => {
      let a = seed;
      return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const r = rng(42);
    const perQuery = Array.from({ length: 20 }, () => {
      const sign = r() < 0.5 ? 1 : -1;
      return [sign, sign, sign, sign];
    });
    const flattened = perQuery.flat();

    const perQueryResult = bcaBootstrapByQuery(perQuery, mean, { seed: 7 });

    // Naive per-value bootstrap over the SAME flattened data, implemented
    // inline (not imported) so this test does not depend on bcaBootstrap's
    // exact internals beyond "resamples individual scalar values" — the
    // property under test is resampling-UNIT-dependent width, not a specific
    // library's numerics.
    function naivePerValueBootstrap(values, seed) {
      const n = values.length;
      const bootRng = rng(seed);
      const boot = [];
      for (let b = 0; b < 10000; b++) {
        let sum = 0;
        for (let k = 0; k < n; k++) sum += values[Math.floor(bootRng() * n)];
        boot.push(sum / n);
      }
      boot.sort((a, b) => a - b);
      return { lo: boot[Math.round(0.025 * (boot.length - 1))], hi: boot[Math.round(0.975 * (boot.length - 1))] };
    }
    const naiveResult = naivePerValueBootstrap(flattened, 7);

    const perQueryWidth = perQueryResult.hi - perQueryResult.lo;
    const naiveWidth = naiveResult.hi - naiveResult.lo;
    expect(perQueryWidth).toBeGreaterThan(naiveWidth);
  });
});

describe('perQueryTierDiffs', () => {
  function row(overrides) {
    return { query_id: 'q0', stratum: 's_approx', tier: 'T1', arm: 'L+D', in_window_10: true, ...overrides };
  }

  it('groups per-tier diffs by query, only for queries present in BOTH arms', () => {
    const rows = [
      row({ query_id: 'q1', tier: 'T1', arm: 'L+D', in_window_10: true }),
      row({ query_id: 'q1', tier: 'T1', arm: 'L', in_window_10: false }),
      row({ query_id: 'q1', tier: 'T4', arm: 'L+D', in_window_10: false }),
      row({ query_id: 'q1', tier: 'T4', arm: 'L', in_window_10: false }),
      row({ query_id: 'q2', tier: 'T1', arm: 'L+D', in_window_10: true }), // no L-arm row for q2 -> excluded
    ];
    const result = perQueryTierDiffs(rows, 's_approx', 'L+D', 'L');
    expect(result).toHaveLength(1);
    expect(result[0].query_id).toBe('q1');
    expect(result[0].diffs).toEqual([{ tier: 'T1', diff: 1 }, { tier: 'T4', diff: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// fireRate — the HARM-CLEAN/HARM-NULL fire-rate threshold input.
// ---------------------------------------------------------------------------

describe('fireRate — fire-rate threshold test', () => {
  function row(overrides) {
    return { query_id: 'q0', stratum: 's_approx', tier: 'T1', arm: 'L+D', d_diagnostic: { fired: false }, ...overrides };
  }

  it('computes the pooled fraction of rows with d_diagnostic.fired === true', () => {
    const rows = [
      row({ query_id: 'q1', d_diagnostic: { fired: true } }),
      row({ query_id: 'q2', d_diagnostic: { fired: false } }),
      row({ query_id: 'q3', d_diagnostic: { fired: false } }),
      row({ query_id: 'q4', d_diagnostic: { fired: false } }),
      row({ query_id: 'q5', d_diagnostic: { fired: false } }),
      row({ query_id: 'q6', d_diagnostic: { fired: false } }),
      row({ query_id: 'q7', d_diagnostic: { fired: false } }),
      row({ query_id: 'q8', d_diagnostic: { fired: false } }),
      row({ query_id: 'q9', d_diagnostic: { fired: false } }),
      row({ query_id: 'q10', d_diagnostic: { fired: false } }),
    ];
    expect(fireRate(rows, 's_approx', 'L+D')).toBeCloseTo(0.1, 10);
  });

  it('returns null when no matching rows exist for the cell', () => {
    expect(fireRate([], 's_approx', 'L+D')).toBeNull();
  });

  it('can be scoped to a single tier', () => {
    const rows = [
      row({ query_id: 'q1', tier: 'T1', d_diagnostic: { fired: true } }),
      row({ query_id: 'q1', tier: 'T4', d_diagnostic: { fired: false } }),
    ];
    expect(fireRate(rows, 's_approx', 'L+D', 'T1')).toBe(1);
    expect(fireRate(rows, 's_approx', 'L+D', 'T4')).toBe(0);
  });

  it('exactly AT the 10% floor counts as meeting it (>= 10%, not > 10%) — verified via scoreDeclex\'s harm-gate classification below', () => {
    // fireRate itself is a pure fraction; the >= vs > distinction is tested
    // where the threshold is actually APPLIED (computeOffStratumHarm, exercised
    // indirectly through scoreDeclex in the "fire-rate threshold" describe block).
    expect(HARM_FIRE_RATE_FLOOR).toBe(0.10);
  });
});

// ---------------------------------------------------------------------------
// scoreDeclex — end-to-end plumbing over small hand-built ResultRow arrays,
// including the fire-rate threshold applied to the harm gate and the F-9
// firewall (fresh vs original query_set separation).
// ---------------------------------------------------------------------------

function row(overrides) {
  return {
    query_id: 'q0', stratum: 's_ident', tier: 'T1', arm: 'H', query_set: 'fresh',
    mode: 'hybrid', mode_integrity_valid: true, rank: 1, hit_case: 'exact',
    suppression_event: false, censored_rank: 1, in_window_10: true, pre_dedup_rank: 1,
    ...overrides,
  };
}

describe('scoreDeclex — plumbing over a small synthetic 10-query S-ident set (harm gate HARM-NULL, both off-strata empty)', () => {
  // H: in_window@10 at T1 AND T4 -> D_loss_H = 0.
  // L: in_window@10 at T1, NOT at T4 -> D_loss_L = 1 (lexical degrades).
  // L+D: in_window@10 at T1 AND T4 -> D_loss_{L+D} = 0 (D fully rescues).
  // Efficacy (L+D vs L @ T4): diff=1 x10 -> maximally significant, PASSES.
  // Delta' (L+D vs H, D_loss): 0-0=0 x10 -> degenerate, meets row-1 GAP CLOSED.
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const qid = `q${i}`;
    rows.push(row({ query_id: qid, tier: 'T1', arm: 'H', in_window_10: true }));
    rows.push(row({ query_id: qid, tier: 'T4', arm: 'H', in_window_10: true }));
    rows.push(row({ query_id: qid, tier: 'T1', arm: 'L', in_window_10: true }));
    rows.push(row({ query_id: qid, tier: 'T4', arm: 'L', in_window_10: false }));
    rows.push(row({ query_id: qid, tier: 'T1', arm: 'L+D', in_window_10: true, d_diagnostic: { fired: true, top_match_channel: 'full', candidate_count: 1 } }));
    rows.push(row({ query_id: qid, tier: 'T4', arm: 'L+D', in_window_10: true, d_diagnostic: { fired: true, top_match_channel: 'full', candidate_count: 1 } }));
  }

  it('computes a strongly-passing efficacy signal', () => {
    const result = scoreDeclex(rows);
    expect(result.efficacy.n).toBe(10);
    expect(result.efficacy.bca_ci.thetaHat).toBeCloseTo(1, 10);
    expect(result.efficacy.bca_ci.lo).toBeGreaterThan(0);
  });

  it('computes a perfectly-closed Delta\' -> degenerate Wilcoxon, zero-width CI', () => {
    const result = scoreDeclex(rows);
    expect(result.decision_bearing.n).toBe(10);
    expect(result.decision_bearing.wilcoxon.degenerate).toBe(true);
    expect(result.decision_bearing.bca_delta_ci.thetaHat).toBeCloseTo(0, 10);
  });

  it('both off-strata are HARM-NULL (no rows at all) and the verdict is harm-UNTESTED closure', () => {
    const result = scoreDeclex(rows);
    expect(result.harm.off_stratum.s_approx.state).toBe(HARM_STATES.HARM_NULL);
    expect(result.harm.off_stratum.s_prose.state).toBe(HARM_STATES.HARM_NULL);
    expect(result.verdict.verdict).toBe(VERDICTS.GAP_CLOSED_HARM_UNTESTED);
  });

  it('the fire-rate aggregate reports null cells for empty strata, not a crash', () => {
    const result = scoreDeclex(rows);
    expect(result.harm.fire_rate_aggregate.s_approx.pooled).toBeNull();
  });

  it('descriptive-only arms compute without error and are excluded from the verdict', () => {
    const result = scoreDeclex(rows);
    expect(result.descriptive_only.h_plus_d.n).toBe(0);
    expect(result.descriptive_only.l_plus_d_esc.n).toBe(0);
  });

  it('throws via validateResultRow on a malformed row rather than silently producing NaN', () => {
    const badRows = [...rows, row({ query_id: 'bad', arm: 'V' })];
    expect(() => scoreDeclex(badRows)).toThrow();
  });

  it('throws when a row is missing query_set (the F-9 firewall\'s partition key)', () => {
    const badRow = row({ query_id: 'bad2' });
    delete badRow.query_set;
    expect(() => scoreDeclex([...rows, badRow])).toThrow();
  });
});

describe('scoreDeclex — HARM-CLEAN fire-rate threshold applied end-to-end (exactly at 10% passes; just under fails to HARM-NULL)', () => {
  function buildRows({ approxFireCount, n = 10 }) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const qid = `q${i}`;
      for (const tier of ['T1', 'T4']) {
        rows.push(row({ query_id: qid, tier, arm: 'H', stratum: 's_ident', in_window_10: true }));
        rows.push(row({ query_id: qid, tier, arm: 'L', stratum: 's_ident', in_window_10: true }));
        rows.push(row({ query_id: qid, tier, arm: 'L+D', stratum: 's_ident', in_window_10: true, d_diagnostic: { fired: true } }));
      }
      // S-approx: fires on exactly `approxFireCount` of n queries, no measurable harm when it does fire.
      const fired = i < approxFireCount;
      for (const tier of ['T1', 'T2', 'T3', 'T4']) {
        rows.push(row({ query_id: qid, tier, arm: 'L', stratum: 's_approx', in_window_10: true }));
        rows.push(row({ query_id: qid, tier, arm: 'L+D', stratum: 's_approx', in_window_10: true, d_diagnostic: { fired } }));
      }
    }
    return rows;
  }

  it('fire rate exactly at 10% (1/10) meets the floor -> s_approx is HARM-CLEAN-eligible (not HARM-NULL)', () => {
    const rows = buildRows({ approxFireCount: 1, n: 10 });
    const result = scoreDeclex(rows);
    expect(result.harm.off_stratum.s_approx.fire_rate).toBeCloseTo(0.1, 10);
    expect(result.harm.off_stratum.s_approx.state).not.toBe(HARM_STATES.HARM_NULL);
  });

  it('fire rate just under 10% (0/10, since counts are integers the boundary below 1/10 is 0) -> HARM-NULL', () => {
    const rows = buildRows({ approxFireCount: 0, n: 10 });
    const result = scoreDeclex(rows);
    expect(result.harm.off_stratum.s_approx.fire_rate).toBe(0);
    expect(result.harm.off_stratum.s_approx.state).toBe(HARM_STATES.HARM_NULL);
  });
});

describe('scoreDeclex — HARMFUL-LEVER (on-stratum) reached end-to-end', () => {
  it('L+D significantly WORSE than L at T4 S-ident, with Delta\' not meeting closure -> HARMFUL-LEVER', () => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
      const qid = `q${i}`;
      // L+D strictly worse than L at T4 on every query (reverse-significant efficacy).
      rows.push(row({ query_id: qid, tier: 'T1', arm: 'H', in_window_10: true }));
      rows.push(row({ query_id: qid, tier: 'T4', arm: 'H', in_window_10: true }));
      rows.push(row({ query_id: qid, tier: 'T1', arm: 'L', in_window_10: true }));
      rows.push(row({ query_id: qid, tier: 'T4', arm: 'L', in_window_10: true }));
      rows.push(row({ query_id: qid, tier: 'T1', arm: 'L+D', in_window_10: true, d_diagnostic: { fired: true } }));
      rows.push(row({ query_id: qid, tier: 'T4', arm: 'L+D', in_window_10: false, d_diagnostic: { fired: true } })); // L+D loses what L kept
    }
    const result = scoreDeclex(rows);
    expect(result.efficacy.bca_ci.hi).toBeLessThan(0);
    expect(result.verdict.verdict).toBe(VERDICTS.HARMFUL_LEVER_ON_STRATUM);
  });
});

describe('scoreDeclex — CLOSED-BUT-HARMFUL reached end-to-end (efficacy passes, Delta\' closes, but an exposed off-stratum shows harm)', () => {
  it('routes to CLOSED-BUT-HARMFUL, not GAP CLOSED', () => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
      const qid = `q${i}`;
      // S-ident: efficacy passes, Delta' closes (same shape as the first describe block).
      rows.push(row({ query_id: qid, tier: 'T1', arm: 'H', in_window_10: true }));
      rows.push(row({ query_id: qid, tier: 'T4', arm: 'H', in_window_10: true }));
      rows.push(row({ query_id: qid, tier: 'T1', arm: 'L', in_window_10: true }));
      rows.push(row({ query_id: qid, tier: 'T4', arm: 'L', in_window_10: false }));
      rows.push(row({ query_id: qid, tier: 'T1', arm: 'L+D', in_window_10: true, d_diagnostic: { fired: true } }));
      rows.push(row({ query_id: qid, tier: 'T4', arm: 'L+D', in_window_10: true, d_diagnostic: { fired: true } }));

      // S-approx: D fires on every query (fire rate 100%, well above the 10%
      // floor) and is CONSISTENTLY worse than L (harm signal, not noise).
      for (const tier of ['T1', 'T2', 'T3', 'T4']) {
        rows.push(row({ query_id: qid, tier, arm: 'L', stratum: 's_approx', in_window_10: true }));
        rows.push(row({ query_id: qid, tier, arm: 'L+D', stratum: 's_approx', in_window_10: false, d_diagnostic: { fired: true } }));
      }
    }
    const result = scoreDeclex(rows);
    expect(result.harm.off_stratum.s_approx.state).toBe(HARM_STATES.HARM_FAIL);
    expect(result.verdict.verdict).toBe(VERDICTS.CLOSED_BUT_HARMFUL);
  });
});

// ---------------------------------------------------------------------------
// Escape-cap sweep
// ---------------------------------------------------------------------------

describe('computeEscapeCapSweep', () => {
  function escRow(overrides) {
    return {
      query_id: 'q0', stratum: 's_ident', tier: 'T1', arm: 'L+D+esc', query_set: 'fresh',
      mode: 'lexical', mode_integrity_valid: true, rank: 1, hit_case: 'exact',
      suppression_event: false, censored_rank: 1, in_window_10: true, pre_dedup_rank: 1,
      escape_cap: 20,
      d_diagnostic: { fired: true, top_match_channel: 'full', candidate_count: 1, lowercase_token_match_counts: { dispose: 25, foo: 2 } },
      ...overrides,
    };
  }

  it('groups rows by whatever escape_cap values are present and reports fire rate + match-count distribution per cap', () => {
    const rows = [
      escRow({ query_id: 'q1', escape_cap: 5, d_diagnostic: { fired: false, top_match_channel: null, candidate_count: 0, lowercase_token_match_counts: { dispose: 25 } } }),
      escRow({ query_id: 'q2', escape_cap: 20, d_diagnostic: { fired: true, top_match_channel: 'full', candidate_count: 1, lowercase_token_match_counts: { foo: 2 } } }),
    ];
    const sweep = computeEscapeCapSweep(rows);
    expect(sweep.map((s) => s.escape_cap)).toEqual([5, 20]);
    const cap5 = sweep.find((s) => s.escape_cap === 5);
    expect(cap5.fire_rate_by_stratum.s_ident.pooled_fire_rate).toBe(0);
    expect(cap5.lowercase_match_count_distribution).toEqual([25]);
    const cap20 = sweep.find((s) => s.escape_cap === 20);
    expect(cap20.fire_rate_by_stratum.s_ident.pooled_fire_rate).toBe(1);
  });

  it('returns an empty array when no L+D+esc rows are present', () => {
    expect(computeEscapeCapSweep([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F-9 firewall — projection_provenance is computed ONLY from `original` rows
// and never influences the verdict-bearing block.
// ---------------------------------------------------------------------------

describe('scoreDeclex — F-9 firewall (projection_provenance uses ONLY original-set rows)', () => {
  it('an original-set-only row set produces an EMPTY fresh-set verdict (AMBIGUOUS/degenerate-shaped from zero data) while projection_provenance reports real numbers', () => {
    const originalRows = [];
    for (let i = 0; i < 4; i++) {
      originalRows.push(row({ query_id: `q${i}`, tier: 'T4', arm: 'L+D', stratum: 's_ident', query_set: 'original', in_window_10: i < 3 }));
      originalRows.push(row({ query_id: `q${i}`, tier: 'T4', arm: 'L', stratum: 's_approx', query_set: 'original', in_window_10: true }));
      originalRows.push(row({ query_id: `q${i}`, tier: 'T4', arm: 'L+D', stratum: 's_approx', query_set: 'original', in_window_10: true }));
    }
    const result = scoreDeclex(originalRows);
    expect(result.query_set_counts.fresh).toBe(0);
    expect(result.query_set_counts.original).toBe(originalRows.length);
    expect(result.efficacy.n).toBe(0); // nothing fresh to compute efficacy from

    expect(result.projection_provenance.n_original_rows).toBe(originalRows.length);
    expect(result.projection_provenance.original_400_t4_rates.s_ident_l_plus_d).toBeCloseTo(0.75, 10);
    expect(result.projection_provenance.divergence_delta.s_ident).toBeCloseTo(0.75 - F_R2_PROJECTION.t4_s_ident_in_window_rate, 10);
  });

  it('a fresh-only row set never populates projection_provenance\'s rate fields (all null, n_original_rows 0)', () => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
      const qid = `q${i}`;
      rows.push(row({ query_id: qid, tier: 'T1', arm: 'H', in_window_10: true }));
      rows.push(row({ query_id: qid, tier: 'T4', arm: 'H', in_window_10: true }));
      rows.push(row({ query_id: qid, tier: 'T1', arm: 'L', in_window_10: true }));
      rows.push(row({ query_id: qid, tier: 'T4', arm: 'L', in_window_10: false }));
      rows.push(row({ query_id: qid, tier: 'T1', arm: 'L+D', in_window_10: true, d_diagnostic: { fired: true } }));
      rows.push(row({ query_id: qid, tier: 'T4', arm: 'L+D', in_window_10: true, d_diagnostic: { fired: true } }));
    }
    const result = scoreDeclex(rows);
    expect(result.projection_provenance.n_original_rows).toBe(0);
    expect(result.projection_provenance.original_400_t4_rates.s_ident_l_plus_d).toBeNull();
    // Verdict-bearing fields must not have been perturbed by the (absent) original data.
    expect(result.verdict.verdict).toBe(VERDICTS.GAP_CLOSED_HARM_UNTESTED);
  });
});

// ---------------------------------------------------------------------------
// parseResultsFile
// ---------------------------------------------------------------------------

describe('parseResultsFile (declex 5-arm, query_set-aware schema)', () => {
  it('parses a bare array and validates every row against the schema', () => {
    const text = JSON.stringify([row({ arm: 'L+D' })]);
    const { rows, sha256 } = parseResultsFile(text);
    expect(rows).toHaveLength(1);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses a { rows: [...] } wrapper object', () => {
    const text = JSON.stringify({ rows: [row({ arm: 'H+D' })] });
    expect(parseResultsFile(text).rows).toHaveLength(1);
  });

  it('accepts all 5 registered arms', () => {
    for (const arm of ['L', 'H', 'L+D', 'H+D', 'L+D+esc']) {
      const text = JSON.stringify([row({ arm })]);
      expect(() => parseResultsFile(text)).not.toThrow();
    }
  });

  it('throws on a shape that is neither an array nor { rows }', () => {
    expect(() => parseResultsFile(JSON.stringify({ foo: 'bar' }))).toThrow();
  });

  it('throws on a row missing query_set', () => {
    const bad = row({});
    delete bad.query_set;
    expect(() => parseResultsFile(JSON.stringify([bad]))).toThrow();
  });

  it('every row it accepts also passes validateResultRow directly (shared-schema guarantee)', () => {
    const text = JSON.stringify([row({ arm: 'L+D+esc' })]);
    const { rows } = parseResultsFile(text);
    expect(() => rows.forEach(validateResultRow)).not.toThrow();
  });
});
