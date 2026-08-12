// E1 — the run driver's decision logic, as pure functions.
//
// Registration: IMPLEMENTATION_PLAN.md § E1/E2 PRE-REGISTRATION, "Design — cold builds,
// randomized run order, three repetitions" and Gates 1/3/5.
//
// Split out of the driver so it is testable without spawning an index. Everything here is
// a rule the registration fixes; nothing here touches the filesystem, the clock, or a
// database, so `eval/__tests__/e1-schedule.test.mjs` can pin all of it. The driver spends
// ~2.3 h of machine time, and a defect in any of these rules would only surface afterwards,
// in data already collected.

import { SEED, RUNGS, seededShuffle } from './e1-common.mjs';

/** The nested ladder. T9 is the whole (chunk-bearing) corpus. */
export const TIERS = Array.from({ length: RUNGS }, (_, i) => `T${i + 1}`);

/**
 * The replication panel. Five distinct corpora — the ladder answers "does THIS corpus's
 * index scale", the panel answers "does the law travel". `nest` doubles as E2's corpus.
 */
export const PANEL = ['P1', 'P2', 'P3', 'P4', 'nest'];

/** Registered repetitions per corpus. */
export const REPS = 3;

/** 9 tiers x 3 = 27 decision-bearing runs, 5 panel x 3 = 15 replication runs. */
export const TOTAL_RUNS = (TIERS.length + PANEL.length) * REPS;

/**
 * The committed run order.
 *
 * Corpus-major / rep-minor construction, then one seeded Fisher-Yates over all 42 pairs.
 * The construction order is fixed here rather than at the call site because the shuffle is
 * only reproducible if its input order is: re-ordering `TIERS` or `PANEL` would silently
 * produce a different schedule under the same seed.
 *
 * Why shuffle at all (registered): each run takes seconds to a minute, so OS page-cache
 * warmth and thermal drift are the dominant non-corpus variance sources. A small-to-large
 * order would confound them with the exposure variable exactly.
 */
export function buildSchedule() {
  const pairs = [];
  for (const corpus of TIERS) {
    for (let rep = 1; rep <= REPS; rep++) pairs.push({ kind: 'tier', corpus, rep });
  }
  for (const corpus of PANEL) {
    for (let rep = 1; rep <= REPS; rep++) pairs.push({ kind: 'panel', corpus, rep });
  }
  return seededShuffle(pairs, SEED).map((p, i) => ({ slot: i + 1, ...p }));
}

/** Gate 3's absolute floor, in ms. */
export const CLOCK_FLOOR_MS = 500;
/** Gate 3's proportional term. */
export const CLOCK_PCT = 0.05;

/**
 * GATE 3 — the two clocks must agree within `max(5%, 500 ms)`.
 *
 * The floor exists because of A1-F5, but BOTH halves of its published rationale are wrong,
 * and AMENDMENT 4 (A4-C1, A4-C2) corrects them here rather than leaving the wrong version
 * copied into the harness:
 *
 *  - `startMs` is `runIndex`'s FIRST statement (`indexer/index.ts:173`) and `openDatabase`
 *    is at `:188` — INSIDE the fitted clock, and therefore inside `c`, exactly as the
 *    registration's calibration paragraph says. Only process boot, commander and
 *    `resolveConfig` are genuinely outside; they run in `cli/index-cmd.ts` before
 *    `runIndex` is called.
 *  - The "~3.5 s T1" premise is stale, though NOT in the direction A4-C2 claimed — see below.
 *
 * A4-C2 ALSO SAID THIS FLOOR IS INERT. IT IS NOT; that claim was withdrawn after scored run
 * 1. It was reasoned by extrapolating T1 from P0's MEAN per-chunk cost, which assumes cost
 * per chunk is constant — i.e. assumes b = 1, i.e. assumes the hypothesis under test. The
 * measurement: T2 (5,332 chunks) runs in 8,908 ms, not the ~28 s that extrapolation implies,
 * because per-chunk cost is 1.671 ms at T2 against 8.670 ms at T9. So the 5% term at T2 is
 * 445 ms and THE FLOOR IS WHAT BINDS at the bottom of the ladder, exactly as A1-F5 argued.
 *
 * The threshold is unchanged regardless: moving a gate on first contact with the data is
 * tuning, in whichever direction it would move. What A1-F5 got right is the consequence it
 * was guarding against — a gate firing on the ideal condition offers only an infinite retake
 * loop, a de facto void of the cheapest anchor, or selective retention of fast-boot runs,
 * and that last one biases small-tier totals down and the slope UP. Measured on run 1: three
 * attempts at 8,908 / 6,861 / 6,264 ms, the third 30% faster than the first purely from
 * cache warmth. Retaining the first take is therefore load-bearing, not bookkeeping.
 *
 * A negative delta is treated as an anomaly rather than a comfortable pass: the external
 * clock encloses the fitted one by construction, so `external < duration` means a clock is
 * wrong, and this is the only gate positioned to notice.
 */
export function gate3Verdict({ externalMs, durationMs }) {
  const delta = externalMs - durationMs;
  const allowance = Math.max(CLOCK_PCT * durationMs, CLOCK_FLOOR_MS);
  const anomaly = delta < 0;
  return {
    ok: !anomaly && delta <= allowance,
    delta_ms: delta,
    allowance_ms: allowance,
    pct_of_fitted: durationMs > 0 ? delta / durationMs : null,
    anomaly,
  };
}

/** Registered retake cap; a third failure is logged as a finding, never retaken. */
export const MAX_RETAKES = 2;

/**
 * Registered: "Only the final repetition's state dirs are retained."
 *
 * Keyed on the repetition NUMBER, not on execution order. The shuffle can run rep 3 first,
 * and a rule that kept "whichever ran last" would then delete the artifact R3's `stat`,
 * R4's checkpoint reading, E2's Gate-8 extraction and R5's probe all read.
 */
export function retainStateDir(rep) {
  return rep === REPS;
}

/** Median of a sample; the calibration constant `c` is the median of 10 empty-corpus runs. */
export function median(values) {
  if (values.length === 0) {
    throw new Error('median: empty sample. A calibration constant of NaN would silently void the adjusted fit.');
  }
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
