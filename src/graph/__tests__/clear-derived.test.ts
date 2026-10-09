import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Sqlite from 'better-sqlite3';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearDerivedTables, openDatabase, type Db } from '../db.js';

// ---------------------------------------------------------------------------
// The rebuild after a version change empties the index inside `graph.db`
// (adr/proposals/schema-rebuild). Deleting the file left a running server
// reading the deleted one (D125) and took the metrics tables with it (D126).
// ---------------------------------------------------------------------------
describe('clearDerivedTables', () => {
  let stateDir: string;
  let db: Db;

  const raw = (): Sqlite.Database => new Sqlite(join(stateDir, 'graph.db'));
  const count = async (table: string): Promise<number> =>
    Number((await sql<{ c: number }>`SELECT count(*) AS c FROM ${sql.table(table)}`.execute(db)).rows[0]?.c);

  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'mast-clear-derived-'));
    db = openDatabase(stateDir);
    await sql`INSERT INTO files (path, language, mtime) VALUES ('a.ts', 'typescript', 1)`.execute(db);
    await sql`INSERT INTO symbols (name, kind, file_id, line, is_exported) VALUES ('a', 'function', 1, 1, 1)`.execute(db);
    await sql`INSERT INTO chunk_fts (rowid, content) VALUES (1, 'function a')`.execute(db);
    await sql`
      INSERT INTO metrics (tool_name, call_timestamp, tokens_returned, tokens_full_file_upper_bound, duration_ms, session_id, status)
      VALUES ('mast_search', 1, 1, 1, 1, 's', 'ok')`.execute(db);
  });
  afterEach(async () => {
    await db.destroy();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('empties what an index run writes, seen through a handle opened before it', async () => {
    clearDerivedTables(stateDir);

    expect([await count('files'), await count('symbols'), await count('chunk_fts')]).toEqual([0, 0, 0]);
  });

  it('keeps the metrics rows', async () => {
    clearDerivedTables(stateDir);

    expect(await count('metrics')).toBe(1);
  });

  it('brings back a table an older version made with other columns in the current shape', async () => {
    const old = raw();
    old.exec('DROP TABLE symbols; CREATE TABLE symbols (id INTEGER PRIMARY KEY, name TEXT NOT NULL, legacy TEXT)');
    old.close();

    clearDerivedTables(stateDir);

    const columns = (await sql<{ name: string }>`SELECT name FROM pragma_table_info('symbols')`.execute(db)).rows.map((c) => c.name);
    expect(columns).toContain('body_hash');
    expect(columns).not.toContain('legacy');
  });

  it('leaves every table with the columns a new database has', async () => {
    const columnsOf = (dir: string): readonly string[] => {
      const sqlite = new Sqlite(join(dir, 'graph.db'));
      const rows = sqlite
        .prepare("SELECT m.name || '.' || c.name AS col FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = 'table' ORDER BY 1")
        .all()
        .map((row) => (row as { col: string }).col);
      sqlite.close();
      return rows;
    };
    const freshDir = mkdtempSync(join(tmpdir(), 'mast-clear-derived-fresh-'));
    await openDatabase(freshDir).destroy();

    clearDerivedTables(stateDir);

    expect(columnsOf(stateDir)).toEqual(columnsOf(freshDir));
    rmSync(freshDir, { recursive: true, force: true });
  });

  it('throws and removes nothing while another connection is writing', async () => {
    const writer = raw();
    writer.exec('BEGIN IMMEDIATE');

    expect(() => clearDerivedTables(stateDir, { busyTimeoutMs: 50 })).toThrow(/locked/);

    writer.exec('ROLLBACK');
    writer.close();
    expect(await count('files')).toBe(1);
  });
});
