// E1-AB — the arms, the schedule, and Gate A.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-AB PRE-REGISTRATION (2026-08-13),
// as amended by AMENDMENT 1 (2026-08-13, pre-run, post-adversarial-review).
//
// A SEPARATE module from `e1-schedule.mjs` and `e1-phase-schedule.mjs`, for the
// reason E1-PHASE gave: those are the scored instruments of completed
// experiments, and extending one in place would put a finished record behind a
// moving definition. What E1-AB inherits unchanged it IMPORTS.
//
// Run every script from `packages/mast`, never the repo root.

import { seededShuffle } from './e1-common.mjs';

/** Committed with the registration. Distinct from E1's 811 so the two permutations cannot be confused. */
export const AB_SEED = 4409;

/** Three rungs of E1's frozen manifest: 1.32x, 5.81x and 26.8x the default page cache. */
export const AB_TIERS = ['T1', 'T5', 'T9'];

/** Blocks, not repetitions: each block holds every arm once, so drift loads onto all arms alike. */
export const AB_BLOCKS = 3;

/**
 * SQLite's own compiled defaults on this install, and therefore the control
 * arm's identity.
 *
 * `better-sqlite3@12.11.1` compiles the amalgamation with
 * `SQLITE_DEFAULT_CACHE_SIZE=-16000` (`deps/defines.gypi:13`), overriding the
 * `#ifndef` fallback of `-2000` at `sqlite3.c:14850`; `mmap_size` has no
 * compiled default and is 0 (memory mapping off).
 *
 * Hardcoded on purpose. If a dependency bump moved either value, Gate A would
 * fail on the CONTROL arm — which is correct: the control is defined as "the
 * un-pragma'd binary", and a silent change to what that means would invalidate
 * every ratio computed against it.
 */
export const DEFAULT_PRAGMAS = { cache_size: -16000, mmap_size: 0 };

/**
 * The registered arms.
 *
 * `expectedPragmas` is Gate A's target and is written in the pragma's OWN units,
 * derived here from the same MiB figure the flag carries — so a mistake in the
 * conversion shows up as a gate failure rather than as a quietly mislabelled
 * arm. `cache_size` is negative when denominated in KiB.
 */
export const AB_ARMS = [
  {
    id: 'A',
    label: 'control',
    extraArgs: [],
    expectedPragmas: DEFAULT_PRAGMAS,
    rungs: ['T1', 'T5', 'T9'],
    role: 'the un-pragma\'d binary; every ratio is taken against this arm within its own block',
  },
  {
    id: 'B',
    label: 'cache 1024 MiB',
    extraArgs: ['--cache-size-mib', '1024'],
    expectedPragmas: { cache_size: -1024 * 1024, mmap_size: 0 },
    rungs: ['T1', 'T5', 'T9'],
    role: '2.45x T9\'s whole 418.8 MiB database, so no page can ever be evicted',
  },
  {
    id: 'D',
    label: 'cache 2 MiB',
    extraArgs: ['--cache-size-mib', '2'],
    expectedPragmas: { cache_size: -2048, mmap_size: 0 },
    rungs: ['T1', 'T5', 'T9'],
    role:
      'positive control. At T1 a 2 MiB cache raises miss volume ~3.76x (76.0% -> 9.5% ' +
      'residency), which is why AMENDMENT 1 A4 reads connectivity off T1 and not T9, ' +
      'where the same shrink moves miss volume only ~1.034x.',
  },
  {
    id: 'C',
    label: 'mmap 1024 MiB',
    extraArgs: ['--mmap-size-mib', '1024'],
    expectedPragmas: { cache_size: -16000, mmap_size: 1024 * 1024 * 1024 },
    // T5 ONLY (AMENDMENT 1 A1). SQLite cannot serve page fetches made through
    // WRITE cursors from the memory map: `bMmapOk` requires
    // `eState==PAGER_READER` or `PAGER_GET_READONLY` (sqlite3.c:65261-65263),
    // and `btreeCursor` gives write cursors `curPagerFlags = 0` (:77886). The
    // index B-tree traversals this arm was aimed at are precisely the traffic
    // mmap cannot touch, so at T9 it was ~27 minutes buying a foreordained
    // null. Retained at the cheap rung as a source-contradiction tripwire.
    rungs: ['T5'],
    role:
      'source-contradiction tripwire, NOT a mechanism arm. rho_C > 0.80 is EXPECTED and is ' +
      'weak evidence; rho_C <= 0.80 would contradict the source reading above and is a finding.',
  },
];

