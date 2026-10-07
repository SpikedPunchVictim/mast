import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  editFile,
  expectGraphEqualsFullIndex,
  indexFull,
  indexIncremental,
  makeProject,
  writeFiles,
} from './graph-fixture.js';

// ---------------------------------------------------------------------------
// T2 — after an incremental run the graph equals a full index of the same
// tree (D081, D084; adr/proposals/incremental-graph-correctness).
//
// One row per scenario: a project, then one or more rounds of edits, each
// followed by an incremental run and the comparison. The first rows are the
// reproductions in spikes/s0-reproductions. A later defect in this family adds
// a row here.
//
// Callers are named to sort after what they import, so no row depends on walk
// order; that is walk-order.test.ts.
// ---------------------------------------------------------------------------

/** A path to its new content, or to `null` to delete the file. */
type Round = Readonly<Record<string, string | null>>;

interface Scenario {
  readonly name: string;
  /**
   * Set while the row is known to fail for an open defect. The row then runs
   * under `it.fails`, which turns red the moment the defect is fixed, so the
   * marker cannot outlive its reason.
   */
  readonly openDefect?: 'D084';
  readonly files: Readonly<Record<string, string>>;
  readonly rounds: readonly Round[];
}

const CALLER = `import { fn } from './x.js';\nexport function use(): void { fn(); }\n`;

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'the body of a called function is edited',
    files: {
      'src/x.ts': `export function fn(): number { return 1; }\n`,
      'src/zc.ts': CALLER,
    },
    rounds: [{ 'src/x.ts': `export function fn(): number { return 2; }\n` }],
  },
  {
    name: 'a file gains a name another file already imports and calls',
    openDefect: 'D084',
    files: {
      'src/x.ts': `export function other(): void {}\n`,
      'src/zc.ts': CALLER,
    },
    rounds: [{ 'src/x.ts': `export function other(): void {}\nexport function fn(): void {}\n` }],
  },
  {
    name: 'a file is created after the file that imports from it',
    openDefect: 'D084',
    files: { 'src/zc.ts': CALLER },
    rounds: [{ 'src/x.ts': `export function fn(): void {}\n` }],
  },
  {
    name: 'a called function is renamed and its caller is not updated',
    files: {
      'src/x.ts': `export function fn(): void {}\n`,
      'src/zc.ts': CALLER,
    },
    rounds: [{ 'src/x.ts': `export function renamed(): void {}\n` }],
  },
  {
    name: 'a star barrel is re-pointed at another file',
    openDefect: 'D084',
    files: {
      'src/a.ts': `export function fn(): number { return 1; }\n`,
      'src/b.ts': `export function fn(): number { return 2; }\n`,
      'src/barrel.ts': `export * from './a.js';\n`,
      'src/zc.ts': `import { fn } from './barrel.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/barrel.ts': `export * from './b.js';\n` }],
  },
  {
    name: 'a named re-export is replaced by a declaration',
    openDefect: 'D084',
    files: {
      'src/impl.ts': `export function fn(): number { return 1; }\n`,
      'src/x.ts': `export { fn } from './impl.js';\n`,
      'src/zc.ts': CALLER,
    },
    rounds: [{ 'src/x.ts': `export function fn(): number { return 2; }\n` }],
  },
  {
    name: 'a type alias becomes an interface that a class implements',
    files: {
      'src/x.ts': `export type Opts = { a: number };\n`,
      'src/zc.ts': `import type { Opts } from './x.js';\nexport class Impl implements Opts { a = 1; }\n`,
    },
    rounds: [{ 'src/x.ts': `export interface Opts { a: number }\n` }],
  },
  {
    name: 'the body of a function behind a star barrel is edited',
    files: {
      'src/x.ts': `export function fn(): number { return 1; }\n`,
      'src/barrel.ts': `export * from './x.js';\n`,
      'src/zc.ts': `import { fn } from './barrel.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/x.ts': `export function fn(): number { return 2; }\n` }],
  },
  {
    name: 'a called file is deleted, indexed, and recreated',
    openDefect: 'D084',
    files: {
      'src/x.ts': `export function fn(): void {}\n`,
      'src/zc.ts': CALLER,
    },
    rounds: [{ 'src/x.ts': null }, { 'src/x.ts': `export function fn(): void {}\n` }],
  },
  {
    name: 'a function moves to another file and its barrel is re-pointed',
    files: {
      'src/a.ts': `export function fn(): void {}\n`,
      'src/barrel.ts': `export { fn } from './a.js';\n`,
      'src/zc.ts': `import { fn } from './barrel.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [
      {
        'src/a.ts': `export function left(): void {}\n`,
        'src/b.ts': `export function fn(): void {}\n`,
        'src/barrel.ts': `export { fn } from './b.js';\n`,
      },
    ],
  },
  {
    name: 'a base class with a subclass and an implementor elsewhere is edited',
    files: {
      'src/x.ts': `export class Base { run(): void {} }\nexport interface Port { open(): void }\n`,
      'src/zc.ts': `import { Base, type Port } from './x.js';\nexport class Child extends Base implements Port {\n  open(): void { super.run(); }\n}\n`,
    },
    rounds: [{ 'src/x.ts': `export class Base { run(): void { return; } }\nexport interface Port { open(): void }\n` }],
  },
];

describe('the graph after an incremental run equals a full index', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('incremental-equivalence');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(scenario: Scenario): Promise<void> {
    writeFiles(dir, scenario.files);
    await indexFull(dir);

    for (const round of scenario.rounds) {
      for (const [relativePath, content] of Object.entries(round)) {
        if (content === null) rmSync(join(dir, relativePath));
        else editFile(dir, relativePath, content);
      }
      await indexIncremental(dir);

      await expectGraphEqualsFullIndex(dir);
    }
  }

  it.each(SCENARIOS.filter((s) => s.openDefect === undefined))('when $name', run);

  // D084: a change to what a file declares or re-exports is not yet followed
  // into the files that import those names. These rows are the reproductions.
  it.fails.each(SCENARIOS.filter((s) => s.openDefect !== undefined))('when $name ($openDefect, open)', run);
});
