// Unit tests for eval/idfuse-score.mjs — the Q1/IDFUSE amended-table scorer.
// Ships BEFORE any real data touches it, per the registration's Gate B/Gate 1
// discipline this program follows throughout (HANDOFF_Q1.md §5's ab-score.mjs
// defect — a registered-but-never-implemented statistical test — must not
// repeat for the amended decision table either).
//
// Two test styles, matching the parent's own precedent
// (eval/__tests__/scale-score.test.mjs): `evaluateVerdict` is tested with
// DIRECTLY CONSTRUCTED wilcoxon-shaped/CI objects (fast, precise, exactly hits
// each threshold — the parent's own test file does the same for its
// evaluateVerdict, e.g. `bcaDeltaCI: { lo: -0.5, hi: -0.1 }` as a literal);
// `scoreIdfuse` is tested end-to-end with small hand-built ResultRow arrays to
// verify the D_loss / Delta' / efficacy plumbing wiring itself.
//
//   pnpm -F mast test

import { describe, it, expect } from 'vitest';
import { evaluateVerdict, scoreIdfuse, parseResultsFile, VERDICTS, PRECISION_FLOOR_PP } from '../idfuse-score.mjs';
import { validateResultRow } from '../idfuse-rank-check.mjs';

// ---------------------------------------------------------------------------
// evaluateVerdict — constructed wilcoxon/CI inputs, one test per registered
// verdict row + the efficacy 2x2 gate + the symmetric consistency triggers.
// ---------------------------------------------------------------------------

function wilcoxon(overrides) {
  return { significant: false, direction: 'zero', degenerate: false, p: 1, ...overrides };
}

describe('evaluateVerdict — efficacy PASSES branch (registered 5-row table)', () => {
  const efficacyPasses = { lo: 0.1, hi: 0.3 };

  it('row 1: not significant AND CI upper <= 5pp -> GAP CLOSED', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
    });
    expect(result.base_row).toBe(1);
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED);
    expect(result.escalated_to_ambiguous).toBe(false);
  });

  it('degenerate Wilcoxon (all-zero Delta\', perfect closure) counts as "not significant" for row 1 (AMENDMENT 1 F5b)', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false, degenerate: true, p: null }),
      bcaDeltaCI: { lo: 0, hi: 0 },
    });
    expect(result.base_row).toBe(1);
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED);
  });

  it('row 2: significant in the REVERSE direction -> GAP CLOSED, a fortiori (AMENDMENT 1 F5a)', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'negative', p: 0.001 }),
      bcaDeltaCI: { lo: -0.5, hi: -0.1 },
    });
    expect(result.base_row).toBe(2);
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED_A_FORTIORI);
  });

  it('row 3: significant, L+I degrades more, CI upper > 5pp -> GAP SURVIVES', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'positive', p: 0.001 }),
      bcaDeltaCI: { lo: 0.1, hi: 0.3 },
    });
    expect(result.base_row).toBe(3);
    expect(result.verdict).toBe(VERDICTS.GAP_SURVIVES);
  });

  it('row 4: significant, L+I degrades more, CI upper <= 5pp -> GAP SURVIVES (marginal, sub-precision-floor) (AMENDMENT 1 F4)', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'positive', p: 0.02 }),
      bcaDeltaCI: { lo: 0.01, hi: 0.04 },
    });
    expect(result.base_row).toBe(4);
    expect(result.verdict).toBe(VERDICTS.GAP_SURVIVES_MARGINAL);
  });

  it('row 5: neither the closed nor the survives condition is met -> AMBIGUOUS', () => {
    // significant + positive direction but a null CI (e.g. a degenerate/empty
    // bootstrap) matches neither row 3 nor row 4's CI-based conditions.
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'positive', p: 0.03 }),
      bcaDeltaCI: { lo: null, hi: null },
    });
    expect(result.base_row).toBe(5);
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
  });

  it('the 5pp precision floor constant matches the registration (not the parent\'s 10pp)', () => {
    expect(PRECISION_FLOOR_PP).toBe(0.05);
  });
});

