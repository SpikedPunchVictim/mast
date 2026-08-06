import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig, CURRENT_SCHEMA_VERSION } from '../../store/config.js';
import { runIndex, loadIndexMeta, writeIndexMeta } from '../../indexer/index.js';
import { bootstrapState, wipeDerivedState } from '../startup.js';
import { initLockMarkers } from '../../store/lock.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const MATH_SRC = `export function add(a: number, b: number): number {
  return a + b;
}
`;

// ---------------------------------------------------------------------------
// Startup ladder state initialisation
// ---------------------------------------------------------------------------

describe('startup ladder — state initialisation', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-startup-'));
    writeFileSync(join(tmpDir, 'math.ts'), MATH_SRC);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('step 1: initLockMarkers creates state directory structure', () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    initLockMarkers(config.resolved_state_dir);
    // If this doesn't throw, state directory was created.
    const meta = loadIndexMeta(config.resolved_state_dir);
    expect(meta).toBeNull(); // Not yet indexed.
  });

  it('step 2: Phase 1 populates the index and writes index.json', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const result = await runIndex(config, { incremental: false });
    expect(result.filesIndexed).toBeGreaterThan(0);
    const meta = loadIndexMeta(config.resolved_state_dir);
    expect(meta).not.toBeNull();
    expect(meta!.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(meta!.file_count).toBeGreaterThan(0);
  });

  it('step 3: schema version mismatch triggers full-reindex flag', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });

    // Inject an old schema version into index.json.
    const oldMeta = loadIndexMeta(config.resolved_state_dir)!;
    writeIndexMeta(config.resolved_state_dir, {
      ...oldMeta,
      schema_version: '0.0.0-stale',
    });

    const stale = loadIndexMeta(config.resolved_state_dir);
    const needsFullReindex = stale !== null && stale.schema_version !== CURRENT_SCHEMA_VERSION;
    expect(needsFullReindex).toBe(true);

    // After a full reindex, the schema version is restored.
    await runIndex(config, { incremental: false });
    const fresh = loadIndexMeta(config.resolved_state_dir)!;
    expect(fresh.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Schema-version guard: wipe derived state on mismatch (§7.4 Step 2 — H3)
// ---------------------------------------------------------------------------

const NO_SEED = join(tmpdir(), 'mast-no-such-seed-dir');

describe('wipeDerivedState', () => {
  it('removes index-derived state but keeps config.json and lock markers', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mast-wipe-'));
    try {
      // Derived state.
      mkdirSync(join(stateDir, 'lance'));
      mkdirSync(join(stateDir, 'embed_cache'));
      writeFileSync(join(stateDir, 'graph.db'), 'x');
      writeFileSync(join(stateDir, 'graph.db-wal'), 'x');
      writeFileSync(join(stateDir, 'graph.db-shm'), 'x');
      writeFileSync(join(stateDir, 'file_manifest.json'), '{}');
      // Preserved state. Only 'structure' is a real lock marker post-Stage-7.1
      // (the 'vectors' lock type was removed with runEmbed, its only
      // acquirer; IMPLEMENTATION_PLAN.md "Stage 7") — 'lance'/'embed_cache'
      // stay in DERIVED_STATE_ENTRIES as orphan-cleanup targets per Stage 7
      // design decision 3, asserted above.
      writeFileSync(join(stateDir, 'config.json'), '{}');
      writeFileSync(join(stateDir, 'structure'), '');

      wipeDerivedState(stateDir);

      expect(existsSync(join(stateDir, 'lance'))).toBe(false);
      expect(existsSync(join(stateDir, 'embed_cache'))).toBe(false);
      expect(existsSync(join(stateDir, 'graph.db'))).toBe(false);
      expect(existsSync(join(stateDir, 'graph.db-wal'))).toBe(false);
      expect(existsSync(join(stateDir, 'graph.db-shm'))).toBe(false);
      expect(existsSync(join(stateDir, 'file_manifest.json'))).toBe(false);

      expect(existsSync(join(stateDir, 'config.json'))).toBe(true);
      expect(existsSync(join(stateDir, 'structure'))).toBe(true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('bootstrapState — schema-version guard', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-bootstrap-'));
    writeFileSync(join(tmpDir, 'math.ts'), MATH_SRC);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('wipes derived state and flags a full reindex on schema mismatch', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    const stateDir = config.resolved_state_dir;
    expect(existsSync(join(stateDir, 'graph.db'))).toBe(true);

    // Stamp the index with a stale schema version.
    writeIndexMeta(stateDir, { ...loadIndexMeta(stateDir)!, schema_version: '0.0.0-stale' });

    const { needsFullReindex } = await bootstrapState(config, NO_SEED);

    expect(needsFullReindex).toBe(true);
    expect(existsSync(join(stateDir, 'graph.db'))).toBe(false);
    expect(existsSync(join(stateDir, 'lance'))).toBe(false);
    expect(existsSync(join(stateDir, 'file_manifest.json'))).toBe(false);

    const meta = loadIndexMeta(stateDir)!;
    expect(meta.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(meta.last_indexed).toBeNull();
  });

  it('is a no-op (no wipe, no reindex) when the schema matches', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    const stateDir = config.resolved_state_dir;

    const { needsFullReindex } = await bootstrapState(config, NO_SEED);

    expect(needsFullReindex).toBe(false);
    expect(existsSync(join(stateDir, 'graph.db'))).toBe(true);
  });
});
