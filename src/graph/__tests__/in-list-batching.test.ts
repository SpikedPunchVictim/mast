// Every caller-sized `IN` list must stay under SQLite's bound-parameter ceiling.
//
// An `IN (?, ?, …)` binds one parameter per value. Past `SQLITE_MAX_VARIABLES`
// (32,766 on the installed better-sqlite3 12.x / SQLite 3.53.2) the statement
// throws `too many SQL variables` — and inside a transaction it takes back
// everything that transaction had already written. D001, this package's
// founding S0, is that ceiling breached from the INSERT side: a whale file blew
// it, rolled back its own transaction, vanished from the index, and the run
// exited 0.
//
// The three sites here are the ones whose list length is set by the caller or
// the corpus rather than by construction. The other six `IN` uses in `src` are
// bounded and are recorded in the sweep below so this file states which
// question it answers.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { SQLITE_MAX_VARIABLES, chunkRowsForSqlite } from '../sqliteBatch.js';
import { removeDeletedFiles } from '../populate.js';
import { loadFileMetaByPath } from '../checker-resolver.js';
import { searchFts } from '../../search/fts.js';

/** Comfortably past the ceiling, and not a multiple of it — an off-by-one in
 *  the batch arithmetic leaves a remainder batch that must still be issued. */
const OVER_CEILING = SQLITE_MAX_VARIABLES + 1_234;

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mast-in-batching-'));
  db = openDatabase(dir);
});
afterEach(async () => {
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

const pathAt = (i: number): string => `src/generated/f${String(i).padStart(6, '0')}.ts`;

/** Insert `count` `files` rows directly — no parsing, so this stays fast. */
async function seedFiles(count: number, language = 'typescript'): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, i) => ({
    path: pathAt(i), language, mtime: 1_700_000_000,
  }));
  for (const batch of chunkRowsForSqlite(rows)) {
    await db.insertInto('files').values([...batch]).execute();
  }
  return rows.map((r) => r.path);
}

describe('removeDeletedFiles', () => {
  it(`deletes ${String(OVER_CEILING)} paths without blowing the parameter ceiling`, async () => {
    const paths = await seedFiles(OVER_CEILING);

    await expect(removeDeletedFiles(db, paths)).resolves.toBeTypeOf('number');

    const left = await db.selectFrom('files').select('path').execute();
    expect(left).toHaveLength(0);
  });

  it('leaves rows outside the deleted set alone', async () => {
    const paths = await seedFiles(OVER_CEILING);
    const keep = paths.slice(0, 5);

    await removeDeletedFiles(db, paths.slice(5));

    const left = (await db.selectFrom('files').select('path').execute()).map((r) => r.path).sort();
    expect(left).toEqual([...keep].sort());
  });
});

describe('loadFileMetaByPath', () => {
  it(`resolves ${String(OVER_CEILING)} paths, and reports every one of them`, async () => {
    const paths = await seedFiles(OVER_CEILING);

    const meta = await loadFileMetaByPath(db, paths);

    // Not just "did not throw": a batching bug that dropped the remainder
    // batch would still resolve, and would silently under-report.
    expect(meta.size).toBe(OVER_CEILING);
    expect(meta.get(pathAt(0))?.mtime).toBe(1_700_000_000);
    expect(meta.get(pathAt(OVER_CEILING - 1))?.mtime).toBe(1_700_000_000);
  });

  it('omits paths with no row rather than inventing them', async () => {
    await seedFiles(3);
    const meta = await loadFileMetaByPath(db, [pathAt(0), 'src/absent.ts']);
    expect([...meta.keys()]).toEqual([pathAt(0)]);
  });
});

describe('searchFts with a scope covering every indexed file', () => {
  it(`survives a language filter matching ${String(OVER_CEILING)} files`, async () => {
    await seedFiles(OVER_CEILING);
    // One matching chunk is enough — the ceiling is blown by the scope's IN
    // list, which is built from `files` and is independent of chunk count.
    await db.insertInto('chunk_fts').values({
      content: 'export function needleFunction(): void {}',
      symbol_name: 'needleFunction',
      chunk_id: 'c1',
      file_path: pathAt(7),
    }).execute();

    const rows = await searchFts(db, 'needleFunction', { limit: 10, language: 'typescript' });

    expect(rows.map((r) => r.chunk_id)).toEqual(['c1']);
  });

  it('still excludes files outside the scope when the list is batched', async () => {
    await seedFiles(OVER_CEILING, 'typescript');
    await db.insertInto('files')
      .values({ path: 'src/other.js', language: 'javascript', mtime: 1_700_000_000 })
      .execute();
    for (const [id, filePath] of [['c1', pathAt(7)], ['c2', 'src/other.js']] as const) {
      await db.insertInto('chunk_fts').values({
        content: 'export function needleFunction(): void {}',
        symbol_name: 'needleFunction', chunk_id: id, file_path: filePath,
      }).execute();
    }

    const ts = await searchFts(db, 'needleFunction', { limit: 10, language: 'typescript' });
    const js = await searchFts(db, 'needleFunction', { limit: 10, language: 'javascript' });

    expect(ts.map((r) => r.chunk_id)).toEqual(['c1']);
    expect(js.map((r) => r.chunk_id)).toEqual(['c2']);
  });
});
