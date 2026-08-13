// E1-PHASE — known-answer tests for the scoring machinery.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-PHASE PRE-REGISTRATION (2026-08-12),
// "Hypotheses and what each predicts", "Falsification criteria", and "Estimator and
// aggregation rules".
//
// This is E1's Gate 7 obligation carried forward: the registration defines a decision-bearing
// classification and would otherwise register nothing that verifies the code evaluating it —
// the `ab-score.mjs` defect class (HANDOFF §5). Every refutation condition, every boundary,
// and the registration's own worked H0 example are pinned here.
//
// The synthetic corpora below are exact by construction: a common multiplicative jitter is
// applied at EVERY rung, so `ln(jitter)` is orthogonal to `ln(chunks)` and OLS returns the
// generating exponent exactly while still leaving non-zero residual variance. That makes
// "b_write is 2.0" an assertion about the estimator rather than about a tolerance.

import { describe, it, expect } from 'vitest';
import { PHASE_TIERS } from '../e1-phase-schedule.mjs';
import {
  EXPONENT_BAR, PARSE_CEILING, WRITE_SHARE_FLOOR, E1_B,
  medianRun, fitSeries, tierShares, evaluateHypotheses, miniReplication, scoreE1Phase,
} from '../e1-phase-score.mjs';

/** The frozen manifest's chunk counts for T1, T3, T5, T7, T9. */
const CHUNKS = [3679, 7761, 16529, 34691, 73359];
const JITTER = [0.98, 1.0, 1.02];

/**
 * Build 15 runs whose phase clocks follow exact power laws.
 *
 * @param {Record<string, {b: number, at_t9: number}>} spec  exponent + T9 value per phase
 * @param {number} attribution  Sigma phase / duration, so the remainder is controllable
 */
function synth(spec, attribution = 0.999) {
  const t9 = CHUNKS[CHUNKS.length - 1];
  const runs = [];
  for (let i = 0; i < CHUNKS.length; i++) {
    for (let rep = 1; rep <= 3; rep++) {
      const j = JITTER[rep - 1];
      const phase = {};
      for (const [name, { b, at_t9 }] of Object.entries(spec)) {
        phase[name] = at_t9 * Math.pow(CHUNKS[i] / t9, b) * j;
      }
      const summed = Object.values(phase).reduce((s, v) => s + v, 0);
      runs.push({
        tier: PHASE_TIERS[i], corpus: PHASE_TIERS[i], rep, kind: 'tier',
        chunk_count: CHUNKS[i], file_count: 100 * (i + 1),
        duration_ms: summed / attribution, phase_ms: phase,
      });
    }
  }
  return runs;
}

/** H1's world: write is quadratic and dominant, everything else linear. */
const H1_SPEC = {
  walk:     { b: 1.0, at_t9: 10_000 },
  parse:    { b: 1.0, at_t9: 250_000 },
  write:    { b: 2.0, at_t9: 700_000 },
  edges:    { b: 1.0, at_t9: 30_000 },
  finalise: { b: 1.0, at_t9: 10_000 },
};

/** The registration's own worked H0 example: write at b = 3.0 but only a 45% T9 share. */
const H0_SPEC = {
  walk:     { b: 1.0, at_t9: 15_000 },
  parse:    { b: 1.0, at_t9: 500_000 },
  write:    { b: 3.0, at_t9: 450_000 },
  edges:    { b: 1.0, at_t9: 20_000 },
  finalise: { b: 1.0, at_t9: 15_000 },
};

/** Everything linear — nothing reaches the bar. */
const H4_SPEC = {
  walk:     { b: 1.0, at_t9: 10_000 },
  parse:    { b: 1.1, at_t9: 400_000 },
  write:    { b: 1.2, at_t9: 500_000 },
  edges:    { b: 1.0, at_t9: 60_000 },
  finalise: { b: 1.0, at_t9: 30_000 },
};

/** The five per-rung values a hypothesis evaluation needs, with sensible defaults. */
const hyp = (over = {}) => evaluateHypotheses({
  b: { walk: 1.0, parse: 1.0, write: 2.0, edges: 1.0, finalise: 1.0 },
  writeShareT9: 0.70,
  edgeMedianShares: [0.05, 0.04, 0.03, 0.02, 0.01],
  ...over,
});

