// E1-FTS — the scorer's registered thresholds and the outcome ladder.
//
// Registration: IMPLEMENTATION_PLAN.md § E1-FTS PRE-REGISTRATION (2026-08-14),
// as amended by AMENDMENT 1 (same day, pre-run).
//
// Run from `packages/mast`, never the repo root.

import { describe, it, expect } from 'vitest';
import {
  B_FTS_DEL_FLOOR, FTS_DEL_SHARE_FLOOR, WRITE_RATIO_FLOOR, E1_SUPERLINEAR_THRESHOLD,
  VALIDITY_TOLERANCE, adjudicate, withinBlockRatios, rungShares, validityCheck,
  spilloverRows, NON_DELETE_SPANS,
} from '../e1-fts-score.mjs';

describe('the registered thresholds', () => {
  it('holds the four MECHANISM_IDENTIFIED bars exactly as registered', () => {
    expect(B_FTS_DEL_FLOOR).toBe(1.6);
    expect(FTS_DEL_SHARE_FLOOR).toBe(0.50);
    expect(WRITE_RATIO_FLOOR).toBe(2);
  });

  // Reused, not reinvented: below it, write is not super-linear by this
  // program's standing definition — a claim it has already committed to and
  // cannot renegotiate here.
  it('reuses E1\'s own immutable linearity threshold', () => {
    expect(E1_SUPERLINEAR_THRESHOLD).toBe(1.35);
  });

  it('holds the instrument-validity tolerance at 15%', () => {
    expect(VALIDITY_TOLERANCE).toBe(0.15);
  });
});

const verdictInput = (over = {}) => ({
  b_fts_del: 1.95,
  b_rest: 1.10,
  b_write_g: 1.20,
  share_fts_del_t9: 0.62,
  write_ratio_t9: 3.4,
  ...over,
});

describe('adjudicate — the registered outcome ladder', () => {
  it('returns MECHANISM_IDENTIFIED when all four conditions hold', () => {
    const v = adjudicate(verdictInput());
    expect(v.outcome).toBe('MECHANISM_IDENTIFIED');
    expect(v.conditions.every((c) => c.met)).toBe(true);
  });

  // NULL is keyed to the decomposition exponent ALONE, and is checked first:
  // it means the static model is wrong about in-build behaviour, which is a
  // publishable finding in its own right rather than a failed experiment.
  it('returns NULL when the delete exponent is below its floor, whatever else holds', () => {
    expect(adjudicate(verdictInput({ b_fts_del: 1.4 })).outcome).toBe('NULL');
    // Even with every other condition satisfied.
    expect(adjudicate(verdictInput({ b_fts_del: 1.59, write_ratio_t9: 9 })).outcome).toBe('NULL');
  });

  it('treats the floors as inclusive, exactly as written', () => {
    expect(adjudicate(verdictInput({ b_fts_del: 1.6 })).outcome).toBe('MECHANISM_IDENTIFIED');
    expect(adjudicate(verdictInput({ share_fts_del_t9: 0.50 })).outcome).toBe('MECHANISM_IDENTIFIED');
    expect(adjudicate(verdictInput({ write_ratio_t9: 2 })).outcome).toBe('MECHANISM_IDENTIFIED');
    expect(adjudicate(verdictInput({ b_write_g: 1.35 })).outcome).toBe('MECHANISM_IDENTIFIED');
  });

  // PARTIAL is FIRST-CLASS, registered in advance precisely so it cannot be
  // reported as a disappointment: `chunks` carries a TEXT primary key whose
  // autoindex is a plausible second super-linear term, and if it is real then
  // removing the delete-scan reduces the exponent without flattening it.
  it('returns PARTIAL when the decomposition holds but the intervention does not flatten', () => {
    expect(adjudicate(verdictInput({ b_write_g: 1.7 })).outcome).toBe('PARTIAL');
    expect(adjudicate(verdictInput({ write_ratio_t9: 1.4 })).outcome).toBe('PARTIAL');
  });

  it('returns PARTIAL when a second super-linear term survives in rest', () => {
    expect(adjudicate(verdictInput({ b_rest: 1.8 })).outcome).toBe('PARTIAL');
  });

  it('returns PARTIAL when the delete exponent holds but its T9 share does not', () => {
    expect(adjudicate(verdictInput({ share_fts_del_t9: 0.3 })).outcome).toBe('PARTIAL');
  });

  it('names every condition with its threshold, so the verdict is auditable', () => {
    const v = adjudicate(verdictInput({ b_write_g: 1.7 }));
    const failed = v.conditions.filter((c) => !c.met);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: 'b_write_g', threshold: 1.35, value: 1.7 });
  });

  // A degenerate fit must not be silently read as a number below a floor —
  // that would return NULL, the outcome most flattering to a broken instrument.
  it('refuses to adjudicate on a missing or degenerate exponent', () => {
    expect(adjudicate(verdictInput({ b_fts_del: null })).outcome).toBe('VOID');
    expect(adjudicate(verdictInput({ b_write_g: undefined })).outcome).toBe('VOID');
  });
});

