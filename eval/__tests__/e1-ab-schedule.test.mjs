// E1-AB — the schedule's decision logic.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-AB PRE-REGISTRATION (2026-08-13),
// as amended by AMENDMENT 1 (arm C demoted to T5; T9 ordered by Latin square)
// and AMENDMENT 3 (the Latin square extended to T1 and T5).
//
// Run from `packages/mast`, never the repo root.

import { describe, it, expect } from 'vitest';
import {
  AB_ARMS, AB_ARMS_BY_ID, AB_TIERS, AB_BLOCKS, AB_ORDERING, AB_TOTAL_RUNS,
  DEFAULT_PRAGMAS, buildAbSchedule, latinSquareRow, gateAVerdict, abStateDirName,
} from '../e1-ab-schedule.mjs';

describe('the registered arms', () => {
  it('runs A, B and D at every rung and C at T5 only', () => {
    expect(AB_ARMS_BY_ID.A.rungs).toEqual(['T1', 'T5', 'T9']);
    expect(AB_ARMS_BY_ID.B.rungs).toEqual(['T1', 'T5', 'T9']);
    expect(AB_ARMS_BY_ID.D.rungs).toEqual(['T1', 'T5', 'T9']);
    // AMENDMENT 1 A1: SQLite cannot serve write-cursor page fetches from the
    // memory map (sqlite3.c:65261, :77886), so arm C is a source-contradiction
    // tripwire at the cheap rung, not a mechanism arm at the expensive one.
    expect(AB_ARMS_BY_ID.C.rungs).toEqual(['T5']);
  });

  it('gives the control arm no flags at all', () => {
    expect(AB_ARMS_BY_ID.A.extraArgs).toEqual([]);
  });

  it('expects the control arm to report SQLite\'s own compiled defaults', () => {
    expect(AB_ARMS_BY_ID.A.expectedPragmas).toEqual(DEFAULT_PRAGMAS);
    expect(DEFAULT_PRAGMAS).toEqual({ cache_size: -16000, mmap_size: 0 });
  });

  // The MiB->pragma-unit conversions are where an arm's declared size and its
  // applied size could silently diverge, which is the one thing Gate A exists
  // to make impossible.
  it('converts each arm\'s declared size into the pragma\'s own units', () => {
    expect(AB_ARMS_BY_ID.B.extraArgs).toEqual(['--cache-size-mib', '1024']);
    expect(AB_ARMS_BY_ID.B.expectedPragmas).toEqual({ cache_size: -1024 * 1024, mmap_size: 0 });

    expect(AB_ARMS_BY_ID.D.extraArgs).toEqual(['--cache-size-mib', '2']);
    expect(AB_ARMS_BY_ID.D.expectedPragmas).toEqual({ cache_size: -2048, mmap_size: 0 });

    expect(AB_ARMS_BY_ID.C.extraArgs).toEqual(['--mmap-size-mib', '1024']);
    expect(AB_ARMS_BY_ID.C.expectedPragmas)
      .toEqual({ cache_size: -16000, mmap_size: 1024 * 1024 * 1024 });
  });
});

describe('latinSquareRow — ordering at every rung, so no arm lives in the hot tail', () => {
  // The whole point: each arm occupies each position exactly once across the
  // three blocks. A seeded shuffle gives no such guarantee.
  it('rotates the arms so every arm holds every position exactly once', () => {
    const rows = [1, 2, 3].map((b) => latinSquareRow(['A', 'B', 'D'], b));
    for (let pos = 0; pos < 3; pos++) {
      expect(new Set(rows.map((r) => r[pos]))).toEqual(new Set(['A', 'B', 'D']));
    }
  });

  it('keeps every block a permutation of the same arms', () => {
    for (const b of [1, 2, 3]) {
      expect(latinSquareRow(['A', 'B', 'D'], b).slice().sort()).toEqual(['A', 'B', 'D']);
    }
  });
});

