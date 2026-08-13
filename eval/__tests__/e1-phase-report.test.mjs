// E1-PHASE — known-answer tests for the journal-to-scorer seam.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-PHASE PRE-REGISTRATION (2026-08-12).
//
// E1's results review (R5) found that its reporting seam was written AFTER the data existed
// and had discretion it happened not to exercise. The lesson recorded there — "it happened
// not to matter is a finding about this dataset, not about the instrument" — is why the
// selection rule is pinned here rather than trusted.

import { describe, it, expect } from 'vitest';
import { PHASE_TIERS, PHASE_TOTAL_RUNS } from '../e1-phase-schedule.mjs';
import { selectPhaseRuns } from '../e1-phase-report.mjs';

/** A journal holding exactly the 15 registered runs, plus the attempt_starts they imply. */
function journal() {
  const records = [];
  for (const tier of PHASE_TIERS) {
    for (let rep = 1; rep <= 3; rep++) {
      records.push({ type: 'attempt_start', corpus: tier, rep, attempt: 1 });
      records.push({ type: 'run', corpus: tier, rep, tier, chunk_count: 1000, duration_ms: 1000 });
    }
  }
  return records;
}

describe('selectPhaseRuns — which records enter the fit', () => {
  it('returns exactly the 15 scored runs from a complete journal', () => {
    expect(selectPhaseRuns(journal())).toHaveLength(PHASE_TOTAL_RUNS);
  });

  it('ignores attempt_start records, which outnumber runs whenever Gate 3 retakes', () => {
    const records = journal();
    records.push({ type: 'attempt_start', corpus: 'T9', rep: 3, attempt: 2 });

    expect(selectPhaseRuns(records)).toHaveLength(PHASE_TOTAL_RUNS);
  });

  it('excludes VOID records rather than fitting a run that has no measurement', () => {
    const records = journal();
    records.push({ type: 'void', corpus: 'T5', rep: 2, reason: 'gate_p_attribution_below_floor' });

    expect(selectPhaseRuns(records).every((r) => r.type === 'run')).toBe(true);
  });

  it('refuses a duplicate pair — a resumed journal appends, and a duplicate over-weights it', () => {
    const records = journal();
    records.push({ type: 'run', corpus: 'T5', rep: 2, tier: 'T5', chunk_count: 1000, duration_ms: 999 });

    expect(() => selectPhaseRuns(records)).toThrow(/duplicate/i);
  });

  it('refuses a short journal rather than fitting whatever arrived', () => {
    const records = journal().filter((r) => !(r.type === 'run' && r.tier === 'T9' && r.rep === 3));

    expect(() => selectPhaseRuns(records)).toThrow(/expected 15/i);
  });
});
