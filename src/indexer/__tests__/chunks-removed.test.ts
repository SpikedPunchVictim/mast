import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase } from '../../graph/db.js';
import { SqliteChunkStore } from '../../store/sqliteChunkStore.js';

describe('chunks_removed accounting (M4)', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mast-removed-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is 0 on a fresh index and counts replaced chunks on reindex', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function f(): number { return 1; }\n');
    const config = resolveConfig({ projectRoot: dir });

    const first = await runIndex(config, { incremental: false });
    expect(first.chunksRemoved).toBe(0);

    const db = openDatabase(config.resolved_state_dir);
    const chunkStore = new SqliteChunkStore(db);
    const before = await chunkStore.chunkCount();
    expect(before).toBeGreaterThan(0);
    await db.destroy();

    // Change the body and fully reindex — every old chunk is replaced.
    writeFileSync(join(dir, 'a.ts'), 'export function f(): number { return 2; }\n');
    const second = await runIndex(config, { incremental: false });
    expect(second.chunksRemoved).toBe(before);
  });

  it('counts the chunks of a deleted file', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function a(): number { return 1; }\n');
    writeFileSync(join(dir, 'b.ts'), 'export function b(): number { return 2; }\nexport function c(): number { return 3; }\n');
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });

    const db = openDatabase(config.resolved_state_dir);
    const chunkStore = new SqliteChunkStore(db);
    const bChunks = (await chunkStore.getChunksByFilePath('b.ts')).length;
    expect(bChunks).toBeGreaterThan(0);
    await db.destroy();

    rmSync(join(dir, 'b.ts'));
    // a.ts is unchanged (same mtime), so only b.ts's chunks are removed.
    const result = await runIndex(config, { incremental: true });
    expect(result.chunksRemoved).toBe(bChunks);
  });
});
