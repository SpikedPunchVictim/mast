import type { Db } from '../graph/db.js';
import type { Chunk } from '../ast/types.js';
import type { ChunkRecord } from './lance.js';

// ---------------------------------------------------------------------------
// Default (production) chunk store — M1, eval/GITNEXUS_COMPARISON.md §15.1.
//
// Chunks live in graph.db's `chunks` table (graph/db.ts), NOT a separate
// file — `SqliteChunkStore` wraps the SAME `Db` connection every other graph
// consumer uses, rather than opening its own. This is what makes
// `graph/populate.ts`'s `populateFile` able to write chunks inside its own
// per-file transaction (true atomicity with symbols/edges/imports/chunk_fts),
// and it means multi-process contention over chunk reads/writes routes
// through the one WAL-mode connection graph.db already serialises, instead of
// needing a second file's own locking story.
//
// This class is the WRITE-FAILURE injection point for
// indexer/__tests__/write-failures.test.ts (via `IndexOptions.chunkStoreOverride`
// -> `populateFile`'s `chunkWriter` param, see graph/populate.ts) and remains
// the general chunk-read surface every search/tool consumer depends on
// (`ChunkStore`, defined below).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Role interface (§4.3) — the chunk-store operations real consumers use.
// Mirrors the existing `ChunkByIdSource` precedent (search/potential-matches.ts)
// and the `Pick<LanceStore, ...>` precedent (indexer/background-embedder.ts).
// `LanceStore` still satisfies this structurally (its six chunk-table methods
// are unchanged) — kept for M2 to decide, but no production path uses it for
// chunks any more.
// ---------------------------------------------------------------------------

export interface ChunkStore {
  /** Replace all chunks for `filePath` atomically. Returns rows removed. */
  replaceChunksForFile(filePath: string, chunks: readonly Chunk[]): Promise<number>;
  /** Delete all chunks for the given files. Returns total rows removed. */
  deleteChunksForFiles(filePaths: readonly string[]): Promise<number>;
  getChunksByFilePath(filePath: string): Promise<ChunkRecord[]>;
  /** Unrecognised ids are silently skipped (LanceStore parity). */
  getChunksByIds(ids: readonly string[]): Promise<ChunkRecord[]>;
  getAllChunks(): Promise<ChunkRecord[]>;
  chunkCount(): Promise<number>;
}

export class SqliteChunkStore implements ChunkStore {
  constructor(private readonly db: Db) {}

  /**
   * Used directly by `populateFile`'s default (no-override) path via a plain
   * function reference, not this class — see `graph/populate.ts`'s
   * `replaceChunksInline`. This method exists so `SqliteChunkStore` itself is
   * a complete, independently-usable `ChunkStore` (tests construct it
   * directly, and it is a valid `chunkStoreOverride`/`ChunkWriter` source).
   */
  async replaceChunksForFile(filePath: string, chunks: readonly Chunk[]): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('chunks')
        .select((eb) => eb.fn.count<number>('chunk_id').as('count'))
        .where('file_path', '=', filePath)
        .executeTakeFirst();
      const removed = row?.count ?? 0;

      await trx.deleteFrom('chunks').where('file_path', '=', filePath).execute();
      if (chunks.length > 0) {
        await trx.insertInto('chunks').values(chunks.map(chunkToRow)).execute();
      }
      return removed;
    });
  }

  async deleteChunksForFiles(filePaths: readonly string[]): Promise<number> {
    if (filePaths.length === 0) return 0;
    return this.db.transaction().execute(async (trx) => {
      let removed = 0;
      for (const fp of filePaths) {
        const row = await trx
          .selectFrom('chunks')
          .select((eb) => eb.fn.count<number>('chunk_id').as('count'))
          .where('file_path', '=', fp)
          .executeTakeFirst();
        removed += row?.count ?? 0;
        await trx.deleteFrom('chunks').where('file_path', '=', fp).execute();
      }
      return removed;
    });
  }

  async getChunksByFilePath(filePath: string): Promise<ChunkRecord[]> {
    const rows = await this.db
      .selectFrom('chunks')
      .selectAll()
      .where('file_path', '=', filePath)
      .execute();
    return rows.map(rowToChunkRecord);
  }

  async getChunksByIds(ids: readonly string[]): Promise<ChunkRecord[]> {
    if (ids.length === 0) return [];
    // Largest id set any call site passes is 50 (hybrid.ts candidateLimit,
    // potential-matches.ts limit=50) — well under SQLite's bound
    // parameter-count ceiling (MAX_VARIABLE_NUMBER=32766 on the installed
    // better-sqlite3 12.11.1 / SQLite 3.53.2), so no batching is needed.
    const rows = await this.db
      .selectFrom('chunks')
      .selectAll()
      .where('chunk_id', 'in', ids as string[])
      .execute();
    return rows.map(rowToChunkRecord);
  }

  async getAllChunks(): Promise<ChunkRecord[]> {
    const rows = await this.db.selectFrom('chunks').selectAll().execute();
    return rows.map(rowToChunkRecord);
  }

  async chunkCount(): Promise<number> {
    const row = await this.db
      .selectFrom('chunks')
      .select((eb) => eb.fn.count<number>('chunk_id').as('count'))
      .executeTakeFirst();
    return row?.count ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Row <-> domain conversions
// ---------------------------------------------------------------------------

function chunkToRow(c: Chunk): {
  chunk_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  chunk_type: string;
  symbol_name: string | null;
  parent_symbol: string | null;
  is_exported: 0 | 1;
  language: string;
  file_mtime: number;
} {
  return {
    chunk_id:      c.chunk_id,
    file_path:     c.file_path,
    start_line:    c.start_line,
    end_line:      c.end_line,
    content:       c.content,
    chunk_type:    c.chunk_type,
    symbol_name:   c.symbol_name,
    parent_symbol: c.parent_symbol,
    is_exported:   c.is_exported ? 1 : 0,
    language:      c.language,
    file_mtime:    c.file_mtime,
  };
}

/**
 * Explicit `0|1` -> `boolean` conversion at the store boundary. SQLite stores
 * booleans as INTEGER (`BoolCol` convention, graph/db.ts) — every read here
 * converts back to `boolean` explicitly so `SearchResult.is_exported`
 * (search/hybrid.ts) and every MCP tool response never silently ships a
 * number where a client expects `true`/`false`.
 */
function rowToChunkRecord(r: {
  chunk_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  chunk_type: string;
  symbol_name: string | null;
  parent_symbol: string | null;
  is_exported: number;
  language: string;
  file_mtime: number;
}): ChunkRecord {
  return {
    chunk_id:      r.chunk_id,
    file_path:     r.file_path,
    start_line:    r.start_line,
    end_line:      r.end_line,
    content:       r.content,
    chunk_type:    r.chunk_type,
    symbol_name:   r.symbol_name,
    parent_symbol: r.parent_symbol,
    is_exported:   r.is_exported === 1,
    language:      r.language,
    file_mtime:    r.file_mtime,
  };
}
