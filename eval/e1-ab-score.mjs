// E1-AB — the scorer. Every registered threshold lives here and nowhere else.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-AB PRE-REGISTRATION (2026-08-13),
// as amended by AMENDMENT 1 (2026-08-13, pre-run, post-adversarial-review).
//
// Two deliberate absences, both registered:
//
// 1. NO confidence intervals, no HC3, no bootstrap. Three blocks is three
//    numbers; an interval computed from them would be decoration, and the
//    E1-PHASE record already contains one case (`b_edges`, HC3 touching 1.6)
//    where a printed interval invited an argument the registration had to
//    refuse. The SPREAD of the three block values is reported instead.
// 2. NO `Delta = rho_B(T1) - rho_B(T9)`. It was registered and then deleted as
//    degenerate: every mechanism predicts `rho_B(T1) ~ 1`, so it fired toward
//    the investigator's prior almost whenever it was consulted. The per-arm
//    SLOPE replaces it, and is non-degenerate for a reason that needs no
//    threshold to be true: a constant-factor speedup shifts the intercept and
//    leaves the slope exactly unchanged, so the slope moves if and only if the
//    effect varies with size.
//
// Run from `packages/mast`, never the repo root.

import { median } from './e1-schedule.mjs';
import { olsFit } from './e1-stats.mjs';
import { AB_TIERS, AB_BLOCKS } from './e1-ab-schedule.mjs';

// ---------------------------------------------------------------------------
// Registered constants. Changing any of these changes the experiment.
// ---------------------------------------------------------------------------

/** `rho_B <= 0.20`: the cache accounts for >=80% of write time at T9. */
export const LEVEL_DOMINANT = 0.20;

/** `rho_B <= 0.80`: materially involved. Above it, a 64x enlargement buys <20%. */
export const LEVEL_IMPLICATED = 0.80;

/** Above this an arm made things WORSE and claims no mechanism cell (AMENDMENT 1 A5). */
export const INTERFERENCE_RATIO = 1.10;

/** `rho_D(T1) >= 1.10`: the lever is connected. Read at T1, not T9 (AMENDMENT 1 A4). */
export const CONNECTIVITY_RATIO = 1.10;

/** `rho_D(T1) <= 0.90`: shrinking the cache HELPED, which is not "shrinking is free". */
export const D_HELPS_ANOMALY = 0.90;

/**
 * E1's own pre-registered, immutable super-linearity threshold.
 *
 * Reused deliberately rather than inventing a bar for this experiment: below it,
 * write is not super-linear *by this program's standing definition*, which is a
 * claim the program has already committed to and cannot renegotiate here.
 */
export const E1_SUPERLINEAR_THRESHOLD = 1.35;

/**
 * How far below the control's slope counts as "materially flatter".
 *
 * Propagating E1-PHASE's own within-rung spreads (T1 8.63%, T9 1.50%) through
 * the endpoint leverages, with a median of three blocks, gives a slope sigma of
 * ~0.0085 — so this bar is ~20 sigma. Left deliberately blunt because that sigma
 * is estimated from within-session repetitions and this schedule runs ~87
 * minutes; a marginal call decided by an unvalidated noise model is worse than a
 * bar that can only fire on an obvious effect.
 */
export const SLOPE_MATERIAL_DELTA = 0.20;

/** Reported as a finding, never a gate. */
export const RATIO_SPREAD_FINDING = 0.15;
export const SLOPE_SPREAD_FINDING = 0.20;

/** Below two usable blocks an arm's ratio is VOID rather than a median of one. */
export const MIN_USABLE_BLOCKS = 2;

// ---------------------------------------------------------------------------
// The primary statistic
// ---------------------------------------------------------------------------

const pick = (runs, arm, tier, block) =>
  runs.find((r) => r.arm === arm && r.tier === tier && r.block === block);

/**
 * The primary statistic: `median over blocks of write_ms(X) / write_ms(A)`, at
 * one rung, with both runs drawn from the SAME block.
 *
 * Within-block is the whole point — an arm and the control it is divided by must
 * be adjacent in time for machine drift to cancel. A block missing either half
 * is DROPPED and recorded (AMENDMENT 1 A6); it is never silently treated as an
 * absent observation, because the pairing IS the estimator here in a way it was
 * not for E1-PHASE's fits.
 *
 * @param {object[]} runs
 * @param {string} tier
 * @param {string} arm  the numerator arm; 'A' is the denominator by definition
 * @param {string} [metric] 'write_ms' (registered primary) or 'duration_ms'
 */