describe('medianRun — "share at T9 is computed from T9\'s median run"', () => {
  it('picks the middle run by the fitted clock, not the mean and not a pooled ratio', () => {
    const runs = [{ duration_ms: 300, rep: 1 }, { duration_ms: 100, rep: 2 }, { duration_ms: 200, rep: 3 }];

    expect(medianRun(runs).rep).toBe(3);
  });

  it('is insensitive to the order the repetitions were journalled in', () => {
    const a = [{ duration_ms: 1, rep: 1 }, { duration_ms: 9, rep: 2 }, { duration_ms: 5, rep: 3 }];
    const b = [{ duration_ms: 9, rep: 2 }, { duration_ms: 5, rep: 3 }, { duration_ms: 1, rep: 1 }];

    expect(medianRun(a)).toEqual(medianRun(b));
  });

  it('refuses an even sample rather than inventing a run between two', () => {
    // Three repetitions are registered; an even count means a rep was voided, and averaging
    // two runs' phase maps would fabricate a decomposition no run ever produced.
    expect(() => medianRun([{ duration_ms: 1 }, { duration_ms: 2 }])).toThrow(/even sample/i);
  });

  it('refuses an empty sample', () => {
    expect(() => medianRun([])).toThrow(/empty/i);
  });
});

describe('fitSeries — OLS of ln(phase_ms) on ln(chunk_count)', () => {
  const runs = synth(H1_SPEC);

  it('recovers a quadratic phase exponent exactly', () => {
    expect(fitSeries(runs, (r) => r.phase_ms.write).b).toBeCloseTo(2.0, 10);
  });

  it('recovers a linear phase exponent exactly', () => {
    expect(fitSeries(runs, (r) => r.phase_ms.parse).b).toBeCloseTo(1.0, 10);
  });

  it('fits all fifteen runs, not the five tier means', () => {
    expect(fitSeries(runs, (r) => r.phase_ms.write).n).toBe(15);
  });

  it('reports an HC3 interval around the point estimate', () => {
    const f = fitSeries(runs, (r) => r.phase_ms.write);

    expect(f.ci_hc3[0]).toBeLessThan(f.b);
    expect(f.ci_hc3[1]).toBeGreaterThan(f.b);
  });

  it('refuses to take ln of a non-positive value, naming the offending runs', () => {
    const bad = synth(H1_SPEC);
    bad[7].phase_ms.write = 0;

    const f = fitSeries(bad, (r) => r.phase_ms.write);

    expect(f.degenerate).toBe('non_positive_values');
    expect(f.b).toBeUndefined();
  });

  it('refuses a zero-residual fit — a zero-width interval is degeneracy, not precision', () => {
    // `y === x` bit-for-bit, so slope is exactly 1, intercept exactly 0, residuals exactly 0.
    // The guard matches `fitOne`'s committed `sse === 0`; it is not a tolerance, because a
    // tolerance is a free threshold and this instrument registers none.
    expect(fitSeries(runs, (r) => r.chunk_count).degenerate).toBe('zero_residual_variance');
  });
});

describe('tierShares — per-rung decomposition', () => {
  const runs = synth(H1_SPEC);

  it('reports the rungs in ladder order, never sorted lexically', () => {
    expect(tierShares(runs).map((t) => t.tier)).toEqual(PHASE_TIERS);
  });

  it('computes the T9 write share from T9\'s median run', () => {
    const t9 = tierShares(runs).at(-1);

    // 700,000 of a 1,000,000 ms phase sum, at 99.9% attribution.
    expect(t9.median_run.write).toBeCloseTo(0.7 * 0.999, 10);
  });

  it('also reports the median OF the three per-run shares, which H2 monotonicity reads', () => {
    const t9 = tierShares(runs).at(-1);

    // Jitter is common to every phase, so both readings coincide here by construction —
    // which is exactly why both are published: on real data they need not.
    expect(t9.median_of_shares.write).toBeCloseTo(t9.median_run.write, 10);
  });

  it('carries the unattributed remainder as a share of its own', () => {
    const t9 = tierShares(runs).at(-1);

    expect(t9.median_run.remainder).toBeCloseTo(0.001, 10);
  });
});