describe('withinBlockRatios — the primary estimator', () => {
  const runs = [
    { block: 1, tier: 'T9', arm: 'A', phase_ms: { write: 300 } },
    { block: 1, tier: 'T9', arm: 'G', phase_ms: { write: 100 } },
    { block: 2, tier: 'T9', arm: 'A', phase_ms: { write: 400 } },
    { block: 2, tier: 'T9', arm: 'G', phase_ms: { write: 200 } },
    { block: 3, tier: 'T9', arm: 'A', phase_ms: { write: 500 } },
    { block: 3, tier: 'T9', arm: 'G', phase_ms: { write: 200 } },
  ];

  // Ratios are taken INSIDE a block, then medianed — never median-of-A over
  // median-of-G. Drift between blocks cancels in the first form and does not in
  // the second, which is the whole reason the blocks are contiguous.
  it('divides arm A by arm G inside each block before medianing', () => {
    const r = withinBlockRatios(runs, 'T9', (x) => x.phase_ms.write);
    expect(r.per_block).toEqual([3, 2, 2.5]);
    expect(r.median).toBe(2.5);
  });

  it('reports the spread across blocks rather than hiding it behind the median', () => {
    const r = withinBlockRatios(runs, 'T9', (x) => x.phase_ms.write);
    expect(r.spread).toBeCloseTo((3 - 2) / 2.5, 5);
  });

  it('drops a block that is missing an arm rather than pairing across blocks', () => {
    const partial = runs.filter((x) => !(x.block === 2 && x.arm === 'G'));
    const r = withinBlockRatios(partial, 'T9', (x) => x.phase_ms.write);
    expect(r.per_block).toEqual([3, 2.5]);
    expect(r.blocks_dropped).toEqual([2]);
  });

  it('returns no median when no block has both arms', () => {
    const r = withinBlockRatios(runs.filter((x) => x.arm === 'A'), 'T9', (x) => x.phase_ms.write);
    expect(r.median).toBeNull();
  });
});

describe('rungShares — both readings, and which one adjudicates', () => {
  const runs = [
    { block: 1, tier: 'T9', arm: 'A', phase_ms: { write: 100 }, write_spans: { fts_del: 40 } },
    { block: 2, tier: 'T9', arm: 'A', phase_ms: { write: 200 }, write_spans: { fts_del: 120 } },
    { block: 3, tier: 'T9', arm: 'A', phase_ms: { write: 300 }, write_spans: { fts_del: 210 } },
  ];

  // The registration names the condition "fts_del/write >= 0.50 at T9" without
  // saying which reading. Both are computed and BOTH are reported; the choice
  // of which adjudicates follows E1-PHASE's H1 precedent (the median run's own
  // share) and is fixed here, before data, rather than after.
  it('reports the median run\'s own share, which is what adjudicates', () => {
    expect(rungShares(runs, 'T9', 'fts_del').median_run).toBeCloseTo(120 / 200, 5);
  });

  it('also reports the median of the per-run shares', () => {
    expect(rungShares(runs, 'T9', 'fts_del').median_of_shares).toBeCloseTo(0.6, 5);
  });

  // Found by the adversarial results review. `median` of an EVEN sample is the
  // average of the two middle values, which equals no run's write phase — so
  // `find` returns undefined and the old `?? cell[0]` fallback silently selected
  // the FIRST run, which is not the median and is not even a median-adjacent
  // one. Unexercised at n=3, armed the moment a block is dropped.
  it('picks a genuinely median-adjacent run on an even sample, never the first', () => {
    const even = [
      { tier: 'T9', arm: 'A', phase_ms: { write: 400 }, write_spans: { fts_del: 360 } },
      { tier: 'T9', arm: 'A', phase_ms: { write: 100 }, write_spans: { fts_del: 10 } },
      { tier: 'T9', arm: 'A', phase_ms: { write: 200 }, write_spans: { fts_del: 100 } },
      { tier: 'T9', arm: 'A', phase_ms: { write: 300 }, write_spans: { fts_del: 240 } },
    ];
    // median write is (200+300)/2 = 250, which no run has. The chosen run must be
    // one of the two straddling it, never the 400 ms run that happens to be first.
    const share = rungShares(even, 'T9', 'fts_del').median_run;
    expect([share === 100 / 200 || share === 240 / 300, share]).toEqual([true, share]);
  });

  it('returns nulls rather than a number when the rung has no runs', () => {
    expect(rungShares(runs, 'T1', 'fts_del').median_run).toBeNull();
  });
});