export function armRatio(runs, tier, arm, metric = 'write_ms') {
  const ratios = [];
  const blocksDropped = [];
  for (let block = 1; block <= AB_BLOCKS; block++) {
    const num = pick(runs, arm, tier, block);
    const den = pick(runs, 'A', tier, block);
    if (num === undefined || den === undefined || !(den[metric] > 0)) {
      blocksDropped.push(block);
      continue;
    }
    ratios.push(num[metric] / den[metric]);
  }
  if (ratios.length < MIN_USABLE_BLOCKS) {
    return { arm, tier, metric, ratios, blocks_dropped: blocksDropped, void: true,
             median: null, min: null, max: null, spread: null, spread_finding: false };
  }
  const min = Math.min(...ratios);
  const max = Math.max(...ratios);
  return {
    arm, tier, metric, ratios,
    blocks_dropped: blocksDropped,
    void: false,
    median: median(ratios),
    min, max,
    spread: max - min,
    spread_finding: max - min > RATIO_SPREAD_FINDING,
  };
}

/** The graded bands. Boundaries are inclusive downward, as registered. */
export function classifyLevel(rho) {
  if (rho > INTERFERENCE_RATIO) return 'INTERFERENCE';
  if (rho <= LEVEL_DOMINANT) return 'DOMINANT';
  if (rho <= LEVEL_IMPLICATED) return 'PARTIAL';
  return 'NOT_IMPLICATED';
}

// ---------------------------------------------------------------------------
// The exponent test
// ---------------------------------------------------------------------------

/**
 * One arm's write-phase slope within one block: OLS of `ln(write_ms)` on
 * `ln(chunk_count)` across T1, T5, T9.
 *
 * Computed WITHIN a block for the same reason the ratio is: it keeps drift out.
 * Note the midpoint carries only 0.09% of this fit's leverage against 33.5% at
 * each endpoint, so T5 is here for the curvature reading and the dose-response
 * curve, NOT for slope precision — on E1-PHASE's control data the three-point
 * slope is 1.9613 against the two-point 1.9614. That is stated in the
 * registration and repeated here so nobody reads T5 as buying accuracy it does
 * not buy.
 */
export function blockSlope(runs, arm, block) {
  const xs = [];
  const ys = [];
  for (const tier of AB_TIERS) {
    const r = pick(runs, arm, tier, block);
    if (r === undefined || !(r.write_ms > 0)) return null;
    xs.push(Math.log(r.chunk_count));
    ys.push(Math.log(r.write_ms));
  }
  return olsFit(xs, ys).slope;
}

/** Median of the per-block slopes, with their spread reported as a finding. */
export function armSlope(runs, arm) {
  const slopes = [];
  for (let block = 1; block <= AB_BLOCKS; block++) {
    const s = blockSlope(runs, arm, block);
    if (s !== null) slopes.push(s);
  }
  if (slopes.length < MIN_USABLE_BLOCKS) {
    return { arm, slopes, void: true, median: null, spread: null, spread_finding: false };
  }
  const spread = Math.max(...slopes) - Math.min(...slopes);
  return {
    arm, slopes, void: false,
    median: median(slopes),
    spread,
    spread_finding: spread > SLOPE_SPREAD_FINDING,
  };
}

/**
 * The registered exponent classification.
 *
 * @param {number} bB arm B's median block slope
 * @param {number} bA the control's
 */
export function classifyExponent(bB, bA) {
  if (bB < E1_SUPERLINEAR_THRESHOLD) return 'EXPONENT_EXPLAINED';
  if (bB <= bA - SLOPE_MATERIAL_DELTA) return 'EXPONENT_REDUCED';
  return 'EXPONENT_UNTOUCHED';
}

/**
 * Split-half slopes within one block — the curvature reading.
 *
 * E1-PHASE found write is itself a mixture. A cache cliff should flatten the
 * UPPER half specifically, where the database most exceeds the cache. Reported
 * per arm as a CORROBORATING reading; it gates nothing.
 */
export function splitHalves(runs, arm, block) {
  const at = (tier) => pick(runs, arm, tier, block);
  const seg = (lo, hi) => {
    const a = at(lo); const b = at(hi);
    if (a === undefined || b === undefined) return null;
    return Math.log(b.write_ms / a.write_ms) / Math.log(b.chunk_count / a.chunk_count);
  };
  return { b_lo: seg('T1', 'T5'), b_hi: seg('T5', 'T9') };
}

// ---------------------------------------------------------------------------
// The 2x2
// ---------------------------------------------------------------------------

/**
 * The mechanism cell, keyed on `(rho_B at T9, rho_D at T1)`.
 *
 * `rho_D` is read at **T1** (AMENDMENT 1 A4): a 2 MiB cache raises miss volume
 * ~3.76x there (76.0% -> 9.5% residency) against ~1.034x at T9, so T9 had no
 * power to prove the lever connected and the original keying was wrong.
 */
