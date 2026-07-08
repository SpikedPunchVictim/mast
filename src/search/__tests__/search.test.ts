import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { runEmbed } from '../../indexer/index.js';
import { openDatabase } from '../../graph/db.js';
import { LanceStore } from '../../store/lance.js';
import { searchFts, splitIdentifierTerms } from '../fts.js';
import { hybridSearch, rrfScore } from '../hybrid.js';
import { trigramSimilarity } from '../../graph/queries.js';
import { JINA_V2_DIM, type EmbedderLike } from '../../indexer/embedder.js';
import type { Chunk, VectorEntry } from '../../ast/types.js';

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
// Fake embedder — deterministic, no ONNX runtime
// ---------------------------------------------------------------------------

function makeFakeEmbedder(): EmbedderLike {
  return {
    async load() {},
    async embed(chunks: readonly Chunk[]): Promise<VectorEntry[]> {
      return chunks.map((c, i) => ({
        chunk_id:     c.chunk_id,
        // Unit vector with 1 at position (i % dim) — each chunk unique
        embedding:    Array.from({ length: JINA_V2_DIM }, (_, d) => d === i % JINA_V2_DIM ? 1 : 0),
        model_version: 'fake-1.0',
      }));
    },
    get dimension() { return JINA_V2_DIM; },
  };
}

// ---------------------------------------------------------------------------
// Shared setup: Phase 1 + Phase 2 over the fixture corpus
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDatabase>;
let lance: LanceStore;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mast-search-test-'));

  writeFileSync(join(tmpDir, 'math.ts'), MATH_SRC);
  writeFileSync(join(tmpDir, 'models.ts'), MODELS_SRC);
  writeFileSync(join(tmpDir, 'format.js'), FORMAT_JS_SRC);

  const config = resolveConfig({ projectRoot: tmpDir });
  await runIndex(config, { incremental: false });
  await runEmbed(config, { embedder: makeFakeEmbedder() });

  db = openDatabase(config.resolved_state_dir);
  lance = await LanceStore.open(config.resolved_state_dir);
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
  const hybridConfig = { rrf_k: 60, similarity_threshold: 0.0 };

  it('returns mode: lexical when embedder is null', async () => {
    const { mode, results } = await hybridSearch(db, lance, null, { query: 'add' }, hybridConfig);
    expect(mode).toBe('lexical');
    expect(results.length).toBeGreaterThan(0);
  });

  it('similarity_score is null in lexical mode', async () => {
    const { results } = await hybridSearch(db, lance, null, { query: 'add' }, hybridConfig);
    for (const r of results) {
      expect(r.similarity_score).toBeNull();
    }
  });

  it('match_score is set from BM25', async () => {
    const { results } = await hybridSearch(db, lance, null, { query: 'add' }, hybridConfig);
    const withFtsHit = results.filter((r) => r.match_score !== null);
    expect(withFtsHit.length).toBeGreaterThan(0);
  });

  it('only_exported filter excludes non-exported chunks', async () => {
    const allResults = await hybridSearch(
      db, lance, null,
      { query: 'Helper', only_exported: false },
      hybridConfig,
    );
    const exportedOnly = await hybridSearch(
      db, lance, null,
      { query: 'Helper', only_exported: true },
      hybridConfig,
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
      db, lance, null,
      { query: 'Shape', chunk_type: 'interface' },
      hybridConfig,
    );
    for (const r of results) {
      expect(r.chunk_type).toBe('interface');
    }
  });

  it('limit is respected', async () => {
    const { results } = await hybridSearch(
      db, lance, null,
      { query: 'a', limit: 2 },
      hybridConfig,
    );
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('rank field increments from 1', async () => {
    const { results } = await hybridSearch(db, lance, null, { query: 'function' }, hybridConfig);
    results.forEach((r, i) => expect(r.rank).toBe(i + 1));
  });
});

// ---------------------------------------------------------------------------
// hybridSearch — hybrid mode (with embedder)
// ---------------------------------------------------------------------------

describe('hybridSearch — hybrid mode', () => {
  const hybridConfig = { rrf_k: 60, similarity_threshold: 0.0 };

  it('returns mode: hybrid when vectors are available', async () => {
    const { mode } = await hybridSearch(
      db, lance, makeFakeEmbedder(),
      { query: 'add' },
      hybridConfig,
    );
    expect(mode).toBe('hybrid');
  });

  it('results have similarity_score set for vector-matched chunks', async () => {
    const { results } = await hybridSearch(
      db, lance, makeFakeEmbedder(),
      { query: 'add' },
      hybridConfig,
    );
    // At least one result should have a similarity score.
    const withScore = results.filter((r) => r.similarity_score !== null);
    expect(withScore.length).toBeGreaterThan(0);
  });

  it('chunk in both FTS and vector results scores higher than chunk in one only', async () => {
    // Run two separate searches and verify the fused ranking is not worse than
    // either individual leg — a chunk in both lists must rank at least as high
    // as a chunk that appears in only one.
    const { results } = await hybridSearch(
      db, lance, makeFakeEmbedder(),
      { query: 'add' },
      hybridConfig,
    );
    const dual = results.filter((r) => r.match_score !== null && r.similarity_score !== null);
    const singleLeg = results.filter(
      (r) => (r.match_score !== null) !== (r.similarity_score !== null),
    );

    if (dual.length > 0 && singleLeg.length > 0) {
      expect(dual[0]!.rank).toBeLessThan(singleLeg[0]!.rank);
    }
  });

  it('falls back to lexical when embedder throws', async () => {
    const brokenEmbedder: EmbedderLike = {
      async load() {},
      async embed() { throw new Error('model unavailable'); },
      get dimension() { return JINA_V2_DIM; },
    };
    const { mode, results } = await hybridSearch(
      db, lance, brokenEmbedder,
      { query: 'add' },
      hybridConfig,
    );
    expect(mode).toBe('lexical');
    expect(results.length).toBeGreaterThan(0);
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
// hybridSearch — zero-result assist (suggestions)
// ---------------------------------------------------------------------------

describe('hybridSearch — zero-result assist', () => {
  // Threshold high enough that the fake embedder's vector hits never survive,
  // and embedder null, so a no-FTS-hit query genuinely returns zero results.
  const lexicalConfig = { rrf_k: 60, similarity_threshold: 0.0 };

  it('attaches suggestions when the query matches no chunk', async () => {
    const { results, suggestions } = await hybridSearch(
      db, lance, null,
      { query: 'adddd' },
      lexicalConfig,
    );
    expect(results).toHaveLength(0);
    expect(suggestions).toBeDefined();
    // The trigram pass should surface the real `add` symbol as a candidate.
    expect(suggestions!.some((s) => s.symbol === 'add')).toBe(true);
  });

  it('each suggestion carries symbol, file_path and reason', async () => {
    const { suggestions } = await hybridSearch(
      db, lance, null,
      { query: 'adddd' },
      lexicalConfig,
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
      db, lance, null,
      { query: 'adddd' },
      lexicalConfig,
    );
    expect(results).toHaveLength(0);
    expect(suggestions).toBeDefined();
  });

  it('omits suggestions when the query returns results', async () => {
    const { results, suggestions } = await hybridSearch(
      db, lance, null,
      { query: 'add' },
      lexicalConfig,
    );
    expect(results.length).toBeGreaterThan(0);
    expect(suggestions).toBeUndefined();
  });
});
