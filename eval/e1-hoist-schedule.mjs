// E1-HOIST — arms, rung and run order.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-HOIST PRE-REGISTRATION (2026-08-18).
//
// Its OWN schedule module, for the reason E1-SCAN's header gives: E1-SCAN's 24 records
// are a finished, scored artifact and must not sit behind a moving definition. What
// this experiment inherits unchanged it IMPORTS; what is new to it lives here.

/**
 * The two arms. `pkgRoot` is a detached worktree OUTSIDE the repo, each with its own
 * `dist/`, so neither arm can observe or overwrite the other's build.
 *
 * `rel_hash` is pinned by the registration and enforced by Gate S1 before every run.
 * It is a hash over `dist/**\/*.js` keyed by path RELATIVE to `dist/` (`armDistHash`).
 *
 * ARM N'S HASH IS E1-SCAN ARM R'S HASH, byte for byte. Everything between `c4b4816`
 * and `cc4332f` is documentation, eval scripts and results — nothing in `src/`. That
 * is not a coincidence to note in passing; it is what makes Gate L below possible,
 * because it means E1-SCAN's arm-R T9 measurement and this experiment's arm N are the
 * same binary measured in two different sessions.
 */
export const HOIST_ARMS = [
  {
    id: 'N',
    label: 'no hoist (query per call)',
    commit: 'cc4332f29db75f209eb76ec2a2a62cb027c75f6f',
    pkgRoot: '/private/tmp/mast-hoist-N/packages/mast',
    rel_hash: '2f94a471694f117b69a5ef3eb1b0a83ab12195a9476b35239fbaf96242cd3de9',
  },
  {
    id: 'H',
    label: 'per-file import index',
    commit: '08b0cd8e99aba9e0c5b0ae2a50d5f7f26ae4ab9c',
    pkgRoot: '/private/tmp/mast-hoist-H/packages/mast',
    rel_hash: '24fd80818c89175a960c4420b3bba4163c9fe615c3a97a003438e87fbbaf8bbc',
  },
];

/**
 * The ONLY file the arms' `dist/` may differ in.
 *
 * Gate S2 asserts this exactly rather than merely asserting "the arms differ". An A/B
 * whose arms differ in the wrong file measures something other than its hypothesis,
 * and that failure looks identical to a successful one in every timing number.
 */
export const EXPECTED_ARM_DELTA = ['graph/populate.js'];

/**
 * T9 ONLY (13,330 files / 73,359 chunks).
 *
 * T1/T5/T8 are omitted on power grounds, computed before this file was written and
 * recorded in the registration: T5 needs ~3,191 blocks per arm to resolve its 1.25%
 * effect, T1's effect (0.18%) is two orders of magnitude under its own rung noise.
 * Running them would yield three null cells that read as evidence of no effect and
 * are actually evidence of no power.
 */
export const HOIST_TIERS = ['T9'];

/**
 * 30 blocks per arm.
 *
 * The first draft said 20, from the closed-form n = 7.849 (CV/effect)^2 at the measured
 * effect (3.57%) and E1-SCAN's paired within-block ratio CV at T9 (5.6%). **That formula
 * is for a MEAN, and the registered primary is a MEDIAN**, which is ~64% as efficient on
 * normal data. Simulating the actual registered decision rule — "the 95% BCa interval on
 * the median of n paired ratios lies below 1.0" — gives:
 *
 *     n = 20 -> 72%   n = 30 -> 87%   n = 40 -> 93%   (400 trials each)
 *
 * So the 20 that was almost registered would have been an 80% claim delivering 72%. Fixed
 * before any run rather than discovered in the verdict; this is the same class of error as
 * E1-LADDER's H3 bar, caught one step earlier because FINDINGS.md §3 now says to look.
 */
export const HOIST_BLOCKS = 30;

export const HOIST_TOTAL_RUNS = HOIST_ARMS.length * HOIST_TIERS.length * HOIST_BLOCKS;

/**
 * GATE L — E1-SCAN arm R's T9 edges median, and the band around it.
 *
 * Derived from `eval/results/e1-scan-runs.jsonl`, not copied from RESULT prose (§11.1).
 * Arm N is source-identical to that arm, so this rung is a re-run and should reproduce.
 *
 * A FINDING, not a blocker: machine state legitimately varies between sessions, and
 * E1-LADDER's own Gate L came in at +10.0% on this rung against the same comparator.
 * The band is generous on purpose.
 */
export const GATE_L_SCAN_ARM_R_T9_EDGES = 2217;
export const GATE_L_BAND = 0.15;

/** The phases `runIndex` emits, in execution order. Not alphabetical; do not sort. */
export const PHASES = ['walk', 'parse', 'write', 'edges', 'finalise'];

/** H3's placebo set — every phase the hoist cannot touch. */
export const PLACEBO_PHASES = PHASES.filter((p) => p !== 'edges');

/** Gate P's attribution floor, inherited from E1-PHASE's measured 0.95. */
export const GATE_P_FLOOR = 0.95;

/**
 * Arm-interleaved with the arm order FLIPPING between blocks.
 *
 * Thermal drift and background load are monotone-ish over a schedule, so a fixed arm
 * order would load the drift onto whichever arm always ran second and show up as a
 * real-looking effect. Keeping the two arms adjacent in time is what makes the paired
 * ratio a variance-reduction device rather than a cosmetic one; flipping across blocks
 * cancels the residual within-pair ordering bias. E1-SCAN's rule, unchanged.
 *
 * NOT shuffled. E1's ladder shuffles because rung size confounds with session position
 * across a 20x cost range; here every run is the same rung and the only thing worth
 * controlling is arm order.
 */
export function buildHoistSchedule() {
  const out = [];
  let slot = 1;
  for (let block = 1; block <= HOIST_BLOCKS; block++) {
    const order = block % 2 === 1 ? ['N', 'H'] : ['H', 'N'];
    for (const tier of HOIST_TIERS) {
      for (const arm of order) out.push({ slot: slot++, block, tier, arm });
    }
  }
  return out;
}

/** Journal identity for a cell. */
export const hoistKey = (c) => `${c.arm}#${c.tier}#${c.block}`;

/** State dir name, in E1-HOIST's own namespace so no other experiment's dirs collide. */
export const hoistStateDirName = (arm, tier, block) => `hoist-${arm}-${tier}-b${block}`;

/**
 * GATE P — attribution: the phases must account for at least 95% of the fitted clock.
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
 * A scored run with a null `phase_ms`, a missing phase, or any phase `<= 0` is VOID,
 * never silently dropped. The outcome here is a RATIO of phase times, so a zero in
 * either arm does not shrink the estimate — it makes it infinite or undefined.
 */
export function phaseTimingVerdict(phaseMs) {
  if (phaseMs === null || phaseMs === undefined) return { ok: false, reason: 'phase_ms_null' };
  for (const p of PHASES) {
    const v = phaseMs[p];
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, reason: `phase_${p}_not_a_number` };
    if (v <= 0) return { ok: false, reason: `phase_${p}_non_positive` };
  }
  return { ok: true, reason: null };
}
