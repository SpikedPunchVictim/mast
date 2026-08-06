// Gate B — Q1/DECLEX ranker D known-answer fixtures, ported from
// `eval/__tests__/declex-ranker.test.mjs` (IMPLEMENTATION_PLAN.md §
// "Q1/DECLEX ... PRE-REGISTRATION" + AMENDMENT 1, Gate B, commit dd10796) into
// the product module `src/search/declex.ts` (Stage 6, PRIMARY ARM ONLY — see
// that module's header for the escape-variant exclusion).
//
// Fixture db uses the REAL product schema/writer path: `openDatabase` builds
// the same `chunks` table shipped code uses (`src/graph/db.ts`), and rows are
// inserted with the SAME column shape the AST extractor produces (`chunk_id,
// file_path, start_line, end_line, content, chunk_type, symbol_name,
// parent_symbol, is_exported, language, file_mtime` — `typescript.ts:280-330`),
// not a hand-rolled shape.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../graph/db.js';
import type { Db } from '../../graph/db.js';
import {
  deriveRankerDTerms, isEligiblePrimaryTerm, deriveEligiblePrimaryTerms,
  searchRankerD, RANKER_D_POOL_MULTIPLIER,
} from '../declex.js';

// ---------------------------------------------------------------------------
// Pure term-derivation / eligibility-gate tests (no DB)
// ---------------------------------------------------------------------------

describe('deriveRankerDTerms (raw /[A-Za-z0-9_$]+/ split, no camelCase split, no lowercase)', () => {
  it('splits a dotted Class.method query into two independent terms', () => {
    expect(deriveRankerDTerms('Scrollable.getFutureScrollPosition')).toEqual([
      'Scrollable', 'getFutureScrollPosition',
    ]);
  });

  it('leaves a camelCase identifier WHOLE (no sub-split)', () => {
    expect(deriveRankerDTerms('ScanCodeChord')).toEqual(['ScanCodeChord']);
  });

  it('does not lowercase', () => {
    expect(deriveRankerDTerms('MyClass')).toEqual(['MyClass']);
  });

  it('includes $ and _ in the token character class', () => {
    expect(deriveRankerDTerms('$scope my_var')).toEqual(['$scope', 'my_var']);
  });

  it('returns an empty array for a query with no usable characters', () => {
    expect(deriveRankerDTerms('!!! ...')).toEqual([]);
  });
});

describe('isEligiblePrimaryTerm (registered: isSymbolShapedTerm MINUS the dead dot clause)', () => {
  it('qualifies a term with an uppercase letter', () => {
    expect(isEligiblePrimaryTerm('ScanCodeChord')).toBe(true);
  });

  it('qualifies a term with an underscore', () => {
    expect(isEligiblePrimaryTerm('my_var')).toBe(true);
  });

  it('qualifies a term with a dollar sign', () => {
    expect(isEligiblePrimaryTerm('$scope')).toBe(true);
  });

  it('qualifies a term with a digit adjacent to a letter', () => {
    expect(isEligiblePrimaryTerm('base64')).toBe(true);
    expect(isEligiblePrimaryTerm('64bit')).toBe(true);
  });

  it('does NOT qualify a bare lowercase prose word', () => {
    expect(isEligiblePrimaryTerm('whitespace')).toBe(false);
  });

  it('has no dot clause at all — a term could never contain a literal dot post-split anyway, but the predicate does not test for one (registered omission)', () => {
    // Sanity: the predicate's source has no `.includes('.')` branch; this is
    // a smoke check that a dot-bearing string (which could never actually
    // reach this function post-split) does not spuriously qualify solely by
    // virtue of containing a dot.
    expect(isEligiblePrimaryTerm('a.b')).toBe(false);
  });

  it('filters a mixed query down to only the eligible terms', () => {
    expect(deriveEligiblePrimaryTerms('parses the ScanCodeChord value')).toEqual(['ScanCodeChord']);
  });
});

// ---------------------------------------------------------------------------
// Fixture-db known-answer tests (Gate B a-h, primary arm only)
// ---------------------------------------------------------------------------

