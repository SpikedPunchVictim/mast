/**
 * Stage 4.5 S1 (IMPLEMENTATION_PLAN.md, added 2026-08-07) — integration red
 * test for the SQLite bound-parameter ceiling defect.
 *
 * SQLite's `MAX_VARIABLE_NUMBER` is 32,766 (better-sqlite3 12.11.1 / SQLite
 * 3.53.2). `populateFile`'s default (no-override) chunk write
 * (`replaceChunksInline`, `populate.ts`) issues ONE multi-row `INSERT` for a
 * file's whole chunk set — 11 columns/row caps a single file at ~2,978
 * chunks. A larger file (vscode's whale fixtures, 146,620 lines) throws
 * `SqliteError: too many SQL variables` and rolls back the WHOLE per-file
 * transaction, silently dropping that file from the index for orchestration
 * that gates only on exit code (`write_errors` is incremented, but nothing
 * requires a caller to check it).
 *
 * This test does NOT parse a real 146k-line file — it synthesizes an
 * extraction with counts chosen to individually exceed several of the eight
 * batching sites' caps in one `populateFile` call:
 *   - 3,000 chunks   (3,000 × 11 = 33,000 params > 32,766 ceiling)
 *   - 5,000 symbols  (5,000 ×  7 = 35,000 params > 32,766 ceiling, and > the
 *                      ~4,680/batch cap for the 7-column `symbols` row shape)
 *   - 5,000 matching identifier_fts rows (well under that table's own
 *     3-column cap, included to prove the FTS write also survives the same
 *     transaction once chunks/symbols are batched).
 *
 * better-sqlite3 is synchronous, so thousands of small rows (short `content`
 * strings) run in well under a second — no need for a real large file.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { populateFile } from '../populate.js';
import type { FileIndexData } from '../populate.js';
import type { Chunk, SymbolRecord } from '../../ast/types.js';
import type { IdentifierRow } from '../../ast/extractor.js';

const WHALE_CHUNK_COUNT = 3_000; // × 11 cols = 33,000 params, past the 32,766 ceiling
const WHALE_SYMBOL_COUNT = 5_000; // × 7 cols = 35,000 params, past both the ceiling and the ~4,680/batch cap

function makeWhaleChunks(filePath: string, count: number): Chunk[] {
  return Array.from({ length: count }, (_, i) => ({
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
    file_mtime: 1_700_000_000,
  }));
}

function makeWhaleSymbols(count: number): SymbolRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `s${i}`,
    kind: 'function',
    line: i + 1,
    isExported: true,
    declarationHash: null,
    bodyHash: null,
  }));
}

function makeWhaleIdentifierRows(filePath: string, count: number): IdentifierRow[] {
  return Array.from({ length: count }, (_, i) => ({
    chunk_id: `${filePath}:${i}`,
    identifiers: `f${i} return`,
  }));
}

describe('populateFile — whale file (Stage 4.5 S1)', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-whale-'));
    db = openDatabase(dir);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('indexes a file whose chunk/symbol counts exceed the SQLite bound-parameter ceiling', async () => {
    const filePath = 'whale.ts';
    const chunks = makeWhaleChunks(filePath, WHALE_CHUNK_COUNT);
    const symbols = makeWhaleSymbols(WHALE_SYMBOL_COUNT);
    const identifierRows = makeWhaleIdentifierRows(filePath, WHALE_CHUNK_COUNT);

    const data: Omit<FileIndexData, 'edges'> = {
      filePath,
      language: 'typescript',
      mtime: 1_700_000_000,
      chunks,
      imports: [],
      symbols,
      identifierRows,
    };

    const result = await populateFile(db, data);

    expect(result.written).toBe(true);

    const chunkCount = await db
      .selectFrom('chunks')
      .select((eb) => eb.fn.count<number>('chunk_id').as('count'))
      .where('file_path', '=', filePath)
      .executeTakeFirst();
    expect(chunkCount?.count).toBe(WHALE_CHUNK_COUNT);

    const symbolCount = await db
      .selectFrom('symbols')
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .where('file_id', '=', result.fileId)
      .executeTakeFirst();
    expect(symbolCount?.count).toBe(WHALE_SYMBOL_COUNT);
  });
});
