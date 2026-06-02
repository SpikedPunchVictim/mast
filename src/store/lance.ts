import * as lancedb from '@lancedb/lancedb';
import type { VectorQuery } from '@lancedb/lancedb';
import * as arrow from 'apache-arrow';
import { join } from 'node:path';
import type { Chunk, VectorEntry } from '../ast/types.js';

const CHUNK_TABLE = 'chunks';
const VECTOR_TABLE = 'vectors';

function buildChunkSchema(): arrow.Schema {
  return new arrow.Schema([
    new arrow.Field('chunk_id', new arrow.Utf8(), false),
    new arrow.Field('file_path', new arrow.Utf8(), false),
    new arrow.Field('start_line', new arrow.Int32(), false),
    new arrow.Field('end_line', new arrow.Int32(), false),
    new arrow.Field('content', new arrow.Utf8(), false),
    new arrow.Field('chunk_type', new arrow.Utf8(), false),
    new arrow.Field('symbol_name', new arrow.Utf8(), true),
    new arrow.Field('parent_symbol', new arrow.Utf8(), true),
    new arrow.Field('is_exported', new arrow.Bool(), false),
    new arrow.Field('language', new arrow.Utf8(), false),
    new arrow.Field('file_mtime', new arrow.Float64(), false),
  ]);
}

function buildVectorSchema(embeddingDim: number): arrow.Schema {
  return new arrow.Schema([
    new arrow.Field('chunk_id', new arrow.Utf8(), false),
    new arrow.Field(
      'embedding',
      new arrow.FixedSizeList(
        embeddingDim,
        new arrow.Field('item', new arrow.Float32(), false),
      ),
      false,
    ),
    new arrow.Field('model_version', new arrow.Utf8(), false),
  ]);
}

export class LanceStore {
  private constructor(private readonly db: lancedb.Connection) {}

  static async open(stateDir: string): Promise<LanceStore> {
    const db = await lancedb.connect(join(stateDir, 'lance'));
    return new LanceStore(db);
  }

  // ---------------------------------------------------------------------------
  // Chunks table
  // ---------------------------------------------------------------------------

  async ensureChunksTable(): Promise<lancedb.Table> {
    const names = await this.db.tableNames();
    if (names.includes(CHUNK_TABLE)) {
      return this.db.openTable(CHUNK_TABLE);
    }
    return this.db.createEmptyTable(CHUNK_TABLE, buildChunkSchema());
  }

  /** Replace all chunks for `filePath` atomically. */
  async replaceChunksForFile(filePath: string, chunks: readonly Chunk[]): Promise<void> {
    const table = await this.db.openTable(CHUNK_TABLE);
    await table.delete(`file_path = '${escapeString(filePath)}'`);
    if (chunks.length > 0) {
      await table.add(chunks.map(chunkToRecord));
    }
  }

  async deleteChunksForFiles(filePaths: readonly string[]): Promise<void> {
    if (filePaths.length === 0) return;
    const table = await this.db.openTable(CHUNK_TABLE);
    for (const fp of filePaths) {
      await table.delete(`file_path = '${escapeString(fp)}'`);
    }
  }

  async getChunksByFilePath(filePath: string): Promise<ChunkRecord[]> {
    const table = await this.db.openTable(CHUNK_TABLE);
    // table.query() returns a Query; .where() filters without vector search.
    const rows = await table
      .query()
      .where(`file_path = '${escapeString(filePath)}'`)
      .toArray();
    return rows as ChunkRecord[];
  }

  async chunkCount(): Promise<number> {
    const table = await this.db.openTable(CHUNK_TABLE);
    return table.countRows();
  }

  // ---------------------------------------------------------------------------
  // Vectors table
  // ---------------------------------------------------------------------------

  async ensureVectorsTable(embeddingDim: number): Promise<lancedb.Table> {
    const names = await this.db.tableNames();
    if (names.includes(VECTOR_TABLE)) {
      return this.db.openTable(VECTOR_TABLE);
    }
    return this.db.createEmptyTable(VECTOR_TABLE, buildVectorSchema(embeddingDim));
  }

  async insertVectors(entries: readonly VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const table = await this.db.openTable(VECTOR_TABLE);
    await table.add(entries.map(vectorToRecord));
  }

