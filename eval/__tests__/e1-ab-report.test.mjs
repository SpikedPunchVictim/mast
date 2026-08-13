// E1-AB — the journal seam.
//
// The first block is the fix for RR6, the latent defect the E1-PHASE results
// review found and could not exercise: a VOID that is later re-run clean must
// leave the queue, or `scoreable` is pinned false forever. Gate A makes a VOID
// genuinely plausible here, so it is tested rather than reasoned about.
//
// Run from `packages/mast`, never the repo root.

import { describe, it, expect } from 'vitest';
import { foldJournal, selectAbRuns, gateP2, planPending, abKey } from '../e1-ab-report.mjs';
import { AB_TOTAL_RUNS, buildAbSchedule } from '../e1-ab-schedule.mjs';
import { orphanedAttempts } from '../e1-schedule.mjs';

const run = (arm, tier, block, extra = {}) =>
  ({ type: 'run', arm, tier, block, chunk_count: 100, write_ms: 10, duration_ms: 12, at: 't', ...extra });
const voided = (arm, tier, block, reason = 'gate_a_cache_size_mismatch') =>
  ({ type: 'void', arm, tier, block, reason, at: 't' });

/** A complete, clean journal for the registered schedule. */
function fullJournal() {
  const chunks = { T1: 3679, T5: 16529, T9: 73359 };
  return buildAbSchedule().map((c) =>
    run(c.arm, c.tier, c.block, { chunk_count: chunks[c.tier] }));
}

describe('foldJournal — the VOID queue dequeues (RR6)', () => {
  it('leaves an unresolved void in the queue', () => {
    const { done, voids } = foldJournal([voided('B', 'T9', 1)]);
    expect([...voids.keys()]).toEqual(['B#T9#b1']);
    expect(done.size).toBe(0);
  });

  // The defect itself. E1-PHASE's version kept the void forever.
  it('resolves a void when the cell is later re-run clean', () => {
    const { done, voids, resolved_voids } = foldJournal([
      voided('B', 'T9', 1),
      run('B', 'T9', 1),
    ]);
    expect(voids.size).toBe(0);
    expect(done.has('B#T9#b1')).toBe(true);
    expect(resolved_voids).toHaveLength(1);
    expect(resolved_voids[0].void_reason).toMatch(/gate_a/);
  });

  it('keeps the resolution auditable rather than erasing the void', () => {
    const { resolved_voids } = foldJournal([voided('D', 'T1', 2, 'gate_p_below_floor'), run('D', 'T1', 2)]);
    expect(resolved_voids[0]).toMatchObject({ key: 'D#T1#b2', void_reason: 'gate_p_below_floor' });
  });

  // A void arriving after a completed run supersedes it — the run is no longer
  // current state. Documented behaviour, not an accident.
  it('lets a later void supersede an earlier completed run', () => {
    const { done, voids } = foldJournal([run('B', 'T5', 1), voided('B', 'T5', 1)]);
    expect(done.has('B#T5#b1')).toBe(false);
    expect(voids.has('B#T5#b1')).toBe(true);
  });

  // AMENDMENT 1 A6: a re-paired control is a SECOND run record for a key that
  // already has one, and it is meant to replace it.
  it('lets a re-paired control supersede the stale one, and records it', () => {
    const { done, superseded } = foldJournal([
      run('A', 'T9', 1, { write_ms: 500 }),
      run('A', 'T9', 1, { write_ms: 520 }),
    ]);
    expect(done.get('A#T9#b1').write_ms).toBe(520);
    expect(superseded).toHaveLength(1);
  });
});

describe('selectAbRuns — an unresolved control void poisons its block-pair', () => {
  it('is scoreable when every cell completed clean', () => {
    const sel = selectAbRuns(fullJournal());
    expect(sel.runs).toHaveLength(AB_TOTAL_RUNS);
    expect(sel.scoreable).toBe(true);
  });

  it('becomes scoreable again after a void is re-run (RR6, end to end)', () => {
    const records = fullJournal();
    // Cell B/T9/b2 voided and was re-run: void record, then a fresh run.
    const i = records.findIndex((r) => abKey(r) === 'B#T9#b2');
    records.splice(i, 1, voided('B', 'T9', 2), run('B', 'T9', 2, { chunk_count: 73359 }));
    const sel = selectAbRuns(records);
    expect(sel.scoreable).toBe(true);
    expect(sel.resolved_voids).toHaveLength(1);
  });

  it('is not scoreable while a void is unresolved', () => {
    const records = fullJournal();
    records.push(voided('B', 'T9', 2));
    expect(selectAbRuns(records).scoreable).toBe(false);
  });

  // The load-bearing exclusion. Dividing a fresh arm run by a control measured
  // at another time is exactly the drift the within-block estimator removes.
  it('excludes every arm in a block whose CONTROL void is unresolved', () => {
    const records = fullJournal();
    records.push(voided('A', 'T9', 3));
    const sel = selectAbRuns(records);
    expect(sel.poisoned_pairs).toEqual(['T9#b3']);
    expect(sel.runs.some((r) => r.tier === 'T9' && r.block === 3)).toBe(false);
    // Other blocks at the same rung are untouched.
    expect(sel.runs.filter((r) => r.tier === 'T9' && r.block === 1)).toHaveLength(3);
  });

  it('does not poison a block when a non-control arm voids', () => {
    const records = fullJournal();
    records.push(voided('B', 'T9', 3));
    const sel = selectAbRuns(records);
    expect(sel.poisoned_pairs).toEqual([]);
    expect(sel.runs.some((r) => r.arm === 'A' && r.tier === 'T9' && r.block === 3)).toBe(true);
  });
});

