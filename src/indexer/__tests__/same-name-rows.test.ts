import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../graph/db.js';
import { declarationsOf, queryBarrelExports, querySymbolByName, queryVerifiedCallers } from '../../graph/queries.js';
import { jitRefreshFile } from '../../mcp/tools/_helpers.js';
import { configFor, dumpGraph, editFile, expectEdgeRows, indexFull, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// Two declarations of one name in one file (D121).
//
// A static and an instance member, a getter and a setter, an interface merged
// with a class or with another interface, a type and a value. Each is a row of
// its own, and an edge is on the row its source line is in. Every expected
// edge here names its ends by line, because the name is the same.
// ---------------------------------------------------------------------------

const ALL = ['POTENTIAL_CALL', 'EXTENDS', 'IMPLEMENTS', 'PARENT_OF'] as const;

describe('two declarations of one name in a file', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('same-name');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a static and an instance method each hold their own calls and both belong to the class', async () => {
    writeFiles(dir, {
      'src/a.ts': `export function one(): void {}
export function two(): void {}
export class K {
  static make(): void { one(); }
  make(): void { two(); }
}
`,
    });

    await expectEdgeRows(dir, [
      'PARENT_OF src/a.ts:K@3 -> src/a.ts:K.make@4',
      'PARENT_OF src/a.ts:K@3 -> src/a.ts:K.make@5',
      'POTENTIAL_CALL src/a.ts:K.make@4 -> src/a.ts:one@1',
      'POTENTIAL_CALL src/a.ts:K.make@5 -> src/a.ts:two@2',
    ], ALL);
  });

  it('a getter and a setter each hold their own calls and both belong to the class', async () => {
    writeFiles(dir, {
      'src/a.ts': `export function one(): number { return 1; }
export function two(): void {}
export class K {
  get value(): number { return one(); }
  set value(v: number) { void v; two(); }
}
`,
    });

    await expectEdgeRows(dir, [
      'PARENT_OF src/a.ts:K@3 -> src/a.ts:K.value@4',
      'PARENT_OF src/a.ts:K@3 -> src/a.ts:K.value@5',
      'POTENTIAL_CALL src/a.ts:K.value@4 -> src/a.ts:one@1',
      'POTENTIAL_CALL src/a.ts:K.value@5 -> src/a.ts:two@2',
    ], ALL);
  });

  it('an interface merged with a class keeps its own `extends`, and the class its members', async () => {
    writeFiles(dir, {
      'src/a.ts': `export interface Events { on(name: string): void }
export class Base {}
export interface Emitter extends Events {}
export class Emitter extends Base {
  constructor(readonly n: number) { super(); }
  emit(): void {}
}
`,
      'src/z.ts': `import { Emitter } from './a.js';
export function build(): Emitter { return new Emitter(1); }
export function fire(e: Emitter): void { e.emit(); }
export class Loud extends Emitter {}
`,
    });

    await expectEdgeRows(dir, [
      'EXTENDS src/a.ts:Emitter@3 -> src/a.ts:Events@1',
      'EXTENDS src/a.ts:Emitter@4 -> src/a.ts:Base@2',
      'EXTENDS src/z.ts:Loud@4 -> src/a.ts:Emitter@4',
      'PARENT_OF src/a.ts:Emitter@4 -> src/a.ts:Emitter.constructor@5',
      'PARENT_OF src/a.ts:Emitter@4 -> src/a.ts:Emitter.emit@6',
      'POTENTIAL_CALL src/z.ts:build@2 -> src/a.ts:Emitter.constructor@5',
      'POTENTIAL_CALL src/z.ts:fire@3 -> src/a.ts:Emitter.emit@6',
    ], ALL);
  });

  it('an interface declared after the class it merges with takes none of the class\'s edges', async () => {
    writeFiles(dir, {
      'src/a.ts': `export interface Events { on(name: string): void }
export class Base {}
export class Emitter extends Base {
  emit(): void {}
}
export interface Emitter extends Events {}
export function build(): Emitter { return new Emitter(); }
`,
    });

    await expectEdgeRows(dir, [
      'EXTENDS src/a.ts:Emitter@3 -> src/a.ts:Base@2',
      'EXTENDS src/a.ts:Emitter@6 -> src/a.ts:Events@1',
      'PARENT_OF src/a.ts:Emitter@3 -> src/a.ts:Emitter.emit@4',
      'POTENTIAL_CALL src/a.ts:build@7 -> src/a.ts:Emitter@3',
    ], ALL);
  });

  it('two declarations of one interface each keep their own `extends`', async () => {
    writeFiles(dir, {
      'src/a.ts': `export interface A { a(): void }
export interface B { b(): void }
export interface Row extends A {}
export interface Row extends B {}
`,
    });

    await expectEdgeRows(dir, [
      'EXTENDS src/a.ts:Row@3 -> src/a.ts:A@1',
      'EXTENDS src/a.ts:Row@4 -> src/a.ts:B@2',
    ], ALL);
  });

  it.each([
    ['imported from the file', {}, './a.js'],
    ['through a named re-export', { 'src/m.ts': `export { Handler } from './a.js';\n` }, './m.js'],
    ['through `export *`', { 'src/m.ts': `export * from './a.js';\n` }, './m.js'],
  ])('a call of a name that is a type and a function reaches the function, %s', async (_name, between, entry) => {
    writeFiles(dir, {
      'src/a.ts': `export function leaf(): void {}
export type Handler = (x: number) => void;
export const Handler = (x: number): void => { void x; leaf(); };
export function here(): void { Handler(1); }
`,
      ...between,
      'src/z.ts': `import { Handler } from '${entry}';\nexport function top(): void { Handler(1); }\n`,
    });

    await expectEdgeRows(dir, [
      'POTENTIAL_CALL src/a.ts:Handler@3 -> src/a.ts:leaf@1',
      'POTENTIAL_CALL src/a.ts:here@4 -> src/a.ts:Handler@3',
      'POTENTIAL_CALL src/z.ts:top@2 -> src/a.ts:Handler@3',
    ], ALL);
  });

  // The marker of `export { fn } from` and a private `fn` are two rows of one
  // name, and the re-export is the marker's.
  it.each([
    ['before', `function fn(): number { return 2; }\nvoid fn;\nexport { fn } from './a.js';\n`],
    ['after', `export { fn } from './a.js';\nfunction fn(): number { return 2; }\nvoid fn;\n`],
  ])('a name re-exported from another file is that file\'s, with a private declaration of it %s the re-export', async (_where, barrel) => {
    writeFiles(dir, {
      'src/a.ts': `export function fn(): number { return 1; }\n`,
      'src/x.ts': barrel,
      'src/z.ts': `import { fn } from './x.js';\nexport function use(): number { return fn(); }\n`,
    });

    await expectEdgeRows(dir, ['POTENTIAL_CALL src/z.ts:use@2 -> src/a.ts:fn@1'], ['POTENTIAL_CALL']);
  });

  it('a class that implements a name that is an interface and a function reaches the interface', async () => {
    writeFiles(dir, {
      'src/a.ts': `export const Shape = (): number => 1;
export interface Shape { area(): number }
`,
      'src/z.ts': `import { Shape } from './a.js';
export class Square implements Shape { area(): number { return 1; } }
class Local {}
interface Local { more(): void }
export class Sub extends Local {}
`,
    });

    await expectEdgeRows(dir, [
      'IMPLEMENTS src/z.ts:Square@2 -> src/a.ts:Shape@2',
      'EXTENDS src/z.ts:Sub@5 -> src/z.ts:Local@3',
    ], ['EXTENDS', 'IMPLEMENTS']);
  });
});

