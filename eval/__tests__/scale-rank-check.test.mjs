// Unit tests for the PURE logic in eval/scale-rank-check.mjs — the hit rule (F4),
// censoring, mode integrity, and ordered-list equivalence. No real DB/lance/embedder
// touched (§8.4 registration Gate 1 precedent: ship tests before real data, never
// repeat ab-score.mjs's "registered but never implemented" defect).
//
//   pnpm -F mast test  (widened vitest.config.ts include picks this file up)

import { describe, it, expect } from 'vitest';
import {
  isExactTarget, isCounterpart, suppressionFired, findRank,
  censoredRank, inWindow, checkModeIntegrity, sameOrderedResults,
  preDedupRank, validateResultRow, WINDOW, DEPTH, CENSORED_RANK,
} from '../scale-rank-check.mjs';

function target(overrides) {
  return {
    file_path: 'src/foo.ts', start_line: 10, end_line: 20,
    chunk_type: 'function', symbol_name: 'doThing', parent_symbol: null,
    ...overrides,
  };
}

function result(overrides) {
  return {
    file_path: 'src/foo.ts', start_line: 10, end_line: 20,
    chunk_type: 'function', symbol_name: 'doThing', parent_symbol: null,
    ...overrides,
  };
}

describe('isExactTarget', () => {
  it('matches on file_path + exact start/end line', () => {
    expect(isExactTarget(target(), result())).toBe(true);
  });

  it('does not match a different file at the same lines', () => {
    expect(isExactTarget(target(), result({ file_path: 'src/bar.ts' }))).toBe(false);
  });

  it('does not match an overlapping but non-identical line range', () => {
    expect(isExactTarget(target(), result({ start_line: 11 }))).toBe(false);
  });
});

describe('isCounterpart (F4 shell<->method)', () => {
  it('a class_shell counts as the counterpart of a method target', () => {
    const t = target({ chunk_type: 'method', symbol_name: 'Foo.bar', parent_symbol: 'Foo' });
    const shell = result({ chunk_type: 'class_shell', symbol_name: 'Foo', parent_symbol: null, start_line: 1, end_line: 100 });
    expect(isCounterpart(t, shell)).toBe(true);
  });

  it('a method counts as the counterpart of a class_shell target', () => {
    const t = target({ chunk_type: 'class_shell', symbol_name: 'Foo', parent_symbol: null });
    const method = result({ chunk_type: 'method', symbol_name: 'Foo.bar', parent_symbol: 'Foo', start_line: 5, end_line: 8 });
    expect(isCounterpart(t, method)).toBe(true);
  });

  it('rejects a same-named class in a DIFFERENT file', () => {
    const t = target({ chunk_type: 'method', symbol_name: 'Foo.bar', parent_symbol: 'Foo' });
    const shell = result({ file_path: 'src/other.ts', chunk_type: 'class_shell', symbol_name: 'Foo' });
    expect(isCounterpart(t, shell)).toBe(false);
  });

  it('two methods never count as counterparts of each other', () => {
    const t = target({ chunk_type: 'method', symbol_name: 'Foo.bar', parent_symbol: 'Foo' });
    const otherMethod = result({ chunk_type: 'method', symbol_name: 'Foo.baz', parent_symbol: 'Foo' });
    expect(isCounterpart(t, otherMethod)).toBe(false);
  });
});

describe('suppressionFired', () => {
  it('fires when a kept shell\'s methods_matched hint names the method target', () => {
    const t = target({ chunk_type: 'method', symbol_name: 'Foo.bar', parent_symbol: 'Foo' });
    const shell = result({ chunk_type: 'class_shell', symbol_name: 'Foo', related: { methods_matched: ['Foo.bar', 'Foo.baz'] } });
    expect(suppressionFired(t, shell)).toBe(true);
  });

  it('does not fire when the hint names a DIFFERENT method', () => {
    const t = target({ chunk_type: 'method', symbol_name: 'Foo.bar', parent_symbol: 'Foo' });
    const shell = result({ chunk_type: 'class_shell', symbol_name: 'Foo', related: { methods_matched: ['Foo.baz'] } });
    expect(suppressionFired(t, shell)).toBe(false);
  });

  it('fires when a kept method\'s parent_symbol hint names the shell target', () => {
    const t = target({ chunk_type: 'class_shell', symbol_name: 'Foo' });
    const method = result({ chunk_type: 'method', symbol_name: 'Foo.bar', parent_symbol: 'Foo', related: { parent_symbol: 'Foo' } });
    expect(suppressionFired(t, method)).toBe(true);
  });

  it('does not fire when there is no related hint at all', () => {
    const t = target({ chunk_type: 'method', symbol_name: 'Foo.bar', parent_symbol: 'Foo' });
    const shell = result({ chunk_type: 'class_shell', symbol_name: 'Foo' });
    expect(suppressionFired(t, shell)).toBe(false);
  });
});

