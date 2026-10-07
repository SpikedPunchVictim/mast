import { rmSync } from 'node:fs';
import { join } from 'node:path';
import Sqlite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../graph/db.js';
import { countPendingEdgeRepairs, listPendingEdgeRepairs } from '../../graph/importer-repair.js';
import { populateFile } from '../../graph/populate.js';
import {
  configFor,
  editFile,
  expectGraphEqualsFullIndex,
  indexFull,
  indexIncremental,
  makeProject,
  writeFiles,
} from '../../indexer/__tests__/graph-fixture.js';
import { checkAndRefreshIfStale, type StalenessCheckResult } from '../staleness.js';

// ---------------------------------------------------------------------------
// The query-time refresh when another writer holds the database between the
// file's own write and the edges being put back (D080).
//
// The file's write deletes every edge other files hold into it. If the repair
// that follows cannot write, those edges are missing, and the only thing that
// can bring them back is a record of which files are waiting. So that record
// has to commit with the file's write, not after it. And the wait has to be
// short: SQLite's busy wait blocks the whole server process.
// ---------------------------------------------------------------------------

describe('a query-time refresh whose edge repair meets a busy database', () => {
  let dir: string;
  let db: Db;
  let release: (() => void) | undefined;
  let result: StalenessCheckResult;
  let elapsedMs: number;

  /** The real write, after which a second connection takes the write lock and keeps it. */
  const writeThenHoldTheDatabase: typeof populateFile = async (...args) => {
    const written = await populateFile(...args);
    const raw = new Sqlite(join(configFor(dir).resolved_state_dir, 'graph.db'));
    raw.exec('begin immediate');
    release = () => {
      raw.exec('rollback');
      raw.close();
    };
    return written;
  };

  beforeEach(async () => {
    dir = makeProject('query-time-contended');
    writeFiles(dir, {
      'src/x.ts': `export function fn(): number { return 1; }\n`,
      'src/zc.ts': `import { fn } from './x.js';\nexport function use(): void { fn(); }\n`,
    });
    await indexFull(dir);
    editFile(dir, 'src/x.ts', `export function fn(): number { return 2; }\n`);
    const config = configFor(dir);
    db = openDatabase(config.resolved_state_dir);
    const stored = await db.selectFrom('files').select('mtime').where('path', '=', 'src/x.ts').executeTakeFirstOrThrow();

    const startedAt = Date.now();
    result = await checkAndRefreshIfStale(db, config, 'src/x.ts', stored.mtime, writeThenHoldTheDatabase);
    elapsedMs = Date.now() - startedAt;
    release?.();
  });
  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the file refreshed, since its own rows were written', () => {
    expect(result).toEqual({ refreshed: true, busy: false });
  });

  it('gives up well inside the 5 s the connection would otherwise wait', () => {
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('leaves the file and the file that calls into it recorded as waiting', async () => {
    expect(await listPendingEdgeRepairs(db)).toEqual(['src/x.ts', 'src/zc.ts']);
  });

  it('is put right by the next incremental run, which leaves nothing waiting', async () => {
    await indexIncremental(dir);

    await expectGraphEqualsFullIndex(dir);
    expect(await countPendingEdgeRepairs(db)).toBe(0);
  });
});
