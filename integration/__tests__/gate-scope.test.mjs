// The blast radius of `integration/**/*.test.mjs`.
//
// The unit gate's include glob covers all of `integration/`, and the harness materialises real
// third-party repositories into `integration/results/` — n8n ships ~35 of its own `*.test.mjs`.
// Vitest collected them, could not run them, and reported 66 failed test files against 97 of
// ours. The directory is gitignored, so nothing showed until a run left a working copy behind,
// which happens exactly when a corpus scenario fails: the gate broke hardest at the moment it
// was most needed, and for a reason unrelated to any change in this repo (LEDGER D062).
//
// This pins the exclusion. It asserts the config entry rather than glob semantics — a weaker
// claim than "no foreign file is ever collected", and stated as such, but it fails if someone
// tidies the entry away, which is the realistic regression.
import { describe, it, expect } from 'vitest';
import config from '../../vitest.config.ts';

describe('unit gate scope', () => {
  it('excludes the integration harness scratch output', () => {
    expect(config.test.exclude).toContain('integration/results/**');
  });

  it('still includes the harness own tests, which live outside that directory', () => {
    // The exclusion must not be widened to `integration/**` — this file, and corpus-walk's,
    // are the reason the include glob reaches into `integration/` at all.
    expect(config.test.include).toContain('integration/**/*.test.mjs');
    expect(config.test.exclude).not.toContain('integration/**');
  });
});
