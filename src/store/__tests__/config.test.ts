// F18 kill-switch (M2 decision memo condition 3) — `declaration_exact_ranker`
// defaults to true in the product config layer (DEFAULTS), and a project's
// `mast.config.json` can override it to false. No dedicated config test file
// existed before this Stage 6.2 task; this one follows the `mast.config.json`
// override fixture convention already used by
// `indexer/__tests__/reembed.test.ts` (mkdtempSync + writeFileSync +
// `resolveConfig({ projectRoot })`).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { resolveConfig } from '../config.js';

describe('resolveConfig — declaration_exact_ranker (F18 kill-switch)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('defaults to true when no mast.config.json overrides it', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-config-declex-'));
    const config = resolveConfig({ projectRoot: tmpDir });
    expect(config.declaration_exact_ranker).toBe(true);
  });

  it('mast.config.json can override the default to false', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-config-declex-'));
    writeFileSync(join(tmpDir, 'mast.config.json'), JSON.stringify({ declaration_exact_ranker: false }));
    const config = resolveConfig({ projectRoot: tmpDir });
    expect(config.declaration_exact_ranker).toBe(false);
  });
});
