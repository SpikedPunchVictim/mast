// E1-AB — the scorer. Every threshold in the registration, and nothing else.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-AB PRE-REGISTRATION (2026-08-13),
// as amended by AMENDMENT 1.
//
// Known-answer tests. The two that matter most are the LAST two in the exponent
// block: a constant-factor speedup must leave the slope untouched (that property
// is the entire reason the slope replaced the degenerate Delta), and a
// size-coupled effect must move it.
//
// Run from `packages/mast`, never the repo root.

import { describe, it, expect } from 'vitest';
import {
  LEVEL_DOMINANT, LEVEL_IMPLICATED, INTERFERENCE_RATIO, CONNECTIVITY_RATIO,
  D_HELPS_ANOMALY, E1_SUPERLINEAR_THRESHOLD, SLOPE_MATERIAL_DELTA,
  RATIO_SPREAD_FINDING,
  armRatio, classifyLevel, blockSlope, armSlope, splitHalves,
  classifyExponent, classifyMechanism, scoreAb,
} from '../e1-ab-score.mjs';

/** Chunk counts fixed by E1's frozen manifest. */
const CHUNKS = { T1: 3679, T5: 16529, T9: 73359 };

/** E1-PHASE's control write times, used as this instrument's known answer. */
const CONTROL_WRITE = { T1: 1414, T5: 23725, T9: 500885 };

/**
 * Synthesise a run set: `factors[arm][tier]` multiplies the control's write.
 * Every run is gate-clean unless a test says otherwise.
 */
function makeRuns(factors, { blocks = 3 } = {}) {
  const runs = [];
  for (let block = 1; block <= blocks; block++) {
    for (const [arm, byTier] of Object.entries(factors)) {
      for (const [tier, factor] of Object.entries(byTier)) {
        runs.push({
          arm, tier, block,
          chunk_count: CHUNKS[tier],
          write_ms: CONTROL_WRITE[tier] * factor,
          duration_ms: CONTROL_WRITE[tier] * factor * 1.06,
          db_bytes: 1000,
          scoreable: true,
        });
      }
    }
  }
  return runs;
}

const allTiers = (f) => ({ T1: f, T5: f, T9: f });

describe('armRatio — the primary statistic, a within-block ratio', () => {
  it('divides each arm run by ITS OWN block\'s control run', () => {
    const runs = makeRuns({ A: allTiers(1), B: allTiers(0.5) });
    // Drift: block 3's control is 2x slower. A pooled ratio would be skewed by
    // it; a within-block ratio is not.
    for (const r of runs) if (r.block === 3) r.write_ms *= 2;

    const r = armRatio(runs, 'T9', 'B');
    expect(r.ratios).toEqual([0.5, 0.5, 0.5]);
    expect(r.median).toBe(0.5);
  });

  it('reports the spread of the three block ratios, not an interval', () => {
    const runs = makeRuns({ A: allTiers(1), B: allTiers(1) });
    runs.find((r) => r.arm === 'B' && r.tier === 'T9' && r.block === 2).write_ms *= 1.2;
    const r = armRatio(runs, 'T9', 'B');
    expect(r.median).toBe(1);
    expect(r.max - r.min).toBeCloseTo(0.2, 10);
    expect(r).not.toHaveProperty('ci');
  });

  it('flags a spread above the registered finding threshold', () => {
    const runs = makeRuns({ A: allTiers(1), B: allTiers(1) });
    runs.find((r) => r.arm === 'B' && r.tier === 'T9' && r.block === 2).write_ms *= 1.5;
    expect(armRatio(runs, 'T9', 'B').spread_finding).toBe(true);
    expect(RATIO_SPREAD_FINDING).toBe(0.15);
  });

  // AMENDMENT 1 A6: a block whose pair is incomplete is DROPPED, and the drop
  // is a finding — it is never silently treated as a missing observation.
  it('drops a block whose control is missing and records it', () => {
    const runs = makeRuns({ A: allTiers(1), B: allTiers(0.5) })
      .filter((r) => !(r.arm === 'A' && r.tier === 'T9' && r.block === 2));
    const r = armRatio(runs, 'T9', 'B');
    expect(r.ratios).toHaveLength(2);
    expect(r.blocks_dropped).toEqual([2]);
  });

  it('is VOID below two usable blocks', () => {
    const runs = makeRuns({ A: allTiers(1), B: allTiers(0.5) })
      .filter((r) => !(r.arm === 'A' && r.tier === 'T9' && r.block !== 1));
    expect(armRatio(runs, 'T9', 'B').void).toBe(true);
  });
});

