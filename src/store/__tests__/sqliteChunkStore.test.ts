import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Chunk } from '../../ast/types.js';
import { openDatabase, type Db } from '../../graph/db.js';
import { SqliteChunkStore } from '../sqliteChunkStore.js';

// ---------------------------------------------------------------------------
// Default (production) chunk store coverage (M1, eval/GITNEXUS_COMPARISON.md
// §15.1). `SqliteChunkStore` wraps graph.db's shared `chunks` table now, not
// a standalone `chunks.db` — these tests exercise it via a real `openDatabase`
// handle instead of the pre-M1 spike's own connection. The one
// non-negotiable check carried over from the spike is the `is_exported`
// type-drift trap: SQLite stores booleans as 0|1 (graph/db.ts's `BoolCol`
// convention), and a silent `0|1` leak into `SearchResult.is_exported` would
// ship numbers to MCP consumers.
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    chunk_id:      'chunk-1',
    file_path:     'a.ts',
    start_line:    1,
    end_line:      3,
    content:       'export function add(a: number, b: number): number { return a + b; }',
    chunk_type:    'function',
    symbol_name:   'add',
    parent_symbol: null,
    is_exported:   true,
    language:      'typescript',
    file_mtime:    1_700_000_000,
    ...overrides,
  };
}

describe('SqliteChunkStore', () => {
  let dir: string;
  let db: Db;
  let store: SqliteChunkStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-sqlite-chunkstore-'));
    db = openDatabase(dir);
    store = new SqliteChunkStore(db);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips is_exported as a real boolean, not 0|1', async () => {
    await store.replaceChunksForFile('a.ts', [
      makeChunk({ chunk_id: 'exported', is_exported: true }),
      makeChunk({ chunk_id: 'private', symbol_name: 'helper', is_exported: false }),
    ]);

    const [exported, priv] = await store.getChunksByIds(['exported', 'private']);
    expect(exported?.is_exported).toBe(true);
    expect(priv?.is_exported).toBe(false);
    // Strict boolean identity — a leaked 0|1 would pass `== true`/`== false`
    // but fail this, which is exactly the ship-numbers-to-MCP trap.
    expect(typeof exported?.is_exported).toBe('boolean');
    expect(typeof priv?.is_exported).toBe('boolean');
  });

  it('replaceChunksForFile deletes the prior set and reports how many were removed', async () => {
    await store.replaceChunksForFile('a.ts', [makeChunk({ chunk_id: 'v1' })]);
    const removed = await store.replaceChunksForFile('a.ts', [makeChunk({ chunk_id: 'v2' })]);

    expect(removed).toBe(1);
    const rows = await store.getChunksByFilePath('a.ts');
    expect(rows.map((r) => r.chunk_id)).toEqual(['v2']);
  });

  it('deleteChunksForFiles removes only the named files and returns the total removed', async () => {
    await store.replaceChunksForFile('a.ts', [makeChunk({ chunk_id: 'a1', file_path: 'a.ts' })]);
    await store.replaceChunksForFile('b.ts', [makeChunk({ chunk_id: 'b1', file_path: 'b.ts' })]);

    const removed = await store.deleteChunksForFiles(['a.ts']);

    expect(removed).toBe(1);
    expect(await store.getChunksByFilePath('a.ts')).toEqual([]);
    expect(await store.getChunksByFilePath('b.ts')).toHaveLength(1);
  });

  it('getChunksByIds silently skips unrecognised ids (LanceStore parity)', async () => {
    await store.replaceChunksForFile('a.ts', [makeChunk({ chunk_id: 'known' })]);

    const rows = await store.getChunksByIds(['known', 'does-not-exist']);

    expect(rows.map((r) => r.chunk_id)).toEqual(['known']);
  });

  it('chunkCount and getAllChunks reflect writes across files', async () => {
    await store.replaceChunksForFile('a.ts', [makeChunk({ chunk_id: 'a1', file_path: 'a.ts' })]);
    await store.replaceChunksForFile('b.ts', [
      makeChunk({ chunk_id: 'b1', file_path: 'b.ts' }),
      makeChunk({ chunk_id: 'b2', file_path: 'b.ts', symbol_name: 'b2sym' }),
    ]);

    expect(await store.chunkCount()).toBe(3);
    const all = await store.getAllChunks();
    expect(all.map((c) => c.chunk_id).sort()).toEqual(['a1', 'b1', 'b2']);
  });
});
