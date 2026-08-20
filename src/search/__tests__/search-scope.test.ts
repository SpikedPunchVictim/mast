// `mast_search`'s SQL-level scope filters — `file_pattern` and `language`.
//
// Two defects motivate this file, and both were invisible to the pre-existing
// suites because every one of their fixtures is a flat directory of short,
// lowercase, ASCII, underscore-free filenames (`math.ts`, `models.ts`,
// `format.js` — search.test.ts; `a.ts`/`b.ts` — fused-declex.test.ts). That is
// the S-09 shape `docs/defects/D004-like-prefix-match.md` records as the cause
// of this package's other `LIKE` defect: the bug lives exactly where real input
// stops being those things, so the corpus below is deliberately nested, mixed
// case, mixed language, and carries a `my_file.ts` / `myXfile.ts` pair.
//
//  1. Ranker D applied no scope filter at all, so any query with a
//     symbol-shaped term (the eligibility gate, `declex.ts`) unioned unscoped
//     declaration hits into a scoped result set.
//  2. The scope glob was translated to a SQL `LIKE` pattern, under which `*`
//     crosses `/`, a literal `_` is a single-character wildcard, and matching
//     is case-INsensitive while the walker that decides what gets indexed is
//     case-sensitive.
//
// The only end-to-end `file_pattern` assertion that existed before this file
// (`mcp/tools/__tests__/tools.test.ts`) queries `'function'`, for which
// `deriveEligiblePrimaryTerms` returns `[]` — D never fires, so it passed
// vacuously for defect 1.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase } from '../../graph/db.js';
import { SqliteChunkStore } from '../../store/sqliteChunkStore.js';
import { fusedSearch } from '../fused.js';
import { deriveEligiblePrimaryTerms } from '../declex.js';
import type { Language } from '../../ast/types.js';

// ---------------------------------------------------------------------------
// Fixture corpus
// ---------------------------------------------------------------------------

/** Declared in four files across three directories and two languages, so a
 * scope filter has something to exclude. `sharedProbe` carries an uppercase
 * letter, which is what makes it eligible for ranker D (`declex.ts`
 * `isEligiblePrimaryTerm`) — asserted below rather than assumed. */
const sharedProbeSrc = (n: number): string =>
  `export function sharedProbe(): number {\n  return ${String(n)};\n}\n`;

/** The `_` pair: under SQL `LIKE`, the pattern `alpha/my_file.ts` also matches
 * `alpha/myXfile.ts`. Both declare the same symbol so one query reaches both. */
const underscoreProbeSrc = (n: number): string =>
  `export function underscoreProbe(): number {\n  return ${String(n)};\n}\n`;

// D-ON config. `rrf_k` is the shipped default; `declaration_exact_ranker` is
// the product default too (`store/config.ts` DEFAULTS) but must be passed
// explicitly here — `FusedSearchConfig` documents absent-means-OFF.
const declexOn = { rrf_k: 60, declaration_exact_ranker: true };
const declexOff = { rrf_k: 60 };

let tmpDir: string;
let db: ReturnType<typeof openDatabase>;
let chunkStore: SqliteChunkStore;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mast-search-scope-'));
  mkdirSync(join(tmpDir, 'alpha'), { recursive: true });
  mkdirSync(join(tmpDir, 'beta', 'nested'), { recursive: true });

  writeFileSync(join(tmpDir, 'alpha', 'a.ts'), sharedProbeSrc(1));
  writeFileSync(join(tmpDir, 'beta', 'b.ts'), sharedProbeSrc(2));
  writeFileSync(join(tmpDir, 'beta', 'nested', 'c.ts'), sharedProbeSrc(3));
  writeFileSync(join(tmpDir, 'beta', 'plain.js'), sharedProbeSrc(4));
  writeFileSync(join(tmpDir, 'alpha', 'my_file.ts'), underscoreProbeSrc(5));
  writeFileSync(join(tmpDir, 'alpha', 'myXfile.ts'), underscoreProbeSrc(6));

  const config = resolveConfig({ projectRoot: tmpDir });
  await runIndex(config, { incremental: false });

  db = openDatabase(config.resolved_state_dir);
  chunkStore = new SqliteChunkStore(db);
});

