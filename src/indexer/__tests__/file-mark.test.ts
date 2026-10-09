import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { openDatabase } from '../../graph/db.js';
import { CURRENT_SCHEMA_VERSION } from '../../store/config.js';
import { measureFreshness } from '../freshness.js';
import {
  configFor,
  expectGraphEqualsFullIndex,
  indexFull,
  indexIncremental,
  makeProject,
  writeFiles,
} from './graph-fixture.js';

// ---------------------------------------------------------------------------
// D142. `index.json` is one value for the whole index, and a mast of another
// version damages it one file at a time: a running server of an older version
// refreshes a file on a read, in the shape it knows, and the stamp does not
// move. Every file row carries the schema version that wrote it, and a row
// without this version's mark is treated as changed.
// adr/proposals/schema-rebuild/PROPOSAL.md, design 4.
// ---------------------------------------------------------------------------
describe('the schema version each file row was written by (D142)', () => {
  let dir: string;

  const FILES = {
    'src/lib.ts': 'export function target(): number { return 1; }\n',
    'src/use.ts': "import { target as t } from './lib';\nexport function caller(): number {\n  return t();\n}\n",
  };

  function graphDb(): Sqlite.Database {
    return new Sqlite(join(configFor(dir).resolved_state_dir, 'graph.db'));
  }

  /**
   * What a server of an older version leaves of `src/use.ts` after refreshing
   * it: no mark, and rows in its own shape. `dropsTheAlias` is what `v0.4.1`
   * was measured to do. The symbol kind stands for whatever a version stores
   * differently that the stability skip does not compare: the skip reads
   * names, lines, hashes, export flags and imports, not kinds.
   */
  function rewriteAsAnOlderVersionWould(options: { readonly dropsTheAlias: boolean }): void {
    const raw = graphDb();
    if (options.dropsTheAlias) {
      raw.exec("UPDATE imports SET aliases = NULL WHERE file_id = (SELECT id FROM files WHERE path = 'src/use.ts')");
    }
    raw.exec("UPDATE symbols SET kind = 'variable' WHERE name = 'caller'");
    raw.exec("UPDATE files SET written_by = NULL WHERE path = 'src/use.ts'");
    raw.close();
  }

  beforeEach(async () => {
    dir = makeProject('file-mark');
    writeFiles(dir, FILES);
    await indexFull(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is on every row an index run writes', () => {
    const raw = graphDb();
    const rows = raw.prepare('SELECT path, written_by FROM files ORDER BY path').all();
    raw.close();

    expect(rows).toEqual([
      { path: 'src/lib.ts', written_by: CURRENT_SCHEMA_VERSION },
      { path: 'src/use.ts', written_by: CURRENT_SCHEMA_VERSION },
    ]);
  });

  it('makes an incremental run rewrite a row without it, though the file has not changed', async () => {
    rewriteAsAnOlderVersionWould({ dropsTheAlias: true });

    await indexIncremental(dir);

    await expectGraphEqualsFullIndex(dir);
  });

  it('makes an incremental run rewrite such a row when the file was edited and the row is as new as the file', async () => {
    // The spike's case: the older server refreshed the file after an edit, so
    // the row's mtime is the file's and only the manifest is behind.
    const absolute = join(dir, 'src/use.ts');
    const later = new Date(statSync(absolute).mtimeMs + 5_000);
    utimesSync(absolute, later, later);
    const raw = graphDb();
    raw.prepare("UPDATE files SET mtime = ? WHERE path = 'src/use.ts'").run(later.getTime() / 1_000);
    raw.close();
    rewriteAsAnOlderVersionWould({ dropsTheAlias: false });

    await indexIncremental(dir);

    await expectGraphEqualsFullIndex(dir);
  });

  it('is counted by the freshness measure as a changed file', async () => {
    rewriteAsAnOlderVersionWould({ dropsTheAlias: true });
    const db = openDatabase(configFor(dir).resolved_state_dir);

    const freshness = await measureFreshness(configFor(dir), db);

    await db.destroy();
    expect(freshness.paths.changed).toEqual(['src/use.ts']);
  });

  it('is not counted when every row has it', async () => {
    const db = openDatabase(configFor(dir).resolved_state_dir);

    const freshness = await measureFreshness(configFor(dir), db);

    await db.destroy();
    expect(freshness.total).toBe(0);
  });
});

describe('opening a database whose files table predates the mark', () => {
  it('adds the column and leaves the rows unmarked', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mast-file-mark-old-'));
    mkdirSync(stateDir, { recursive: true });
    const raw = new Sqlite(join(stateDir, 'graph.db'));
    raw.exec('CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, language TEXT NOT NULL, mtime REAL NOT NULL)');
    raw.exec("INSERT INTO files (path, language, mtime) VALUES ('a.ts', 'typescript', 1)");
    raw.close();

    const db = openDatabase(stateDir);
    void db.destroy();

    const after = new Sqlite(join(stateDir, 'graph.db'));
    const rows = after.prepare('SELECT path, written_by FROM files').all();
    after.close();
    rmSync(stateDir, { recursive: true, force: true });
    expect(rows).toEqual([{ path: 'a.ts', written_by: null }]);
  });
});
