import { cpSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../graph/db.js';
import { queryImplementors, querySymbolByName, queryVerifiedCallers } from '../../graph/queries.js';
import {
  configFor,
  editFile,
  expectGraphEqualsFullIndex,
  expectStoredEdges,
  indexFull,
  indexIncremental,
  makeProject,
} from './graph-fixture.js';

// ---------------------------------------------------------------------------
// T17 — a small monorepo whose every edge is written out by hand
// (adr/proposals/incremental-graph-correctness).
//
// The single-shape tests beside this one each isolate one cause. This one
// puts the causes together the way a real repository does — callers walked
// before barrels, a named re-export behind a star, the same name in two
// packages — and checks the whole graph, so a combination no single-shape
// test thought of still has somewhere to fail. See the fixture's README.md
// for what each file is there for.
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'edge-monorepo');
const ALL_EDGE_TYPES = ['POTENTIAL_CALL', 'EXTENDS', 'IMPLEMENTS', 'PARENT_OF', 'RE_EXPORTS'];

function readExpectedEdges(): string[] {
  return readFileSync(join(FIXTURE_DIR, 'expected-edges.txt'), 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe('fixture monorepo, full index', () => {
  let dir: string;
  let db: Db;

  beforeAll(async () => {
    dir = makeProject('edge-monorepo');
    cpSync(FIXTURE_DIR, dir, { recursive: true });
    await indexFull(dir);
    db = openDatabase(configFor(dir).resolved_state_dir);
  });
  afterAll(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('has exactly the edges written in expected-edges.txt', async () => {
    await expectStoredEdges(dir, readExpectedEdges(), ALL_EDGE_TYPES);
  });

  it('lists every implementor of Store, each with its own methods', async () => {
    const implementors = await queryImplementors(db, 'Store');

    expect(
      implementors.map((i) => `${i.file_path}:${i.class_name} {${[...i.methods].sort().join(', ')}}`).sort(),
    ).toEqual([
      'packages/app/src/stores.ts:CacheStore {CacheStore.get}',
      'packages/app/src/stores.ts:FileStore {FileStore.get}',
      'packages/core/src/memory-store.ts:MemoryStore {MemoryStore.get}',
    ]);
  });

  it('lists the implementor of the app Handler interface, which shares its name with a core type', async () => {
    const implementors = await queryImplementors(db, 'Handler');

    expect(implementors.map((i) => `${i.file_path}:${i.class_name}`)).toEqual([
      'packages/app/src/main.ts:Main',
    ]);
  });

  it('finds the caller of a function imported through the package entry point', async () => {
    const [target] = await querySymbolByName(db, 'createLogger', 'packages/core/src/logger.ts');
    expect(target).toBeDefined();

    const callers = await queryVerifiedCallers(db, target!.id, false);

    expect(callers.map((c) => `${c.file_path}:${c.caller_symbol}`)).toEqual([
      'packages/app/src/main.ts:Main.run',
    ]);
  });
});

describe('fixture monorepo, after an incremental run over body edits', () => {
  let dir: string;

  // Two files that other files reach only through the package entry point:
  // one holds the interface with three implementors, the other the function
  // called from the other package. Neither edit changes a declared name.
  beforeAll(async () => {
    dir = makeProject('edge-monorepo-incremental');
    cpSync(FIXTURE_DIR, dir, { recursive: true });
    await indexFull(dir);
    const read = (relativePath: string): string => readFileSync(join(dir, relativePath), 'utf-8');
    editFile(dir, 'packages/core/src/ports.ts', read('packages/core/src/ports.ts').replace('string | undefined', 'undefined | string'));
    editFile(dir, 'packages/core/src/logger.ts', read('packages/core/src/logger.ts').replace("'ready'", "'started'"));
    await indexIncremental(dir);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('still has exactly the edges written in expected-edges.txt', async () => {
    await expectStoredEdges(dir, readExpectedEdges(), ALL_EDGE_TYPES);
  });

  it('equals a full index of the edited tree', async () => {
    await expectGraphEqualsFullIndex(dir);
  });
});
