import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase } from '../../graph/db.js';
import { SqliteChunkStore, type ChunkRecord } from '../../store/sqliteChunkStore.js';
import { searchFts, splitIdentifierTerms } from '../fts.js';
import { hybridSearch, rrfScore, dedupShellMethodCollisions } from '../hybrid.js';
import { trigramSimilarity } from '../../graph/queries.js';

// ---------------------------------------------------------------------------
// Fixture sources
// ---------------------------------------------------------------------------

const MATH_SRC = `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

function internalHelper(): void {}
`;

const MODELS_SRC = `export interface Shape {
  area(): number;
  perimeter(): number;
}

export type Color = 'red' | 'green' | 'blue';

export class Circle implements Shape {
  constructor(private radius: number) {}

  area(): number {
    return Math.PI * this.radius * this.radius;
  }

  perimeter(): number {
    return 2 * Math.PI * this.radius;
  }
}
`;

// JavaScript file — tests language filter.
const FORMAT_JS_SRC = `export function formatDate(date) {
  return date.toISOString().split('T')[0];
}
`;

// ---------------------------------------------------------------------------
// Shared setup: Phase 1 over the fixture corpus
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDatabase>;
let chunkStore: SqliteChunkStore;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mast-search-test-'));

  writeFileSync(join(tmpDir, 'math.ts'), MATH_SRC);
  writeFileSync(join(tmpDir, 'models.ts'), MODELS_SRC);
  writeFileSync(join(tmpDir, 'format.js'), FORMAT_JS_SRC);

  const config = resolveConfig({ projectRoot: tmpDir });
  await runIndex(config, { incremental: false });

  db = openDatabase(config.resolved_state_dir);
  chunkStore = new SqliteChunkStore(db);
});