export function classifyMechanism({ rhoB, rhoD_T1 }) {
  const level = classifyLevel(rhoB);
  const findings = [];

  if (rhoD_T1 <= D_HELPS_ANOMALY) findings.push('arm_D_helps_anomaly');

  // Hole 1 (AMENDMENT 1 A5): an arm that made things WORSE claims no cell. Its
  // wording under every other cell would be false.
  if (level === 'INTERFERENCE') {
    findings.push('arm_B_interference');
    return { cell: 'INTERFERENCE', level, findings };
  }

  const connected = rhoD_T1 >= CONNECTIVITY_RATIO;
  const implicated = rhoB <= LEVEL_IMPLICATED;

  if (implicated) {
    // Hole 2: while shrinking HELPS, no clean cell may be claimed.
    if (findings.includes('arm_D_helps_anomaly')) {
      return { cell: 'CACHE_ASYMMETRIC', level, findings };
    }
    return { cell: connected ? 'CACHE_IMPLICATED' : 'CACHE_ASYMMETRIC', level, findings };
  }
  if (connected) return { cell: 'CACHE_SATURATED', level, findings };
  // Hole 2 again, from the other side: CACHE_INERT asserts "shrinking is free",
  // which is not what a helping shrink is.
  if (findings.includes('arm_D_helps_anomaly')) {
    return { cell: 'CACHE_UNRESOLVED', level, findings };
  }
  return { cell: 'CACHE_INERT', level, findings };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Score a complete run set.
 *
 * @param {object[]} runs each `{arm, tier, block, write_ms, duration_ms, chunk_count, scoreable}`
 */
export function scoreAb(runs) {
  const scoreable = runs.every((r) => r.scoreable !== false);

  const level = {};
  for (const tier of AB_TIERS) {
    level[tier] = {
      B: armRatio(runs, tier, 'B'),
      D: armRatio(runs, tier, 'D'),
      // Reported under the identical estimator so a divergence from write_ms is
      // visible rather than hidden. It decides nothing.
      B_duration: armRatio(runs, tier, 'B', 'duration_ms'),
      D_duration: armRatio(runs, tier, 'D', 'duration_ms'),
    };
  }

  const rhoB = level.T9.B.median;
  const rhoD_T1 = level.T1.D.median;
  const mechanism = classifyMechanism({ rhoB, rhoD_T1 });

  const slopes = {
    A: armSlope(runs, 'A'),
    B: armSlope(runs, 'B'),
    D: armSlope(runs, 'D'),
  };
  const exponent = (slopes.A.void || slopes.B.void)
    ? null
    : classifyExponent(slopes.B.median, slopes.A.median);

  const curvature = {};
  for (const arm of ['A', 'B', 'D']) {
    curvature[arm] = [];
    for (let block = 1; block <= AB_BLOCKS; block++) curvature[arm].push(splitHalves(runs, arm, block));
  }

  // Arm C: T5 only, and it never claims a mechanism cell (AMENDMENT 1 A1).
  const cRatio = armRatio(runs, 'T5', 'C');
  const mmap = {
    tier: 'T5',
    ratio: cRatio,
    expected_inert: true,
    source_basis: 'sqlite3.c:65261-65263 (bMmapOk requires PAGER_READER or PAGER_GET_READONLY) ' +
      'and :77886 (write cursors get curPagerFlags = 0)',
    contradicts_source_reading: cRatio.void ? false : cRatio.median <= LEVEL_IMPLICATED,
    reading: cRatio.void || cRatio.median > LEVEL_IMPLICATED
      ? 'EXPECTED-INERT: predicted by the source reading, therefore WEAK evidence. May not be ' +
        'reported as "the mmap story is refuted by measurement" — the refutation is analytic.'
      : 'CONTRADICTS the source reading. A finding in its own right; triggers a dedicated probe, ' +
        'and licenses no conclusion here.',
  };

  // Hole 3 (AMENDMENT 1 A5): the Gate A caveat is stated in the 2x2's own terms
  // rather than as a third partition using |rho - 1| < 0.10, which contradicted
  // the cells at e.g. (0.85, 1.05).
  const gateACaveat =
    mechanism.cell === 'CACHE_INERT' &&
    (mmap.ratio.void || mmap.ratio.median > LEVEL_IMPLICATED);

  return {
    scoreable,
    level,
    rho_B_T9: rhoB,
    rho_D_T1: rhoD_T1,
    mechanism,
    slopes,
    exponent,
    curvature,
    mmap,
    gate_a_caveat_attached: gateACaveat,
    gate_a_caveat: gateACaveat
      ? 'No arm anywhere moved the clock. Gate A proves each pragma was CONFIGURED on the ' +
        'connection SQLite reported it from; it cannot prove the pager honoured it. A ' +
        'disconnected lever is therefore not fully excluded, and this refutation carries that ' +
        'caveat rather than being reported clean.'
      : null,
    thresholds: {
      LEVEL_DOMINANT, LEVEL_IMPLICATED, INTERFERENCE_RATIO, CONNECTIVITY_RATIO,
      D_HELPS_ANOMALY, E1_SUPERLINEAR_THRESHOLD, SLOPE_MATERIAL_DELTA,
      RATIO_SPREAD_FINDING, SLOPE_SPREAD_FINDING,
    },
  };
}