describe('gateP2 — work identity across ARMS, not just repetitions', () => {
  it('passes when every run at a rung reports the same chunk count', () => {
    const rows = gateP2(selectAbRuns(fullJournal()).runs);
    expect(rows.every((r) => r.identical)).toBe(true);
  });

  it('counts arm C into T5\'s expected run total and nowhere else', () => {
    const rows = gateP2(selectAbRuns(fullJournal()).runs);
    expect(rows.find((r) => r.tier === 'T5').expected).toBe(12);
    expect(rows.find((r) => r.tier === 'T9').expected).toBe(9);
    expect(rows.find((r) => r.tier === 'T1').expected).toBe(9);
  });

  it('fails the rung when one arm indexed different work', () => {
    const records = fullJournal();
    records.find((r) => r.arm === 'D' && r.tier === 'T5').chunk_count = 16528;
    const rows = gateP2(selectAbRuns(records).runs);
    expect(rows.find((r) => r.tier === 'T5').identical).toBe(false);
    expect(rows.find((r) => r.tier === 'T9').identical).toBe(true);
  });
});

describe('planPending — AMENDMENT 1 A6\'s re-pairing', () => {
  const schedule = buildAbSchedule();

  it('schedules everything on a cold start', () => {
    expect(planPending(schedule, foldJournal([]))).toHaveLength(AB_TOTAL_RUNS);
  });

  it('schedules nothing once every cell is complete', () => {
    expect(planPending(schedule, foldJournal(fullJournal()))).toHaveLength(0);
  });

  // The A6 rule, and the gap in it. Re-running B alone would divide a fresh arm
  // run by a control measured however long ago the original block was. But
  // superseding that control silently re-pairs D against a control from a
  // different time too — so the whole block-pair group is re-run, control first.
  it('re-runs the whole block-pair group, control first', () => {
    const records = [...fullJournal(), voided('B', 'T9', 2)];
    const plan = planPending(schedule, foldJournal(records));
    expect(plan.map((c) => `${c.arm}#${c.tier}#b${c.block}`))
      .toEqual(['A#T9#b2', 'B#T9#b2', 'D#T9#b2']);
  });

  it('emits the control first, so the pair is measured in the estimator\'s order', () => {
    const records = [...fullJournal(), voided('D', 'T1', 1)];
    expect(planPending(schedule, foldJournal(records))[0].arm).toBe('A');
  });

  it('marks untouched arms as repairs rather than as missing runs', () => {
    const records = [...fullJournal(), voided('B', 'T5', 3)];
    const plan = planPending(schedule, foldJournal(records));
    expect(plan.find((c) => c.arm === 'A').reason).toBe('repair_pair');
    expect(plan.find((c) => c.arm === 'D').reason).toBe('repair_pair');
    expect(plan.find((c) => c.arm === 'B').reason).toBe('not_run');
  });

  it('does not disturb other blocks at the same rung', () => {
    const records = [...fullJournal(), voided('B', 'T9', 2)];
    const plan = planPending(schedule, foldJournal(records));
    expect(plan.every((c) => c.block === 2)).toBe(true);
  });

  // A voided CONTROL is the same case seen from the other side: every arm in
  // that block loses its denominator, so the whole group is re-measured.
  it('re-runs the whole group when the control itself voided', () => {
    const records = [...fullJournal(), voided('A', 'T9', 1)];
    const plan = planPending(schedule, foldJournal(records));
    expect(plan.map((c) => c.arm)).toEqual(['A', 'B', 'D']);
    expect(plan.every((c) => c.tier === 'T9' && c.block === 1)).toBe(true);
  });
});

/**
 * `orphanedAttempts` is E1's, shared with E1-PHASE's scored record. E1-AB needed
 * it keyed on `arm#tier#block` instead of `corpus#rep`, so the key became a
 * parameter. This pins that the generalisation left E1's own behaviour alone —
 * under the hardcoded key every E1-AB record would have collapsed into one
 * `undefined#undefined` bucket and mis-attributed every orphan.
 */
describe('orphanedAttempts — generalised without moving E1\'s behaviour', () => {
  it('still keys on corpus#rep by default', () => {
    const records = [
      { type: 'attempt_start', corpus: 'T9', rep: 1, attempt: 1, at: 't1' },
      { type: 'attempt_start', corpus: 'T9', rep: 1, attempt: 1, at: 't2' },
      { type: 'run', corpus: 'T9', rep: 1, gate3_attempts: [{ attempt: 1 }] },
    ];
    const orphans = orphanedAttempts(records);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].key).toBe('T9#1');
  });

  it('separates E1-AB cells that the default key would have merged', () => {
    const records = [
      { type: 'attempt_start', arm: 'A', tier: 'T9', block: 1, attempt: 1, at: 't1' },
      { type: 'attempt_start', arm: 'B', tier: 'T9', block: 1, attempt: 1, at: 't2' },
      { type: 'run', arm: 'A', tier: 'T9', block: 1, gate3_attempts: [{ attempt: 1 }] },
      { type: 'run', arm: 'B', tier: 'T9', block: 1, gate3_attempts: [{ attempt: 1 }] },
    ];
    expect(orphanedAttempts(records, abKey)).toHaveLength(0);
    // Under the default key both cells share one bucket and one is called an orphan.
    expect(orphanedAttempts(records).length).toBeGreaterThan(0);
  });
});
