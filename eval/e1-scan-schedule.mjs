// E1-SCAN — arms, rungs and the run order.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-SCAN PRE-REGISTRATION (2026-08-17).
//
// Its OWN schedule module rather than a parameter added to `e1-ab-schedule.mjs`:
// E1-AB's 30 records are a finished, scored artifact and must not sit behind a
// moving definition. Same rule that gave E1-AB its own module.


/**
 * The two arms. `pkgRoot` is a detached worktree OUTSIDE the repo, each with its own
 * `dist/`, so neither arm can observe or overwrite the other's build.
 *
 * `rel_hash` is pinned by the registration and enforced by Gate S1 before every run.
 * It is a hash over `dist/**\/*.js` keyed by path RELATIVE to `dist/` — see
 * `armDistHash` for why `e1-common.mjs`'s absolute-path hash cannot be used here.
 */
export const SCAN_ARMS = [
  {
    id: 'N',
    label: 'no-fix (LIKE)',
    commit: '24ebc66e3a8278163e113628c66adae0421e45b8',
    pkgRoot: '/private/tmp/mast-scan-nofix/packages/mast',
    rel_hash: '75040aff0ed9089ace829a72b9666e161935fb2c60950c076ec273e9f6678fcb',
  },
  {
    id: 'R',
    label: 'range fix',
    commit: 'c4b4816',
    pkgRoot: '/private/tmp/mast-scan-fix/packages/mast',
    rel_hash: '2f94a471694f117b69a5ef3eb1b0a83ab12195a9476b35239fbaf96242cd3de9',
  },
];

/**
 * T1 and T5 are CONTROLS (F = 656 / 2,880), T8 and T9 the treatment
 * (F = 8,945 / 13,330).
 *
 * The controls are what make H2 a dose-response test rather than a single-point
 * claim: a scan whose cost grows with F must be invisible at T1 and decisive at T9.
 * A uniform speedup across all four rungs would falsify the mechanism even if the
 * T9 number looked good.
 */
export const SCAN_TIERS = ['T1', 'T5', 'T8', 'T9'];

export const SCAN_BLOCKS = 3;

export const SCAN_TOTAL_RUNS = SCAN_ARMS.length * SCAN_TIERS.length * SCAN_BLOCKS;

/**
 * Rung-blocked, arm-interleaved, with the arm order FLIPPING between blocks.
 *
 * Thermal drift and background load are monotone-ish over a schedule, so a fixed
 * arm order would load the drift onto whichever arm always ran second and show up
 * as a real-looking effect. Alternating within a rung keeps the two arms adjacent
 * in time; flipping across blocks cancels the residual within-pair ordering bias.
 * E1-AB's blocking, with the flip made explicit.
 */
export function buildScanSchedule() {
  const out = [];
  let slot = 1;
  for (let block = 1; block <= SCAN_BLOCKS; block++) {
    const order = block % 2 === 1 ? ['N', 'R'] : ['R', 'N'];
    for (const tier of SCAN_TIERS) {
      for (const arm of order) {
        out.push({ slot: slot++, block, tier, arm });
      }
    }
  }
  return out;
}

/** Journal identity for a cell. */
export const scanKey = (c) => `${c.arm}#${c.tier}#${c.block}`;

/** State dir name, in E1-SCAN's own namespace so no other experiment's dirs collide. */
export const scanStateDirName = (arm, tier, block) => `scan-${arm}-${tier}-b${block}`;
