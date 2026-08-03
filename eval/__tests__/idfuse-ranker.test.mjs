// Gate B — Q1/IDFUSE ranker I known-answer fixtures (IMPLEMENTATION_PLAN.md
// § "Q1/IDFUSE ... PRE-REGISTRATION + AMENDMENT 1", Gate B, extended per F1).
// Fixture db uses the REAL product schema/writer path: `openDatabase` builds
// the same `identifier_fts` FTS5 table shipped code uses
// (`src/graph/db.ts:287-292`), and rows are inserted with the SAME shape
// `populate.ts:205-213` uses (`{ identifiers, chunk_id, file_path }`), with
// `identifiers` computed via the REAL `extractIdentifiers`
// (`src/ast/extractors/typescript.ts:1430-1438`) — not a hand-rolled
// tokenizer. No real DB/lance/embedder assets touched; no scored query set
// touched (probes/fixtures only, per the hard rule).
//
//   pnpm -F mast test  (vitest.config.ts already includes eval/**/*.test.mjs)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../dist/graph/db.js';
import { extractIdentifiers } from '../../dist/ast/extractors/typescript.js';
import { splitIdentifierTerms } from '../../dist/search/fts.js';
import {
  deriveRankerITerms, deriveSymbolOnlyTerms, isSymbolShapedTerm,
  buildOrMatchExpression, searchRankerI, RANKER_I_POOL_MULTIPLIER,
} from '../idfuse-ranker.mjs';

// ---------------------------------------------------------------------------
// Pure term-derivation / expression-builder tests (no DB)
// ---------------------------------------------------------------------------

describe('deriveRankerITerms (F1 — raw /[A-Za-z0-9_$]+/ split, no camelCase split, no lowercase)', () => {
  it('splits a dotted Class.method query into two independent terms', () => {
    expect(deriveRankerITerms('Scrollable.getFutureScrollPosition')).toEqual([
      'Scrollable', 'getFutureScrollPosition',
    ]);
  });

  it('leaves a camelCase identifier WHOLE (no sub-split)', () => {
    expect(deriveRankerITerms('ScanCodeChord')).toEqual(['ScanCodeChord']);
  });

  it('does not lowercase', () => {
    expect(deriveRankerITerms('MyClass')).toEqual(['MyClass']);
  });

  it('includes $ in the token character class', () => {
    expect(deriveRankerITerms('$scope foo')).toEqual(['$scope', 'foo']);
  });

  it('returns an empty array for a query with no usable characters', () => {
    expect(deriveRankerITerms('!!! ...')).toEqual([]);
  });
});

describe('isSymbolShapedTerm / deriveSymbolOnlyTerms (F7 descriptive L+Isym predicate)', () => {
  it('qualifies a term with an uppercase letter', () => {
    expect(isSymbolShapedTerm('ScanCodeChord')).toBe(true);
  });

  it('qualifies a term with an underscore', () => {
    expect(isSymbolShapedTerm('my_var')).toBe(true);
  });

  it('qualifies a term with a dollar sign', () => {
    expect(isSymbolShapedTerm('$scope')).toBe(true);
  });

  it('qualifies a term with a digit adjacent to a letter', () => {
    expect(isSymbolShapedTerm('base64')).toBe(true);
    expect(isSymbolShapedTerm('64bit')).toBe(true);
  });

  it('does NOT qualify a bare lowercase prose word', () => {
    expect(isSymbolShapedTerm('whitespace')).toBe(false);
  });

  it('filters a mixed query down to only the symbol-shaped terms', () => {
    expect(deriveSymbolOnlyTerms('parses the ScanCodeChord value')).toEqual(['ScanCodeChord']);
  });
});

describe('buildOrMatchExpression (same phrase-quote + OR-join semantics as searchIdentifierNearMiss, fts.ts:140-154)', () => {
  it('phrase-quotes each term and OR-joins them', () => {
    expect(buildOrMatchExpression(['foo', 'bar'])).toBe('"foo" OR "bar"');
  });

  it('escapes embedded double quotes', () => {
    expect(buildOrMatchExpression(['a"b'])).toBe('"a""b"');
  });

  it('returns null for an empty term list', () => {
    expect(buildOrMatchExpression([])).toBeNull();
  });

  it('trims and drops blank terms before building', () => {
    expect(buildOrMatchExpression([' foo ', '', '  '])).toBe('"foo"');
  });
});

// ---------------------------------------------------------------------------
// Fixture-db known-answer tests (Gate B a-e)
// ---------------------------------------------------------------------------