describe('searchRankerD — Gate B known-answer fixtures', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'declex-gateb-'));
    db = openDatabase(tmpDir);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Insert one chunk row the same shape the AST extractor produces
   * (typescript.ts:280-330) — chunk_id, symbol_name, chunk_type, parent_symbol
   * are the columns ranker D reads; the rest are filled with harmless values. */
  async function insertChunk(o: {
    chunk_id: string;
    chunk_type: string;
    symbol_name: string;
    parent_symbol?: string | null;
    file_path?: string;
    start_line?: number;
    end_line?: number;
    content?: string;
  }): Promise<void> {
    await db.insertInto('chunks').values({
      chunk_id: o.chunk_id,
      file_path: o.file_path ?? 'a.ts',
      start_line: o.start_line ?? 1,
      end_line: o.end_line ?? 2,
      content: o.content ?? 'x',
      chunk_type: o.chunk_type,
      symbol_name: o.symbol_name,
      parent_symbol: o.parent_symbol ?? null,
      is_exported: 1,
      language: 'typescript',
      file_mtime: 0,
    }).execute();
  }

  it('(a) dotted Class.method target: the method-name term SEGMENT-matches the method chunk directly', async () => {
    await insertChunk({ chunk_id: 'shell', chunk_type: 'class_shell', symbol_name: 'Scrollable' });
    await insertChunk({ chunk_id: 'method', chunk_type: 'method', symbol_name: 'Scrollable.getFutureScrollPosition', parent_symbol: 'Scrollable' });

    const { rows } = await searchRankerD(db, 'Scrollable.getFutureScrollPosition', { limit: 40 });
    const methodRow = rows.find((r) => r.chunk_id === 'method');
    expect(methodRow).toBeDefined();
    expect(methodRow?.match_type).toBe('segment');
    const shellRow = rows.find((r) => r.chunk_id === 'shell');
    expect(shellRow).toBeDefined();
    expect(shellRow?.match_type).toBe('full');
  });

  it('(b) camelCase target: the unsplit whole token FULL-matches a function chunk of the same name', async () => {
    await insertChunk({ chunk_id: 'camel', chunk_type: 'function', symbol_name: 'ScanCodeChord' });

    const { rows } = await searchRankerD(db, 'ScanCodeChord', { limit: 10 });
    expect(rows.map((r) => r.chunk_id)).toEqual(['camel']);
    expect(rows[0]?.match_type).toBe('full');
  });

  it('(c) case-insensitivity: an eligible (mixed-case) token matches a symbol_name stored in a different case', async () => {
    await insertChunk({ chunk_id: 'caseTest', chunk_type: 'function', symbol_name: 'scanCodeChord' });

    const { rows } = await searchRankerD(db, 'SCANCODECHORD', { limit: 10 });
    expect(rows.map((r) => r.chunk_id)).toEqual(['caseTest']);
    expect(rows[0]?.match_type).toBe('full');
  });

  it('an underscore in an eligible token is matched LITERALLY, never as a SQL LIKE wildcard (segment channel)', async () => {
    await insertChunk({ chunk_id: 'realMatch', chunk_type: 'method', symbol_name: 'Foo.my_var', parent_symbol: 'Foo' });
    await insertChunk({ chunk_id: 'falsePositive', chunk_type: 'method', symbol_name: 'Foo.myXvar', parent_symbol: 'Foo' });

    const { rows } = await searchRankerD(db, 'my_var', { limit: 40 });
    expect(rows.map((r) => r.chunk_id)).toEqual(['realMatch']);
  });

  it('(d) lowercase EXCLUDED in primary arm: a lowercase term produces no rows and fired:false', async () => {
    await insertChunk({ chunk_id: 'lowerFn', chunk_type: 'function', symbol_name: 'whitespace' });

    const primary = await searchRankerD(db, 'whitespace', { limit: 10 });
    expect(primary.rows).toEqual([]);
    expect(primary.diagnostics.fired).toBe(false);
  });

  it('(e) same-name multiplicity ordering: a candidate whose matched name has FEWER same-named siblings ranks before one with MORE', async () => {
    // "uniqueMethod" matched by exactly 1 chunk; "commonMethod" matched by 5.
    await insertChunk({ chunk_id: 'unique1', chunk_type: 'method', symbol_name: 'A.uniqueMethod', parent_symbol: 'A' });
    for (let i = 0; i < 5; i++) {
      await insertChunk({ chunk_id: `common${i}`, chunk_type: 'method', symbol_name: `C${i}.commonMethod`, parent_symbol: `C${i}` });
    }

    const { rows } = await searchRankerD(db, 'uniqueMethod commonMethod', { limit: 40 });
    // All are segment matches (same tier); "uniqueMethod" (count=1) sorts
    // before every "commonMethod" (count=5) candidate.
    expect(rows[0]?.chunk_id).toBe('unique1');
    expect(rows.slice(1).map((r) => r.chunk_id).sort()).toEqual(['common0', 'common1', 'common2', 'common3', 'common4']);
  });

  it('ties within the same (match_type, same-name-count) group break by ascending chunk_id', async () => {
    await insertChunk({ chunk_id: 'zChunk', chunk_type: 'method', symbol_name: 'Z.tiedMethod', parent_symbol: 'Z' });
    await insertChunk({ chunk_id: 'aChunk', chunk_type: 'method', symbol_name: 'A.tiedMethod', parent_symbol: 'A' });

    const { rows } = await searchRankerD(db, 'tiedMethod', { limit: 40 });
    expect(rows.map((r) => r.chunk_id)).toEqual(['aChunk', 'zChunk']);
  });

  it('(f) REGISTERED toJSON-class fixture: ~140 same-segment candidates, full-name and class-shell matches order strictly above the segment crowd, deterministically', async () => {
    const SEGMENT_CROWD_SIZE = 140;
    for (let i = 0; i < SEGMENT_CROWD_SIZE; i++) {
      await insertChunk({ chunk_id: `toJSON_method_${i}`, chunk_type: 'method', symbol_name: `Klass${i}.toJSON`, parent_symbol: `Klass${i}` });
    }
    // A class_shell literally named "toJSON" — a full-name match distinct
    // from the segment crowd, exercising the registration's "class_shell on
    // class name... no segment logic needed" rule at scale.
    await insertChunk({ chunk_id: 'toJSON_shell', chunk_type: 'class_shell', symbol_name: 'toJSON' });

    const { rows: rowsRun1 } = await searchRankerD(db, 'toJSON', { limit: 4 * (SEGMENT_CROWD_SIZE + 1) });
    expect(rowsRun1).toHaveLength(SEGMENT_CROWD_SIZE + 1);
    expect(rowsRun1[0]?.chunk_id).toBe('toJSON_shell');
    expect(rowsRun1[0]?.match_type).toBe('full');
    // Every remaining row is a segment match from the crowd.
    expect(rowsRun1.slice(1).every((r) => r.match_type === 'segment')).toBe(true);

    // Determinism (Gate B — "two runs byte-identical"): a second independent
    // call over the same fixture db produces the identical ordered list.
    const { rows: rowsRun2 } = await searchRankerD(db, 'toJSON', { limit: 4 * (SEGMENT_CROWD_SIZE + 1) });
    expect(rowsRun2).toEqual(rowsRun1);

    // Pool cap 4x limit: capping to a small limit still keeps the full-name
    // match on top (ordering is applied BEFORE the cap, never after).
    const { rows: capped } = await searchRankerD(db, 'toJSON', { limit: 10 });
    expect(capped).toHaveLength(10);
    expect(capped[0]?.chunk_id).toBe('toJSON_shell');
  });

  it('(g) empty contribution: a query with no usable terms returns an empty array and fired:false', async () => {
    await insertChunk({ chunk_id: 'present', chunk_type: 'function', symbol_name: 'SomethingReal' });
    const { rows, diagnostics } = await searchRankerD(db, '!!! ...', { limit: 10 });
    expect(rows).toEqual([]);
    expect(diagnostics.fired).toBe(false);
    expect(diagnostics.candidate_count).toBe(0);
  });

  it('a query whose only terms are all-lowercase (primary-ineligible) also contributes nothing in primary mode', async () => {
    await insertChunk({ chunk_id: 'present2', chunk_type: 'function', symbol_name: 'lowercaseonly' });
    const { rows, diagnostics } = await searchRankerD(db, 'lowercaseonly', { limit: 10 });
    expect(rows).toEqual([]);
    expect(diagnostics.fired).toBe(false);
  });

  it('(h) two-run byte-determinism on an ordinary (non-crowd) query', async () => {
    await insertChunk({ chunk_id: 'shell', chunk_type: 'class_shell', symbol_name: 'Scrollable' });
    await insertChunk({ chunk_id: 'method', chunk_type: 'method', symbol_name: 'Scrollable.getFutureScrollPosition', parent_symbol: 'Scrollable' });

    const run1 = await searchRankerD(db, 'Scrollable.getFutureScrollPosition', { limit: 40 });
    const run2 = await searchRankerD(db, 'Scrollable.getFutureScrollPosition', { limit: 40 });
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
  });

  it('applies the caller-supplied limit as the pool cap (caller multiplies by RANKER_D_POOL_MULTIPLIER before calling)', async () => {
    for (let i = 0; i < 5; i++) {
      await insertChunk({ chunk_id: `row${i}`, chunk_type: 'method', symbol_name: `Distinct${i}.sharedTerm`, parent_symbol: `Distinct${i}` });
    }
    const { rows } = await searchRankerD(db, 'sharedTerm', { limit: 3 });
    expect(rows).toHaveLength(3);
    expect(RANKER_D_POOL_MULTIPLIER).toBe(4);
  });

  it('OR semantics: a chunk matching only ONE of two eligible terms still surfaces', async () => {
    await insertChunk({ chunk_id: 'onlyFoo', chunk_type: 'function', symbol_name: 'FooBar' });
    await insertChunk({ chunk_id: 'onlyBaz', chunk_type: 'function', symbol_name: 'BazQux' });

    const { rows } = await searchRankerD(db, 'FooBar BazQux', { limit: 40 });
    expect(rows.map((r) => r.chunk_id).sort()).toEqual(['onlyBaz', 'onlyFoo']);
  });
});