describe('evaluateVerdict — efficacy 2x2 precondition gate (AMENDMENT 1, F2)', () => {
  const efficacyFails = { lo: -0.01, hi: 0.03 }; // includes 0

  it('efficacy FAILS + Delta\' meets the GAP CLOSED criteria -> AMBIGUOUS (the registered collision cell, NOT a false GAP SURVIVES)', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyFails,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.01, hi: 0.02 }, // meets row-1 criteria
    });
    expect(result.efficacy.passes).toBe(false);
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
    expect(result.reasoning.some((r) => r.includes('collision'))).toBe(true);
  });

  it('efficacy FAILS + Delta\' does NOT meet the GAP CLOSED criteria -> INERT-LEVER', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyFails,
      wilcoxon: wilcoxon({ significant: true, direction: 'positive', p: 0.001 }),
      bcaDeltaCI: { lo: 0.1, hi: 0.3 }, // GAP SURVIVES shape, not closure
    });
    expect(result.verdict).toBe(VERDICTS.INERT_LEVER);
  });

  it('efficacy FAILS + Delta\' is a-fortiori-shaped -> AMBIGUOUS, not INERT-LEVER (documented judgment call: a-fortiori counts as "meets closed criteria")', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyFails,
      wilcoxon: wilcoxon({ significant: true, direction: 'negative', p: 0.001 }),
      bcaDeltaCI: { lo: -0.5, hi: -0.1 },
    });
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
  });

  it('efficacy exactly at the boundary (lo=0) FAILS (strict > 0 required, matching the registration\'s own k=3 knife-edge example, F2)', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: { lo: 0, hi: 0.05 },
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.01, hi: 0.02 },
    });
    expect(result.efficacy.passes).toBe(false);
  });

  it('a reverse-significant efficacy CI (ranker I significantly HURTS lexical) is reported explicitly, not silently treated as a pass', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: { lo: -0.3, hi: -0.05 },
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.01, hi: 0.02 },
    });
    expect(result.efficacy.passes).toBe(false);
    expect(result.efficacy.reverse_significant).toBe(true);
    expect(result.reasoning.some((r) => r.includes('REVERSE direction'))).toBe(true);
  });
});

