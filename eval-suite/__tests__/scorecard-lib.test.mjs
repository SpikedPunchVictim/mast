import { describe, it, expect } from 'vitest';
import { scoreSets, countsOf, compareScorecards, formatComparison } from '../scorecard-lib.mjs';

const card = (items) => ({ items });
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
