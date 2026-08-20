// `globToRegex` against fast-glob, the other half of the same contract.
//
// One pattern list — `exclude_patterns` — is read by two different matchers:
// `walkProject` hands it to fast-glob's `ignore`, and watch mode compiles it
// with `globToRegex` (`watcher.ts` `excludeRegexes`). `mast_search` and
// `mast_project_skeleton` compile `file_pattern` with the same function. Two
// producers of one decision is this package's S-05 shape, so the agreement is
// asserted here rather than assumed.
//
// It did not hold. The pre-2026-08-20 implementation chained four `.replace`
// calls, each rewriting the previous one's output: `**` became `.*` and then
// `.[^/]*`, and `**/` became `(.+/)?` and then `(.+/)[^/]`. Measured against
// the shipped defaults, `**/node_modules/**` compiled to
// `^(.+\/)[^/]node_modules\/.[^/]*$`, which matches neither `node_modules/`
// nor `node_modules/pkg/index.ts` — so watch mode's exclusion of every
// default-excluded directory was inert, and `file_pattern: 'src/**'` returned
// nothing below `src/`.
//
// `cli.test.ts`'s D6 invariant ("no indexed path matches any exclude pattern")
// was green throughout, because a regex that matches nothing satisfies a
// negative assertion vacuously — S-10, the check you ran is not the check that
// governs. It stays as it is; this file is what makes it non-vacuous.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fg from 'fast-glob';
import { globToRegex } from '../walker.js';

/** Relative paths laid down in the fixture tree, in walk order. */
const TREE = [
  'good.ts',
  'foo.test.ts',
  'abc.ts',
  'src/a.ts',
  'src/my_file.ts',
  'src/myXfile.ts',
  'src/sub/deep.ts',
  'src/sub/deep.test.ts',
  'beta/b.ts',
  'beta/nested/c.ts',
  'node_modules/top.ts',
  'node_modules/pkg/index.ts',
  'dist/out.ts',
] as const;

/**
 * Patterns checked for fast-glob parity. Dot-leading patterns (`.mast/**`) are
 * asserted separately below: fast-glob is not given `dot: true` by
 * `walkProject`, so it never enumerates a dotted directory at all and there is
 * no fast-glob answer to compare against. Watch mode's chokidar does see them,
 * which is why that case still has to hold.
 */
const PARITY_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.test.ts',
  '**/*.ts',
  'src/*.ts',
  'src/**',
  'src/**/*.ts',
  'beta/*.ts',
  'beta/**',
  'good.ts',
  'src/my_file.ts',
  'ab?.ts',
] as const;

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mast-glob-parity-'));
  for (const rel of TREE) {
    mkdirSync(join(tmpDir, dirname(rel)), { recursive: true });
    writeFileSync(join(tmpDir, rel), 'export const x = 1;\n');
  }
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('globToRegex — parity with fast-glob', () => {
  it.each(PARITY_PATTERNS)('selects the same files as fast-glob for `%s`', async (pattern) => {
    const viaFastGlob = (await fg([pattern], { cwd: tmpDir, onlyFiles: true })).sort();
    const viaRegex = TREE.filter((rel) => globToRegex(pattern).test(rel)).sort();

    expect(viaRegex).toEqual(viaFastGlob);
    // A pattern that selects nothing on both sides would pass vacuously.
    expect(viaFastGlob.length).toBeGreaterThan(0);
  });
});

describe('globToRegex — the directory forms watch mode depends on', () => {
  // `watcher.ts` tests both `rel` and `rel + '/'` against these so chokidar can
  // prune an excluded subtree without descending into it.
  it.each([
    ['**/node_modules/**', 'node_modules/'],
    ['**/node_modules/**', 'node_modules/pkg/index.ts'],
    ['**/node_modules/**', 'src/node_modules/pkg/index.ts'],
    ['**/dist/**', 'dist/'],
    ['.mast/**', '.mast/'],
    ['.mast/**', '.mast/graph.db'],
    ['.mast/**', '.mast/lance/chunks/data.lance'],
  ])('`%s` matches `%s`', (pattern, path) => {
    expect(globToRegex(pattern).test(path)).toBe(true);
  });

  it.each([
    ['.mast/**', 'src/.mast/graph.db'],
    ['**/node_modules/**', 'node_modules'],
    ['src/**', 'src'],
    ['src/*.ts', 'src/sub/deep.ts'],
  ])('`%s` does not match `%s`', (pattern, path) => {
    expect(globToRegex(pattern).test(path)).toBe(false);
  });
});

describe('globToRegex — regex metacharacters in a pattern are literal', () => {
  it('a `.` matches only a `.`', () => {
    expect(globToRegex('a.ts').test('a.ts')).toBe(true);
    expect(globToRegex('a.ts').test('axts')).toBe(false);
  });

  it('a `_` is not a wildcard, and `+()[]` are not operators', () => {
    expect(globToRegex('src/my_file.ts').test('src/myXfile.ts')).toBe(false);
    expect(globToRegex('a+(b).ts').test('a+(b).ts')).toBe(true);
  });
});
