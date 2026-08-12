// Gate 5 / Gate 3 — known-answer tests for the run driver's decision logic.
//
// The run driver spends ~2.3 h of machine time. Every rule it applies that could silently
// corrupt the design — the run-order shuffle, the clock-agreement gate, the retention rule —
// is a pure function tested here, because the alternative is discovering the defect in the
// scored data afterwards. That is the Q1/SCALE lesson twice over (`ab-score.mjs`'s
// unimplemented Wilcoxon, `idfuse-score.mjs`'s missing entry point).
//
// Registration: IMPLEMENTATION_PLAN.md § E1/E2 PRE-REGISTRATION, Gates 1/3/5 and the
// "Design — cold builds, randomized run order, three repetitions" section.

import { describe, it, expect } from 'vitest';
import {
  TIERS, PANEL, REPS, TOTAL_RUNS, buildSchedule, gate3Verdict, retainStateDir, median,
  MAX_RETAKES, orphanedAttempts, remainingAttempts,
} from '../e1-schedule.mjs';

describe('buildSchedule — the committed run order', () => {
  it('produces exactly the 42 registered (corpus, rep) pairs', () => {
    const schedule = buildSchedule();

    expect(schedule).toHaveLength(TOTAL_RUNS);
    expect(TOTAL_RUNS).toBe(42);
  });

  it('covers every corpus exactly three times and no corpus a fourth', () => {
    const schedule = buildSchedule();

    const counts = new Map();
    for (const r of schedule) counts.set(r.corpus, (counts.get(r.corpus) ?? 0) + 1);

    expect([...counts.keys()].sort()).toEqual([...TIERS, ...PANEL].sort());
    expect([...counts.values()]).toEqual(new Array(14).fill(REPS));
  });

  it('gives each (corpus, rep) pair exactly one slot', () => {
    const schedule = buildSchedule();

    const keys = schedule.map((r) => `${r.corpus}#${r.rep}`);

    expect(new Set(keys).size).toBe(TOTAL_RUNS);
  });

  it('is deterministic under the committed seed', () => {
    expect(buildSchedule()).toEqual(buildSchedule());
  });

  it('breaks the size ordering the shuffle exists to break', () => {
    // The registered reason for shuffling: at seconds-to-a-minute per run, page-cache
    // warmth and thermal drift are the dominant non-corpus variance sources, and a
    // small-to-large order would confound them with the exposure variable exactly. A
    // shuffle that happened to emit the tiers in ascending size would reintroduce that
    // confound while looking randomised.
    const tierOrdinals = buildSchedule()
      .filter((r) => r.kind === 'tier')
      .map((r) => Number(r.corpus.slice(1)));

    const isMonotone = tierOrdinals.every((v, i) => i === 0 || v >= tierOrdinals[i - 1]);

    expect(isMonotone).toBe(false);
  });

  it('labels tier runs and panel runs distinguishably, since only tiers feed the fit', () => {
    const schedule = buildSchedule();

    expect(schedule.filter((r) => r.kind === 'tier')).toHaveLength(TIERS.length * REPS);
    expect(schedule.filter((r) => r.kind === 'panel')).toHaveLength(PANEL.length * REPS);
  });
});

describe('gate3Verdict — clock agreement, max(5%, 500 ms)', () => {
  it('passes a small-tier run whose fixed process boot exceeds 5% but not 500 ms', () => {
    // A1-F5, the exact case the absolute floor exists for: `startMs` sits inside `runIndex`
    // (indexer/index.ts:173), so process boot, commander, config resolution and
    // `openDatabase` are all outside the fitted clock. 400 ms of that on a 3,500 ms T1 run
    // is 11.4% — a bare 5% rule would fire on the HEALTHIEST small runs.
    const v = gate3Verdict({ externalMs: 3900, durationMs: 3500 });

    expect(v.ok).toBe(true);
  });

  it('fails when the gap exceeds the floor on a small run', () => {
    const v = gate3Verdict({ externalMs: 4100, durationMs: 3500 });

    expect(v.ok).toBe(false);
  });

  it('uses the 5% term once it dominates the floor, on a large run', () => {
    const v = gate3Verdict({ externalMs: 630000, durationMs: 600000 });

    expect(v.allowance_ms).toBe(30000);
    expect(v.ok).toBe(true);
  });

  it('fails a large run whose gap clears 5%', () => {
    const v = gate3Verdict({ externalMs: 631000, durationMs: 600000 });

    expect(v.ok).toBe(false);
  });

  it('flags an external clock BELOW the fitted clock as an anomaly, not a pass', () => {
    // The external clock encloses the fitted one by construction, so delta < 0 is
    // impossible unless a clock is wrong. Treating it as "comfortably within budget"
    // would let a broken measurement through the one gate that could have caught it.
    const v = gate3Verdict({ externalMs: 3400, durationMs: 3500 });

    expect(v.anomaly).toBe(true);
    expect(v.ok).toBe(false);
  });
});