describe('searchRankerI — Gate B known-answer fixtures', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'idfuse-gateb-'));
    db = openDatabase(tmpDir);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Insert one identifier_fts row the same way populate.ts does (populate.ts:205-213),
   * deriving `identifiers` via the real extractIdentifiers. */
  async function insertRow(chunkId, filePath, content) {
    await db
      .insertInto('identifier_fts')
      .values({ identifiers: extractIdentifiers(content), chunk_id: chunkId, file_path: filePath })
      .execute();
  }

  it('(a) dotted Class.method target: the OR-split anchors on the method term alone, even though the class name is absent from the method chunk\'s own bag', async () => {
    // Mirrors the registration's own scenario (IMPLEMENTATION_PLAN.md:3065-3073):
    // the class shell and its method are separate chunks; the method chunk's
    // identifier bag does not contain the class name.
    await insertRow('shell', 'scrollable.ts', 'class Scrollable {\n  getFutureScrollPosition(): number {}\n}');
    await insertRow('method', 'scrollable.ts', 'getFutureScrollPosition(): number {\n  return this.target;\n}');

    const methodBag = extractIdentifiers('getFutureScrollPosition(): number {\n  return this.target;\n}');
    expect(methodBag).not.toContain('Scrollable');

    const rows = await searchRankerI(db, 'Scrollable.getFutureScrollPosition', { limit: 10 });
    const ids = rows.map((r) => r.chunk_id);
    expect(ids).toContain('method');
  });

  it('(b) camelCase target: the unsplit whole token matches; camelCase-split terms do NOT', async () => {
    await insertRow('camel', 'chord.ts', 'function scanCodeChord() { return 1; }');

    // The unsplit raw query matches the whole indexed token under unicode61's
    // match-time case-folding.
    const unsplit = await searchRankerI(db, 'ScanCodeChord', { limit: 10 });
    expect(unsplit.map((r) => r.chunk_id)).toEqual(['camel']);

    // The ONLY production caller of the near-miss builder feeds
    // splitIdentifierTerms(query) — camelCase-split and lowercased
    // (fts.ts:170-184). Feeding those split terms through ranker I must find
    // NOTHING: the indexed token is the unsplit whole "scancodechord",
    // never sub-split by unicode61.
    const splitTerms = splitIdentifierTerms('ScanCodeChord');
    expect(splitTerms).toEqual(['scan', 'code', 'chord']);
    const splitResult = await searchRankerI(db, splitTerms.join(' '), { limit: 10 });
    expect(splitResult).toEqual([]);
  });

  it('(c) OR semantics: a chunk matching only ONE of two OR-joined terms still hits', async () => {
    await insertRow('onlyFoo', 'a.ts', 'function foo() {}');
    await insertRow('onlyBar', 'b.ts', 'function bar() {}');

    const rows = await searchRankerI(db, 'foo bar', { limit: 10 });
    const ids = rows.map((r) => r.chunk_id).sort();
    expect(ids).toEqual(['onlyBar', 'onlyFoo']);
  });

  it('(d) empty-match contributes nothing: a query with no usable terms returns an empty array', async () => {
    await insertRow('present', 'a.ts', 'function somethingReal() {}');
    const rows = await searchRankerI(db, '!!! ...', { limit: 10 });
    expect(rows).toEqual([]);
  });

  it('(e) bm25 ordering is applied — an unordered (rowid/insertion-order) SELECT would fail this test', async () => {
    // rowA inserted FIRST but is a long document (the term diluted among
    // filler identifiers); rowB inserted SECOND but is a short document
    // consisting of ONLY the matched term. BM25's length normalization ranks
    // the short, focused document as the better match (verified empirically:
    // rowA bm25 ~ -7.4e-7, rowB bm25 ~ -1.54e-6 — more negative is better).
    // FTS5's default (unordered) row order is rowid/insertion order, which
    // would return [rowA, rowB] — the OPPOSITE of the bm25-correct order —
    // so this assertion only passes because searchRankerI's explicit
    // `ORDER BY bm25(identifier_fts) ASC` is present.
    await insertRow(
      'rowA',
      'a.ts',
      'uniqueTargetToken padOne padTwo padThree padFour padFive padSix padSeven padEight padNine padTen padEleven padTwelve',
    );
    await insertRow('rowB', 'b.ts', 'uniqueTargetToken');

    const rows = await searchRankerI(db, 'uniqueTargetToken', { limit: 10 });
    expect(rows.map((r) => r.chunk_id)).toEqual(['rowB', 'rowA']);
    expect(rows[0].bm25_score).toBeLessThan(rows[1].bm25_score); // more negative = better
  });

  it('applies the caller-supplied limit directly (pool = 4x limit is the caller\'s responsibility, matching searchVectors\'s convention)', async () => {
    for (let i = 0; i < 5; i++) {
      await insertRow(`row${i}`, 'a.ts', `sharedTerm distinct${i}`);
    }
    const rows = await searchRankerI(db, 'sharedTerm', { limit: 3 });
    expect(rows).toHaveLength(3);
    // Sanity: the multiplier constant is exported and equals the registered 4x.
    expect(RANKER_I_POOL_MULTIPLIER).toBe(4);
  });

  it('the L+Isym symbol-only mode omits a bare prose term the primary ranker would use', async () => {
    await insertRow('proseHit', 'a.ts', 'a function about whitespaces and trimming');
    await insertRow('symbolHit', 'b.ts', 'function ScanCodeChord() {}');

    // Primary ranker I: both terms are used, so the prose-only chunk can hit.
    const primary = await searchRankerI(db, 'whitespaces ScanCodeChord', { limit: 10 });
    expect(primary.map((r) => r.chunk_id).sort()).toEqual(['proseHit', 'symbolHit']);

    // L+Isym: only the symbol-shaped term ("ScanCodeChord") is fed in, so the
    // prose-only chunk cannot hit through this arm.
    const symbolOnly = await searchRankerI(db, 'whitespaces ScanCodeChord', { limit: 10, symbolOnly: true });
    expect(symbolOnly.map((r) => r.chunk_id)).toEqual(['symbolHit']);
  });
});
