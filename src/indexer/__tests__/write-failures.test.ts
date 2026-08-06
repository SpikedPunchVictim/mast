import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase, type Db } from '../../graph/db.js';
import type { Chunk } from '../../ast/types.js';
import type { ChunkRecord, ChunkStore } from '../../store/sqliteChunkStore.js';

// ---------------------------------------------------------------------------
// A chunk-store write failure must be LOUD and correctly classified
// (GITNEXUS_COMPARISON.md §15.3 item 3 / §16 closing paragraph).
//
// Before this fix, a `chunkStore.replaceChunksForFile` rejection was counted
// as `parseErrors++` — a storage failure misattributed to the parse phase —
// and the file's chunks/symbols/edges/imports/FTS rows silently vanished
// from the index with only a WARN line as evidence. These tests assert the
// corrected VALUES (§14.6: shape-only assertions have hidden this exact bug
// class before), not just that a `write_errors` field exists.
// ---------------------------------------------------------------------------

/**
 * In-memory `ChunkStore` fake (§4.4 DI — no module mocking) whose
 * `replaceChunksForFile` throws for a configured set of file paths. Backs
 * the other methods with a plain Map so a non-incremental run (the only mode
 * these tests exercise) has everything it needs from the chunk store.
 */
class FailingChunkStore implements ChunkStore {
  private readonly stored = new Map<string, Chunk[]>();

  constructor(private readonly failingFiles: ReadonlySet<string>) {}

  async replaceChunksForFile(filePath: string, chunks: readonly Chunk[]): Promise<number> {
    if (this.failingFiles.has(filePath)) {
      throw new Error(`simulated chunk store write failure for ${filePath}`);
    }
    const removed = this.stored.get(filePath)?.length ?? 0;
    this.stored.set(filePath, [...chunks]);
    return removed;
  }

  async deleteChunksForFiles(filePaths: readonly string[]): Promise<number> {
    let removed = 0;
    for (const fp of filePaths) {
      removed += this.stored.get(fp)?.length ?? 0;
      this.stored.delete(fp);
    }
    return removed;
  }

  async getChunksByFilePath(filePath: string): Promise<ChunkRecord[]> {
    return (this.stored.get(filePath) ?? []).map(toRecord);
  }

  async getChunksByIds(ids: readonly string[]): Promise<ChunkRecord[]> {
    const idSet = new Set(ids);
    return (await this.getAllChunks()).filter((c) => idSet.has(c.chunk_id));
  }

  async getAllChunks(): Promise<ChunkRecord[]> {
    return [...this.stored.values()].flat().map(toRecord);
  }

  async chunkCount(): Promise<number> {
    return (await this.getAllChunks()).length;
  }
}

function toRecord(c: Chunk): ChunkRecord {
  return {
    chunk_id: c.chunk_id,
    file_path: c.file_path,
    start_line: c.start_line,
    end_line: c.end_line,
    content: c.content,
    chunk_type: c.chunk_type,
    symbol_name: c.symbol_name,
    parent_symbol: c.parent_symbol,
    is_exported: c.is_exported,
    language: c.language,
    file_mtime: c.file_mtime,
  };
}

describe('chunk-store write failures are loud and correctly classified', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mast-write-errors-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a chunk-store write failure increments write_errors, not parse_errors', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function ok(): number { return 1; }\n');
    writeFileSync(join(dir, 'b.ts'), 'export function bad(): number { return 2; }\n');
    const config = resolveConfig({ projectRoot: dir });
    const chunkStoreOverride = new FailingChunkStore(new Set(['b.ts']));

    const result = await runIndex(config, { incremental: false, chunkStoreOverride });

    expect(result.writeErrors).toBe(1);
    expect(result.parseErrors).toBe(0); // the assertion that would have caught the original defect
  });

  it('a genuine parse failure increments parse_errors, not write_errors (converse)', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function ok(): number { return 1; }\n');
    const unreadable = join(dir, 'unreadable.ts');
    writeFileSync(unreadable, 'export function boom(): number { return 1; }\n');
    // Deny read permission so extractFile's readFileSync throws — a genuine
    // parse-phase failure, distinct from a chunk-store write failure.
    chmodSync(unreadable, 0o000);
    const config = resolveConfig({ projectRoot: dir });

    try {
      const result = await runIndex(config, { incremental: false });
      expect(result.parseErrors).toBe(1);
      expect(result.writeErrors).toBe(0);
    } finally {
      // Restore permissions so afterEach's rmSync can clean up the temp dir.
      chmodSync(unreadable, 0o644);
    }
  });

  it('the failing file has no files/symbols row in the graph — amputation is loud, not silent', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function ok(): number { return 1; }\n');
    writeFileSync(join(dir, 'b.ts'), 'export function bad(): number { return 2; }\n');
    const config = resolveConfig({ projectRoot: dir });
    const chunkStoreOverride = new FailingChunkStore(new Set(['b.ts']));

    await runIndex(config, { incremental: false, chunkStoreOverride });

    const db: Db = openDatabase(config.resolved_state_dir);
    try {
      const files = await db.selectFrom('files').select('path').execute();
      const paths = files.map((f) => f.path);
      expect(paths).toContain('a.ts');    // successful write is present
      expect(paths).not.toContain('b.ts'); // failed write is genuinely absent

      const bSymbols = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.name')
        .where('f.path', '=', 'b.ts')
        .execute();
      expect(bSymbols).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it('a clean run reports write_errors: 0 and does not regress existing counters', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export function ok(): number { return 1; }\n');
    const config = resolveConfig({ projectRoot: dir });

    const result = await runIndex(config, { incremental: false });

    expect(result.writeErrors).toBe(0);
    expect(result.parseErrors).toBe(0);
    expect(result.filesIndexed).toBe(1);
  });
});
