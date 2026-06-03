import * as lancedb from '@lancedb/lancedb';
import type { VectorQuery } from '@lancedb/lancedb';
import * as arrow from 'apache-arrow';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Chunk, VectorEntry } from '../ast/types.js';
import { joinVectorKey } from '../indexer/embedder.js';

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
    // sha256 of the chunk content this vector came from — the freshness key (H1).
    new arrow.Field('content_hash', new arrow.Utf8(), false),
  ]);
}

export class LanceStore {
  private constructor(private readonly db: lancedb.Connection) {}

  static async open(stateDir: string): Promise<LanceStore> {
    const lancePath = join(stateDir, 'lance');
    let db = await lancedb.connect(lancePath);

    // Probe for data-fragment corruption: the chunks table manifest may reference
    // .lance fragment files that no longer exist on disk (e.g. the data/ directory
    // was externally wiped while _versions/ survived). Without early detection,
    // every write in the subsequent reindex fails with "Not found" and the error
    // cascades silently through the entire run. Wipe the lance directory and
    // reconnect so ensureChunksTable() starts with a clean slate.
    const tableNames = await db.tableNames();
    if (tableNames.includes(CHUNK_TABLE)) {
      try {
        const table = await db.openTable(CHUNK_TABLE);
        // countRows() with no predicate reads only the manifest metadata and
        // succeeds even when data fragment files are missing. A limit-1 scan
        // forces LanceDB to open an actual fragment file, surfacing "Not found"
        // when the data/ directory has been externally wiped.
        await table.query().limit(1).toArray();
      } catch (err) {
        if (isFragmentMissingError(err)) {
          process.stderr.write(
            '[mast] WARN: chunks.lance has missing data fragments — ' +
            'wiping lance directory; a full reindex will rebuild it\n',
          );
          rmSync(lancePath, { recursive: true, force: true });
          db = await lancedb.connect(lancePath);
        } else {
          throw err;
        }
      }
    }

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

  /** Replace all chunks for `filePath` atomically. Returns the number of old
   *  chunks removed (so callers can report `chunks_removed`). */
  async replaceChunksForFile(filePath: string, chunks: readonly Chunk[]): Promise<number> {
    const table = await this.db.openTable(CHUNK_TABLE);
    const predicate = `file_path = '${escapeString(filePath)}'`;
    const removed = await table.countRows(predicate);
    await table.delete(predicate);
    if (chunks.length > 0) {
      await table.add(chunks.map(chunkToRecord));
    }
    return removed;
  }

  /** Delete all chunks for the given files. Returns the total rows removed. */
  async deleteChunksForFiles(filePaths: readonly string[]): Promise<number> {
    if (filePaths.length === 0) return 0;
    const table = await this.db.openTable(CHUNK_TABLE);
    let removed = 0;
    for (const fp of filePaths) {
      const predicate = `file_path = '${escapeString(fp)}'`;
      removed += await table.countRows(predicate);
      await table.delete(predicate);
    }
    return removed;
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

  /**
   * Insert vectors, first deleting any existing rows for the same chunk ids.
   * Used by the embed paths so re-embedding a chunk (e.g. after an in-place
   * edit, same chunk_id) overwrites its stale vector instead of appending a
   * duplicate — LanceDB enforces no uniqueness on chunk_id (H1).
   */
  async upsertVectors(entries: readonly VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const table = await this.db.openTable(VECTOR_TABLE);
    const ids = entries.map((e) => `'${escapeString(e.chunk_id)}'`).join(', ');
    await table.delete(`chunk_id IN (${ids})`);
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

  /**
   * Freshness keys (chunk id + content hash) for every stored vector. A chunk
   * is up to date only when `vectorKey(chunk_id, content)` is in this set — so a
   * chunk whose content changed (same id, new hash) is treated as pending (H1).
   */
  async getEmbeddedVectorKeys(): Promise<Set<string>> {
    const names = await this.db.tableNames();
    if (!names.includes(VECTOR_TABLE)) return new Set();
    const table = await this.db.openTable(VECTOR_TABLE);
    const rows = await table.query().select(['chunk_id', 'content_hash']).toArray();
    return new Set(
      (rows as unknown as { chunk_id: string; content_hash: string }[])
        .map((r) => joinVectorKey(r.chunk_id, r.content_hash ?? '')),
    );
  }

  /** Total number of stored vectors (rows, not deduped) — used to assert no duplicates. */
  async vectorCount(): Promise<number> {
    const names = await this.db.tableNames();
    if (!names.includes(VECTOR_TABLE)) return 0;
    const table = await this.db.openTable(VECTOR_TABLE);
    return table.countRows();
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
    content_hash:  v.content_hash ?? '',
  };
}

/** True when the error is LanceDB reporting a missing data fragment on disk. */
function isFragmentMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // LanceDB surfaces missing fragments in two forms depending on access path:
  //   Direct read: "lance error: Not found: <path>.lance, ..."
  //   Streaming scan: "... Object at location <path>.lance not found: No such file ..."
  // Both contain a .lance path and a "not found" / "No such file" substring.
  return (
    msg.includes('.lance') &&
    (msg.includes('Not found') || msg.includes('not found') || msg.includes('No such file'))
  );
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
