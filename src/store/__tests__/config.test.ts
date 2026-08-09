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
import { resolveConfig, writeStateConfig, type ResolvedConfig } from '../config.js';

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

// ---------------------------------------------------------------------------
// resolveConfig — tolerates config keys removed by Stage 7
//
// IMPLEMENTATION_PLAN.md "Stage 7: Vector-store deletion" decision 2: a
// `mast.config.json` written before Stage 7.2 may still carry the removed
// embedding-model / Transformers.js cache-dir keys. Never-shipped means no
// migration path is owed — the file must simply keep loading.
// ---------------------------------------------------------------------------

describe('resolveConfig — tolerates config keys Stage 7 removed', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('loads a pre-Stage-7.2 mast.config.json without throwing, applying defaults for the rest', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-config-old-keys-'));
    writeFileSync(
      join(tmpDir, 'mast.config.json'),
      JSON.stringify({
        embedding_model: 'jinaai/jina-embeddings-v2-base-code',
        transformers_cache_dir: '/opt/transformers-cache',
      }),
    );

    expect(() => resolveConfig({ projectRoot: tmpDir })).not.toThrow();
    const config = resolveConfig({ projectRoot: tmpDir });
    // The removed keys don't override anything real — DEFAULTS still apply
    // to every field the current MastConfig actually declares.
    expect(config.rrf_k).toBe(60);
    expect(config.declaration_exact_ranker).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F9 (Stage 3.5, eval/GITNEXUS_COMPARISON.md M3): `mast init --extensions` /
// `--exclude` are honoured, and the persisted `<state_dir>/config.json` is
// now READ, not just written. Priority order, highest first: explicit CLI
// overrides (`extensions`/`excludePatterns` options) > `mast.config.json` in
// projectRoot > persisted `<state_dir>/config.json` > built-in defaults.
// ---------------------------------------------------------------------------

/** Builds a fixture ResolvedConfig for `writeStateConfig` — only the fields a test cares about differ from DEFAULTS. */
function fixtureResolvedConfig(overrides: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    state_dir: '.mast',
    project_root: '.',
    file_extensions: ['.ts'],
    exclude_patterns: [],
    rrf_k: 60,
    declaration_exact_ranker: true,
    chunk_split_threshold: 100,
    context_lines: 3,
    markdown_heading_depth: 2,
    resolved_state_dir: '/nonexistent',
    resolved_project_root: '/nonexistent',
    ...overrides,
  };
}

describe('resolveConfig — explicit extensions/excludePatterns overrides (F9)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('extensions option overrides file_extensions exactly', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-config-ext-override-'));
    const config = resolveConfig({ projectRoot: tmpDir, extensions: ['.py'] });
    expect(config.file_extensions).toEqual(['.py']);
  });

  it('excludePatterns option overrides exclude_patterns exactly', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-config-exclude-override-'));
    const config = resolveConfig({ projectRoot: tmpDir, excludePatterns: ['**/skipme.ts'] });
    expect(config.exclude_patterns).toEqual(['**/skipme.ts']);
  });
});

describe('resolveConfig — persisted state config layer (F9)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('picks up custom file_extensions from a previously-written state config.json', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-config-state-layer-'));
    const stateDir = join(tmpDir, '.mast');
    writeStateConfig(
      stateDir,
      fixtureResolvedConfig({
        file_extensions: ['.py'],
        resolved_state_dir: stateDir,
        resolved_project_root: tmpDir,
      }),
    );

    const config = resolveConfig({ projectRoot: tmpDir });

    expect(config.file_extensions).toEqual(['.py']);
  });

  it('mast.config.json wins over the persisted state config', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-config-state-layer-'));
    const stateDir = join(tmpDir, '.mast');
    writeStateConfig(
      stateDir,
      fixtureResolvedConfig({
        file_extensions: ['.py'],
        resolved_state_dir: stateDir,
        resolved_project_root: tmpDir,
      }),
    );
    writeFileSync(join(tmpDir, 'mast.config.json'), JSON.stringify({ file_extensions: ['.rs'] }));

    const config = resolveConfig({ projectRoot: tmpDir });

    expect(config.file_extensions).toEqual(['.rs']);
  });

  it('explicit overrides win over both mast.config.json and the persisted state config', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-config-state-layer-'));
    const stateDir = join(tmpDir, '.mast');
    writeStateConfig(
      stateDir,
      fixtureResolvedConfig({
        file_extensions: ['.py'],
        resolved_state_dir: stateDir,
        resolved_project_root: tmpDir,
      }),
    );
    writeFileSync(join(tmpDir, 'mast.config.json'), JSON.stringify({ file_extensions: ['.rs'] }));

    const config = resolveConfig({ projectRoot: tmpDir, extensions: ['.go'] });

    expect(config.file_extensions).toEqual(['.go']);
  });
});

// ---------------------------------------------------------------------------
// Path-portability (F9 mandate): the SDD pipeline mounts the same workspace
// volume at different container paths, so a persisted config.json's absolute
// `state_dir`/`project_root`/`resolved_state_dir`/`resolved_project_root`
// from a PREVIOUS container must never be merged back in — only the current
// resolution's paths are trustworthy. Verified here by pointing the
// persisted file at an absolute path that does not exist on this machine at
// all; if the merge ever picked it up, resolveConfig's own path fields would
// echo the nonexistent path.
// ---------------------------------------------------------------------------

describe('resolveConfig — never merges path keys from persisted state config (F9)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolved paths come from the current resolution, never the persisted file', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-config-path-portability-'));
    const stateDir = join(tmpDir, '.mast');
    const stalePath = '/nonexistent-container-mount/from-a-different-container/.mast';
    writeStateConfig(
      stateDir,
      fixtureResolvedConfig({
        state_dir: stalePath,
        project_root: stalePath,
        resolved_state_dir: stalePath,
        resolved_project_root: stalePath,
      }),
    );

    const config = resolveConfig({ projectRoot: tmpDir });

    expect(config.resolved_state_dir).toBe(stateDir);
    expect(config.resolved_project_root).toBe(tmpDir);
    expect(config.resolved_state_dir).not.toContain('nonexistent-container-mount');
    expect(config.resolved_project_root).not.toContain('nonexistent-container-mount');
  });
});