describe('evaluateVerdict — symmetric consistency triggers (both directions, the Q1/SCALE F-R3 lesson)', () => {
  const efficacyPasses = { lo: 0.1, hi: 0.3 };

  it('trigger (closure direction): a supporting cell shows L+I significantly WORSE than H while the decision test closed -> escalate to AMBIGUOUS', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 }, // would be GAP CLOSED alone
      supportingCIs: [{ name: 's_approx', lo: 0.05, hi: 0.15 }], // excludes 0, worse direction
    });
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
    expect(result.escalated_to_ambiguous).toBe(true);
  });

  it('trigger (survives direction): a supporting cell shows L+I significantly BETTER than H while the decision test survived -> escalate to AMBIGUOUS', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: true, direction: 'positive', p: 0.001 }),
      bcaDeltaCI: { lo: 0.1, hi: 0.3 }, // would be GAP SURVIVES alone
      supportingCIs: [{ name: 's_prose', lo: -0.2, hi: -0.05 }], // excludes 0, better direction
    });
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
    expect(result.escalated_to_ambiguous).toBe(true);
  });

  it('the Delta-log2(rank) co-metric participates in the same trigger as the supporting strata', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      deltaLog2CI: { lo: 0.2, hi: 0.6 }, // excludes 0, worse direction
    });
    expect(result.verdict).toBe(VERDICTS.AMBIGUOUS);
    expect(result.escalated_to_ambiguous).toBe(true);
  });

  it('a supporting cell CI that INCLUDES 0 does not trigger escalation', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      supportingCIs: [{ name: 's_approx', lo: -0.05, hi: 0.05 }],
    });
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED);
    expect(result.escalated_to_ambiguous).toBe(false);
  });

  it('monotonicity flags are reported but do NOT alone force AMBIGUOUS', () => {
    const result = evaluateVerdict({
      efficacyBcaCI: efficacyPasses,
      wilcoxon: wilcoxon({ significant: false }),
      bcaDeltaCI: { lo: -0.02, hi: 0.03 },
      monotonicityFlags: [{ tier: 'T2', arm: 'L+I', outsideEnvelope: true }],
    });
    expect(result.verdict).toBe(VERDICTS.GAP_CLOSED);
    expect(result.reasoning.some((r) => r.includes('Monotonicity'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scoreIdfuse — end-to-end D_loss / Delta' / efficacy plumbing over small
// hand-built ResultRow arrays (mirrors scale-score.test.mjs's scoreStratum test).
// ---------------------------------------------------------------------------

function row(overrides) {
  return {
    query_id: 'q0', stratum: 's_ident', tier: 'T1', arm: 'H',
    mode: 'hybrid', mode_integrity_valid: true, rank: 1, hit_case: 'exact',
    suppression_event: false, censored_rank: 1, in_window_10: true, pre_dedup_rank: 1,
    ...overrides,
  };
}

describe('scoreIdfuse — plumbing over a small synthetic 10-query set', () => {
  // 10 queries, S-ident only (S-approx/S-prose intentionally empty — verifies
  // the supporting-stratum code path degrades to a null CI rather than
  // crashing on an empty array).
  //
  //   H:   in_window@10 at T1 AND T4 -> D_loss_H = 0 for every query.
  //   L:   in_window@10 at T1, NOT at T4 -> D_loss_L = 1 for every query
  //        (lexical degrades on all 10 — a strong, unambiguous efficacy signal).
  //   L+I: in_window@10 at T1 AND T4 -> D_loss_{L+I} = 0 for every query
  //        (ranker I fully rescues the lexical degradation).
  //
  // Efficacy (L+I vs L @ T4): L+I=true, L=false for every query -> diff=1 x10
  // -> maximally significant, BCa CI collapses to a point at 1 (constant
  // array) -> clearly PASSES.
  // Delta' (L+I vs H, D_loss): 0 - 0 = 0 for every query -> degenerate
  // Wilcoxon, BCa CI collapses to 0 -> meets the row-1 GAP CLOSED criteria.
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const qid = `q${i}`;
    rows.push(row({ query_id: qid, tier: 'T1', arm: 'H', in_window_10: true }));
    rows.push(row({ query_id: qid, tier: 'T4', arm: 'H', in_window_10: true }));
    rows.push(row({ query_id: qid, tier: 'T1', arm: 'L', in_window_10: true }));
    rows.push(row({ query_id: qid, tier: 'T4', arm: 'L', in_window_10: false }));
    rows.push(row({ query_id: qid, tier: 'T1', arm: 'L+I', in_window_10: true }));
    rows.push(row({ query_id: qid, tier: 'T4', arm: 'L+I', in_window_10: true }));
  }

  it('computes a strongly-passing efficacy signal from the L+I vs L @ T4 diffs', () => {
    const result = scoreIdfuse(rows);
    expect(result.efficacy.n).toBe(10);
    expect(result.efficacy.bca_ci.thetaHat).toBeCloseTo(1, 10);
    expect(result.efficacy.bca_ci.lo).toBeGreaterThan(0);
  });

  it('computes a perfectly-closed Delta\' (L+I matches H exactly, D_loss both 0) -> degenerate Wilcoxon, zero-width CI', () => {
    const result = scoreIdfuse(rows);
    expect(result.decision_bearing.n).toBe(10);
    expect(result.decision_bearing.wilcoxon.degenerate).toBe(true);
    expect(result.decision_bearing.bca_delta_ci.thetaHat).toBeCloseTo(0, 10);
  });

  it('supporting strata degrade to a null CI (not a crash) when no rows exist for them', () => {
    const result = scoreIdfuse(rows);
    expect(result.supporting.s_approx.n).toBe(0);
    expect(result.supporting.s_approx.bca_delta_ci.lo).toBeNull();
    expect(result.supporting.s_prose.n).toBe(0);
  });

  it('descriptive-only arms (H+I, L+Isym) compute without error and are excluded from the verdict', () => {
    const result = scoreIdfuse(rows);
    expect(result.descriptive_only.h_plus_i.n).toBe(0); // no H+I rows in this fixture
    expect(result.descriptive_only.l_plus_isym.n).toBe(0);
    expect(result.verdict.verdict).toBe(VERDICTS.GAP_CLOSED);
  });

  it('the full pipeline reaches GAP CLOSED given this efficacy-passes + perfect-closure fixture', () => {
    const result = scoreIdfuse(rows);
    expect(result.verdict.efficacy.passes).toBe(true);
    expect(result.verdict.verdict).toBe(VERDICTS.GAP_CLOSED);
  });

  it('throws via validateResultRow on a malformed row rather than silently producing NaN', () => {
    const badRows = [...rows, row({ query_id: 'bad', arm: 'V' })];
    expect(() => scoreIdfuse(badRows)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseResultsFile — same shared-schema guarantee as the parent's own test
// (scale-score.test.mjs), validated against the 5-arm validateResultRow here.
// ---------------------------------------------------------------------------

describe('parseResultsFile (idfuse 5-arm schema)', () => {
  it('parses a bare array and validates every row against the 5-arm schema', () => {
    const text = JSON.stringify([row({ arm: 'L+I' })]);
    const { rows, sha256 } = parseResultsFile(text);
    expect(rows).toHaveLength(1);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses a { rows: [...] } wrapper object', () => {
    const text = JSON.stringify({ rows: [row({ arm: 'H+I' })] });
    expect(parseResultsFile(text).rows).toHaveLength(1);
  });

  it('accepts all 5 registered arms, including the 3 new ones the parent\'s validator would reject', () => {
    for (const arm of ['L', 'H', 'L+I', 'H+I', 'L+Isym']) {
      const text = JSON.stringify([row({ arm })]);
      expect(() => parseResultsFile(text)).not.toThrow();
    }
  });

  it('throws on a shape that is neither an array nor { rows }', () => {
    expect(() => parseResultsFile(JSON.stringify({ foo: 'bar' }))).toThrow();
  });

  it('every row it accepts also passes validateResultRow directly (shared-schema guarantee)', () => {
    const text = JSON.stringify([row({ arm: 'L+Isym' })]);
    const { rows } = parseResultsFile(text);
    expect(() => rows.forEach(validateResultRow)).not.toThrow();
  });
});
