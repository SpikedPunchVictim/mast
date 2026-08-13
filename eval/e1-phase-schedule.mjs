// E1-PHASE — the run driver's decision logic, as pure functions.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-PHASE PRE-REGISTRATION (2026-08-12).
//
// A SEPARATE module from `e1-schedule.mjs` on purpose. E1's schedule module is the scored
// instrument of a completed experiment; extending it in place would put E1's 42-run record
// and E1-PHASE's 15-run record behind one shared, moving definition. What E1-PHASE inherits
// unchanged it IMPORTS (`gate3Verdict`, `orphanedAttempts`, `remainingAttempts`,
// `selectFitted`, `retainStateDir`, `median`); what is new to it lives here.

import { SEED, seededShuffle } from './e1-common.mjs';
import { REPS } from './e1-schedule.mjs';

/**
 * The five rungs, registered: "every other rung of the 9-rung ladder", so the design stays
 * exactly evenly spaced in `ln N` (`d = ln(19.94)/4 = 0.7482`, `Sxx_cluster = 5.598`).
 */
export const PHASE_TIERS = ['T1', 'T3', 'T5', 'T7', 'T9'];

/** 5 rungs x 3 repetitions. */
export const PHASE_TOTAL_RUNS = PHASE_TIERS.length * REPS;

/**
 * The phase names emitted by `runIndex` (`indexer/index.ts:288`), in execution order.
 *
 * Order is load-bearing for H2's monotonicity report and for every table this instrument
 * prints; it is not alphabetical and must not be sorted.
 */
export const PHASES = ['walk', 'parse', 'write', 'edges', 'finalise'];

/** Gate P's attribution floor, registered at 0.95 after `eval/e1-phase-attribution.mjs`. */
export const GATE_P_FLOOR = 0.95;

/**
 * The registered FINDING threshold on the unattributed remainder — not a gate.
 *
 * The remainder is `db.destroy()`'s WAL close-time checkpoint, the one size-coupled cost
 * outside every phase. T1 measured 0.09%, so 2% is a 20x rise rather than a tolerance.
 */
export const REMAINDER_FINDING_SHARE = 0.02;

/** The registered void condition on `walk`'s share of `durationMs` at T9. */
export const WALK_VOID_SHARE = 0.10;

/**
 * E1-PHASE's own committed run order — 15 pairs, its own shuffle.
 *
 * The seed is inherited (811) but the INPUT to the shuffle is different (5 corpora, not 14),
 * so this is a genuinely different permutation and not a prefix of E1's. Construction order
 * is fixed here, as in `buildSchedule`, because a seeded shuffle is only reproducible if its
 * input order is.
 */
export function buildPhaseSchedule() {
  const pairs = [];
  for (const corpus of PHASE_TIERS) {
    for (let rep = 1; rep <= REPS; rep++) pairs.push({ kind: 'tier', corpus, rep });
  }
  return seededShuffle(pairs, SEED).map((p, i) => ({ slot: i + 1, ...p }));
}

/**
 * GATE P — attribution: the phases must account for at least 95% of the fitted clock.
 *
 * Registered floor, anchored on measurement rather than on the first draft's smoke run:
 * `eval/e1-phase-attribution.mjs` ran the real T1 rung three times at 99.91 / 99.93 / 99.93%.
 * The floor sits beneath the worst observation with ~5 points of headroom and stays
 * permissive on purpose — the remainder is genuinely size-coupled, and a tight floor would
 * VOID T9 for exhibiting the very growth this experiment is looking for.
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
 * The registered `ln(0)` guard: a scored run with a null `phase_ms`, a missing phase, or any
 * phase `<= 0` is VOID, never silently dropped.
 *
 * `parsePhaseMs` returns null BY DESIGN so the harness can still read E1's own 42-run
 * history, which was measured by a binary predating `c71d59c`. On an E1-PHASE scored run,
 * whose binary is pinned by Gate 0's content hash to a phase-timed build, that null is a
 * defect and must stop the pair rather than shrink the fit.
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
 * E1-PHASE's per-(corpus, rep) state directory name.
 *
 * NAMESPACED AWAY FROM E1's. E1 retained its rep-3 state dirs under `run-<corpus>-r3` and
 * Gate 6 sequences R3, R4, E2 and R5 to read them; `runColdIndex` wipes its state dir before
 * every run, so reusing E1's names would destroy those artifacts on the first T1 run.
 */
export function phaseStateDirName(corpus, rep) {
  return `phase-run-${corpus}-r${rep}`;
}