describe('findRank', () => {
  it('returns the 1-indexed rank and case "exact" for the target\'s own chunk', () => {
    const t = target();
    const list = [result({ start_line: 1, end_line: 2 }), result(), result({ start_line: 3, end_line: 4 })];
    expect(findRank(t, list)).toEqual({ rank: 2, case: 'exact', suppression_event: false });
  });

  it('returns case "counterpart" and the suppression flag when only the shell survives', () => {
    const t = target({ chunk_type: 'method', symbol_name: 'Foo.bar', parent_symbol: 'Foo' });
    const shell = result({
      chunk_type: 'class_shell', symbol_name: 'Foo', parent_symbol: null,
      start_line: 1, end_line: 100, related: { methods_matched: ['Foo.bar'] },
    });
    const list = [result({ file_path: 'other.ts', start_line: 50, end_line: 60 }), shell];
    expect(findRank(t, list)).toEqual({ rank: 2, case: 'counterpart', suppression_event: true });
  });

  it('returns null rank when absent from the scanned list (censoring input)', () => {
    const t = target({ symbol_name: 'nowhere' });
    const list = [result({ symbol_name: 'somethingElse', start_line: 99, end_line: 100 })];
    expect(findRank(t, list)).toEqual({ rank: null, case: null, suppression_event: false });
  });

  it('prefers the FIRST qualifying hit when both exact and a counterpart appear (exact wins by scan order)', () => {
    const t = target();
    const list = [result(), result({ chunk_type: 'class_shell', symbol_name: 'doThing' })];
    expect(findRank(t, list).case).toBe('exact');
  });
});

describe('censoring (DEPTH+1 = 201)', () => {
  it('CENSORED_RANK is DEPTH + 1', () => {
    expect(CENSORED_RANK).toBe(DEPTH + 1);
    expect(CENSORED_RANK).toBe(201);
  });

  it('passes a real rank through unchanged', () => {
    expect(censoredRank(5)).toBe(5);
  });

  it('censors a null rank to 201', () => {
    expect(censoredRank(null)).toBe(201);
  });
});

describe('inWindow (uncensored by construction)', () => {
  it('true at rank <= WINDOW', () => {
    expect(inWindow(WINDOW)).toBe(true);
    expect(inWindow(1)).toBe(true);
  });

  it('false just past WINDOW', () => {
    expect(inWindow(WINDOW + 1)).toBe(false);
  });

  it('false for a null (absent) rank, not a thrown error', () => {
    expect(inWindow(null)).toBe(false);
  });
});

describe('checkModeIntegrity (Gate 3)', () => {
  it('H call returning mode "hybrid" is valid', () => {
    expect(checkModeIntegrity('H', 'hybrid')).toEqual({ valid: true, arm: 'H', mode: 'hybrid' });
  });

  it('H call that silently decayed to "lexical" is INVALID — voids the tier-arm run', () => {
    expect(checkModeIntegrity('H', 'lexical').valid).toBe(false);
  });

  it('L call is expected to be "lexical" by construction (embedder: null)', () => {
    expect(checkModeIntegrity('L', 'lexical').valid).toBe(true);
  });

  it('throws on an unknown arm label rather than silently passing', () => {
    expect(() => checkModeIntegrity('V', 'hybrid')).toThrow();
  });
});

describe('sameOrderedResults (Gate 2 self-check comparator)', () => {
  it('true for two structurally identical ordered lists', () => {
    const a = [result(), result({ start_line: 30, end_line: 40 })];
    const b = [result(), result({ start_line: 30, end_line: 40 })];
    expect(sameOrderedResults(a, b)).toBe(true);
  });

  it('false when lengths differ', () => {
    expect(sameOrderedResults([result()], [])).toBe(false);
  });

  it('false when the order of two otherwise-identical chunks differs', () => {
    const a = [result({ start_line: 1, end_line: 2 }), result({ start_line: 3, end_line: 4 })];
    const b = [result({ start_line: 3, end_line: 4 }), result({ start_line: 1, end_line: 2 })];
    expect(sameOrderedResults(a, b)).toBe(false);
  });
});

describe('preDedupRank', () => {
  it('finds the target by chunk_id (ChunkRecord, not SearchResult)', () => {
    const t = { chunk_id: 'abc123' };
    const records = [{ chunk_id: 'zzz' }, { chunk_id: 'abc123' }, { chunk_id: 'yyy' }];
    expect(preDedupRank(t, records)).toBe(2);
  });

  it('returns null when the target chunk_id is absent', () => {
    const t = { chunk_id: 'missing' };
    const records = [{ chunk_id: 'a' }, { chunk_id: 'b' }];
    expect(preDedupRank(t, records)).toBeNull();
  });
});

describe('validateResultRow (shared results schema)', () => {
  function validRow(overrides) {
    return {
      query_id: 'q1', stratum: 's_ident', tier: 'T1', arm: 'H',
      mode: 'hybrid', in_window_10: true, censored_rank: 3,
      ...overrides,
    };
  }

  it('accepts a well-formed row', () => {
    expect(validateResultRow(validRow())).toBe(true);
  });

  it('throws when a required field is missing', () => {
    const row = validRow();
    delete row.censored_rank;
    expect(() => validateResultRow(row)).toThrow(/censored_rank/);
  });

  it('throws on an unknown stratum', () => {
    expect(() => validateResultRow(validRow({ stratum: 'bogus' }))).toThrow(/stratum/);
  });

  it('throws on an unknown tier', () => {
    expect(() => validateResultRow(validRow({ tier: 'T5' }))).toThrow(/tier/);
  });

  it('throws on an unknown arm', () => {
    expect(() => validateResultRow(validRow({ arm: 'V' }))).toThrow(/arm/);
  });

  it('throws when in_window_10 is not a boolean', () => {
    expect(() => validateResultRow(validRow({ in_window_10: 1 }))).toThrow(/in_window_10/);
  });
});
