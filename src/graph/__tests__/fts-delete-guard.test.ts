/**
 * The FTS5 delete guard — skip the per-file delete-scan when the file was never
 * indexed.
 *
 * `DELETE FROM chunk_fts WHERE file_path = ?` is a full table scan: FTS5's
 * `xBestIndex` (`sqlite3.c:260775-260860`) will not consume an equality
 * constraint on an ordinary column. E1-FTS measured that scan at **91.7% of
 * T9's write phase**, growing with exponent 2.35, and matching zero rows every
 * time on a cold build (IMPLEMENTATION_PLAN.md § E1-FTS RESULT).
 *
 * The guard reuses the monotonic write-guard's SELECT, which already knows
 * whether the file had a `files` row. Its safety rests on ONE invariant:
 *
 *   **A file's FTS rows exist only if its `files` row exists.**
 *
 * That invariant is maintained by the only two writers of these tables, both in
 * `graph/populate.ts` and both transactional: `writePopulatedFileRows` writes
 * the `files` row and the FTS rows in one `BEGIN IMMEDIATE`, and
 * `removeDeletedFiles` deletes both in one transaction. `chunk_fts` and
 * `identifier_fts` are FTS5 virtual tables and do NOT participate in the
 * foreign-key cascade that removes `symbols` / `edges` / `imports`, so the
 * second writer's explicit deletes are load-bearing — which is why this file
 * pins the invariant directly rather than assuming it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { populateFile, removeDeletedFiles, newWriteSpans } from '../populate.js';
import type { FileIndexData } from '../populate.js';
import type { Chunk, SymbolRecord } from '../../ast/types.js';
import type { IdentifierRow } from '../../ast/extractor.js';

function fileData(filePath: string, mtime = 1_700_000_000, count = 5): Omit<FileIndexData, 'edges'> {
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
  const identifierRows: IdentifierRow[] = Array.from({ length: count }, (_, i) => ({
    chunk_id: `${filePath}:${i}`, identifiers: `f${i} return`,
  }));
  return { filePath, language: 'typescript', mtime, chunks, imports: [], symbols, identifierRows };
}

const ftsRows = async (db: Db, filePath: string): Promise<number> => {
  const r = await db
    .selectFrom('chunk_fts')
    .select((eb) => eb.fn.count<number>('chunk_id').as('c'))
    .where('file_path', '=', filePath)
    .executeTakeFirst();
  return r?.c ?? 0;
};

describe('the FTS delete guard', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-ftsguard-'));
    db = openDatabase(dir);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  // The whole point: on a cold build the scan is skipped entirely.
  it('does not run the delete-scan for a file that was never indexed', async () => {
    const spans = newWriteSpans();
    await populateFile(db, fileData('a.ts'), { spans });

    expect(spans.fts_del).toBe(0);
    expect(await ftsRows(db, 'a.ts')).toBe(5);
  });

  // The guard must not become "never delete". A file with a prior version has
  // rows that MUST be removed, or the index silently accumulates stale hits.
  it('runs the delete-scan for a file that was indexed before', async () => {
    await populateFile(db, fileData('a.ts', 1_700_000_000, 5));

    const spans = newWriteSpans();
    await populateFile(db, fileData('a.ts', 1_700_000_100, 3), { spans });

    expect(spans.fts_del).toBeGreaterThan(0);
    expect(await ftsRows(db, 'a.ts')).toBe(3);
  });

  it('leaves no stale rows when a file shrinks on re-index', async () => {
    await populateFile(db, fileData('a.ts', 1_700_000_000, 9));
    await populateFile(db, fileData('a.ts', 1_700_000_100, 2));

    const rows = await db.selectFrom('chunk_fts').select('chunk_id').where('file_path', '=', 'a.ts').execute();
    expect(rows.map((r) => r.chunk_id).sort()).toEqual(['a.ts:0', 'a.ts:1']);
  });

  it('guards each file independently', async () => {
    await populateFile(db, fileData('a.ts'));

    const spans = newWriteSpans();
    await populateFile(db, fileData('b.ts'), { spans });
    expect(spans.fts_del).toBe(0); // b.ts is new even though a.ts is not
    expect(await ftsRows(db, 'a.ts')).toBe(5);
    expect(await ftsRows(db, 'b.ts')).toBe(5);
  });

  // THE INVARIANT THE GUARD RESTS ON. `chunk_fts` / `identifier_fts` are FTS5
  // virtual tables and do NOT participate in the FK cascade that removes
  // symbols/edges/imports when a `files` row goes. If a future change ever
  // deletes a `files` row without its FTS rows, this test fails — and the guard
  // silently becomes wrong, because it would then skip a delete that had work
  // to do.
  it('leaves no FTS rows behind when a deleted file is cleaned up', async () => {
    await populateFile(db, fileData('gone.ts'));
    expect(await ftsRows(db, 'gone.ts')).toBe(5);

    await removeDeletedFiles(db, ['gone.ts']);

    expect(await ftsRows(db, 'gone.ts')).toBe(0);
    const identifiers = await db
      .selectFrom('identifier_fts').select('chunk_id').where('file_path', '=', 'gone.ts').execute();
    expect(identifiers).toEqual([]);
    const files = await db.selectFrom('files').select('id').where('path', '=', 'gone.ts').execute();
    expect(files).toEqual([]);
  });

  // Follows from the invariant above: cleanup removed both, so re-adding is a
  // cold write and the guard is right to skip.
  it('re-indexes a deleted-then-restored file without duplicating rows', async () => {
    await populateFile(db, fileData('cycle.ts', 1_700_000_000, 4));
    await removeDeletedFiles(db, ['cycle.ts']);

    const spans = newWriteSpans();
    await populateFile(db, fileData('cycle.ts', 1_700_000_100, 4), { spans });

    expect(spans.fts_del).toBe(0);
    expect(await ftsRows(db, 'cycle.ts')).toBe(4);
  });

  // The stale-write rejection returns before any write. The guard must not have
  // moved work in front of it.
  it('writes nothing when the monotonic guard rejects a stale write', async () => {
    await populateFile(db, fileData('a.ts', 2_000, 5));
    const result = await populateFile(db, fileData('a.ts', 1_000, 2));

    expect(result.written).toBe(false);
    expect(await ftsRows(db, 'a.ts')).toBe(5);
  });

  // E1-FTS's arm G must keep working: it is the instrument of a completed
  // experiment and skips the deletes unconditionally, guard or no guard.
  it('still honours the eval-only unconditional skip', async () => {
    await populateFile(db, fileData('a.ts', 1_700_000_000, 3));

    const spans = newWriteSpans();
    await populateFile(db, fileData('a.ts', 1_700_000_100, 3), { spans, skipFtsDeletes: true });

    expect(spans.fts_del).toBe(0);
    expect(await ftsRows(db, 'a.ts')).toBe(6); // 3 stale + 3 fresh — the arm's known cost
  });
});
