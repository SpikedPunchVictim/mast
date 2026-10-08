import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../graph/db.js';
import { countPendingEdgeRepairs } from '../../graph/importer-repair.js';
import { measureFreshness } from '../freshness.js';
import { freshnessCause, runIndex } from '../index.js';
import {
  configFor,
  dumpGraph,
  editFile,
  expectGraphEqualsFullIndex,
  indexFull,
  makeProject,
  writeFiles,
} from './graph-fixture.js';

// ---------------------------------------------------------------------------
// T13 — a run that stops resolving files again at its time budget records the
// ones it left, and the next run finishes them
// (adr/proposals/incremental-graph-correctness, decision 2).
//
// The budget is in elapsed time, which a test cannot hold still, so the two
// ends are used: 0 leaves every such file, no budget leaves none.
// ---------------------------------------------------------------------------

const CALLER = (name: string): string =>
  `import { fn } from './barrel.js';\nexport function ${name}(): void { fn(); }\n`;
const filesWith = (barrel: string): Record<string, string> => ({
  'src/x.ts': `export function fn(): number { return 1; }\n`,
  'src/barrel.ts': barrel,
  'src/za.ts': CALLER('a'),
  'src/zb.ts': CALLER('b'),
  'src/zc.ts': CALLER('c'),
});
const X_EDITED = `export function fn(): number { return 2; }\n`;

// Both kinds of barrel: a star barrel loses its only row when the file behind
// it is re-written, so it has to be recognised as a barrel before that.
describe.each([
  { kind: 'named', barrel: `export { fn } from './x.js';\n`, restored: { edges: ['RE_EXPORTS src/barrel.ts:fn -> src/x.ts:fn'], stars: [] } },
  { kind: 'star', barrel: `export * from './x.js';\n`, restored: { edges: [], stars: ['src/barrel.ts => src/x.ts'] } },
])('files left to resolve again when the budget runs out, behind a $kind barrel', ({ barrel, restored }) => {
  let dir: string;

  async function pending(): Promise<number> {
    const db = openDatabase(configFor(dir).resolved_state_dir);
    try {
      return await countPendingEdgeRepairs(db);
    } finally {
      await db.destroy();
    }
  }

  beforeEach(async () => {
    dir = makeProject('edge-repair-pending');
    writeFiles(dir, filesWith(barrel));
    await indexFull(dir);
    editFile(dir, 'src/x.ts', X_EDITED);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('are counted on the result and stored with the index', async () => {
    const result = await runIndex(configFor(dir), { incremental: true, edgeRepairBudgetMs: 0 });

    // The barrel is resolved whatever the budget; the three callers wait.
    expect({ left: result.edgeRepairsPending, done: result.filesReResolved, stored: await pending() }).toEqual({
      left: 3,
      done: 1,
      stored: 3,
    });
  });

  it('do not include a file that re-exports, which is always resolved', async () => {
    await runIndex(configFor(dir), { incremental: true, edgeRepairBudgetMs: 0 });

    const graph = await dumpGraph(configFor(dir), { withResolution: false, edgeTypes: ['RE_EXPORTS', 'POTENTIAL_CALL'] });
    expect({ edges: graph.edges, stars: graph.stars }).toEqual(restored);
  });

  it('make the index report itself not fresh, with a cause that names them', async () => {
    await runIndex(configFor(dir), { incremental: true, edgeRepairBudgetMs: 0 });

    const config = configFor(dir);
    const db = openDatabase(config.resolved_state_dir);
    try {
      const freshness = await measureFreshness(config, db);
      expect({ total: freshness.total, pending: freshness.pendingEdgeRepairs, cause: freshnessCause(freshness) }).toEqual({
        total: 0,
        pending: 3,
        cause: 'edge_repair_pending',
      });
    } finally {
      await db.destroy();
    }
  });

  it('are finished by the next run, which leaves the graph equal to a full index', async () => {
    await runIndex(configFor(dir), { incremental: true, edgeRepairBudgetMs: 0 });

    const result = await runIndex(configFor(dir), { incremental: true });

    expect({ left: result.edgeRepairsPending, done: result.filesReResolved, stored: await pending() }).toEqual({
      left: 0,
      done: 3,
      stored: 0,
    });
    await expectGraphEqualsFullIndex(dir);
  });

  it('leave the list when they are re-written or deleted before that run', async () => {
    await runIndex(configFor(dir), { incremental: true, edgeRepairBudgetMs: 0 });
    editFile(dir, 'src/za.ts', CALLER('renamed'));
    rmSync(`${dir}/src/zb.ts`);

    const result = await runIndex(configFor(dir), { incremental: true, edgeRepairBudgetMs: 0 });

    expect(result.edgeRepairsPending).toBe(1);
  });

  it('are none when the run has no budget set', async () => {
    const result = await runIndex(configFor(dir), { incremental: true });

    expect(result.edgeRepairsPending).toBe(0);
    expect(await pending()).toBe(0);
  });

  it('are cleared by a full index', async () => {
    await runIndex(configFor(dir), { incremental: true, edgeRepairBudgetMs: 0 });

    const result = await runIndex(configFor(dir), { incremental: false });

    expect(result.edgeRepairsPending).toBe(0);
    expect(await pending()).toBe(0);
  });
});

// A call of an inherited member is put out of date by a class it neither
// imports nor holds an edge into. Under a budget the class between waits like
// any other file, so the caller's edge is right only once that class has been
// resolved and the caller after it.
describe('a class hierarchy left to resolve again when the budget runs out', () => {
  let dir: string;

  beforeEach(async () => {
    dir = makeProject('edge-repair-pending-hierarchy');
    writeFiles(dir, {
      'src/h-base.ts': `export class Base {\n  top(): void {}\n}\n`,
      'src/h-mid.ts': `import { Base } from './h-base.js';\nexport class Mid extends Base {}\n`,
      'src/h-leaf.ts': `import { Mid } from './h-mid.js';\nexport class Leaf extends Mid {}\n`,
      'src/a-use.ts': `import { Leaf } from './h-leaf.js';\nexport function use(leaf: Leaf): void { leaf.find(); }\n`,
    });
    await indexFull(dir);
    editFile(dir, 'src/h-base.ts', `export class Base {\n  top(): void {}\n  find(): void {}\n}\n`);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is finished by the next run, which leaves the graph equal to a full index', async () => {
    const first = await runIndex(configFor(dir), { incremental: true, edgeRepairBudgetMs: 0 });

    const second = await runIndex(configFor(dir), { incremental: true });

    expect({ leftByFirst: first.edgeRepairsPending > 0, leftBySecond: second.edgeRepairsPending }).toEqual({
      leftByFirst: true,
      leftBySecond: 0,
    });
    await expectGraphEqualsFullIndex(dir);
  });
});