describe('buildAbSchedule — 30 runs, blocked', () => {
  const schedule = buildAbSchedule();

  it('schedules exactly the registered number of runs', () => {
    expect(schedule).toHaveLength(AB_TOTAL_RUNS);
    expect(AB_TOTAL_RUNS).toBe(30);
  });

  it('gives every cell a block index and a monotonic slot', () => {
    // AMENDMENT 1 A6: the block index is what a VOID re-run pairs against, and
    // the original registration assumed it without ever recording it.
    expect(schedule.map((s) => s.slot)).toEqual(schedule.map((_, i) => i + 1));
    expect(new Set(schedule.map((s) => s.block))).toEqual(new Set([1, 2, 3]));
  });

  it('puts every arm at every rung it is registered for, once per block', () => {
    for (const arm of AB_ARMS) {
      for (const tier of arm.rungs) {
        const cells = schedule.filter((s) => s.arm === arm.id && s.tier === tier);
        expect(cells).toHaveLength(AB_BLOCKS);
        expect(new Set(cells.map((c) => c.block))).toEqual(new Set([1, 2, 3]));
      }
    }
  });

  it('never schedules arm C outside T5', () => {
    expect(schedule.filter((s) => s.arm === 'C').every((s) => s.tier === 'T5')).toBe(true);
  });

  // Drift cancellation depends on an arm and its control being close in time.
  it('keeps each block contiguous', () => {
    const blocks = schedule.map((s) => s.block);
    expect(blocks).toEqual(blocks.slice().sort((a, b) => a - b));
  });

  it('orders each block\'s T9 cells by the Latin square', () => {
    for (const b of [1, 2, 3]) {
      const t9 = schedule.filter((s) => s.block === b && s.tier === 'T9').map((s) => s.arm);
      expect(t9).toEqual(latinSquareRow(['A', 'B', 'D'], b));
    }
  });

  it('is deterministic', () => {
    expect(buildAbSchedule()).toEqual(schedule);
  });
});

// AMENDMENT 3. The defect this pins is not "the order looked untidy" — it is
// that the seeded shuffle gave arm C position 2 in ALL THREE blocks, making a
// positional effect and the arm-C effect perfectly collinear. Arm C is A1's
// source-contradiction tripwire, so an unreadable rho_C costs the design its
// only check on the source reading.
describe('positional balance — every rung, not just T9 (AMENDMENT 3)', () => {
  const schedule = buildAbSchedule();
  const positionsOf = (tier) => {
    const byArm = new Map();
    for (const b of [1, 2, 3]) {
      const row = schedule.filter((s) => s.block === b && s.tier === tier).map((s) => s.arm);
      row.forEach((arm, i) => {
        if (!byArm.has(arm)) byArm.set(arm, []);
        byArm.get(arm).push(i + 1);
      });
    }
    return byArm;
  };

  it.each(['T1', 'T5', 'T9'])('gives every arm three DISTINCT positions at %s', (tier) => {
    for (const [arm, pos] of positionsOf(tier)) {
      expect(`${tier}/${arm}: ${pos.join(',')}`)
        .toBe(`${tier}/${arm}: ${[...new Set(pos)].join(',')}`);
    }
  });

  // The specific regression: C was 2,2,2. A design that pinned any arm to one
  // position would pass a weaker "is it a permutation" check.
  it('leaves no arm at a fixed position across all blocks', () => {
    for (const tier of ['T1', 'T5', 'T9']) {
      for (const [arm, pos] of positionsOf(tier)) {
        expect([tier, arm, new Set(pos).size === 1]).toEqual([tier, arm, false]);
      }
    }
  });

  // T1 with 3 arms admits exact balance; T5 with 4 arms in 3 blocks provably
  // does not — 3*(1+2+3+4)/4 = 7.5 is not an integer, and requiring distinct
  // positions forces the sums to be exactly {6,7,8,9}. Optimal, not balanced.
  it('balances T1 and T9 exactly, and attains T5\'s forced optimum', () => {
    for (const tier of ['T1', 'T9']) {
      const sums = [...positionsOf(tier).values()].map((p) => p.reduce((a, x) => a + x, 0));
      expect(sums).toEqual([6, 6, 6]);
    }
    const t5 = [...positionsOf('T5').values()].map((p) => p.reduce((a, x) => a + x, 0));
    expect(t5.slice().sort((a, b) => a - b)).toEqual([6, 7, 8, 9]);
  });

  // Without the rotation an arm's T1 position equals its T9 position in the same
  // block. A position effect whose MAGNITUDE varies by rung then fails to cancel
  // in the block slope — a constant multiplicative factor cancels in a log-log
  // slope exactly, a rung-varying one does not.
  it('decorrelates T1 ordering from T9 ordering within a block', () => {
    for (const b of [1, 2, 3]) {
      const t1 = schedule.filter((s) => s.block === b && s.tier === 'T1').map((s) => s.arm);
      const t9 = schedule.filter((s) => s.block === b && s.tier === 'T9').map((s) => s.arm);
      expect(t1).not.toEqual(t9);
    }
  });

  // T9's order is explicitly OUT of scope for AMENDMENT 3.
  it('leaves T9 exactly as AMENDMENT 1 A9 registered it', () => {
    const t9 = [1, 2, 3].map((b) =>
      schedule.filter((s) => s.block === b && s.tier === 'T9').map((s) => s.arm));
    expect(t9).toEqual([['A', 'B', 'D'], ['B', 'D', 'A'], ['D', 'A', 'B']]);
  });
});