describe('evaluateHypotheses — H1, write-localised', () => {
  it('fires when all three registered conditions hold', () => {
    const r = hyp();

    expect(r.H1.fires).toBe(true);
    expect(r.fired).toEqual(['H1']);
  });

  it('fires exactly at every boundary — the registered comparisons are >=, <=, >=', () => {
    const r = hyp({
      b: { walk: 1, parse: PARSE_CEILING, write: EXPONENT_BAR, edges: 1, finalise: 1 },
      writeShareT9: WRITE_SHARE_FLOOR,
    });

    expect(r.H1.fires).toBe(true);
  });

  it('is refuted when b_write falls below the bar', () => {
    const r = hyp({ b: { walk: 1, parse: 1, write: 1.5999, edges: 1, finalise: 1 } });

    expect(r.H1.fires).toBe(false);
    expect(r.H1.refuted_by).toContain('b_write');
  });

  it('is refuted when parse exceeds its ceiling, even with write carrying the exponent', () => {
    const r = hyp({ b: { walk: 1, parse: 1.2501, write: 2.0, edges: 1, finalise: 1 } });

    expect(r.H1.fires).toBe(false);
    expect(r.H1.refuted_by).toContain('b_parse');
  });

  it('is refuted on the share condition alone — the one substantively free condition', () => {
    const r = hyp({ writeShareT9: 0.5999 });

    expect(r.H1.fires).toBe(false);
    expect(r.H1.refuted_by).toEqual(['write_share_t9']);
  });

  it('records every condition with its value, so a near-miss is auditable', () => {
    expect(hyp().H1.conditions.map((c) => c.name))
      .toEqual(['b_write', 'b_parse', 'write_share_t9']);
  });
});

describe('evaluateHypotheses — H2, edge/symbol resolution', () => {
  it('fires on a high edge exponent with strictly rising shares', () => {
    const r = hyp({
      b: { walk: 1, parse: 1, write: 1.0, edges: 1.8, finalise: 1 },
      edgeMedianShares: [0.01, 0.02, 0.03, 0.04, 0.05],
      writeShareT9: 0.2,
    });

    expect(r.H2.fires).toBe(true);
  });

  it('is refuted by a tie — the registered monotonicity is strict', () => {
    const r = hyp({
      b: { walk: 1, parse: 1, write: 1.0, edges: 1.8, finalise: 1 },
      edgeMedianShares: [0.01, 0.02, 0.02, 0.04, 0.05],
      writeShareT9: 0.2,
    });

    expect(r.H2.fires).toBe(false);
    expect(r.H2.refuted_by).toContain('edge_share_monotonic');
  });

  it('is refuted by a low edge exponent even when shares rise perfectly', () => {
    const r = hyp({ edgeMedianShares: [0.01, 0.02, 0.03, 0.04, 0.05] });

    expect(r.H2.fires).toBe(false);
    expect(r.H2.refuted_by).toContain('b_edges');
  });

  it('can fire alongside H1 — the registration says both firing is a reportable outcome', () => {
    const r = hyp({
      b: { walk: 1, parse: 1, write: 2.0, edges: 1.8, finalise: 1 },
      edgeMedianShares: [0.01, 0.02, 0.03, 0.04, 0.05],
    });

    expect(r.fired).toEqual(['H1', 'H2']);
  });
});

describe('evaluateHypotheses — H3, H4 and the H0 residual', () => {
  it('fires H3 when parse itself reaches the bar', () => {
    const r = hyp({ b: { walk: 1, parse: 1.7, write: 1.0, edges: 1, finalise: 1 }, writeShareT9: 0.2 });

    expect(r.H3.fires).toBe(true);
    expect(r.H1.fires).toBe(false);       // mutually exclusive by construction
  });

  it('fires H4 when no phase reaches the bar', () => {
    const r = hyp({ b: { walk: 1.0, parse: 1.1, write: 1.2, edges: 1.0, finalise: 1.5 }, writeShareT9: 0.4 });

    expect(r.H4.fires).toBe(true);
    expect(r.fired).toEqual(['H4']);
  });

  it('does not fire H4 when any single phase reaches the bar, however small its share', () => {
    const r = hyp({ b: { walk: 1.0, parse: 1.0, write: 1.0, edges: 1.0, finalise: 1.6 }, writeShareT9: 0.3 });

    expect(r.H4.fires).toBe(false);
  });

  it('fires H0 on the registration\'s own worked example: b_write 3.0 at a 45% share', () => {
    const r = hyp({ b: { walk: 1, parse: 1, write: 3.0, edges: 1, finalise: 1 }, writeShareT9: 0.45 });

    expect(r.fired).toEqual([]);
    expect(r.H0.fires).toBe(true);
    expect(r.outcome).toBe('H0');
  });

  it('routes H0 to H4\'s escalation, as registered — never to a narrower story', () => {
    const r = hyp({ b: { walk: 1, parse: 1, write: 3.0, edges: 1, finalise: 1 }, writeShareT9: 0.45 });

    expect(r.H0.escalates_as).toBe('H4');
    expect(r.next_step).toMatch(/statement-level profiling/i);
  });

  it('refuses to classify when a phase exponent is missing rather than assuming it failed', () => {
    expect(() => hyp({ b: { walk: 1, parse: 1, write: null, edges: 1, finalise: 1 } }))
      .toThrow(/write/);
  });
});