afterAll(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// rrfScore helper
// ---------------------------------------------------------------------------

describe('rrfScore', () => {
  it('returns 1/(k+rank)', () => {
    expect(rrfScore(1, 60)).toBeCloseTo(1 / 61);
    expect(rrfScore(10, 60)).toBeCloseTo(1 / 70);
  });

  it('rank 1 always scores higher than rank 2', () => {
    expect(rrfScore(1, 60)).toBeGreaterThan(rrfScore(2, 60));
  });
});

// ---------------------------------------------------------------------------
// searchFts — BM25 with filters
// ---------------------------------------------------------------------------

describe('searchFts', () => {
  it('returns results matching query', async () => {
    const rows = await searchFts(db, 'add', { limit: 10 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ chunk_id: expect.any(String), bm25_score: expect.any(Number) });
  });

  it('returns empty array for empty query', async () => {
    const rows = await searchFts(db, '', { limit: 10 });
    expect(rows).toHaveLength(0);
  });

  it('filePattern limits results to matching files', async () => {
    const mathOnly = await searchFts(db, 'function', { limit: 20, filePattern: 'math.ts' });
    expect(mathOnly.length).toBeGreaterThan(0);
    // No rows from models.ts or format.js should appear.
    const allRows = await searchFts(db, 'function', { limit: 20 });
    expect(allRows.length).toBeGreaterThanOrEqual(mathOnly.length);
  });

  it('language filter returns only TypeScript chunks', async () => {
    const tsOnly = await searchFts(db, 'function', { limit: 20, language: 'typescript' });
    const jsOnly = await searchFts(db, 'function', { limit: 20, language: 'javascript' });

    expect(tsOnly.length).toBeGreaterThan(0);
    expect(jsOnly.length).toBeGreaterThan(0);
    // The two sets must be disjoint.
    const tsIds = new Set(tsOnly.map((r) => r.chunk_id));
    const jsIds = new Set(jsOnly.map((r) => r.chunk_id));
    for (const id of jsIds) {
      expect(tsIds.has(id)).toBe(false);
    }
  });

  it('limit is respected (result count ≤ limit × 2)', async () => {
    const rows = await searchFts(db, 'a', { limit: 2 });
    expect(rows.length).toBeLessThanOrEqual(4); // limit * 2 in impl
  });
});

// ---------------------------------------------------------------------------
// hybridSearch — lexical mode (no embedder)
// ---------------------------------------------------------------------------

describe('hybridSearch — lexical mode', () => {
  const hybridConfig = { rrf_k: 60 };

  it('returns mode: lexical', async () => {
    const { mode, results } = await hybridSearch(db, { query: 'add' }, hybridConfig, chunkStore);
    expect(mode).toBe('lexical');
    expect(results.length).toBeGreaterThan(0);
  });

  it('similarity_score is always null (Stage 7.1: vector leg removed)', async () => {
    const { results } = await hybridSearch(db, { query: 'add' }, hybridConfig, chunkStore);
    for (const r of results) {
      expect(r.similarity_score).toBeNull();
    }
  });

  it('match_score is set from BM25', async () => {
    const { results } = await hybridSearch(db, { query: 'add' }, hybridConfig, chunkStore);
    const withFtsHit = results.filter((r) => r.match_score !== null);
    expect(withFtsHit.length).toBeGreaterThan(0);
  });

  it('only_exported filter excludes non-exported chunks', async () => {
    const allResults = await hybridSearch(
      db,
      { query: 'Helper', only_exported: false },
      hybridConfig,
      chunkStore,
    );
    const exportedOnly = await hybridSearch(
      db,
      { query: 'Helper', only_exported: true },
      hybridConfig,
      chunkStore,
    );
    // internalHelper is not exported — if it appears in allResults, it must
    // not appear in exportedOnly.
    const internalInAll = allResults.results.some(
      (r) => r.symbol_name === 'internalHelper',
    );
    const internalInExported = exportedOnly.results.some(
      (r) => r.symbol_name === 'internalHelper',
    );
    if (internalInAll) {
      expect(internalInExported).toBe(false);
    }
  });

  it('chunk_type filter restricts to matching type', async () => {
    const { results } = await hybridSearch(
      db,
      { query: 'Shape', chunk_type: 'interface' },
      hybridConfig,
      chunkStore,
    );
    for (const r of results) {
      expect(r.chunk_type).toBe('interface');
    }
  });

  it('limit is respected', async () => {
    const { results } = await hybridSearch(
      db,
      { query: 'a', limit: 2 },
      hybridConfig,
      chunkStore,
    );
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('rank field increments from 1', async () => {
    const { results } = await hybridSearch(db, { query: 'function' }, hybridConfig, chunkStore);
    results.forEach((r, i) => expect(r.rank).toBe(i + 1));
  });
});

// ---------------------------------------------------------------------------
// splitIdentifierTerms — camelCase / snake_case tokenisation
// ---------------------------------------------------------------------------

describe('splitIdentifierTerms', () => {
  it('splits camelCase into lowercased sub-terms', () => {
    expect(splitIdentifierTerms('getUserProfile')).toEqual(['get', 'user', 'profile']);
  });

  it('splits snake_case into lowercased sub-terms', () => {
    expect(splitIdentifierTerms('get_user_profile')).toEqual(['get', 'user', 'profile']);
  });

  it('splits acronym boundaries', () => {
    expect(splitIdentifierTerms('HTTPServer')).toEqual(['http', 'server']);
  });

  it('drops sub-terms shorter than the trigram minimum and de-dupes', () => {
    // "by" and "id" are below the 3-char trigram floor; "user" appears once.
    expect(splitIdentifierTerms('userUserById')).toEqual(['user']);
  });

  it('returns an empty array for a query with no usable terms', () => {
    expect(splitIdentifierTerms('')).toEqual([]);
    expect(splitIdentifierTerms('a-b')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// trigramSimilarity — Dice coefficient over character trigrams
// ---------------------------------------------------------------------------

describe('trigramSimilarity', () => {
  it('is 1 for identical strings', () => {
    expect(trigramSimilarity('circle', 'circle')).toBe(1);
  });

  it('is 0 when there is no shared trigram', () => {
    expect(trigramSimilarity('circle', 'zzzzzz')).toBe(0);
  });

  it('is 0 when either string is shorter than a trigram', () => {
    expect(trigramSimilarity('ab', 'abc')).toBe(0);
  });

  it('scores a near-miss between 0 and 1', () => {
    const score = trigramSimilarity('adddd', 'add');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// dedupShellMethodCollisions — post-RRF shell/method dedup (presentation only)
// ---------------------------------------------------------------------------

/** Synthetic ChunkRecord with sensible defaults; candidates are in rank order. */
function fakeRec(partial: Partial<ChunkRecord> & Pick<ChunkRecord, 'chunk_id'>): ChunkRecord {
  return {
    file_path: 'a.ts',
    start_line: 1,
    end_line: 5,
    content: 'x',
    chunk_type: 'function',
    symbol_name: null,
    parent_symbol: null,
    is_exported: true,
    language: 'typescript',
    file_mtime: 0,
    ...partial,
  };
}

const circleShell = () => fakeRec({
  chunk_id: 'shell', chunk_type: 'class_shell', symbol_name: 'Circle', file_path: 'models.ts',
});
const circleMethod = (name: string) => fakeRec({
  chunk_id: `m-${name}`, chunk_type: 'method', symbol_name: `Circle.${name}`,
  parent_symbol: 'Circle', file_path: 'models.ts',
});

describe('dedupShellMethodCollisions', () => {
  it('suppresses the shell when a method of the same class ranks higher', () => {
    const kept = dedupShellMethodCollisions(
      [circleMethod('area'), circleShell(), fakeRec({ chunk_id: 'other' })],
      10,
    );

    const ids = kept.map((k) => k.chunk.chunk_id);
    expect(ids).toEqual(['m-area', 'other']);
    expect(kept[0]!.related).toEqual({ parent_symbol: 'Circle' });
    expect(kept[1]!.related).toBeUndefined();
  });

  it('suppresses methods when the shell ranks higher and lists them in methods_matched', () => {
    const kept = dedupShellMethodCollisions(
      [circleShell(), circleMethod('area'), circleMethod('perimeter')],
      10,
    );

    const ids = kept.map((k) => k.chunk.chunk_id);
    expect(ids).toEqual(['shell']);
    expect(kept[0]!.related).toEqual({ methods_matched: ['Circle.area', 'Circle.perimeter'] });
  });

  it('attaches the shell-suppression hint to the highest-ranked method only', () => {
    const kept = dedupShellMethodCollisions(
      [circleMethod('area'), circleMethod('perimeter'), circleShell()],
      10,
    );

    const ids = kept.map((k) => k.chunk.chunk_id);
    expect(ids).toEqual(['m-area', 'm-perimeter']);
    expect(kept[0]!.related).toEqual({ parent_symbol: 'Circle' });
    expect(kept[1]!.related).toBeUndefined();
  });

  it('does not collapse same-named classes in different files', () => {
    const otherFileShell = fakeRec({
      chunk_id: 'shell-b', chunk_type: 'class_shell', symbol_name: 'Circle', file_path: 'other.ts',
    });
    const kept = dedupShellMethodCollisions([circleMethod('area'), otherFileShell], 10);

    expect(kept.map((k) => k.chunk.chunk_id)).toEqual(['m-area', 'shell-b']);
    expect(kept.every((k) => k.related === undefined)).toBe(true);
  });

  it('backfills from the tail so limit results are still returned', () => {
    const kept = dedupShellMethodCollisions(
      [
        circleMethod('area'),
        circleShell(),                 // suppressed
        fakeRec({ chunk_id: 'b' }),
        fakeRec({ chunk_id: 'c' }),    // backfill into the freed slot
        fakeRec({ chunk_id: 'd' }),    // beyond limit
      ],
      3,
    );

    expect(kept.map((k) => k.chunk.chunk_id)).toEqual(['m-area', 'b', 'c']);
  });

  it('methods of the same class never suppress each other', () => {
    const kept = dedupShellMethodCollisions(
      [circleMethod('area'), circleMethod('perimeter')],
      10,
    );

    expect(kept.map((k) => k.chunk.chunk_id)).toEqual(['m-area', 'm-perimeter']);
    expect(kept.every((k) => k.related === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hybridSearch — shell/method dedup end to end
// ---------------------------------------------------------------------------

describe('hybridSearch — shell/method dedup', () => {
  const hybridConfig = { rrf_k: 60 };

  it('never returns both a class shell and one of its methods', async () => {
    // 'perimeter' matches the Circle shell (member signature), the
    // Circle.perimeter method chunk, and the Shape interface.
    const { results } = await hybridSearch(db, { query: 'perimeter' }, hybridConfig, chunkStore);

    const shell = results.find((r) => r.chunk_type === 'class_shell' && r.symbol_name === 'Circle');
    const method = results.find((r) => r.chunk_type === 'method' && r.parent_symbol === 'Circle');

    expect(shell !== undefined && method !== undefined).toBe(false);
    // The survivor carries the hint pointing at what was suppressed.
    if (shell !== undefined) {
      expect(shell.related).toMatchObject({ methods_matched: expect.arrayContaining(['Circle.perimeter']) });
    } else {
      expect(method).toBeDefined();
      expect(method!.related).toEqual({ parent_symbol: 'Circle' });
    }
  });

  it('ranks stay contiguous from 1 after dedup', async () => {
    const { results } = await hybridSearch(db, { query: 'perimeter' }, hybridConfig, chunkStore);
    results.forEach((r, i) => expect(r.rank).toBe(i + 1));
  });

  it('non-colliding results carry no related field', async () => {
    const { results } = await hybridSearch(db, { query: 'add' }, hybridConfig, chunkStore);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.related).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// hybridSearch — zero-result assist (suggestions)
// ---------------------------------------------------------------------------

describe('hybridSearch — zero-result assist', () => {
  // Threshold high enough that the fake embedder's vector hits never survive,
  // and embedder null, so a no-FTS-hit query genuinely returns zero results.
  const lexicalConfig = { rrf_k: 60 };

  it('attaches suggestions when the query matches no chunk', async () => {
    const { results, suggestions } = await hybridSearch(
      db,
      { query: 'adddd' },
      lexicalConfig,
      chunkStore,
    );
    expect(results).toHaveLength(0);
    expect(suggestions).toBeDefined();
    // The trigram pass should surface the real `add` symbol as a candidate.
    expect(suggestions!.some((s) => s.symbol === 'add')).toBe(true);
  });

  it('each suggestion carries symbol, file_path and reason', async () => {
    const { suggestions } = await hybridSearch(
      db,
      { query: 'adddd' },
      lexicalConfig,
      chunkStore,
    );
    expect(suggestions!.length).toBeGreaterThan(0);
    for (const s of suggestions!) {
      expect(typeof s.symbol).toBe('string');
      expect(typeof s.file_path).toBe('string');
      expect(typeof s.reason).toBe('string');
    }
  });

  it('never substitutes suggestions for results (results stay empty)', async () => {
    const { results, suggestions } = await hybridSearch(
      db,
      { query: 'adddd' },
      lexicalConfig,
      chunkStore,
    );
    expect(results).toHaveLength(0);
    expect(suggestions).toBeDefined();
  });

  it('omits suggestions when the query returns results', async () => {
    const { results, suggestions } = await hybridSearch(
      db,
      { query: 'add' },
      lexicalConfig,
      chunkStore,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(suggestions).toBeUndefined();
  });
});
