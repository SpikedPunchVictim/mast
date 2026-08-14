// E1-FTS — the schedule's decision logic, and the two gates it owns.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-FTS PRE-REGISTRATION (2026-08-14),
// as amended by AMENDMENT 1 (same day, pre-run: four spans became six).
//
// Run from `packages/mast`, never the repo root.

import { describe, it, expect } from 'vitest';
import {
  FTS_ARMS, FTS_ARMS_BY_ID, FTS_TIERS, FTS_BLOCKS, FTS_TOTAL_RUNS, FTS_ORDERING,
  WRITE_SPANS, GATE_TILING_FLOOR, buildFtsSchedule, ftsStateDirName,
  tilingVerdict, dbIdentityVerdict, spanSum,
} from '../e1-fts-schedule.mjs';
import { parseWriteSpans } from '../e1-common.mjs';

describe('the registered arms', () => {
  it('runs exactly two arms, both at every rung', () => {
    expect(FTS_ARMS.map((a) => a.id)).toEqual(['A', 'G']);
    for (const arm of FTS_ARMS) expect([arm.id, arm.rungs]).toEqual([arm.id, FTS_TIERS]);
  });

  it('gives the control arm no flags at all', () => {
    expect(FTS_ARMS_BY_ID.A.extraArgs).toEqual([]);
  });

  // Arm G's ONLY difference from the control. A second flag here would reopen
  // the confound that got arm F cut.
  it('gives arm G exactly one flag — the delete skip', () => {
    expect(FTS_ARMS_BY_ID.G.extraArgs).toEqual(['--unsafe-skip-fts-deletes']);
  });
});

describe('the ladder', () => {
  // Five, not E1-AB's three: a three-rung slope is determined by three points
  // with no residual freedom and no honest interval, which E1-AB's own results
  // review named as a weakness. Not E1's nine — the marginal rungs cost more
  // than the precision buys.
  it('carries five rungs, evenly spaced in ln N', () => {
    expect(FTS_TIERS).toEqual(['T1', 'T3', 'T5', 'T7', 'T9']);
  });

  it('schedules 2 arms x 5 rungs x 3 blocks', () => {
    expect(FTS_TOTAL_RUNS).toBe(30);
    expect(buildFtsSchedule()).toHaveLength(30);
  });
});

describe('buildFtsSchedule — blocked, contiguous, alternating', () => {
  const schedule = buildFtsSchedule();

  it('gives every cell a block index and a monotonic slot', () => {
    expect(schedule.map((s) => s.slot)).toEqual(schedule.map((_, i) => i + 1));
    expect(new Set(schedule.map((s) => s.block))).toEqual(new Set([1, 2, 3]));
  });

  // The primary estimator is a WITHIN-BLOCK ratio, so an arm and the control it
  // is divided by must be close in time for drift to cancel.
  it('keeps each block contiguous', () => {
    const blocks = schedule.map((s) => s.block);
    expect(blocks).toEqual(blocks.slice().sort((a, b) => a - b));
  });

  it('puts both arms at every rung, once per block', () => {
    for (const arm of ['A', 'G']) {
      for (const tier of FTS_TIERS) {
        const cells = schedule.filter((s) => s.arm === arm && s.tier === tier);
        expect([arm, tier, cells.length]).toEqual([arm, tier, FTS_BLOCKS]);
      }
    }
  });

  it('runs the cheap rungs before the expensive ones inside a block', () => {
    for (const b of [1, 2, 3]) {
      const tiers = schedule.filter((s) => s.block === b).map((s) => s.tier);
      const firstIndex = FTS_TIERS.map((t) => tiers.indexOf(t));
      expect([b, firstIndex]).toEqual([b, firstIndex.slice().sort((x, y) => x - y)]);
    }
  });

  it('is deterministic', () => {
    expect(buildFtsSchedule()).toEqual(schedule);
  });
});

// AMENDMENT 3 of E1-AB is the precedent: a seeded shuffle handed one arm the
// same position in all three blocks, making a positional effect and the arm
// effect perfectly collinear. With 2 arms x 3 blocks exact balance is NOT
// attainable, and saying so is the point — the imbalance is recorded rather
// than described as balance.
describe('positional balance — forced imbalance, recorded not hidden', () => {
  const schedule = buildFtsSchedule();
  const positionsOf = (tier) => {
    const byArm = new Map();
    for (const b of [1, 2, 3]) {
      schedule
        .filter((s) => s.block === b && s.tier === tier)
        .forEach((s, i) => {
          if (!byArm.has(s.arm)) byArm.set(s.arm, []);
          byArm.get(s.arm).push(i + 1);
        });
    }
    return byArm;
  };

  it.each(FTS_TIERS)('gives each arm both positions at %s — neither is pinned', (tier) => {
    for (const [arm, pos] of positionsOf(tier)) {
      expect([tier, arm, new Set(pos).size]).toEqual([tier, arm, 2]);
    }
  });

  // 3*(1+2)/2 = 4.5 is not attainable, so {4,5} is the forced optimum: one arm
  // must go first twice. Pinned so a future reader sees the imbalance is
  // arithmetic, not an oversight.
  it('attains the forced optimum {4,5} rather than pretending to balance', () => {
    for (const tier of FTS_TIERS) {
      const sums = [...positionsOf(tier).values()].map((p) => p.reduce((a, x) => a + x, 0));
      expect([tier, sums.slice().sort()]).toEqual([tier, [4, 5]]);
    }
  });

  // A position effect whose magnitude varies by rung does not cancel in a
  // log-log slope, so an arm must not hold the same position at every rung.
  it('decorrelates the rungs from each other within a block', () => {
    const firstArmPerRung = (b) =>
      FTS_TIERS.map((t) => schedule.filter((s) => s.block === b && s.tier === t)[0].arm);
    for (const b of [1, 2, 3]) {
      expect([b, new Set(firstArmPerRung(b)).size]).toEqual([b, 2]);
    }
  });

  it('records that the order is alternating, not randomised', () => {
    expect(FTS_ORDERING).toBe('alternating_latin_square_forced_imbalance');
  });
});