// A tool is asked about a name, and the name is every row of it in the file.
describe('the callers of a name declared twice in a file', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('same-name-callers');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** As `mast_callers` picks its rows (`src/mcp/tools/callers.ts`). */
  async function callersOf(name: string): Promise<readonly string[]> {
    await indexFull(dir);
    const db = openDatabase(configFor(dir).resolved_state_dir);
    try {
      const rows = declarationsOf(await querySymbolByName(db, name));
      return (await queryVerifiedCallers(db, rows.map((r) => r.id), false)).map((r) => r.caller_symbol).sort();
    } finally {
      await db.destroy();
    }
  }

  it('are the constructor\'s, for a class declared after the interface it merges with', async () => {
    writeFiles(dir, {
      'src/a.ts': `export interface Emitter { on(): void }
export class Emitter { constructor(readonly n: number) {} }
`,
      'src/z.ts': `import { Emitter } from './a.js';\nexport function build(): Emitter { return new Emitter(1); }\n`,
    });

    expect(await callersOf('Emitter')).toEqual(['build']);
  });

  it('are those of the static and of the instance method', async () => {
    writeFiles(dir, {
      'src/a.ts': `export class K {
  make(): void {}
  static make(): K { return new K(); }
}
export function onClass(): void { K.make(); }
export function onValue(k: K): void { k.make(); }
`,
    });

    expect(await callersOf('K.make')).toEqual(['onClass', 'onValue']);
  });

  // `mast_rename_impact` lists the files that re-export the name, by the edge
  // of each marker, which is on the value's row.
  it('come with the re-exports of the name, whichever row is first', async () => {
    writeFiles(dir, {
      'src/a.ts': `export interface Codec { decode(): number }\nexport const Codec = (x: number): number => x;\n`,
      'src/m.ts': `export { Codec } from './a.js';\n`,
    });
    await indexFull(dir);
    const db = openDatabase(configFor(dir).resolved_state_dir);
    try {
      const rows = declarationsOf(await querySymbolByName(db, 'Codec'));
      const barrels = await queryBarrelExports(db, rows.map((r) => r.id), 'Codec', rows[0]?.file_id ?? -1);

      expect(barrels.map((b) => `${b.file_path} ${b.via}`)).toEqual(['src/m.ts named']);
    } finally {
      await db.destroy();
    }
  });

  it('are not those of a declaration of the name in another file', async () => {
    writeFiles(dir, {
      'src/a.ts': `export function run(): void {}\nexport function a(): void { run(); }\n`,
      'src/b.ts': `export function run(): void {}\nexport function b(): void { run(); }\n`,
    });

    expect(await callersOf('run')).toEqual(['a']);
  });
});

