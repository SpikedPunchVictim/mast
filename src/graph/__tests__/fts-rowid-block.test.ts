/**
 * The FTS5 rowid block — making the per-file delete cost O(this file) instead
 * of O(corpus).
 *
 * `fts-delete-guard.test.ts` pins the *cold-build* half of this problem: a file
 * that was never indexed skips the delete entirely. This file pins the other
 * half, which that guard cannot help with — a file that HAS a previous version
 * must still delete it, and `DELETE FROM chunk_fts WHERE file_path = ?` is a
 * full table scan every time (FTS5's `xBestIndex` will not consume an equality
 * constraint on an ordinary column).
 *
 * Measured on the E1 ladder, one changed file: 3.0 ms at T1 (3,679 chunks) →
 * 18.2 ms at T5 → 95.6 ms at T8 → 151.6 ms at T9 (73,359 chunks); OLS on
 * log-log gives exponent 1.32, R² 0.9975. That is the cost of re-indexing ONE
 * file, and it grows with the size of the whole repository.
 *
 * The fix records the contiguous rowid block each file owns, because a rowid is
 * the one column FTS5 will seek on. The invariant every test here defends:
 *
 *   **`files.chunk_fts_lo/hi` bound exactly the rowids of that file's
 *   `chunk_fts` rows, and no other file's.**
 *
 * The second clause is the dangerous one. A block that is too wide does not
 * fail loudly — it silently deletes a neighbouring file's search rows, and the
 * only symptom is a document that stops being findable. So the neighbour test
 * below is the load-bearing one, not the happy path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'kysely';
import { openDatabase, type Db } from '../db.js';
import { populateFile } from '../populate.js';
import type { FileIndexData } from '../populate.js';
import type { Chunk, SymbolRecord } from '../../ast/types.js';
import type { IdentifierRow } from '../../ast/extractor.js';

/**
 * `identifierCount` defaults to `count` but is separable: markdown chunks
 * produce chunk rows and no identifier rows, which is why the two blocks are
 * tracked independently (FINDINGS.md §1.4).
 */
function fileData(
  filePath: string,
  mtime = 1_700_000_000,
  count = 5,
  identifierCount = count,
): Omit<FileIndexData, 'edges'> {
  const chunks: Chunk[] = Array.from({ length: count }, (_, i) => ({
    chunk_id: `${filePath}:${i}`,
    file_path: filePath,
    start_line: i * 2 + 1,
    end_line: i * 2 + 2,
    content: `function f${i}() { return ${i}; }`,
    chunk_type: 'function' as const,
    symbol_name: `f${i}`,
    parent_symbol: null,
    is_exported: true,
    language: 'typescript' as const,
    file_mtime: mtime,
  }));
  const symbols: SymbolRecord[] = Array.from({ length: count }, (_, i) => ({
    name: `s${i}`, kind: 'function', line: i + 1, isExported: true,
    declarationHash: null, bodyHash: null,
  }));
  const identifierRows: IdentifierRow[] = Array.from({ length: identifierCount }, (_, i) => ({
    chunk_id: `${filePath}:${i}`, identifiers: `f${i} return`,
  }));
  return { filePath, language: 'typescript', mtime, chunks, imports: [], symbols, identifierRows };
}

type Block = { lo: number | null; hi: number | null };

const chunkBlock = async (db: Db, path: string): Promise<Block> => {
  const r = await db.selectFrom('files')
    .select(['chunk_fts_lo as lo', 'chunk_fts_hi as hi'])
    .where('path', '=', path).executeTakeFirstOrThrow();
  return r;
};

const identBlock = async (db: Db, path: string): Promise<Block> => {
  const r = await db.selectFrom('files')
    .select(['ident_fts_lo as lo', 'ident_fts_hi as hi'])
    .where('path', '=', path).executeTakeFirstOrThrow();
  return r;
};

/** Actual rowids a file occupies, read straight from the virtual table. */
const rowidsIn = async (db: Db, table: 'chunk_fts' | 'identifier_fts', path: string): Promise<number[]> => {
  const rows = await sql<{ rowid: number }>`
    SELECT rowid FROM ${sql.table(table)} WHERE file_path = ${path} ORDER BY rowid
  `.execute(db);
  return rows.rows.map((r) => r.rowid);
};

describe('the FTS rowid block', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-ftsblock-'));
    db = openDatabase(dir);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('bounds exactly the chunk_fts rowids the file owns', async () => {
    await populateFile(db, fileData('a.ts', 1_700_000_000, 5));

    const rowids = await rowidsIn(db, 'chunk_fts', 'a.ts');
    const block = await chunkBlock(db, 'a.ts');

    expect(block).toEqual({ lo: rowids[0], hi: rowids[rowids.length - 1] });
  });

  it('bounds the identifier_fts rowids independently of the chunk_fts block', async () => {
    // Three chunks, one identifier row — the markdown shape. A single shared
    // block would be wrong for one of the two tables.
    await populateFile(db, fileData('a.ts', 1_700_000_000, 3, 1));

    const rowids = await rowidsIn(db, 'identifier_fts', 'a.ts');
    expect(rowids).toHaveLength(1);
    expect(await identBlock(db, 'a.ts')).toEqual({ lo: rowids[0], hi: rowids[0] });
  });

  it('records a null block for a file that produces no chunks', async () => {
    await populateFile(db, fileData('empty.ts', 1_700_000_000, 0));

    expect(await chunkBlock(db, 'empty.ts')).toEqual({ lo: null, hi: null });
  });

  it('moves the block when the file is re-indexed', async () => {
    await populateFile(db, fileData('a.ts', 1_700_000_000, 5));
    const before = await chunkBlock(db, 'a.ts');

    await populateFile(db, fileData('a.ts', 1_700_000_100, 2));
    const after = await chunkBlock(db, 'a.ts');

    expect(after).toEqual({ lo: (before.hi ?? 0) + 1, hi: (before.hi ?? 0) + 2 });
  });

  // The load-bearing one: a block that overreaches deletes a neighbour's rows,
  // and nothing else in the suite would notice.
  it('leaves a neighbouring file untouched when one file is re-indexed', async () => {
    await populateFile(db, fileData('a.ts', 1_700_000_000, 5));
    await populateFile(db, fileData('b.ts', 1_700_000_000, 5));
    const bBefore = await rowidsIn(db, 'chunk_fts', 'b.ts');

    await populateFile(db, fileData('a.ts', 1_700_000_100, 3));

    expect(await rowidsIn(db, 'chunk_fts', 'b.ts')).toEqual(bBefore);
    expect(await rowidsIn(db, 'chunk_fts', 'a.ts')).toHaveLength(3);
  });

  // Databases indexed before Stage 4.6 have NULL blocks. They must still be
  // cleaned — degraded to the old scan, never skipped.
  it('still removes stale rows for a file whose block predates the column', async () => {
    await populateFile(db, fileData('a.ts', 1_700_000_000, 5));
    await db.updateTable('files')
      .set({ chunk_fts_lo: null, chunk_fts_hi: null, ident_fts_lo: null, ident_fts_hi: null })
      .where('path', '=', 'a.ts').execute();

    await populateFile(db, fileData('a.ts', 1_700_000_100, 2));

    expect(await rowidsIn(db, 'chunk_fts', 'a.ts')).toHaveLength(2);
    expect(await rowidsIn(db, 'identifier_fts', 'a.ts')).toHaveLength(2);
  });
});