describe('classifyLevel — the graded bands, with the boundaries pinned', () => {
  it('is DOMINANT at exactly the 0.20 boundary', () => {
    expect(classifyLevel(LEVEL_DOMINANT)).toBe('DOMINANT');
    expect(classifyLevel(0.2001)).toBe('PARTIAL');
  });

  it('is PARTIAL at exactly the 0.80 boundary', () => {
    expect(classifyLevel(LEVEL_IMPLICATED)).toBe('PARTIAL');
    expect(classifyLevel(0.8001)).toBe('NOT_IMPLICATED');
  });

  // AMENDMENT 1 A5: an arm that makes things WORSE was previously swept into
  // NOT_IMPLICATED, whose wording is false for it.
  it('is INTERFERENCE above 1.10, not NOT_IMPLICATED', () => {
    expect(classifyLevel(1.05)).toBe('NOT_IMPLICATED');
    expect(classifyLevel(INTERFERENCE_RATIO)).toBe('NOT_IMPLICATED');
    expect(classifyLevel(1.1001)).toBe('INTERFERENCE');
  });
});

describe('blockSlope and armSlope — the registered exponent test', () => {
  it('reproduces the control ladder\'s known slope', () => {
    const runs = makeRuns({ A: allTiers(1) });
    expect(blockSlope(runs, 'A', 1)).toBeCloseTo(1.9613, 4);
    expect(armSlope(runs, 'A').median).toBeCloseTo(1.9613, 4);
  });

  it('computes the slope WITHIN a block, so drift cannot enter it', () => {
    const runs = makeRuns({ A: allTiers(1) });
    for (const r of runs) if (r.block === 2) r.write_ms *= 3;   // whole block 3x slower
    // A uniform multiplier is an intercept shift; the slope is unchanged.
    expect(blockSlope(runs, 'A', 2)).toBeCloseTo(1.9613, 4);
  });

  // The test above passes even if the function ignores its `block` argument and
  // always reads block 1 — a uniform shift is invisible to a slope. This one
  // bends block 2's curve instead, so it fails unless the right block is read.
  // (Found by mutation-testing the suite, not by reading it.)
  it('reads the block it was asked for', () => {
    const runs = makeRuns({ A: allTiers(1) });
    runs.find((r) => r.arm === 'A' && r.tier === 'T9' && r.block === 2).write_ms *= 4;
    expect(blockSlope(runs, 'A', 2)).toBeGreaterThan(blockSlope(runs, 'A', 1) + 0.3);
  });

  // THE load-bearing property, and the reason Delta was deleted. A constant
  // factor shifts the intercept and leaves the slope EXACTLY alone, so the
  // slope moves if and only if the effect varies with size.
  it('is unchanged by a constant-factor speedup at every rung', () => {
    const runs = makeRuns({ A: allTiers(1), B: allTiers(0.5) });
    expect(armSlope(runs, 'B').median).toBeCloseTo(armSlope(runs, 'A').median, 10);
  });

  it('falls when the effect grows with size', () => {
    // Helps 0% at T1, 50% at T5, 90% at T9 — a cliff being removed.
    const runs = makeRuns({ A: allTiers(1), B: { T1: 1.0, T5: 0.5, T9: 0.1 } });
    expect(armSlope(runs, 'B').median).toBeLessThan(armSlope(runs, 'A').median - 0.5);
  });
});

describe('classifyExponent — graded against E1\'s own immutable threshold', () => {
  it('uses 1.35, the number E1 registered, not one invented here', () => {
    expect(E1_SUPERLINEAR_THRESHOLD).toBe(1.35);
    expect(SLOPE_MATERIAL_DELTA).toBe(0.20);
  });

  it('is EXPONENT_EXPLAINED strictly below 1.35', () => {
    expect(classifyExponent(1.3499, 1.96)).toBe('EXPONENT_EXPLAINED');
    expect(classifyExponent(1.35, 1.96)).toBe('EXPONENT_REDUCED');
  });

  it('is EXPONENT_REDUCED when it flattens materially but stays super-linear', () => {
    expect(classifyExponent(1.70, 1.96)).toBe('EXPONENT_REDUCED');
  });

  it('is EXPONENT_UNTOUCHED at exactly the material-delta boundary', () => {
    expect(classifyExponent(1.76, 1.96)).toBe('EXPONENT_REDUCED');   // 1.96 - 0.20
    expect(classifyExponent(1.7601, 1.96)).toBe('EXPONENT_UNTOUCHED');
  });

  // The number the level test alone could never deliver: at the CACHE-DOMINANT
  // floor the arm is still super-linear, so a level result must not be read as
  // explaining the exponent.
  it('refuses EXPONENT_EXPLAINED at the CACHE-DOMINANT level floor', () => {
    const runs = makeRuns({ A: allTiers(1), B: { T1: 1.0, T5: 1.0, T9: 0.2 } });
    const bB = armSlope(runs, 'B').median;
    expect(bB).toBeGreaterThan(E1_SUPERLINEAR_THRESHOLD);
    expect(classifyExponent(bB, armSlope(runs, 'A').median)).not.toBe('EXPONENT_EXPLAINED');
  });
});