describe('retainStateDir — the disk-retention rule', () => {
  it('retains only the final repetition, whatever order the shuffle ran it in', () => {
    // Registered: "Only the final repetition's state dirs are retained". The rule is keyed
    // on the repetition NUMBER, not on execution order — the shuffle can run rep 3 first,
    // and a rule that kept "the most recently run" would then delete the artifact R3, R4,
    // E2 and R5 all read.
    expect(retainStateDir(1)).toBe(false);
    expect(retainStateDir(2)).toBe(false);
    expect(retainStateDir(REPS)).toBe(true);
  });
});

describe('median — the calibration constant c', () => {
  it('averages the two middle values of the registered 10 runs', () => {
    const ten = [120, 118, 125, 119, 122, 121, 117, 130, 124, 123];

    // sorted: 117 118 119 120 121 122 123 124 125 130 -> (121 + 122) / 2
    expect(median(ten)).toBe(121.5);
  });

  it('takes the middle value of an odd sample', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('does not mutate its input', () => {
    const xs = [3, 1, 2];

    median(xs);

    expect(xs).toEqual([3, 1, 2]);
  });

  it('refuses an empty sample rather than returning NaN as a calibration constant', () => {
    expect(() => median([])).toThrow(/empty/i);
  });
});

// A4-MAT-3, discharged late. The registration requires an orphaned attempt-start to be "a
// logged finding" whose re-attempt is "counted against the retake cap". The driver detected
// orphans and printed them, but `summarise()` never put them in `findings`, so the E1
// schedule's two interrupted T9 attempts reached no persisted artifact — found by the
// adversarial results review, not by the harness. Console output is not a finding.
describe('orphanedAttempts', () => {
  const start = (corpus, rep, attempt, at) => ({ type: 'attempt_start', corpus, rep, attempt, at });
  const run = (corpus, rep, n) => ({
    type: 'run', corpus, rep, gate3_attempts: Array.from({ length: n }, (_, i) => ({ attempt: i + 1 })),
  });

  it('finds no orphan when every start has a completed attempt', () => {
    expect(orphanedAttempts([start('T9', 3, 1, 'a'), run('T9', 3, 1)])).toEqual([]);
  });

  it('finds the interrupted start when a pair was re-attempted after a kill', () => {
    const journal = [start('T9', 1, 1, 'killed'), start('T9', 1, 1, 'redone'), run('T9', 1, 1)];

    const orphans = orphanedAttempts(journal);

    expect(orphans).toHaveLength(1);
    expect(orphans[0].at).toBe('killed');
  });

  it('counts a retaken run\'s attempts, so a Gate 3 retake is not mistaken for an orphan', () => {
    const journal = [start('T2', 1, 1, 'a'), start('T2', 1, 2, 'b'), start('T2', 1, 3, 'c'), run('T2', 1, 3)];

    expect(orphanedAttempts(journal)).toEqual([]);
  });

  it('treats every start of a still-pending pair as orphaned', () => {
    expect(orphanedAttempts([start('T7', 2, 1, 'a')])).toHaveLength(1);
  });

  it('charges orphans against the retake cap, which is the half that bounds warm re-runs', () => {
    // Two kills already spent the budget; a third spawn would be the 3rd attempt, and the
    // registered cap is 3 total. Selective retention of fast warm re-runs is the risk.
    expect(remainingAttempts(2)).toBe(1);
    expect(remainingAttempts(0)).toBe(MAX_RETAKES + 1);
  });
});
