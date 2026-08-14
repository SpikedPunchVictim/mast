// E1-FTS — the journal fold, the pending planner, and the cross-run gates.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-FTS PRE-REGISTRATION (2026-08-14),
// as amended by AMENDMENT 1 and AMENDMENT 2 (both pre-run).
//
// This logic lives in a module rather than inside the driver for RR6's reason:
// driver-private logic is what nothing can test, and RR6 was a fold defect that
// pinned `scoreable` false forever once anything had voided.
//
// Run from `packages/mast`, never the repo root.

import { describe, it, expect } from 'vitest';
import {
  ftsKey, ftsPairKey, foldJournal, planPending, selectFtsRuns,
  chunkIdentityRows, dbIdentityRows, ftsOrphanedAttempts,
} from '../e1-fts-report.mjs';
import { buildFtsSchedule } from '../e1-fts-schedule.mjs';

const run = (arm, tier, block, over = {}) => ({
  type: 'run', arm, tier, block, at: `2026-08-14T00:0${block}:00Z`,
  chunk_count: 1000, db_bytes: 4096, phase_ms: { write: 100 },
  write_spans: { fts_del: 50, fts_ins: 20, commit: 15, rest: 10, txn: 3, lock: 2 },
  ...over,
});
const voided = (arm, tier, block, reason = 'gate_tiling') => ({
  type: 'void', arm, tier, block, reason, at: `2026-08-14T00:0${block}:30Z`,
});

describe('keys', () => {
  it('identifies a cell by arm, rung and block', () => {
    expect(ftsKey({ arm: 'G', tier: 'T9', block: 2 })).toBe('G#T9#b2');
  });

  it('identifies a pair by rung and block, which is what a ratio is taken over', () => {
    expect(ftsPairKey({ arm: 'G', tier: 'T9', block: 2 })).toBe('T9#b2');
  });
});

describe('foldJournal — append-only records into current state', () => {
  it('records a completed run', () => {
    const { done } = foldJournal([run('A', 'T1', 1)]);
    expect([...done.keys()]).toEqual(['A#T1#b1']);
  });

  // RR6. E1-PHASE's fold left a void in the map forever, which pinned
  // `scoreable` false permanently once anything had ever voided. Unexercised
  // there because nothing voided; the tiling gate makes a void plausible here.
  it('dequeues a void when the cell is later re-run clean', () => {
    const f = foldJournal([voided('A', 'T1', 1), run('A', 'T1', 1)]);
    expect(f.voids.size).toBe(0);
    expect(f.resolved_voids).toHaveLength(1);
    expect(f.resolved_voids[0]).toMatchObject({ key: 'A#T1#b1', void_reason: 'gate_tiling' });
  });

  it('lets a later void supersede an earlier clean run', () => {
    const f = foldJournal([run('A', 'T1', 1), voided('A', 'T1', 1)]);
    expect(f.done.size).toBe(0);
    expect(f.voids.size).toBe(1);
  });

  // A re-paired control is a second `run` record for a key that already has
  // one, and it is meant to supersede — but silently replacing a record is
  // exactly the kind of thing a reader must be told about.
  it('lets a later run supersede an earlier one, and says so', () => {
    const f = foldJournal([run('A', 'T1', 1), run('A', 'T1', 1, { chunk_count: 1001 })]);
    expect(f.done.get('A#T1#b1').chunk_count).toBe(1001);
    expect(f.superseded).toHaveLength(1);
  });
});

describe('selectFtsRuns — what enters the score', () => {
  const clean = buildFtsSchedule().map((c) => run(c.arm, c.tier, c.block));

  it('is scoreable when every cell completed and nothing voided', () => {
    const sel = selectFtsRuns(clean);
    expect(sel.runs).toHaveLength(30);
    expect(sel.scoreable).toBe(true);
  });

  it('is not scoreable while a void is unresolved', () => {
    expect(selectFtsRuns([...clean, voided('G', 'T5', 2)]).scoreable).toBe(false);
  });

  it('is not scoreable when a cell never ran', () => {
    expect(selectFtsRuns(clean.slice(0, 29)).scoreable).toBe(false);
  });

  // THE DIFFERENCE FROM E1-AB, and the reason this module is not an import of
  // that one. E1-AB had four arms sharing one control, so only a CONTROL void
  // poisoned the pair. E1-FTS has exactly two arms and the estimator is their
  // ratio, so a void on EITHER arm leaves the other with nothing to divide by.
  it('poisons a pair when EITHER arm voids, not only the control', () => {
    const sel = selectFtsRuns([...clean, voided('G', 'T5', 2)]);
    expect(sel.poisoned_pairs).toEqual(['T5#b2']);
    expect(sel.runs.some((r) => r.tier === 'T5' && r.block === 2)).toBe(false);
    // and the other blocks at that rung are untouched
    expect(sel.runs.filter((r) => r.tier === 'T5')).toHaveLength(4);
  });

  it('poisons the pair when the control voids too', () => {
    expect(selectFtsRuns([...clean, voided('A', 'T5', 2)]).poisoned_pairs).toEqual(['T5#b2']);
  });
});