describe('splitHalves — the curvature reading arm C\'s replacement rung buys', () => {
  it('reproduces the control\'s known split halves', () => {
    const runs = makeRuns({ A: allTiers(1) });
    const { b_lo, b_hi } = splitHalves(runs, 'A', 1);
    expect(b_lo).toBeCloseTo(1.8770, 4);
    expect(b_hi).toBeCloseTo(2.0465, 4);
  });

  it('shows a cliff being removed as a flattened UPPER half', () => {
    const runs = makeRuns({ A: allTiers(1), B: { T1: 1.0, T5: 1.0, T9: 0.2 } });
    expect(splitHalves(runs, 'B', 1).b_lo).toBeCloseTo(splitHalves(runs, 'A', 1).b_lo, 10);
    expect(splitHalves(runs, 'B', 1).b_hi).toBeLessThan(splitHalves(runs, 'A', 1).b_hi - 0.5);
  });
});

describe('classifyMechanism — the 2x2, keyed on rho_D at T1 (AMENDMENT 1 A4)', () => {
  it('reads connectivity off T1, where a 2 MiB cache raises miss volume 3.76x', () => {
    expect(CONNECTIVITY_RATIO).toBe(1.10);
    expect(D_HELPS_ANOMALY).toBe(0.90);
  });

  it('is CACHE_INERT when enlarging does not help and shrinking does not hurt', () => {
    expect(classifyMechanism({ rhoB: 0.85, rhoD_T1: 1.05 }).cell).toBe('CACHE_INERT');
  });

  it('is CACHE_SATURATED when shrinking hurts but enlarging does not help', () => {
    expect(classifyMechanism({ rhoB: 0.85, rhoD_T1: 1.10 }).cell).toBe('CACHE_SATURATED');
  });

  it('is CACHE_ASYMMETRIC when enlarging helps but shrinking is free', () => {
    const v = classifyMechanism({ rhoB: 0.50, rhoD_T1: 1.00 });
    expect(v.cell).toBe('CACHE_ASYMMETRIC');
    // The band classification still STANDS in this cell; only an anomaly is added.
    expect(v.level).toBe('PARTIAL');
  });

  it('is CACHE_IMPLICATED when both directions corroborate', () => {
    const v = classifyMechanism({ rhoB: 0.15, rhoD_T1: 1.30 });
    expect(v.cell).toBe('CACHE_IMPLICATED');
    expect(v.level).toBe('DOMINANT');
  });

  // AMENDMENT 1 A5, hole 1: an arm that makes things worse claims no cell.
  it('claims no mechanism cell when arm B interferes', () => {
    const v = classifyMechanism({ rhoB: 1.15, rhoD_T1: 1.05 });
    expect(v.cell).toBe('INTERFERENCE');
    expect(v.findings).toContain('arm_B_interference');
  });

  // AMENDMENT 1 A5, hole 2: shrinking the cache HELPING is not "shrinking is free".
  it('refuses CACHE_INERT while shrinking the cache helps', () => {
    const v = classifyMechanism({ rhoB: 0.85, rhoD_T1: 0.85 });
    expect(v.cell).not.toBe('CACHE_INERT');
    expect(v.findings).toContain('arm_D_helps_anomaly');
  });
});

describe('scoreAb — the whole verdict', () => {
  const runs = makeRuns({
    A: allTiers(1), B: allTiers(1), D: allTiers(1),
    C: { T5: 1 },
  });

  it('attaches the Gate A caveat only when nothing anywhere moved', () => {
    // AMENDMENT 1 A5, hole 3: restated in the 2x2's own terms rather than a
    // third, inconsistent partition.
    const v = scoreAb(runs);
    expect(v.mechanism.cell).toBe('CACHE_INERT');
    expect(v.gate_a_caveat_attached).toBe(true);
  });

  it('drops the Gate A caveat once any arm moved the clock', () => {
    const moved = makeRuns({
      A: allTiers(1), B: allTiers(1), D: { T1: 1.5, T5: 1, T9: 1 }, C: { T5: 1 },
    });
    const v = scoreAb(moved);
    expect(v.mechanism.cell).toBe('CACHE_SATURATED');
    expect(v.gate_a_caveat_attached).toBe(false);
  });

  it('reports arm C without letting it claim a mechanism cell', () => {
    const v = scoreAb(runs);
    expect(v.mmap.tier).toBe('T5');
    expect(v.mmap.expected_inert).toBe(true);
    expect(v.mechanism).not.toHaveProperty('mmap_cell');
  });

  it('records the contradiction when arm C moves despite the source reading', () => {
    const moved = makeRuns({
      A: allTiers(1), B: allTiers(1), D: allTiers(1), C: { T5: 0.5 },
    });
    expect(scoreAb(moved).mmap.contradicts_source_reading).toBe(true);
  });

  it('refuses to score when a run is not scoreable', () => {
    const bad = makeRuns({ A: allTiers(1), B: allTiers(1), D: allTiers(1), C: { T5: 1 } });
    bad[0].scoreable = false;
    expect(scoreAb(bad).scoreable).toBe(false);
  });
});