afterAll(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Distinct `file_path`s in a scoped search's results, sorted — the quantity
 * every assertion in this file is about. */
async function scopedPaths(
  query: string,
  scope: { file_pattern?: string; language?: Language },
  config: { rrf_k: number; declaration_exact_ranker?: boolean } = declexOn,
): Promise<string[]> {
  const { results } = await fusedSearch(db, { query, limit: 20, ...scope }, config, chunkStore);
  return [...new Set(results.map((r) => r.file_path))].sort();
}

// ---------------------------------------------------------------------------
// Precondition: the query actually fires ranker D
// ---------------------------------------------------------------------------

describe('scope fixture preconditions', () => {
  it('the probe queries are ranker-D eligible, so these tests are not vacuous', () => {
    expect(deriveEligiblePrimaryTerms('sharedProbe')).toEqual(['sharedProbe']);
    expect(deriveEligiblePrimaryTerms('underscoreProbe')).toEqual(['underscoreProbe']);
    // The pre-existing end-to-end file_pattern test's query, for contrast.
    expect(deriveEligiblePrimaryTerms('function')).toEqual([]);
  });

  it('unscoped, the corpus really does span every directory and both languages', async () => {
    expect(await scopedPaths('sharedProbe', {})).toEqual([
      'alpha/a.ts', 'beta/b.ts', 'beta/nested/c.ts', 'beta/plain.js',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 1. Ranker D must not leak past the scope
// ---------------------------------------------------------------------------

describe('file_pattern / language hold when ranker D fires', () => {
  it('file_pattern excludes out-of-scope declaration hits', async () => {
    expect(await scopedPaths('sharedProbe', { file_pattern: 'alpha/**' }))
      .toEqual(['alpha/a.ts']);
  });

  it('language excludes a same-named declaration in another language', async () => {
    expect(await scopedPaths('sharedProbe', { language: 'typescript' }))
      .toEqual(['alpha/a.ts', 'beta/b.ts', 'beta/nested/c.ts']);
  });

  it('a scoped search returns the same paths with D on as with D off', async () => {
    const on = await scopedPaths('sharedProbe', { file_pattern: 'alpha/**' }, declexOn);
    const off = await scopedPaths('sharedProbe', { file_pattern: 'alpha/**' }, declexOff);
    expect(on).toEqual(off);
  });
});

// ---------------------------------------------------------------------------
// 2. Glob semantics — `*` is not `%`, `_` is not a wildcard, case matters
// ---------------------------------------------------------------------------

describe('file_pattern glob semantics', () => {
  it('`*` does not cross a directory separator', async () => {
    expect(await scopedPaths('sharedProbe', { file_pattern: 'beta/*.ts' }))
      .toEqual(['beta/b.ts']);
  });

  it('`**` still crosses directory separators', async () => {
    expect(await scopedPaths('sharedProbe', { file_pattern: 'beta/**' }))
      .toEqual(['beta/b.ts', 'beta/nested/c.ts', 'beta/plain.js']);
  });

  it('a literal `_` in a filename matches only itself', async () => {
    expect(await scopedPaths('underscoreProbe', { file_pattern: 'alpha/my_file.ts' }))
      .toEqual(['alpha/my_file.ts']);
  });

  it('matching is case-sensitive, as the walker that indexed the files is', async () => {
    expect(await scopedPaths('sharedProbe', { file_pattern: 'ALPHA/**' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The zero-result assist is scoped too
// ---------------------------------------------------------------------------

describe('suggestions honour the scope', () => {
  it('never suggests a symbol from a file the scope excludes', async () => {
    // No chunk matches this token, so the assist path runs — and each of its
    // three passes queries the whole corpus. `sharedProb` would NOT do: the
    // trigram tokeniser matches a prefix of `sharedProbe` and the search
    // returns a real result.
    const { results, suggestions } = await fusedSearch(
      db,
      { query: 'sharedProbeXyzzy', limit: 10, file_pattern: 'alpha/**' },
      declexOn,
      chunkStore,
    );
    expect(results).toEqual([]);
    expect(suggestions ?? []).not.toEqual([]);
    for (const s of suggestions ?? []) {
      expect(s.file_path.startsWith('alpha/')).toBe(true);
    }
  });
});