describe('planPending — what still has to run', () => {
  const schedule = buildFtsSchedule();

  it('plans the whole schedule when nothing has run', () => {
    expect(planPending(schedule, { done: new Map(), voids: new Map() })).toHaveLength(30);
  });

  it('plans nothing when everything is done', () => {
    const { done, voids } = foldJournal(schedule.map((c) => run(c.arm, c.tier, c.block)));
    expect(planPending(schedule, { done, voids })).toHaveLength(0);
  });

  // The primary estimator is a within-block ratio, so a cell re-run hours after
  // its block no longer cancels drift against the partner that block already
  // has. Re-running the pair keeps both halves temporally adjacent.
  it('re-runs the whole pair when one half voided, not just the voided half', () => {
    const records = [...schedule.map((c) => run(c.arm, c.tier, c.block)), voided('G', 'T5', 2)];
    const { done, voids } = foldJournal(records);
    const pending = planPending(schedule, { done, voids });

    expect(pending.map(ftsKey).sort()).toEqual(['A#T5#b2', 'G#T5#b2']);
    expect(pending.find((c) => c.arm === 'A').reason).toBe('repair_pair');
  });

  it('emits the control first in a repair, so the pair is measured in estimator order', () => {
    const records = [...schedule.map((c) => run(c.arm, c.tier, c.block)), voided('G', 'T9', 3)];
    const { done, voids } = foldJournal(records);
    expect(planPending(schedule, { done, voids })[0].arm).toBe('A');
  });

  // On the FIRST pass the schedule's own alternating order is registered and
  // must not be reordered — hoisting the control would defeat the positional
  // alternation the design paid for.
  it('preserves the registered order on the initial pass', () => {
    const pending = planPending(schedule, { done: new Map(), voids: new Map() });
    expect(pending.map(ftsKey)).toEqual(schedule.map(ftsKey));
  });
});

describe('chunkIdentityRows — the two arms must have indexed identical corpora', () => {
  const rows = (records) => chunkIdentityRows(selectFtsRuns(records).runs);

  it('passes when every run at a rung reports the same chunk count', () => {
    const clean = buildFtsSchedule().map((c) => run(c.arm, c.tier, c.block));
    expect(rows(clean).every((r) => r.identical)).toBe(true);
  });

  // Arm G differs from the control by one flag that must not change WHAT is
  // indexed. A chunk-count divergence means it did, and every ratio computed
  // across the two would be comparing different work.
  it('fails a rung where the arms disagree', () => {
    const clean = buildFtsSchedule().map((c) =>
      run(c.arm, c.tier, c.block, c.arm === 'G' && c.tier === 'T5' ? { chunk_count: 999 } : {}));
    const t5 = rows(clean).find((r) => r.tier === 'T5');
    expect(t5.identical).toBe(false);
    expect(t5.chunk_counts).toContain(999);
  });
});

// The gate that makes arm G confound-free. Arm F was cut because a ~69% smaller
// database confounds "FTS work removed" with "smaller database"; arm G's claim
// is that skipping deletes which match nothing changes no bytes at all.
describe('dbIdentityRows — arm G must not have changed the database', () => {
  it('passes when both arms of every pair produce identical bytes', () => {
    const clean = buildFtsSchedule().map((c) => run(c.arm, c.tier, c.block));
    const rows = dbIdentityRows(selectFtsRuns(clean).runs);
    expect(rows).toHaveLength(15);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it('fails the pair where arm G shrank the database, naming the delta', () => {
    const clean = buildFtsSchedule().map((c) =>
      run(c.arm, c.tier, c.block, c.arm === 'G' && c.tier === 'T9' && c.block === 1
        ? { db_bytes: 4000 } : {}));
    const bad = dbIdentityRows(selectFtsRuns(clean).runs).filter((r) => !r.ok);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ tier: 'T9', block: 1, delta_bytes: -96 });
  });

  it('reports a pair missing an arm rather than silently skipping it', () => {
    const partial = buildFtsSchedule()
      .filter((c) => !(c.arm === 'G' && c.tier === 'T1' && c.block === 1))
      .map((c) => run(c.arm, c.tier, c.block));
    const row = dbIdentityRows(selectFtsRuns(partial).runs).find((r) => r.tier === 'T1' && r.block === 1);
    expect(row.ok).toBe(false);
    expect(row.reason).toBe('db_size_unreadable');
  });
});