// Two independent measurements of the same quantity. The registration is
// explicit that this ADJUDICATES NOTHING: disagreement condemns the instrument,
// not the hypothesis.
describe('validityCheck — the instrument grading itself', () => {
  it('passes when the intervention delta matches the directly-timed span', () => {
    const v = validityCheck({ writeA: 1000, writeG: 400, ftsDelA: 600 });
    expect(v.ok).toBe(true);
    expect(v.relative_error).toBeCloseTo(0, 5);
  });

  it('passes inside the registered 15% tolerance', () => {
    expect(validityCheck({ writeA: 1000, writeG: 400, ftsDelA: 530 }).ok).toBe(true);
  });

  it('fails when the two measurements disagree beyond tolerance', () => {
    const v = validityCheck({ writeA: 1000, writeG: 400, ftsDelA: 300 });
    expect(v.ok).toBe(false);
    expect(v.relative_error).toBeCloseTo(1, 5);
  });

  it('is explicitly marked as adjudicating nothing', () => {
    expect(validityCheck({ writeA: 1000, writeG: 400, ftsDelA: 600 }).adjudicates).toBe(false);
  });

  it('cannot divide by a zero span', () => {
    expect(validityCheck({ writeA: 1000, writeG: 400, ftsDelA: 0 }).ok).toBe(false);
  });
});

// The adversarial results review's finding 2. Arm G is faster at NON-delete work
// too — at T9 its non-delete spans are 7,858 ms lower and `rest` alone is +70%
// on arm A. So `write_A - write_G` is the delete span PLUS a secondary effect,
// almost certainly page-cache eviction by the scans. The effect was visible in
// the spans and went unreported; this gives it its own estimate.
//
// A FINDING, never a gate. It does not threaten the intervention result: the
// spillover is a causal CONSEQUENCE of the deletes, so it belongs in what
// removing them buys.
describe('spilloverRows — the eviction cost the deletes impose on everything else', () => {
  const spans = (over) => ({ fts_del: 0, fts_ins: 0, commit: 0, rest: 0, txn: 0, lock: 0, ...over });
  const r = (arm, tier, block, ftsDel, rest) => ({
    arm, tier, block,
    phase_ms: { write: ftsDel + rest },
    write_spans: spans({ fts_del: ftsDel, rest }),
  });

  it('names the five spans that are not the delete span', () => {
    expect(NON_DELETE_SPANS).toEqual(['fts_ins', 'commit', 'rest', 'txn', 'lock']);
  });

  it('measures arm A\'s non-delete work against arm G\'s, inside a block', () => {
    const runs = [r('A', 'T9', 1, 400, 100), r('G', 'T9', 1, 0, 60)];
    const row = spilloverRows(runs).find((x) => x.tier === 'T9');
    expect(row.spillover_ms).toBe(40);
  });

  // The number that matters for interpretation: how much of the intervention
  // delta is NOT the directly-timed delete span.
  it('reports the spillover as a share of the intervention delta', () => {
    const runs = [r('A', 'T9', 1, 400, 100), r('G', 'T9', 1, 0, 60)];
    const row = spilloverRows(runs).find((x) => x.tier === 'T9');
    // delta = 500 - 60 = 440; spillover 40 => 9.09%
    expect(row.share_of_delta).toBeCloseTo(40 / 440, 6);
  });

  it('breaks the spillover down by span, so its location is visible', () => {
    const runs = [
      { arm: 'A', tier: 'T9', block: 1, phase_ms: { write: 200 },
        write_spans: spans({ fts_del: 100, rest: 70, commit: 30 }) },
      { arm: 'G', tier: 'T9', block: 1, phase_ms: { write: 60 },
        write_spans: spans({ fts_del: 0, rest: 40, commit: 20 }) },
    ];
    const row = spilloverRows(runs).find((x) => x.tier === 'T9');
    expect(row.by_span.rest).toBe(30);
    expect(row.by_span.commit).toBe(10);
  });

  // A NEGATIVE spillover would mean arm G was slower at non-delete work, which
  // the eviction story does not predict. It must be reportable, not clamped.
  it('reports a negative spillover rather than clamping it to zero', () => {
    const runs = [r('A', 'T9', 1, 400, 50), r('G', 'T9', 1, 0, 80)];
    expect(spilloverRows(runs).find((x) => x.tier === 'T9').spillover_ms).toBe(-30);
  });

  it('takes the median across blocks and keeps the per-block values', () => {
    const runs = [
      r('A', 'T9', 1, 400, 100), r('G', 'T9', 1, 0, 60),
      r('A', 'T9', 2, 400, 120), r('G', 'T9', 2, 0, 60),
      r('A', 'T9', 3, 400, 110), r('G', 'T9', 3, 0, 60),
    ];
    const row = spilloverRows(runs).find((x) => x.tier === 'T9');
    expect(row.per_block).toEqual([40, 60, 50]);
    expect(row.spillover_ms).toBe(50);
  });

  it('reports nulls for a rung with no complete pair rather than a zero', () => {
    const row = spilloverRows([r('A', 'T1', 1, 10, 5)]).find((x) => x.tier === 'T1');
    expect(row.spillover_ms).toBeNull();
    expect(row.share_of_delta).toBeNull();
  });

  it('never adjudicates', () => {
    const runs = [r('A', 'T9', 1, 400, 100), r('G', 'T9', 1, 0, 60)];
    expect(spilloverRows(runs).every((x) => x.adjudicates === false)).toBe(true);
  });
});