// A file resolved again without being written is parsed as it is on disk, and
// its rows are as they were when it was last written. The line tells two rows
// of a name apart; it is not what makes a record's row its row.
describe('a record whose line no row of its name is on', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('same-name-shifted');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function edgesAfterRefreshOfLeaf(caller: string, shifted: string): Promise<readonly string[]> {
    writeFiles(dir, {
      'src/a.ts': `export function leaf(): number { return 1; }\n`,
      'src/o.ts': `export function other(): void {}\n`,
      'src/z.ts': caller,
    });
    await indexFull(dir);
    editFile(dir, 'src/z.ts', shifted);
    editFile(dir, 'src/a.ts', `export function leaf(): number { return 2; }\n`);
    const db = openDatabase(configFor(dir).resolved_state_dir);
    try {
      await jitRefreshFile(db, configFor(dir), 'src/a.ts');
    } finally {
      await db.destroy();
    }
    return (await dumpGraph(configFor(dir), { withResolution: false, edgeTypes: ['POTENTIAL_CALL', 'PARENT_OF'] })).edges;
  }

  const IMPORTS = `import { leaf } from './a.js';\nimport { other } from './o.js';\n`;

  it('is on the one row of the name', async () => {
    const caller = `${IMPORTS}export function use(): number { other(); return leaf(); }\n`;

    expect(await edgesAfterRefreshOfLeaf(caller, `// a comment\n${caller}`)).toEqual([
      'POTENTIAL_CALL src/z.ts:use -> src/a.ts:leaf',
      'POTENTIAL_CALL src/z.ts:use -> src/o.ts:other',
    ]);
  });

  it('is on no row when the name has two', async () => {
    const caller = `${IMPORTS}export class K {\n  static make(): number { other(); return leaf(); }\n  make(): void {}\n}\n`;

    // Five lines down: one would put the static method on the line the instance one had.
    expect(await edgesAfterRefreshOfLeaf(caller, `${'// a comment\n'.repeat(5)}${caller}`)).toEqual([]);
  });
});