// Found by smoking the driver at --limit 2: a mid-schedule summary reported
// fourteen DB IDENTITY failures for pairs that had simply not run yet. An
// operator who learns to scroll past this gate is one who will scroll past the
// time it fires for real.
describe('dbIdentityRows — a pair that has not run is pending, not failing', () => {
  it('marks an entirely un-run pair pending rather than failed', () => {
    const rows = dbIdentityRows([run('A', 'T1', 1), run('G', 'T1', 1)]);
    const untouched = rows.filter((r) => !(r.tier === 'T1' && r.block === 1));
    expect(untouched).toHaveLength(14);
    expect(untouched.every((r) => r.pending === true && r.ok === null)).toBe(true);
  });

  it('still adjudicates the pair that did run', () => {
    const row = dbIdentityRows([run('A', 'T1', 1), run('G', 'T1', 1)])
      .find((r) => r.tier === 'T1' && r.block === 1);
    expect(row).toMatchObject({ pending: false, ok: true });
  });

  // A HALF-populated pair is genuinely incomplete, not pending — one arm ran and
  // the other is missing, which is the shape a lost run leaves behind.
  it('does not hide a half-populated pair behind pending', () => {
    const row = dbIdentityRows([run('A', 'T1', 1)]).find((r) => r.tier === 'T1' && r.block === 1);
    expect(row.pending).toBe(false);
    expect(row.ok).toBe(false);
  });
});

// Found on the real schedule: after the voided T3/b1 pair was repaired, the
// summary reported five INTERRUPTED attempts that never happened. E1's
// `orphanedAttempts` compares ALL of a key's starts against only the LAST
// terminal record, so both passes' attempts are charged to the second pass.
//
// Not cosmetic — orphan counts feed `remainingAttempts`, which shrinks a
// resumed cell's Gate 3 budget and at the limit auto-voids it.
describe('ftsOrphanedAttempts — repair-aware interruption detection', () => {
  const start = (arm, tier, block, attempt, at) => ({ type: 'attempt_start', arm, tier, block, attempt, at });
  const ran = (arm, tier, block, attempts, at) => ({
    type: 'run', arm, tier, block, at, gate3_attempts: Array.from({ length: attempts }, (_, i) => ({ attempt: i + 1 })),
  });

  it('reports nothing for a cell that ran once, first time', () => {
    expect(ftsOrphanedAttempts([start('A', 'T1', 1, 1, 't0'), ran('A', 'T1', 1, 1, 't1')])).toEqual([]);
  });

  it('reports nothing for a cell that retook and then completed', () => {
    expect(ftsOrphanedAttempts([
      start('A', 'T1', 1, 1, 't0'), start('A', 'T1', 1, 2, 't1'), ran('A', 'T1', 1, 2, 't2'),
    ])).toEqual([]);
  });

  // The exact shape that produced the false report: two passes over one cell,
  // each internally complete.
  it('reports nothing when a cell legitimately ran twice — first pass then repair', () => {
    expect(ftsOrphanedAttempts([
      start('A', 'T3', 1, 1, 't0'), start('A', 'T3', 1, 2, 't1'), ran('A', 'T3', 1, 2, 't2'),
      start('A', 'T3', 1, 1, 't3'), start('A', 'T3', 1, 2, 't4'), ran('A', 'T3', 1, 2, 't5'),
    ])).toEqual([]);
  });

  it('reports nothing when a void segment is followed by a clean repair', () => {
    expect(ftsOrphanedAttempts([
      start('G', 'T3', 1, 1, 't0'), start('G', 'T3', 1, 2, 't1'), start('G', 'T3', 1, 3, 't2'),
      { type: 'void', arm: 'G', tier: 'T3', block: 1, attempt: 3, at: 't3' },
      start('G', 'T3', 1, 1, 't4'), ran('G', 'T3', 1, 1, 't5'),
    ])).toEqual([]);
  });

  // The case orphan detection actually exists for — a killed process leaves a
  // start with no terminal record after it.
  it('reports a start left pending at the end of the journal', () => {
    const o = ftsOrphanedAttempts([start('A', 'T9', 2, 1, 'tX')]);
    expect(o).toHaveLength(1);
    expect(o[0].key).toBe('A#T9#b2');
  });

  // A kill mid-retake: three starts but the terminal record only accounts for
  // two, so the earliest was killed.
  it('reports a start killed inside a segment, taking the earliest', () => {
    const o = ftsOrphanedAttempts([
      start('A', 'T5', 1, 1, 'early'), start('A', 'T5', 1, 1, 'mid'), start('A', 'T5', 1, 2, 'late'),
      ran('A', 'T5', 1, 2, 'done'),
    ]);
    expect(o).toHaveLength(1);
    expect(o[0].at).toBe('early');
  });

  it('still reports a pending start that follows a completed segment', () => {
    const o = ftsOrphanedAttempts([
      start('A', 'T1', 1, 1, 't0'), ran('A', 'T1', 1, 1, 't1'), start('A', 'T1', 1, 1, 't2'),
    ]);
    expect(o).toHaveLength(1);
    expect(o[0].at).toBe('t2');
  });
});
