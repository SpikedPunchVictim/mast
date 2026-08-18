import { describe, it, expect } from 'vitest';
import { foldRuns, count, checkRuns } from '../e1-fts-invariant.mjs';

describe('foldRuns', () => {
  it('keeps the last write for a repeated key', () => {
    const { runs } = foldRuns([
      { type: 'run', tier: 'T1', block: 1, chunk_count: 10 },
      { type: 'run', tier: 'T1', block: 1, chunk_count: 20 },
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].chunk_count).toBe(20);
  });

  it('removes a key that was voided after its run', () => {
    const { runs, voided } = foldRuns([
      { type: 'run', tier: 'T1', block: 1, chunk_count: 10 },
      { type: 'void', tier: 'T1', block: 1, reason: 'write_errors' },
    ]);

    expect(runs).toHaveLength(0);
    expect(voided).toEqual(['T1#1']);
  });

  it('distinguishes arms that share a tier and block', () => {
    const { runs } = foldRuns([
      { type: 'run', arm: 'N', tier: 'T9', block: 1, chunk_count: 10 },
      { type: 'run', arm: 'H', tier: 'T9', block: 1, chunk_count: 10 },
    ]);

    // Collapsing these would silently halve every two-arm journal.
    expect(runs).toHaveLength(2);
  });
});

describe('count', () => {
  it('prefers the top-level field', () => {
    expect(count({ chunk_fts_count: 7, measurement: { chunk_fts_count: 9 } }, 'chunk_fts_count'))
      .toEqual({ value: 7, source: 'top-level' });
  });

  it('falls back to measurement when the field is absent at the top level', () => {
    // e1-ladder carries both FTS counts ONLY under `measurement`.
    expect(count({ measurement: { chunk_fts_count: 9 } }, 'chunk_fts_count'))
      .toEqual({ value: 9, source: 'measurement' });
  });

  it('reports an absent field rather than returning a falsy count', () => {
    // A silent `undefined` here becomes NaN in any ratio built on it.
    expect(count({ measurement: {} }, 'chunk_fts_count')).toEqual({ value: undefined, source: null });
  });
});

describe('checkRuns', () => {
  const run = (over = {}) => ({ __key: 'k', chunk_count: 100, chunk_fts_count: 100, identifier_fts_count: 95, ...over });

  it('holds when every chunk has exactly one chunk_fts row', () => {
    const res = checkRuns('j', [run(), run({ __key: 'k2' })]);

    expect(res.violations).toEqual([]);
    expect(res.held).toBe(2);
  });

  it('flags a run where chunk_fts rows were orphaned by the delete guard', () => {
    // The failure this whole script exists to catch: a guard that skips the delete for a
    // file that HAD been indexed is just as fast and leaves rows behind.
    const res = checkRuns('j', [run({ chunk_fts_count: 137 })]);

    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]).toMatchObject({ reason: 'identity_broken', delta: 37 });
  });

  it('flags a run whose chunk_fts_count is missing entirely', () => {
    const res = checkRuns('j', [{ __key: 'k', chunk_count: 100, measurement: {} }]);

    expect(res.violations[0]).toMatchObject({ reason: 'field_absent' });
  });

  it('does not count a violating run as holding', () => {
    const res = checkRuns('j', [run({ chunk_fts_count: 99 })]);

    expect(res.held).toBe(0);
  });

  it('records the identifier ratio against chunk_count', () => {
    const res = checkRuns('j', [run({ chunk_count: 200, chunk_fts_count: 200, identifier_fts_count: 190 })]);

    expect(res.ratios[0].ratio).toBeCloseTo(0.95, 10);
  });
});
