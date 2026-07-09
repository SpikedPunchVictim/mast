/**
 * Stage 3 integration tests: SQLite graph + LanceDB chunk storage.
 *
 * Each test group creates an isolated temp directory so tests never share
 * state. The temp directory is removed after the group regardless of outcome.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import { openDatabase } from '../db.js';
import { populateFile, insertEdges, removeDeletedFiles } from '../populate.js';
import { LanceStore } from '../../store/lance.js';
import { searchFts, searchIdentifiers } from '../../search/fts.js';
import { extractFile } from '../../ast/extract.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_SRC = `import { readFileSync } from 'node:fs';
import type { PathLike } from 'node:fs';

export interface Readable {
  read(path: PathLike): string;
}

export class FileReader implements Readable {
  private encoding: string;

  constructor(encoding = 'utf-8') {
    this.encoding = encoding;
  }

  read(path: PathLike): string {
    return readFileSync(path, this.encoding);
  }

  private decode(buf: Buffer): string {
    return buf.toString(this.encoding);
  }
}

export function readText(path: PathLike): string {
  return readFileSync(path, 'utf-8');
}
`;

const FIXTURE_V2_SRC = `export function readText(path: string): string {
  return 'updated';
}

export function writeText(path: string, data: string): void {
  void path;
  void data;
}
`;

// ---------------------------------------------------------------------------
// SQLite schema initialisation
// ---------------------------------------------------------------------------

describe('SQLite schema initialisation', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-test-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opens a WAL-mode database with the full schema', () => {
    const db = openDatabase(tmpDir);

    // Verify WAL mode via the raw better-sqlite3 handle.
    // Kysely wraps better-sqlite3; we check via a raw query.
    const raw = new Sqlite(join(tmpDir, 'graph.db'));
    try {
      const row = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(row.journal_mode).toBe('wal');
    } finally {
      raw.close();
      void db.destroy();
    }
  });

  it('creates all required tables and FTS5 virtual tables', () => {
    const db = openDatabase(tmpDir);
    const raw = new Sqlite(join(tmpDir, 'graph.db'));
    try {
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'shadow') AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      const names = new Set(tables.map((t) => t.name));

      expect(names.has('files')).toBe(true);
      expect(names.has('symbols')).toBe(true);
      expect(names.has('edges')).toBe(true);
      expect(names.has('imports')).toBe(true);
      expect(names.has('chunk_fts')).toBe(true);
      expect(names.has('identifier_fts')).toBe(true);
      expect(names.has('metrics')).toBe(true);
    } finally {
      raw.close();
      void db.destroy();
    }
  });

  it('creates expected indexes on symbols and edges', () => {
    const raw = new Sqlite(join(tmpDir, 'graph.db'));
    try {
      const indexes = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[];
      const names = new Set(indexes.map((i) => i.name));

      expect(names.has('idx_symbols_lookup')).toBe(true);
      expect(names.has('idx_symbols_file')).toBe(true);
      expect(names.has('idx_edges_from')).toBe(true);
      expect(names.has('idx_edges_to')).toBe(true);
      expect(names.has('idx_imports_file')).toBe(true);
    } finally {
      raw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Graph population (populateFile)
// ---------------------------------------------------------------------------

describe('populateFile — graph population', () => {
  let tmpDir: string;
  let fixtureFile: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-test-'));
    fixtureFile = join(tmpDir, 'reader.ts');
    writeFileSync(fixtureFile, FIXTURE_SRC);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts a file row for each indexed file', async () => {
    const db = openDatabase(tmpDir);
    try {
      const result = extractFile(fixtureFile, tmpDir, 0, 100);
      await populateFile(db, {
        filePath: 'reader.ts',
        language: 'typescript',
        mtime: 1_000,
        chunks: result.chunks,
        imports: result.imports,
        symbols: result.symbols,
        identifierRows: result.identifierRows,
      });

      const file = await db
        .selectFrom('files')
        .select(['path', 'language', 'mtime'])
        .where('path', '=', 'reader.ts')
        .executeTakeFirst();

      expect(file?.path).toBe('reader.ts');
      expect(file?.language).toBe('typescript');
    } finally {
      await db.destroy();
    }
  });

  it('inserts symbols with correct kind and export flag', async () => {
    const db = openDatabase(tmpDir);
    try {
      const result = extractFile(fixtureFile, tmpDir, 0, 100);
      await populateFile(db, {
        filePath: 'reader.ts',
        language: 'typescript',
        mtime: 1_000,
        chunks: result.chunks,
        imports: result.imports,
        symbols: result.symbols,
        identifierRows: result.identifierRows,
      });

      const classSymbol = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select(['s.name', 's.kind', 's.is_exported'])
        .where('f.path', '=', 'reader.ts')
        .where('s.name', '=', 'FileReader')
        .executeTakeFirst();

      expect(classSymbol?.kind).toBe('class');
      expect(classSymbol?.is_exported).toBe(1);

      const fnSymbol = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select(['s.name', 's.kind'])
        .where('f.path', '=', 'reader.ts')
        .where('s.name', '=', 'readText')
        .executeTakeFirst();

      expect(fnSymbol?.kind).toBe('function');
    } finally {
      await db.destroy();
    }
  });

  it('inserts interface symbol with is_exported = 1', async () => {
    const db = openDatabase(tmpDir);
    try {
      const result = extractFile(fixtureFile, tmpDir, 0, 100);
      await populateFile(db, {
        filePath: 'reader.ts',
        language: 'typescript',
        mtime: 1_000,
        chunks: result.chunks,
        imports: result.imports,
        symbols: result.symbols,
        identifierRows: result.identifierRows,
      });

      const sym = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select(['s.kind', 's.is_exported'])
        .where('f.path', '=', 'reader.ts')
        .where('s.name', '=', 'Readable')
        .executeTakeFirst();

      expect(sym?.kind).toBe('interface');
      expect(sym?.is_exported).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  it('inserts import records for the file', async () => {
    const db = openDatabase(tmpDir);
    try {
      const result = extractFile(fixtureFile, tmpDir, 0, 100);
      await populateFile(db, {
        filePath: 'reader.ts',
        language: 'typescript',
        mtime: 1_000,
        chunks: result.chunks,
        imports: result.imports,
        symbols: result.symbols,
        identifierRows: result.identifierRows,
      });

      const imports = await db
        .selectFrom('imports as i')
        .innerJoin('files as f', 'f.id', 'i.file_id')
        .select(['i.module', 'i.is_external'])
        .where('f.path', '=', 'reader.ts')
        .execute();

      const modules = imports.map((r) => r.module);
      expect(modules).toContain('node:fs');
      const fsImport = imports.find((r) => r.module === 'node:fs');
      expect(fsImport?.is_external).toBe(1);
    } finally {
      await db.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Delete-and-replace (incremental reindex consistency)
// ---------------------------------------------------------------------------

describe('delete-and-replace consistency', () => {
  let tmpDir: string;
  let fixtureFile: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-test-'));
    fixtureFile = join(tmpDir, 'reader.ts');
    writeFileSync(fixtureFile, FIXTURE_SRC);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces symbols on re-index, leaving no stale rows', async () => {
    const db = openDatabase(tmpDir);
    try {
      // First index — original source.
      const r1 = extractFile(fixtureFile, tmpDir, 0, 100);
      await populateFile(db, {
        filePath: 'reader.ts',
        language: 'typescript',
        mtime: 1_000,
        chunks: r1.chunks,
        imports: r1.imports,
        symbols: r1.symbols,
        identifierRows: r1.identifierRows,
      });

      const before = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.name')
        .where('f.path', '=', 'reader.ts')
        .execute();
      const beforeNames = new Set(before.map((r) => r.name));
      expect(beforeNames.has('FileReader')).toBe(true);

      // Second index — updated source (FileReader removed, writeText added).
      writeFileSync(fixtureFile, FIXTURE_V2_SRC);
      const r2 = extractFile(fixtureFile, tmpDir, 0, 100);
      await populateFile(db, {
        filePath: 'reader.ts',
        language: 'typescript',
        mtime: 2_000,
        chunks: r2.chunks,
        imports: r2.imports,
        symbols: r2.symbols,
        identifierRows: r2.identifierRows,
      });

      const after = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.name')
        .where('f.path', '=', 'reader.ts')
        .execute();
      const afterNames = new Set(after.map((r) => r.name));

      // FileReader is gone — delete-and-replace removed it.
      expect(afterNames.has('FileReader')).toBe(false);
      // writeText is present — new symbol.
      expect(afterNames.has('writeText')).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it('removeDeletedFiles cascades all rows for a deleted file', async () => {
    const db = openDatabase(tmpDir);
    try {
      const result = extractFile(fixtureFile, tmpDir, 0, 100);
      await populateFile(db, {
        filePath: 'reader.ts',
        language: 'typescript',
        mtime: 1_000,
        chunks: result.chunks,
        imports: result.imports,
        symbols: result.symbols,
        identifierRows: result.identifierRows,
      });

      await removeDeletedFiles(db, ['reader.ts']);

      const fileRow = await db
        .selectFrom('files')
        .select('id')
        .where('path', '=', 'reader.ts')
        .executeTakeFirst();
      expect(fileRow).toBeUndefined();

      const symbolRows = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.id')
        .where('f.path', '=', 'reader.ts')
        .execute();
      expect(symbolRows).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// FTS5 chunk_fts and identifier_fts
// ---------------------------------------------------------------------------

describe('FTS5 population — chunk_fts and identifier_fts', () => {
  let tmpDir: string;
  let fixtureFile: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-test-'));
    fixtureFile = join(tmpDir, 'reader.ts');
    writeFileSync(fixtureFile, FIXTURE_SRC);
    const db = openDatabase(tmpDir);
    try {
      const result = extractFile(fixtureFile, tmpDir, 0, 100);
      await populateFile(db, {
        filePath: 'reader.ts',
        language: 'typescript',
        mtime: 1_000,
        chunks: result.chunks,
        imports: result.imports,
        symbols: result.symbols,
        identifierRows: result.identifierRows,
      });
    } finally {
      await db.destroy();
    }
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('FTS search returns results for a known symbol name', async () => {
    const db = openDatabase(tmpDir);
    try {
      const rows = await searchFts(db, 'FileReader', { limit: 10 });
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await db.destroy();
    }
  });

  it('FTS search returns results for content keywords', async () => {
    const db = openDatabase(tmpDir);
    try {
      // 'encoding' appears in the FileReader class body.
      const rows = await searchFts(db, 'encoding', { limit: 10 });
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await db.destroy();
    }
  });

  it('identifier_fts search returns a chunk containing the identifier', async () => {
    const db = openDatabase(tmpDir);
    try {
      const rows = await searchIdentifiers(db, 'readFileSync');
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await db.destroy();
    }
  });

  it('FTS rows are replaced on re-index (no duplicates)', async () => {
    const db = openDatabase(tmpDir);
    try {
      // Re-index the same file — should not double the rows.
      const result = extractFile(fixtureFile, tmpDir, 0, 100);
      await populateFile(db, {
        filePath: 'reader.ts',
        language: 'typescript',
        mtime: 2_000,
        chunks: result.chunks,
        imports: result.imports,
        symbols: result.symbols,
        identifierRows: result.identifierRows,
      });

      const rows = await searchFts(db, 'FileReader', { limit: 100 });
      // Duplicate FTS rows would produce multiple hits for the same chunk_id.
      const ids = rows.map((r) => r.chunk_id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await db.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// LanceDB chunk table
// ---------------------------------------------------------------------------

describe('LanceStore — chunk table CRUD', () => {
  let tmpDir: string;
  let fixtureFile: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-test-'));
    fixtureFile = join(tmpDir, 'reader.ts');
    writeFileSync(fixtureFile, FIXTURE_SRC);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the chunks table and inserts rows', async () => {
    const lance = await LanceStore.open(tmpDir);
    await lance.ensureChunksTable();

    const result = extractFile(fixtureFile, tmpDir, 0, 100);
    await lance.replaceChunksForFile('reader.ts', result.chunks);

    const count = await lance.chunkCount();
    expect(count).toBeGreaterThan(0);
    expect(count).toBe(result.chunks.length);
  });

  it('getChunksByFilePath returns all chunks for the file', async () => {
    const lance = await LanceStore.open(tmpDir);
    const result = extractFile(fixtureFile, tmpDir, 0, 100);
    await lance.replaceChunksForFile('reader.ts', result.chunks);

    const rows = await lance.getChunksByFilePath('reader.ts');
    expect(rows.length).toBe(result.chunks.length);
    const chunkIds = rows.map((r) => r.chunk_id);
    for (const chunk of result.chunks) {
      expect(chunkIds).toContain(chunk.chunk_id);
    }
  });

  it('replaceChunksForFile deletes old rows and inserts new ones', async () => {
    const lance = await LanceStore.open(tmpDir);

    // First write.
    const r1 = extractFile(fixtureFile, tmpDir, 0, 100);
    await lance.replaceChunksForFile('reader.ts', r1.chunks);
    const countAfterFirst = await lance.chunkCount();

    // Second write with updated source.
    writeFileSync(fixtureFile, FIXTURE_V2_SRC);
    const r2 = extractFile(fixtureFile, tmpDir, 0, 100);
    await lance.replaceChunksForFile('reader.ts', r2.chunks);

    const countAfterSecond = await lance.chunkCount();
    // Chunk count should reflect the new source, not accumulate.
    expect(countAfterSecond).toBe(r2.chunks.length);
    expect(countAfterSecond).not.toBe(countAfterFirst + r2.chunks.length);
  });

  it('deleteChunksForFiles removes all rows for the file', async () => {
    const lance = await LanceStore.open(tmpDir);
    const result = extractFile(fixtureFile, tmpDir, 0, 100);
    await lance.replaceChunksForFile('reader.ts', result.chunks);

    await lance.deleteChunksForFiles(['reader.ts']);
    const count = await lance.chunkCount();
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge insertion (insertEdges)
// ---------------------------------------------------------------------------

describe('insertEdges — second-pass graph edges', () => {
  let tmpDir: string;
  let fixtureFile: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-test-'));
    fixtureFile = join(tmpDir, 'reader.ts');
    writeFileSync(fixtureFile, FIXTURE_SRC);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts a PARENT_OF edge between class and method symbols', async () => {
    const db = openDatabase(tmpDir);
    try {
      const result = extractFile(fixtureFile, tmpDir, 0, 100);
      await populateFile(db, {
        filePath: 'reader.ts',
        language: 'typescript',
        mtime: 1_000,
        chunks: result.chunks,
        imports: result.imports,
        symbols: result.symbols,
        identifierRows: result.identifierRows,
      });

      await insertEdges(db, 'reader.ts', [
        { fromName: 'FileReader', toName: 'FileReader.read', edgeType: 'PARENT_OF' },
      ]);

      const edge = await db
        .selectFrom('edges as e')
        .innerJoin('symbols as fs', 'fs.id', 'e.from_id')
        .innerJoin('symbols as ts', 'ts.id', 'e.to_id')
        .select(['fs.name as from_name', 'ts.name as to_name', 'e.edge_type'])
        .where('e.edge_type', '=', 'PARENT_OF')
        .executeTakeFirst();

      expect(edge?.from_name).toBe('FileReader');
      expect(edge?.to_name).toBe('FileReader.read');
      expect(edge?.edge_type).toBe('PARENT_OF');
    } finally {
      await db.destroy();
    }
  });

  it('silently skips edges for unknown symbol names', async () => {
    const db = openDatabase(tmpDir);
    try {
      const result = extractFile(fixtureFile, tmpDir, 0, 100);
      await populateFile(db, {
        filePath: 'reader.ts',
        language: 'typescript',
        mtime: 1_000,
        chunks: result.chunks,
        imports: result.imports,
        symbols: result.symbols,
        identifierRows: result.identifierRows,
      });

      // Neither symbol exists in the DB.
      await expect(
        insertEdges(db, 'reader.ts', [
          { fromName: 'NoSuchClass', toName: 'NoSuchMethod', edgeType: 'PARENT_OF' },
        ]),
      ).resolves.not.toThrow();
    } finally {
      await db.destroy();
    }
  });
});