describe('gateAVerdict — arm identity, the lever-level analogue of Gate 0', () => {
  it('passes when the run reports exactly its arm\'s pragmas', () => {
    expect(gateAVerdict({ arm: 'B', pragmas: { cache_size: -1048576, mmap_size: 0 } }).ok)
      .toBe(true);
  });

  it('fails when a tuning flag silently did not reach the connection', () => {
    // The failure the gate exists for: arm B reporting the control's cache
    // would make both arms identical and yield a credible-looking null.
    const v = gateAVerdict({ arm: 'B', pragmas: { cache_size: -16000, mmap_size: 0 } });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/cache_size/);
  });

  it('fails when the pragmas line is absent entirely', () => {
    expect(gateAVerdict({ arm: 'A', pragmas: null }).ok).toBe(false);
  });

  // The control arm is the one whose "un-pragma'd" claim carries the most
  // weight, so it is graded exactly as strictly as the tuned arms.
  it('holds the control arm to the compiled default rather than waving it through', () => {
    expect(gateAVerdict({ arm: 'A', pragmas: { cache_size: -2000, mmap_size: 0 } }).ok)
      .toBe(false);
    expect(gateAVerdict({ arm: 'A', pragmas: DEFAULT_PRAGMAS }).ok).toBe(true);
  });

  it('fails on an mmap mismatch, not only a cache mismatch', () => {
    expect(gateAVerdict({ arm: 'C', pragmas: { cache_size: -16000, mmap_size: 0 } }).ok)
      .toBe(false);
  });
});

describe('abStateDirName — namespaced away from E1 and E1-PHASE retained artifacts', () => {
  // `runColdIndex` wipes its state dir before every run. E1 retained
  // `run-T9-r3` and E1-PHASE retained `phase-run-T9-r3`; an unnamespaced dir
  // would destroy them on the first T9 run. `ab-run-*` would also collide with
  // the unrelated paraphrase A/B's `~/.cache/mast-eval/ab-runs/`.
  it('uses the e1ab- prefix and encodes arm, tier and block', () => {
    expect(abStateDirName('B', 'T9', 2)).toBe('e1ab-run-B-T9-b2');
  });

  it('never collides with E1 or E1-PHASE state dir names', () => {
    const names = buildAbSchedule().map((s) => abStateDirName(s.arm, s.tier, s.block));
    expect(names.some((n) => n.startsWith('run-') || n.startsWith('phase-run-'))).toBe(false);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the committed ordering', () => {
  // AMENDMENT 3 retired AB_SEED. A seed in the record would have implied the
  // order was drawn at random; it is balanced by construction.
  it('is a Latin square at every rung, not a seeded shuffle', () => {
    expect(AB_ORDERING).toBe('latin_square_all_rungs');
  });

  it('covers three rungs', () => {
    expect(AB_TIERS).toEqual(['T1', 'T5', 'T9']);
  });
});
