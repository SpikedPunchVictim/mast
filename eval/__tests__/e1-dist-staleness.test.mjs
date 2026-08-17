// GATE 0b — the built binary must be CURRENT, not merely self-consistent.
//
// The near-miss this pins: the FTS delete guard was written, tested, linted and
// committed, and `dist/` was never rebuilt. Two E1-VERIFY cells ran against a
// binary two days old. Nothing in the harness caught it — the only signal was a
// span the guard should have zeroed reporting 956 ms.
//
// Gate 0 could not see it, and that is the point. Its `schema_version` check
// compares binary to source, but the version had not changed. Its content hash
// pins the binary across a RESUME — it detects dist/ changing mid-schedule, and
// says nothing about whether dist/ ever corresponded to src/. A stale build is
// perfectly self-consistent.
//
// Run from `packages/mast`, never the repo root.

import { describe, it, expect } from 'vitest';
import { distStalenessVerdict, isBuildInput } from '../e1-common.mjs';

const T = 1_760_000_000_000;

describe('distStalenessVerdict', () => {
  it('passes when dist was built after the newest source file', () => {
    expect(distStalenessVerdict({ newestSrcMs: T, newestDistMs: T + 5_000 }).ok).toBe(true);
  });

  // tsc rewrites only outputs whose input changed, so a current build always has
  // some artifact at or after the newest source file. Equality is current.
  it('passes on an exact tie', () => {
    expect(distStalenessVerdict({ newestSrcMs: T, newestDistMs: T }).ok).toBe(true);
  });

  // The actual failure: src edited, dist never rebuilt.
  it('fails when src is newer than dist, naming the file and the gap', () => {
    const v = distStalenessVerdict({
      newestSrcMs: T + 172_800_000, newestDistMs: T, newestSrcFile: '/x/src/graph/populate.ts',
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('dist_older_than_src');
    expect(v.newest_src_file).toBe('/x/src/graph/populate.ts');
    expect(v.src_newer_by_ms).toBe(172_800_000);
  });

  // Zero tolerance. A "close enough" window is exactly how a one-file edit
  // slips through, and a one-file edit is what this incident was.
  it('fails on a one-millisecond gap — no tolerance window', () => {
    expect(distStalenessVerdict({ newestSrcMs: T + 1, newestDistMs: T }).ok).toBe(false);
  });

  it('fails rather than passing when a mtime is unreadable', () => {
    expect(distStalenessVerdict({ newestSrcMs: 0, newestDistMs: T }).ok).toBe(false);
    expect(distStalenessVerdict({ newestSrcMs: T, newestDistMs: 0 }).reason).toBe('mtimes_unreadable');
  });
});

// ---------------------------------------------------------------------------
// Which files can actually make `dist/` stale.
//
// Gate 0b's first live firing was a FALSE POSITIVE: it named
// `src/graph/__tests__/fts-delete-guard.test.ts` as the newest source and refused
// to run. But `tsconfig.json` excludes `**/*.test.ts`, `**/*.spec.ts` and
// `**/__tests__/**` from the build, so no edit to any of them can change a single
// byte of `dist/`.
//
// This matters more than a nuisance: a gate that blocks for a reason that cannot
// affect the binary teaches its operator to bypass it, and the next block will be
// the real one. The predicate below is the fix, and it must stay in step with
// tsconfig.json's `exclude`.
// ---------------------------------------------------------------------------

describe('isBuildInput', () => {
  it('accepts ordinary source that tsc compiles', () => {
    expect(isBuildInput('/p/src/graph/populate.ts')).toBe(true);
  });

  it('rejects a .test.ts file — tsconfig.json excludes it from the build', () => {
    expect(isBuildInput('/p/src/graph/__tests__/fts-delete-guard.test.ts')).toBe(false);
  });

  it('rejects a .spec.ts file', () => {
    expect(isBuildInput('/p/src/graph/thing.spec.ts')).toBe(false);
  });

  // The exact false positive that produced this predicate.
  it('rejects anything under a __tests__ directory, including non-test fixtures', () => {
    expect(isBuildInput('/p/src/ast/extractors/__tests__/fixtures/basic.ts')).toBe(false);
  });

  it('rejects non-TypeScript files', () => {
    expect(isBuildInput('/p/src/graph/schema.sql')).toBe(false);
  });
});