describe('miniReplication — the free confirmatory signal', () => {
  const durations = (b) => {
    const runs = [];
    for (let i = 0; i < CHUNKS.length; i++) {
      for (let rep = 1; rep <= 3; rep++) {
        runs.push({
          tier: PHASE_TIERS[i], chunk_count: CHUNKS[i],
          duration_ms: 20 + 0.001 * Math.pow(CHUNKS[i], b) * JITTER[rep - 1],
        });
      }
    }
    return runs;
  };

  it('is "consistent" iff its 95% HC3 interval covers E1\'s 1.7529', () => {
    const r = miniReplication(durations(E1_B), { c: 20, B: 200 });

    expect(r.b).toBeCloseTo(E1_B, 3);
    expect(r.consistent_with_e1).toBe(true);
  });

  it('is not consistent when the interval misses, and says so without adjudicating E1', () => {
    const r = miniReplication(durations(1.0), { c: 20, B: 200 });

    expect(r.consistent_with_e1).toBe(false);
    expect(r.adjudicates).toBe(false);
  });

  it('subtracts the calibration constant — an omitted c biases b downward, toward HOLDS', () => {
    const withC = miniReplication(durations(E1_B), { c: 20, B: 200 });
    const withoutC = miniReplication(durations(E1_B), { c: 0, B: 200 });

    expect(withC.b).not.toBeCloseTo(withoutC.b, 6);
  });

  it('refuses an unpassed calibration constant — A4-MAT-1\'s defect class', () => {
    expect(() => miniReplication(durations(E1_B), { B: 200 })).toThrow(/c/);
  });
});

describe('scoreE1Phase — the whole instrument on synthetic ladders', () => {
  it('classifies a write-localised ladder as H1', () => {
    const r = scoreE1Phase(synth(H1_SPEC), { c: 20, B: 200 });

    expect(r.hypotheses.outcome).toBe('H1');
    expect(r.exponents.write.b).toBeCloseTo(2.0, 10);
    expect(r.exponents.parse.b).toBeCloseTo(1.0, 10);
  });

  it('classifies a flat ladder as H4', () => {
    expect(scoreE1Phase(synth(H4_SPEC), { c: 20, B: 200 }).hypotheses.outcome).toBe('H4');
  });

  it('classifies the registration\'s worked counterexample as H0, not as H1', () => {
    const r = scoreE1Phase(synth(H0_SPEC), { c: 20, B: 200 });

    expect(r.hypotheses.outcome).toBe('H0');
    expect(r.hypotheses.H1.refuted_by).toEqual(['write_share_t9']);
  });

  it('fits the unattributed remainder as a sixth series', () => {
    const runs = synth(H1_SPEC);

    // The synthetic remainder is a FIXED FRACTION of the clock, so it must carry the clock's
    // own exponent exactly — which is a mixture (~1.36 here), not write's 2.0.
    expect(scoreE1Phase(runs, { c: 20, B: 200 }).exponents.remainder.b)
      .toBeCloseTo(fitSeries(runs, (r) => r.duration_ms).b, 10);
  });

  it('raises a finding when the remainder exceeds 2% at any rung', () => {
    const r = scoreE1Phase(synth(H1_SPEC, 0.97), { c: 20, B: 200 });

    expect(r.findings.some((f) => /remainder/i.test(f))).toBe(true);
  });

  it('raises no remainder finding at T1\'s measured 0.09%', () => {
    const r = scoreE1Phase(synth(H1_SPEC, 0.9991), { c: 20, B: 200 });

    expect(r.findings.some((f) => /remainder/i.test(f))).toBe(false);
  });

  it('voids the instrument when walk exceeds 10% of the clock at T9', () => {
    const spec = { ...H1_SPEC, walk: { b: 1.0, at_t9: 300_000 } };

    const r = scoreE1Phase(synth(spec), { c: 20, B: 200 });

    expect(r.void).toBe(true);
    expect(r.void_reason).toMatch(/walk/i);
  });

  it('refuses a ladder that is not the five registered rungs', () => {
    const short = synth(H1_SPEC).filter((r) => r.tier !== 'T5');

    expect(() => scoreE1Phase(short, { c: 20, B: 200 })).toThrow(/rung/i);
  });

  it('refuses a rung with the wrong number of repetitions', () => {
    const runs = synth(H1_SPEC);
    runs.push({ ...runs[0], rep: 4 });

    expect(() => scoreE1Phase(runs, { c: 20, B: 200 })).toThrow(/repetition/i);
  });
});
