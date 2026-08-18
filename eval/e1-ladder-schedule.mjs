// E1-LADDER — the run driver's decision logic, as pure functions.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-LADDER PRE-REGISTRATION (2026-08-17).
//
// A SEPARATE module from `e1-schedule.mjs` and `e1-phase-schedule.mjs`, for the reason
// E1-PHASE's own header gives: each of those is the scored instrument of a completed
// experiment, and extending one in place would put two run records behind a single moving
// definition. What E1-LADDER inherits unchanged it IMPORTS; what is new to it lives here.

import { SEED, seededShuffle } from './e1-common.mjs';
import { REPS } from './e1-schedule.mjs';

/**
 * The full nine-rung ladder.
 *
 * E1-PHASE took every other rung to keep the design evenly spaced in `ln N` at five points.
 * E1-LADDER wants the opposite: the whole ladder, because its H3 is a statement about
 * ADJACENT-rung local slopes, and every rung dropped is a segment that cannot be inspected.
 * The pre-fix curve is flat through T4 and bends above it, so the skipped even rungs are
 * exactly where the knee lives.
 */
export const LADDER_TIERS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'];

/** 9 rungs x 3 repetitions. */
export const LADDER_TOTAL_RUNS = LADDER_TIERS.length * REPS;

/** H1's registered bar on the primary (all-runs) exponent. */
export const H1_EXPONENT_BAR = 1.15;

/**
 * H2's registered minimum separation from the pre-fix comparator.
 *
 * `B_VERIFY` is not recomputed here — it is READ from `e1-unread-fit.json` by the scorer, so
 * the comparator cannot drift between the registration and the verdict. This constant is only
 * the gap the contrast must clear.
 */
export const H2_MIN_SEPARATION = 0.20;

/** H3's registered ceiling on the largest adjacent-rung local slope. */
export const H3_MAX_LOCAL_SLOPE = 1.30;

/**
 * Gate L — E1-SCAN arm R's edges medians, and the band around them.
 *
 * Derived from `eval/results/e1-scan-runs.jsonl`, not copied from the RESULT prose (§11.1).
 * This binary is source-identical to arm R (`git log c4b4816..HEAD -- src/` is empty), so
 * these four rungs are a re-run and should reproduce.
 *
 * A FINDING, not a blocker: machine state legitimately varies between sessions, and the band
 * is generous on purpose — E1-SCAN's arm N reproduced E1-VERIFY within +/-4%.
 */
export const GATE_L_SCAN_ARM_R = { T1: 112, T5: 446, T8: 1461, T9: 2217 };
export const GATE_L_BAND = 0.15;

/**
 * The phase names emitted by `runIndex`, in execution order.
 *
 * Order is load-bearing for the attribution report; it is not alphabetical and must not be
 * sorted. Re-declared rather than imported from `e1-phase-schedule.mjs` for the same reason
 * this module exists at all: E1-PHASE's constants are part of a scored record.
 */
export const PHASES = ['walk', 'parse', 'write', 'edges', 'finalise'];

/** Gate P's attribution floor, inherited from E1-PHASE's measured 0.95. */
export const GATE_P_FLOOR = 0.95;

/**
 * E1-LADDER's own committed run order — 27 pairs, its own shuffle.
 *
 * The seed is inherited (811) but the INPUT is 27 pairs rather than E1's 42 or E1-PHASE's 15,
 * so this is a genuinely different permutation and not a prefix of either. Construction order
 * is fixed here because a seeded shuffle is only reproducible if its input order is.
 *
 * Shuffling rather than blocking is what decorrelates rung size from position in the session:
 * the rungs span a 20x range in wall-clock cost, so any size-ordered schedule confounds the
 * exponent with thermal drift.
 */
export function buildLadderSchedule() {
  const pairs = [];
  for (const corpus of LADDER_TIERS) {
    for (let rep = 1; rep <= REPS; rep++) pairs.push({ kind: 'tier', corpus, rep });
  }
  return seededShuffle(pairs, SEED).map((p, i) => ({ slot: i + 1, ...p }));
}

/**
 * GATE P — attribution: the phases must account for at least 95% of the fitted clock.
 *
 * @param {{phaseMs: Record<string, number>|null, durationMs: number}} run
 */
export function gatePVerdict({ phaseMs, durationMs }) {
  const timing = phaseTimingVerdict(phaseMs);
  if (!timing.ok) {
    return { ok: false, reason: timing.reason, summed_ms: null, attribution: null, remainder_ms: null };
  }
  const summed = PHASES.reduce((s, p) => s + phaseMs[p], 0);
  const attribution = durationMs > 0 ? summed / durationMs : null;
  return {
    ok: attribution !== null && attribution >= GATE_P_FLOOR,
    reason: attribution !== null && attribution >= GATE_P_FLOOR ? null : 'attribution_below_floor',
    summed_ms: summed,
    attribution,
    remainder_ms: durationMs - summed,
    floor: GATE_P_FLOOR,
  };
}

/**
 * The `ln(0)` guard: a scored run with a null `phase_ms`, a missing phase, or any phase `<= 0`
 * is VOID, never silently dropped.
 *
 * The outcome here is `ln(edges)`, so a zero or absent `edges` would not shrink the fit — it
 * would poison it. Refusing the run is the only safe handling.
 */
export function phaseTimingVerdict(phaseMs) {
  if (phaseMs === null || phaseMs === undefined) {
    return { ok: false, reason: 'phase_ms_null' };
  }
  for (const p of PHASES) {
    const v = phaseMs[p];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ok: false, reason: `phase_${p}_not_a_number` };
    }
    if (v <= 0) return { ok: false, reason: `phase_${p}_non_positive` };
  }
  return { ok: true, reason: null };
}

/**
 * E1-LADDER's per-(corpus, rep) state directory name.
 *
 * NAMESPACED AWAY FROM E1's and E1-PHASE's. `runColdIndex` wipes its state dir before every
 * run, so reusing E1's `run-<corpus>-r3` names would destroy the rep-3 artifacts Gate 6
 * sequences R3/R4/E2/R5 to read.
 */
export function ladderStateDirName(corpus, rep) {
  return `ladder-run-${corpus}-r${rep}`;
}
