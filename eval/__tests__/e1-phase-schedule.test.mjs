// E1-PHASE — known-answer tests for the run driver's decision logic.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-PHASE PRE-REGISTRATION (2026-08-12), Gates
// 0/1/3/P/P2 and the "Estimator and aggregation rules" section.
//
// Same rationale as `e1-schedule.test.mjs`: the driver spends ~35 min of machine time and
// every rule it applies that could silently corrupt the design is a pure function, tested
// here, because the alternative is finding the defect in data already collected. Gate P and
// the `ln(0)` guard are new to this experiment and carry the whole VOID path, so they get
// the most cases.

import { describe, it, expect } from 'vitest';
import { REPS } from '../e1-schedule.mjs';
import {
  PHASE_TIERS, PHASE_TOTAL_RUNS, PHASES, GATE_P_FLOOR,
  buildPhaseSchedule, gatePVerdict, phaseTimingVerdict, phaseStateDirName,
} from '../e1-phase-schedule.mjs';

/** A phase map that attributes exactly `sum` ms across the five phases. */
const phasesSumming = (sum) => ({ walk: 1, parse: sum - 4, write: 1, edges: 1, finalise: 1 });

describe('buildPhaseSchedule — E1-PHASE\'s committed run order', () => {
  it('produces exactly the 15 registered (corpus, rep) pairs', () => {
    const schedule = buildPhaseSchedule();

    expect(schedule).toHaveLength(PHASE_TOTAL_RUNS);
    expect(PHASE_TOTAL_RUNS).toBe(15);
  });

  it('covers every one of the five rungs exactly three times', () => {
    const counts = new Map();

    for (const r of buildPhaseSchedule()) counts.set(r.corpus, (counts.get(r.corpus) ?? 0) + 1);

    expect([...counts.keys()].sort()).toEqual([...PHASE_TIERS].sort());
    expect([...counts.values()]).toEqual(new Array(PHASE_TIERS.length).fill(REPS));
  });

  it('gives each (corpus, rep) pair exactly one slot, numbered from 1', () => {
    const schedule = buildPhaseSchedule();

    const keys = schedule.map((r) => `${r.corpus}#${r.rep}`);

    expect(new Set(keys).size).toBe(PHASE_TOTAL_RUNS);
    expect(schedule.map((r) => r.slot)).toEqual(
      Array.from({ length: PHASE_TOTAL_RUNS }, (_, i) => i + 1));
  });

  it('is deterministic across calls — the order is committed, not sampled per invocation', () => {
    expect(buildPhaseSchedule()).toEqual(buildPhaseSchedule());
  });

  it('does not run the rungs in size order — the shuffle is what decorrelates warmth from size', () => {
    const order = buildPhaseSchedule().map((r) => r.corpus);

    expect(order).not.toEqual([...order].sort());
  });

  it('labels every entry as a tier run — E1-PHASE has no replication panel', () => {
    expect(buildPhaseSchedule().every((r) => r.kind === 'tier')).toBe(true);
  });
});

describe('gatePVerdict — Gate P, attribution at 95%', () => {
  it('passes a run whose phases account for the whole clock', () => {
    const v = gatePVerdict({ phaseMs: phasesSumming(1000), durationMs: 1000 });

    expect(v.ok).toBe(true);
    expect(v.attribution).toBe(1);
  });

  it('passes exactly at the floor — the registered comparison is >=, not >', () => {
    const v = gatePVerdict({ phaseMs: phasesSumming(950), durationMs: 1000 });

    expect(v.attribution).toBeCloseTo(GATE_P_FLOOR, 12);
    expect(v.ok).toBe(true);
  });

  it('fails one millisecond beneath the floor', () => {
    const v = gatePVerdict({ phaseMs: phasesSumming(949), durationMs: 1000 });

    expect(v.ok).toBe(false);
    expect(v.reason).toBe('attribution_below_floor');
  });

  it('reports the unattributed remainder, which is the quantity policed as a finding', () => {
    const v = gatePVerdict({ phaseMs: phasesSumming(980), durationMs: 1000 });

    expect(v.remainder_ms).toBe(20);
  });

  it('fails a null phase map rather than dividing by nothing', () => {
    const v = gatePVerdict({ phaseMs: null, durationMs: 1000 });

    expect(v.ok).toBe(false);
    expect(v.reason).toBe('phase_ms_null');
  });

  it('fails a non-positive phase before it can reach the attribution arithmetic', () => {
    // Attribution alone would PASS this run at 99.5%; the ln(0) guard is what stops it.
    const v = gatePVerdict({ phaseMs: { walk: 0, parse: 900, write: 90, edges: 4, finalise: 1 }, durationMs: 1000 });

    expect(v.ok).toBe(false);
    expect(v.reason).toBe('phase_walk_non_positive');
  });
});

describe('phaseTimingVerdict — the registered ln(0) guard', () => {
  it('accepts a complete, strictly positive phase map', () => {
    expect(phaseTimingVerdict({ walk: 1, parse: 2, write: 3, edges: 4, finalise: 5 }))
      .toEqual({ ok: true, reason: null });
  });

  it('rejects null — on a phase-timed binary that is a defect, not a legacy record', () => {
    expect(phaseTimingVerdict(null).ok).toBe(false);
    expect(phaseTimingVerdict(null).reason).toBe('phase_ms_null');
  });

  it('rejects a zero phase, naming the phase so the VOID is diagnosable', () => {
    const v = phaseTimingVerdict({ walk: 1, parse: 2, write: 3, edges: 4, finalise: 0 });

    expect(v.ok).toBe(false);
    expect(v.reason).toBe('phase_finalise_non_positive');
  });

  it('rejects a negative phase', () => {
    expect(phaseTimingVerdict({ walk: 1, parse: -2, write: 3, edges: 4, finalise: 5 }).reason)
      .toBe('phase_parse_non_positive');
  });

  it('rejects a missing phase rather than treating absence as zero', () => {
    expect(phaseTimingVerdict({ walk: 1, parse: 2, write: 3, edges: 4 }).reason)
      .toBe('phase_finalise_not_a_number');
  });

  it('checks every registered phase name', () => {
    for (const p of PHASES) {
      const map = { walk: 1, parse: 1, write: 1, edges: 1, finalise: 1, [p]: 0 };

      expect(phaseTimingVerdict(map).reason).toBe(`phase_${p}_non_positive`);
    }
  });
});

describe('phaseStateDirName — E1\'s retained artifacts must survive this experiment', () => {
  it('does not collide with E1\'s own per-(corpus, rep) directory names', () => {
    // `runColdIndex` wipes its state dir before every run, and Gate 6 sequences R3/R4/E2/R5
    // to read E1's retained `run-T9-r3`. A collision would delete it on the first T9 run.
    expect(phaseStateDirName('T9', 3)).not.toBe('run-T9-r3');
  });

  it('is unique per (corpus, rep)', () => {
    const names = new Set();

    for (const t of PHASE_TIERS) for (let rep = 1; rep <= REPS; rep++) names.add(phaseStateDirName(t, rep));

    expect(names.size).toBe(PHASE_TOTAL_RUNS);
  });
});
