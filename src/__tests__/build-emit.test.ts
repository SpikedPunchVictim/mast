/**
 * The build must always emit. This pins the configuration that guarantees it.
 *
 * D022 (docs/defects/LEDGER.md): `pnpm build` is `tsc`, and under
 * `composite: true` TypeScript writes a `tsconfig.tsbuildinfo` and then trusts
 * it. Delete `dist/` without also deleting the buildinfo and tsc concludes the
 * project is up to date, **emits nothing, and exits 0**. Measured on both
 * drivers — plain `tsc` and `tsc -b` — so build mode is not an escape either.
 *
 * That is the severity-zero shape for this package: damage with a clean exit.
 * It is not hypothetical. `eval/__tests__/e1-dist-staleness.test.mjs` exists
 * because a stale `dist/` already ran two E1-VERIFY cells against a two-day-old
 * binary, and `packages/workbench/foldv2/mast-bridge` consumes this package's
 * `dist/` for its types.
 *
 * The fix is to stop claiming a capability nothing uses: no tsconfig in this
 * repo references mast as a composite project, and the incremental machinery
 * was measured to save 0.9s (0.7s no-op vs 1.6s full) on a package whose test
 * suite takes 13s. Dropping it makes the silent no-op unrepresentable rather
 * than worked around.
 *
 * This is a structural pin per CLAUDE.md §5.4a — a behavioural test would have
 * to shell out to `tsc` against a mutated working tree, which is slow and races
 * any concurrent build. If a future change genuinely needs project references,
 * delete this test deliberately and give `build` an explicit clean step.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import ts from 'typescript';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Resolved via the compiler's own parser — tsconfig.json is JSONC, and it may extend. */
function buildOptions(): ts.CompilerOptions {
  const configPath = join(PKG_ROOT, 'tsconfig.json');
  const { config, error } = ts.readConfigFile(configPath, (p) => readFileSync(p, 'utf-8'));
  expect(error).toBeUndefined();
  return ts.parseJsonConfigFileContent(config, ts.sys, PKG_ROOT).options;
}

describe('the build configuration', () => {
  it('does not enable incremental build state, which would let tsc skip emit after dist is deleted', () => {
    const options = buildOptions();

    expect({ composite: options.composite, incremental: options.incremental })
      .toEqual({ composite: undefined, incremental: undefined });
  });

  it('still emits declarations, which mast-bridge imports from dist', () => {
    expect(buildOptions().declaration).toBe(true);
  });
});