/** Arms by id, for the gate and the scorer. */
export const AB_ARMS_BY_ID = Object.fromEntries(AB_ARMS.map((a) => [a.id, a]));

/** The arms carried at every rung — the ones every registered statistic is computed over. */
export const AB_FULL_ARMS = ['A', 'B', 'D'];

/** 3 arms x 3 rungs x 3 blocks, plus arm C at T5 x 3 blocks. */
export const AB_TOTAL_RUNS =
  AB_ARMS.reduce((n, arm) => n + arm.rungs.length * AB_BLOCKS, 0);

/**
 * One row of a Latin square — T9's within-block ordering.
 *
 * A seeded shuffle gives no positional balance: an arm can land in the
 * thermally-hot tail of two blocks out of three across a ~80-minute stretch of
 * T9 runs. With arm C removed from T9 (AMENDMENT 1 A1) the T9 cells are exactly
 * 3 arms x 3 blocks, so a rotation makes each arm hold each position exactly
 * once. This is free and strictly stronger than shuffling.
 *
 * @param {string[]} arms in canonical order
 * @param {number} block 1-based
 */
export function latinSquareRow(arms, block) {
  const offset = (block - 1) % arms.length;
  return arms.map((_, i) => arms[(i + offset) % arms.length]);
}

/**
 * The committed run order: 3 contiguous blocks, 10 runs each.
 *
 * Within a block, the cheap rungs run first and T9 last. Blocks are contiguous
 * because the primary estimator is a WITHIN-BLOCK ratio — an arm and the control
 * it is divided by must be close in time for drift to cancel.
 *
 * T1 and T5 keep a seeded shuffle: at 2.7 s and 30 s per run, ordering is not a
 * credible confound there. T9 gets the Latin square.
 */
export function buildAbSchedule() {
  const cells = [];
  for (let block = 1; block <= AB_BLOCKS; block++) {
    for (const tier of AB_TIERS) {
      const arms = AB_ARMS.filter((a) => a.rungs.includes(tier)).map((a) => a.id);
      // The shuffle's input order is fixed by AB_ARMS' declaration order, because
      // a seeded shuffle is only reproducible if its input order is.
      const ordered = tier === 'T9'
        ? latinSquareRow(arms, block)
        : seededShuffle(arms, AB_SEED + block);
      for (const arm of ordered) cells.push({ block, tier, arm });
    }
  }
  return cells.map((c, i) => ({ slot: i + 1, ...c }));
}

/**
 * GATE A — arm identity.
 *
 * Every run echoes the `cache_size` / `mmap_size` SQLite reported for its own
 * connection; this compares that echo against the arm's declared pair. It is the
 * lever-level analogue of Gate 0's `dist` content hash: without it, a flag that
 * silently failed to reach the connection would make two arms identical and
 * produce a clean, credible-looking null.
 *
 * Its limit, stated in the registration and repeated here because a reader of
 * this code should not have to find it elsewhere: the echo proves the pragma was
 * CONFIGURED on the connection SQLite reported it from. It does not prove
 * SQLite's pager honoured it internally, and it is blind to the structural
 * gating that makes arm C inert (AMENDMENT 1 A1) — which is physics, not a
 * failure mode.
 *
 * @param {{arm: string, pragmas: object|null}} run
 */
export function gateAVerdict({ arm, pragmas }) {
  const spec = AB_ARMS_BY_ID[arm];
  if (spec === undefined) return { ok: false, reason: `unknown_arm_${arm}`, expected: null, actual: pragmas ?? null };

  const expected = spec.expectedPragmas;
  if (pragmas === null || pragmas === undefined) {
    return { ok: false, reason: 'pragmas_line_absent', expected, actual: null };
  }
  for (const key of ['cache_size', 'mmap_size']) {
    if (pragmas[key] !== expected[key]) {
      return { ok: false, reason: `${key}_mismatch`, expected, actual: pragmas };
    }
  }
  return { ok: true, reason: null, expected, actual: pragmas };
}

/**
 * Per-(arm, tier, block) state directory name.
 *
 * NAMESPACED THREE WAYS. `runColdIndex` wipes its state dir before every run, so
 * a name collision destroys artifacts rather than merely confusing them: E1
 * retained `run-<tier>-r3` and E1-PHASE retained `phase-run-<tier>-r3`, both of
 * which Gate 6 sequences later work to read. A bare `ab-run-*` would also
 * collide with the unrelated paraphrase A/B's `~/.cache/mast-eval/ab-runs/`,
 * which already exists on this machine.
 */
export function abStateDirName(arm, tier, block) {
  return `e1ab-run-${arm}-${tier}-b${block}`;
}
