/**
 * D026's pin.
 *
 * The defect: `isSelfReferential` decided "the agent was investigating MAST itself" by
 * testing every result path against the string literal `packages/mast/`. That literal
 * encoded the layout of a HOST repository — kluster's monorepo — which this package does
 * not control. The 2026-08-19 eject moved the package to its own repository root, the
 * literal stopped matching anything, and the path half of the filter went silently dead.
 * Every test stayed green, because no test ever asserted that the literal matched the
 * layout.
 *
 * The fix points the coupling at the layout this repo DOES control: mast's own source
 * signature. So this file pins the signature, not the answer:
 *
 *   1. every signature path still exists in this repo — the assertion that would have
 *      failed at the eject, and that fails again on the next re-layout;
 *   2. the prefix is derived correctly for all three layouts the harvest can meet —
 *      mast at the root (dogfooding), mast vendored at a subpath (the pinned corpus),
 *      and mast absent (a third-party corpus);
 *   3. an absent prefix DISABLES the path half rather than silently classifying
 *      everything as organic — the S-07 shape that caused this defect.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAST_SOURCE_SIGNATURE,
  deriveMastPrefix,
  isSelfReferential,
} from '../harvest-real-queries.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the mast source signature matches this repo (D026)', () => {
  it('every signature path exists — this is the assertion the eject would have failed', () => {
    const missing = MAST_SOURCE_SIGNATURE.filter((p) => !existsSync(join(repoRoot, p)));
    expect(missing).toEqual([]);
  });

  it('uses no host-repository path literal', () => {
    // `packages/mast/` was kluster's layout, not this package's. Nothing in the
    // signature may name a directory this repo does not own.
    expect(MAST_SOURCE_SIGNATURE.every((p) => p.startsWith('src/'))).toBe(true);
  });
});

describe('deriveMastPrefix covers every layout the harvest can meet (D026)', () => {
  const vendored = (prefix) => MAST_SOURCE_SIGNATURE.map((p) => prefix + p);

  it('returns the empty prefix when mast IS the indexed project (dogfooding)', () => {
    expect(deriveMastPrefix([...vendored(''), 'README.md'])).toBe('');
  });

  it('returns the subpath when mast is vendored inside a monorepo (the pinned corpus)', () => {
    expect(deriveMastPrefix([...vendored('packages/mast/'), 'packages/api/src/x.ts']))
      .toBe('packages/mast/');
  });

  it('returns null when the corpus contains no mast source', () => {
    expect(deriveMastPrefix(['src/app.ts', 'src/lib/util.ts'])).toBeNull();
  });

  it('returns null when the signature is only partly present, rather than guessing', () => {
    // A partial match is ambiguous: it may be a coincidence, or a moved layout. Either
    // way the honest answer is "I could not locate mast", not a prefix built from one hit.
    expect(deriveMastPrefix(['packages/mast/src/indexer/index.ts'])).toBeNull();
  });
});

describe('isSelfReferential (D026)', () => {
  const hit = (p) => ({ file_path: p });

  it('flags a query whose results are all mast source, at the derived prefix', () => {
    expect(isSelfReferential('walkProject sort order', [hit('packages/mast/src/indexer/walker.ts')], 'packages/mast/'))
      .toBe(true);
  });

  it('flags every result-bearing query when mast IS the indexed project', () => {
    // The dogfooding case D026 was recorded to prevent: with mast at the root there is
    // no subpath to match, and the pre-fix literal classified all of it as organic.
    expect(isSelfReferential('safeRealpath casing', [hit('src/indexer/import-resolver.ts')], ''))
      .toBe(true);
  });

  it('does NOT flag ordinary queries when the corpus has no mast source', () => {
    expect(isSelfReferential('user login handler', [hit('src/auth/login.ts')], null)).toBe(false);
  });

  it('still flags a mast-vocabulary query regardless of prefix', () => {
    expect(isSelfReferential('chunk_fts ranking', [hit('src/auth/login.ts')], null)).toBe(true);
  });

  it('does not flag a query that returned nothing', () => {
    expect(isSelfReferential('nothing matches this', [], '')).toBe(false);
  });
});
