/**
 * Stage 4 integration tests: CLI commands and full Phase 1 pipeline.
 *
 * Each `describe` block creates its own isolated temp directory so tests
 * never share state. Temp directories are removed in `afterAll`.
 *
 * Tests exercise the underlying functions that the CLI commands call rather
 * than shelling out to the binary — this avoids a build step and gives
 * accurate error messages.
 */
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { initLockMarkers, acquireLock, withLock } from '../../store/lock.js';
import { runIndex, loadIndexMeta } from '../../indexer/index.js';
import { walkProject, diffManifest } from '../../indexer/walker.js';
import { openDatabase } from '../../graph/db.js';
import { LanceStore } from '../../store/lance.js';
import { searchFts } from '../../search/fts.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const UTILS_SRC = `export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  private total = 0;

  add(n: number): void {
    this.total += n;
  }

  get result(): number {
    return this.total;
  }
}
`;

const TYPES_SRC = `export interface Config {
  name: string;
  value: number;
}

export type Id = string;
`;

const UTILS_V2_SRC = `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`;

// ---------------------------------------------------------------------------
// Full Phase 1 (`mast init` + `mast index`)
// ---------------------------------------------------------------------------

describe('full index', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-cli-test-'));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_SRC);
    writeFileSync(join(tmpDir, 'types.ts'), TYPES_SRC);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the state directory and config.json', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    initLockMarkers(config.resolved_state_dir);

    const result = await runIndex(config, { incremental: false });

    expect(result.filesIndexed).toBe(2);
    expect(result.parseErrors).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes index.json with correct file_count', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });

    const meta = loadIndexMeta(config.resolved_state_dir);
    expect(meta).not.toBeNull();
    expect(meta?.file_count).toBe(2);
    expect(meta?.last_indexed).toBeTruthy();
    expect(meta?.schema_version).toBe('1.0.0');
  });

  it('populates the graph database with symbols', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });

    const db = openDatabase(config.resolved_state_dir);
    try {
      const symbols = await db
        .selectFrom('symbols')
        .select('name')
        .execute();
      const names = new Set(symbols.map((s) => s.name));
      expect(names.has('Calculator')).toBe(true);
      expect(names.has('add')).toBe(true);
      expect(names.has('Config')).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it('populates LanceDB with chunks', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });

    const lance = await LanceStore.open(config.resolved_state_dir);
    const count = await lance.chunkCount();
    expect(count).toBeGreaterThan(0);
  });

  it('populates FTS so chunk content is searchable', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });

    const db = openDatabase(config.resolved_state_dir);
    try {
      const rows = await searchFts(db, 'Calculator', { limit: 5 });
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await db.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Incremental reindex (`mast index --incremental`)
// ---------------------------------------------------------------------------

describe('incremental reindex', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-cli-test-'));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_SRC);
    writeFileSync(join(tmpDir, 'types.ts'), TYPES_SRC);

    // Run full index first to establish the manifest baseline.
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('only reindexes files whose mtime changed', async () => {
    // Overwrite utils.ts — mtime will advance.
    await new Promise<void>((res) => setTimeout(res, 10));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_V2_SRC);

    const config = resolveConfig({ projectRoot: tmpDir });
    const result = await runIndex(config, { incremental: true });

    expect(result.filesIndexed).toBe(1);   // only utils.ts
    expect(result.filesSkipped).toBe(1);   // types.ts unchanged
    expect(result.parseErrors).toBe(0);
  });

  it('reflects updated symbols after incremental reindex', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const db = openDatabase(config.resolved_state_dir);
    try {
      // Calculator was in utils.ts v1; UTILS_V2_SRC replaced it with subtract.
      const symbols = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.name')
        .where('f.path', '=', 'utils.ts')
        .execute();
      const names = new Set(symbols.map((s) => s.name));

      expect(names.has('Calculator')).toBe(false);  // removed in v2
      expect(names.has('subtract')).toBe(true);      // added in v2
    } finally {
      await db.destroy();
    }
  });

  it('unchanged file symbols survive incremental reindex', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const db = openDatabase(config.resolved_state_dir);
    try {
      const sym = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.name')
        .where('f.path', '=', 'types.ts')
        .executeTakeFirst();
      expect(sym).toBeDefined();
    } finally {
      await db.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// `mast status` — accurate file count and staleness
// ---------------------------------------------------------------------------

describe('status — staleness detection', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-cli-test-'));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_SRC);
    writeFileSync(join(tmpDir, 'types.ts'), TYPES_SRC);

    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadIndexMeta returns accurate indexed file count', () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const meta = loadIndexMeta(config.resolved_state_dir);
    expect(meta?.file_count).toBe(2);
    expect(meta?.chunk_count).toBeGreaterThan(0);
  });

  it('reports stale_files = 0 immediately after indexing', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const manifestPath = join(config.resolved_state_dir, 'file_manifest.json');
    const { readFileSync, existsSync } = await import('node:fs');
    const prevManifest: Record<string, number> = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, number>)
      : {};

    const currentFiles = await walkProject(config);
    const { stale, added, deleted } = diffManifest(currentFiles, prevManifest);
    const staleCount = stale.length + added.length + deleted.length;

    expect(staleCount).toBe(0);
  });

  it('reports stale_files = 1 after modifying a file', async () => {
    await new Promise<void>((res) => setTimeout(res, 10));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_V2_SRC);

    const config = resolveConfig({ projectRoot: tmpDir });
    const manifestPath = join(config.resolved_state_dir, 'file_manifest.json');
    const { readFileSync } = await import('node:fs');
    const prevManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, number>;

    const currentFiles = await walkProject(config);
    const { stale, added, deleted } = diffManifest(currentFiles, prevManifest);
    const staleCount = stale.length + added.length + deleted.length;

    expect(staleCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lock acquisition — concurrent write prevention
// ---------------------------------------------------------------------------

describe('concurrent write prevention', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-cli-test-'));
    initLockMarkers(tmpDir);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('first acquisition succeeds', async () => {
    const release = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    await release();
  });

  it('second acquisition fails while first is held', async () => {
    const release = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    try {
      await expect(
        acquireLock(tmpDir, 'structure', { maxRetries: 0 }),
      ).rejects.toThrow();
    } finally {
      await release();
    }
  });

  it('acquisition succeeds after lock is released', async () => {
    const r1 = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    await r1();

    const r2 = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    await r2();
  });

  it('structure and vectors locks are independent', async () => {
    const r1 = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    const r2 = await acquireLock(tmpDir, 'vectors', { maxRetries: 0 });
    await r1();
    await r2();
  });

  it('withLock releases the lock on success', async () => {
    await withLock(tmpDir, 'structure', { maxRetries: 0 }, async () => {
      // lock is held here
    });
    // After withLock returns, lock should be released; re-acquiring must succeed.
    const r = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    await r();
  });

  it('withLock releases the lock on thrown error', async () => {
    await expect(
      withLock(tmpDir, 'structure', { maxRetries: 0 }, async () => {
        throw new Error('simulated failure');
      }),
    ).rejects.toThrow('simulated failure');

    // Lock must be released even after the throw.
    const r = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    await r();
  });
});

// ---------------------------------------------------------------------------
// Deleted file cleanup
// ---------------------------------------------------------------------------

describe('deleted file cleanup', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-cli-test-'));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_SRC);
    writeFileSync(join(tmpDir, 'types.ts'), TYPES_SRC);

    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes deleted file chunks from LanceDB on next index run', async () => {
    // Delete types.ts from disk.
    unlinkSync(join(tmpDir, 'types.ts'));

    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: true });

    const lance = await LanceStore.open(config.resolved_state_dir);
    const rows = await lance.getChunksByFilePath('types.ts');
    expect(rows).toHaveLength(0);
  });

  it('removes deleted file rows from the graph database', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const db = openDatabase(config.resolved_state_dir);
    try {
      const file = await db
        .selectFrom('files')
        .select('id')
        .where('path', '=', 'types.ts')
        .executeTakeFirst();
      expect(file).toBeUndefined();

      // Cascaded to symbols too.
      const symbols = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.id')
        .where('f.path', '=', 'types.ts')
        .execute();
      expect(symbols).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it('removes deleted file rows from chunk_fts', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const db = openDatabase(config.resolved_state_dir);
    try {
      const rows = await searchFts(db, 'Config', { limit: 10 });
      // Config was defined in types.ts — should no longer appear in FTS.
      const fromTypesTs = rows.filter((r) => {
        // We can't directly filter by file_path here (FTS row has chunk_id only),
        // but Config only existed in types.ts, so zero matches is the right signal.
        return true;
      });
      // After deletion the only surviving FTS rows are from utils.ts.
      // 'Config' is not in utils.ts — so FTS should return 0 hits.
      expect(rows).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it('surviving file remains fully indexed after peer deletion', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const db = openDatabase(config.resolved_state_dir);
    try {
      const sym = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.name')
        .where('f.path', '=', 'utils.ts')
        .executeTakeFirst();
      expect(sym).toBeDefined();
    } finally {
      await db.destroy();
    }
  });
});
