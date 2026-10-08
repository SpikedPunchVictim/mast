import { describe, it, expect } from 'vitest';
import { scoreSets, countsOf, compareScorecards, formatComparison } from '../scorecard-lib.mjs';

const card = (items) => ({ items });
const meta = (m) => ({ root: 'r', tsconfig: 'tsconfig.json', prefix: '', scored_typescript_files: 3, ...m });
const buckets = (b) => ({ agree: [], wrong: [], lacks: [], extra: [], unjudged: [], ...b });

describe('scoreSets', () => {
  it('splits two sets of keys into what both have, what only the reference has, and what only mast has', () => {
    const scored = scoreSets(['a', 'b', 'c'], ['b', 'c', 'd']);

    expect(scored).toEqual(buckets({ agree: ['b', 'c'], lacks: ['a'], extra: ['d'] }));
  });

  it('counts a key once however often it is given', () => {
    const scored = scoreSets(['a', 'a'], ['a', 'a', 'a']);

    expect(scored.agree).toEqual(['a']);
  });
});

describe('countsOf', () => {
  it('gives the reference total as what agrees plus what mast lacks plus what mast has wrong', () => {
    const counts = countsOf(buckets({ agree: ['a', 'b'], wrong: ['c'], lacks: ['d'], extra: ['e'], unjudged: ['f'] }));

    expect(counts).toEqual({ reference: 4, mast: 5, agree: 2, wrong: 1, lacks: 1, extra: 1, unjudged: 1 });
  });
});

describe('compareScorecards', () => {
  it('reports a row whose counts did not move when five keys left and five others arrived', () => {
    const before = card({ calls: buckets({ agree: ['a1', 'a2', 'a3', 'a4', 'a5'] }) });
    const after = card({ calls: buckets({ agree: ['b1', 'b2', 'b3', 'b4', 'b5'] }) });

    const [row] = compareScorecards(before, after).rows;

    expect(row.delta.agree).toBe(0);
    expect(row.moves['agree -> absent']).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(row.moves['absent -> agree']).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
  });

  it('names the state a key came from and the state it went to', () => {
    const before = card({ calls: buckets({ lacks: ['x'], wrong: ['y'] }) });
    const after = card({ calls: buckets({ agree: ['x', 'y'] }) });

    const [row] = compareScorecards(before, after).rows;

    expect(row.moves).toEqual({ 'lacks -> agree': ['x'], 'wrong -> agree': ['y'] });
  });

  it('fails when a key that agreed no longer does', () => {
    const before = card({ calls: buckets({ agree: ['x'] }) });
    const after = card({ calls: buckets({ lacks: ['x'] }) });

    const result = compareScorecards(before, after);

    expect(result.lostAgree).toEqual([{ item: 'calls', key: 'x', now: 'lacks' }]);
    expect(result.pass).toBe(false);
  });

  // The corpus changed: the reference no longer has the key either. Had it kept it, the
  // key would be in `lacks`.
  it('does not fail on a key that agreed and that neither side has any more, when the corpus changed', () => {
    const before = { meta: meta({ corpus_hash: 'one' }), items: { calls: buckets({ agree: ['x'] }) } };
    const after = { meta: meta({ corpus_hash: 'two' }), items: { calls: buckets({}) } };

    const result = compareScorecards(before, after);

    expect(result.rows[0].moves).toEqual({ 'agree -> absent': ['x'] });
    expect(result.pass).toBe(true);
  });

  // The same files, so the reference cannot have dropped it by itself: mast lost the file
  // or the symbol the key was judged by.
  it('fails on a key that agreed and that neither side has any more, when the corpus is the same', () => {
    const before = { meta: meta({ corpus_hash: 'one' }), items: { calls: buckets({ agree: ['x'] }) } };
    const after = { meta: meta({ corpus_hash: 'one' }), items: { calls: buckets({}) } };

    const result = compareScorecards(before, after);

    expect(result.lostAgree).toEqual([{ item: 'calls', key: 'x', now: 'absent' }]);
    expect(result.pass).toBe(false);
  });

  it.each(['unjudged', 'extra'])('fails when a key arrives in %s', (bucket) => {
    const before = card({ calls: buckets({}) });
    const after = card({ calls: buckets({ [bucket]: ['x'] }) });

    const result = compareScorecards(before, after);

    expect(result.newUnverified).toEqual([{ item: 'calls', key: 'x', was: 'absent', now: bucket }]);
    expect(result.pass).toBe(false);
  });

  it.each([
    ['root', { root: 'other' }],
    ['tsconfig', { tsconfig: 'packages/cli/tsconfig.json' }],
    ['prefix', { prefix: 'packages/cli/' }],
  ])('refuses two scorecards with a different %s', (field, change) => {
    const before = { meta: meta({}), items: {} };
    const after = { meta: meta(change), items: {} };

    const result = compareScorecards(before, after);

    expect(result.refused).toEqual([expect.stringContaining(field)]);
    expect(result.pass).toBe(false);
  });

  it('refuses a scorecard that scored no file', () => {
    const before = { meta: meta({}), items: {} };
    const after = { meta: meta({ scored_typescript_files: 0 }), items: {} };

    const result = compareScorecards(before, after);

    expect(result.refused).toEqual([expect.stringContaining('no file')]);
    expect(result.pass).toBe(false);
  });

  it('fails when a key is wrong that was not wrong before', () => {
    const before = card({ calls: buckets({ unjudged: ['x'] }) });
    const after = card({ calls: buckets({ wrong: ['x'] }) });

    const result = compareScorecards(before, after);

    expect(result.newWrong).toEqual([{ item: 'calls', key: 'x', was: 'unjudged' }]);
    expect(result.pass).toBe(false);
  });

  it('passes when keys only move toward agreeing, and when nothing moves', () => {
    const before = card({ calls: buckets({ lacks: ['x'], agree: ['y'] }) });
    const after = card({ calls: buckets({ agree: ['x', 'y'] }) });

    expect(compareScorecards(before, after).pass).toBe(true);
    expect(compareScorecards(before, before).pass).toBe(true);
  });

  it('compares an item only one of the two runs has against an empty one', () => {
    const before = card({});
    const after = card({ symbols: buckets({ agree: ['s'] }) });

    const [row] = compareScorecards(before, after).rows;

    expect(row.item).toBe('symbols');
    expect(row.delta.agree).toBe(1);
  });
});

describe('formatComparison', () => {
  it('prints every row, and the keys behind a failure', () => {
    const before = card({ calls: buckets({ agree: ['x'] }), symbols: buckets({ agree: ['s'] }) });
    const after = card({ calls: buckets({ lacks: ['x'] }), symbols: buckets({ agree: ['s'] }) });

    const text = formatComparison(compareScorecards(before, after));

    expect(text).toContain('calls');
    expect(text).toContain('symbols');
    expect(text).toContain('agree -> lacks');
    expect(text).toContain('x');
    expect(text).toContain('FAIL');
  });
});