  async deleteVectorsForChunks(chunkIds: readonly string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const table = await this.db.openTable(VECTOR_TABLE);
    const ids = chunkIds.map((id) => `'${escapeString(id)}'`).join(', ');
    await table.delete(`chunk_id IN (${ids})`);
  }

  /**
   * Nearest-neighbour vector search using cosine distance.
   * `table.search()` returns `VectorQuery | Query`; we assert `VectorQuery`
   * because we always pass a numeric vector, not a string FTS query.
   */
  async searchVectors(queryVector: readonly number[], limit: number): Promise<VectorSearchRow[]> {
    const names = await this.db.tableNames();
    if (!names.includes(VECTOR_TABLE)) return [];
    const table = await this.db.openTable(VECTOR_TABLE);
    const rows = await (table.search(Array.from(queryVector)) as VectorQuery)
      .distanceType('cosine')
      .limit(limit)
      .toArray();
    return rows as VectorSearchRow[];
  }

  async getEmbeddedChunkIds(): Promise<Set<string>> {
    const names = await this.db.tableNames();
    if (!names.includes(VECTOR_TABLE)) return new Set();
    const table = await this.db.openTable(VECTOR_TABLE);
    const rows = await table.query().select(['chunk_id']).toArray();
    return new Set(
      (rows as unknown as { chunk_id: string }[]).map((r) => r.chunk_id),
    );
  }

  // ---------------------------------------------------------------------------
  // Bulk chunk access (used by Phase 2 embedding)
  // ---------------------------------------------------------------------------

  /** Return every row in the chunks table. Returns [] when Phase 1 has not run. */
  async getAllChunks(): Promise<ChunkRecord[]> {
    const names = await this.db.tableNames();
    if (!names.includes(CHUNK_TABLE)) return [];
    const table = await this.db.openTable(CHUNK_TABLE);
    const rows = await table.query().toArray();
    return rows as ChunkRecord[];
  }

  /** Return chunk rows matching the given IDs. Unrecognised IDs are silently skipped. */
  async getChunksByIds(ids: readonly string[]): Promise<ChunkRecord[]> {
    if (ids.length === 0) return [];
    const names = await this.db.tableNames();
    if (!names.includes(CHUNK_TABLE)) return [];
    const table = await this.db.openTable(CHUNK_TABLE);
    const escaped = ids.map((id) => `'${escapeString(id)}'`).join(', ');
    const rows = await table.query().where(`chunk_id IN (${escaped})`).toArray();
    return rows as ChunkRecord[];
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface ChunkRecord {
  chunk_id: string;
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  chunk_type: string;
  symbol_name: string | null;
  parent_symbol: string | null;
  is_exported: boolean;
  language: string;
  file_mtime: number;
}

export interface VectorSearchRow {
  chunk_id: string;
  model_version: string;
  _distance: number;
}

// LanceDB's Data type is Record<string, unknown>[] — these functions satisfy it.

function chunkToRecord(c: Chunk): Record<string, unknown> {
  return {
    chunk_id:     c.chunk_id,
    file_path:    c.file_path,
    start_line:   c.start_line,
    end_line:     c.end_line,
    content:      c.content,
    chunk_type:   c.chunk_type,
    symbol_name:  c.symbol_name,
    parent_symbol: c.parent_symbol,
    is_exported:  c.is_exported,
    language:     c.language,
    file_mtime:   c.file_mtime,
  };
}

function vectorToRecord(v: VectorEntry): Record<string, unknown> {
  return {
    chunk_id:      v.chunk_id,
    embedding:     Array.from(v.embedding),
    model_version: v.model_version,
  };
}

function escapeString(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Convert a `ChunkRecord` (LanceDB row shape) back to the `Chunk` domain type.
 * The string fields `chunk_type` and `language` are narrowed by cast — they are
 * written by our own code and are always valid members of the union.
 */
export function chunkRecordToChunk(r: ChunkRecord): Chunk {
  return {
    chunk_id:     r.chunk_id,
    file_path:    r.file_path,
    start_line:   r.start_line,
    end_line:     r.end_line,
    content:      r.content,
    chunk_type:   r.chunk_type as Chunk['chunk_type'],
    symbol_name:  r.symbol_name,
    parent_symbol: r.parent_symbol,
    is_exported:  r.is_exported,
    language:     r.language as Chunk['language'],
    file_mtime:   r.file_mtime,
  };
}