describe('WRITE_SPANS — the six regions, matching what the CLI emits', () => {
  it('names all six, AMENDMENT 1 included', () => {
    expect(WRITE_SPANS).toEqual(['fts_del', 'fts_ins', 'commit', 'rest', 'txn', 'lock']);
  });

  // The gate is only as good as the span list agreeing with the binary. A CLI
  // that grew a seventh span would otherwise leave it silently unattributed.
  it('matches the keys the binary actually prints', () => {
    const line = 'write_spans: {"fts_del":8.1,"fts_ins":50.5,"commit":54.7,"rest":27.1,"txn":12.0,"lock":23.4}';
    expect(Object.keys(parseWriteSpans(line)).sort()).toEqual([...WRITE_SPANS].sort());
  });
});

describe('tilingVerdict — the six spans must account for the write phase', () => {
  const full = { fts_del: 10, fts_ins: 20, commit: 30, rest: 25, txn: 5, lock: 8 };

  it('is registered at the same floor as E1-PHASE\'s Gate P, for the same reason', () => {
    expect(GATE_TILING_FLOOR).toBe(0.95);
  });

  it('sums the spans', () => {
    expect(spanSum(full)).toBe(98);
  });

  it('passes when the spans account for the write phase', () => {
    expect(tilingVerdict({ spans: full, writeMs: 100 }).ok).toBe(true);
  });

  it('fails when a region of the write phase went unattributed', () => {
    // AMENDMENT 1's own finding, in miniature: the four registered spans left
    // ~25% of a smoke build's write phase unmeasured.
    const v = tilingVerdict({ spans: { ...full, txn: 0, lock: 0 }, writeMs: 100 });
    expect(v.ok).toBe(false);
    expect(v.tiling).toBeCloseTo(0.85, 5);
  });

  // A missing line is a defect, and it must void the run rather than read as
  // zero attributed time or as a pass.
  it('fails when the write_spans line is absent entirely', () => {
    const v = tilingVerdict({ spans: null, writeMs: 100 });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/absent/);
  });

  it('fails when a span the binary should emit is missing from the record', () => {
    const { lock: _lock, ...missing } = full;
    const v = tilingVerdict({ spans: missing, writeMs: 100 });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/lock/);
  });

  // Spans exceeding the phase they are carved from means double counting, which
  // is a different defect from under-attribution and must not read as a pass.
  it('fails when the spans exceed the write phase', () => {
    const v = tilingVerdict({ spans: full, writeMs: 50 });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/exceed/);
  });

  it('fails rather than dividing by zero when the write phase is empty', () => {
    expect(tilingVerdict({ spans: full, writeMs: 0 }).ok).toBe(false);
  });
});

// This is what makes arm G confound-free where the cut arm F was not: skipping
// deletes that match nothing leaves the finished database identical. Registered
// as a GATE and not an observation — a mismatch voids the arm.
describe('dbIdentityVerdict — arm G must not have changed the database', () => {
  it('passes on an exact byte match', () => {
    expect(dbIdentityVerdict({ armA: 3_768_320, armG: 3_768_320 }).ok).toBe(true);
  });

  // Not a tolerance. Arm F was cut precisely because a ~69% smaller database
  // confounds "FTS work removed" with "smaller database"; any drift at all
  // means the arm is measuring something other than what it claims.
  it('fails on any difference, however small', () => {
    expect(dbIdentityVerdict({ armA: 3_768_320, armG: 3_768_324 }).ok).toBe(false);
  });

  it('reports both sizes so the direction of the drift is visible', () => {
    const v = dbIdentityVerdict({ armA: 100, armG: 90 });
    expect(v).toMatchObject({ ok: false, arm_a_bytes: 100, arm_g_bytes: 90, delta_bytes: -10 });
  });

  it('fails when either size is missing rather than treating it as equal', () => {
    expect(dbIdentityVerdict({ armA: 100, armG: null }).ok).toBe(false);
  });
});

describe('ftsStateDirName — namespaced away from every retained artifact', () => {
  // `runColdIndex` wipes its state dir before every run, so a name collision
  // DESTROYS artifacts. E1 retained `run-<tier>-r3`, E1-PHASE `phase-run-*`,
  // E1-AB `e1ab-run-*`; Gate 6 sequences later work to read them.
  it('uses the e1fts- prefix and encodes arm, tier and block', () => {
    expect(ftsStateDirName('G', 'T9', 2)).toBe('e1fts-run-G-T9-b2');
  });

  it('never collides with an E1, E1-PHASE or E1-AB state dir', () => {
    const names = buildFtsSchedule().map((s) => ftsStateDirName(s.arm, s.tier, s.block));
    expect(names.some((n) => /^(run-|phase-run-|e1ab-run-)/.test(n))).toBe(false);
    expect(new Set(names).size).toBe(names.length);
  });
});
