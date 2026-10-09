import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../graph/db.js';
import { configFor, editFile, indexFull, indexIncremental, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// T6 — what an incremental run does to rows the checker pass wrote
// (adr/proposals/incremental-graph-correctness, prior decision 3).
//
// A verdict or checker edge about a re-written file's symbols was computed
// against the old content and must go. Since D150 every other checker row goes
// with it: what `kept.go()` resolves to was decided by the compiler against the
// whole program, and a write of any file can change it. This file first pinned
// the opposite for the caller's other rows ("they are about files that did not
// change"), which is the reasoning D150 is the counter-example to. Restoring a
// caller's edges after the cascade (D081) must still not bring any of them back.
//
// Rows are planted directly. Running the compiler here would test the checker,
// which has its own suite.
// ---------------------------------------------------------------------------

describe('checker rows across an incremental run', () => {
  let dir: string;
  let db: Db;

  async function symbolId(name: string, path: string): Promise<number> {
    const row = await db
      .selectFrom('symbols as s')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select('s.id')
      .where('s.name', '=', name)
      .where('f.path', '=', path)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function fileId(path: string): Promise<number> {
    return (await db.selectFrom('files').select('id').where('path', '=', path).executeTakeFirstOrThrow()).id;
  }

  /** `caller -> target` for every checker edge, and `target @ call-site file` for every verdict. */
  async function checkerRows(): Promise<{ edges: string[]; verdicts: string[] }> {
    const edges = await db
      .selectFrom('edges as e')
      .innerJoin('symbols as from_s', 'from_s.id', 'e.from_id')
      .innerJoin('symbols as to_s', 'to_s.id', 'e.to_id')
      .select(['from_s.name as caller', 'to_s.name as target'])
      .where('e.resolution', '=', 'checker')
      .execute();
    const verdicts = await db
      .selectFrom('checker_verdicts as v')
      .innerJoin('symbols as s', 's.id', 'v.queried_symbol_id')
      .innerJoin('files as f', 'f.id', 'v.call_site_file_id')
      .select(['s.name as target', 'f.path as site'])
      .execute();
    return {
      edges: edges.map((e) => `${e.caller} -> ${e.target}`).sort(),
      verdicts: verdicts.map((v) => `${v.target} @ ${v.site}`).sort(),
    };
  }

  beforeEach(async () => {
    dir = makeProject('checker-rows');
    writeFiles(dir, {
      'src/edited.ts': `export function fn(): number { return 1; }\nexport function run(): void {}\n`,
      'src/kept.ts': `export function go(): void {}\n`,
      // `run` and `go` are reached through an object, which the heuristic
      // resolver does not follow: these are the calls a checker pass adds.
      'src/zz-caller.ts': `import * as edited from './edited.js';\nimport * as kept from './kept.js';\nimport { fn } from './edited.js';\nexport function use(): number { edited.run(); kept.go(); return fn(); }\n`,
    });
    await indexFull(dir);
    db = openDatabase(configFor(dir).resolved_state_dir);

    const use = await symbolId('use', 'src/zz-caller.ts');
    const callerFile = await fileId('src/zz-caller.ts');
    const inEdited = await symbolId('run', 'src/edited.ts');
    const inKept = await symbolId('go', 'src/kept.ts');
    await db
      .insertInto('edges')
      .values([
        { from_id: use, to_id: inEdited, edge_type: 'POTENTIAL_CALL', resolution: 'checker', call_line: 4, context: 'edited.run()' },
        { from_id: use, to_id: inKept, edge_type: 'POTENTIAL_CALL', resolution: 'checker', call_line: 4, context: 'kept.go()' },
      ])
      .execute();
    await db
      .insertInto('checker_verdicts')
      .values([
        { queried_symbol_id: inEdited, call_site_file_id: callerFile, call_site_line: 4, verdict: 'resolves_to_queried', call_site_mtime: 0 },
        { queried_symbol_id: inKept, call_site_file_id: callerFile, call_site_line: 4, verdict: 'resolves_to_queried', call_site_mtime: 0 },
      ])
      .execute();
  });
  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts with both planted edges and both verdicts', async () => {
    expect(await checkerRows()).toEqual({
      edges: ['use -> go', 'use -> run'],
      verdicts: ['go @ src/zz-caller.ts', 'run @ src/zz-caller.ts'],
    });
  });

  it('drops every checker row when a file is re-written, the ones about other files included', async () => {
    editFile(dir, 'src/edited.ts', `export function fn(): number { return 2; }\nexport function run(): void {}\n`);

    await indexIncremental(dir);

    expect(await checkerRows()).toEqual({ edges: [], verdicts: [] });
  });

  it('still restores the caller\'s own edge into the re-written file', async () => {
    editFile(dir, 'src/edited.ts', `export function fn(): number { return 2; }\nexport function run(): void {}\n`);

    await indexIncremental(dir);

    const restored = await db
      .selectFrom('edges as e')
      .innerJoin('symbols as to_s', 'to_s.id', 'e.to_id')
      .select(['to_s.name', 'e.resolution'])
      .where('e.from_id', '=', await symbolId('use', 'src/zz-caller.ts'))
      .where('to_s.name', '=', 'fn')
      .execute();
    expect(restored).toEqual([{ name: 'fn', resolution: 'import' }]);
  });
});
