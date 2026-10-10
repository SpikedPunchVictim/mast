import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import {
  editFile,
  expectEdges,
  expectGraphEqualsFullIndex,
  expectStoredEdges,
  indexFull,
  indexIncremental,
  makeProject,
  writeFiles,
} from './graph-fixture.js';

// ---------------------------------------------------------------------------
// T15 — every re-export shape, on a full index, against edges written by hand
// (adr/proposals/incremental-graph-correctness).
//
// A consumer imports a class, an interface and a function through an entry
// file, then extends, implements and calls them, and calls a method of the
// class. The four edges must reach the declaring file whatever sits between. A comparison against a full index
// cannot check this: the full index is the thing under test.
//
// File names are chosen so every file sorts after the files it re-exports
// from. Walk order is T4's subject (D083); here the layout is the favourable
// one, so a red row is the resolver, not the order.
//
// Each shape also runs beside a decoy file that declares the same three names
// and is imported by nothing. Structural edges that resolve by bare name
// (D085) land on the decoy; with it present the row passes only when the edge
// followed the import.
// ---------------------------------------------------------------------------

const LEAF_SRC = `export class Base { hello(): void {} }
export interface Shape { area(): number }
export function make(): void {}
`;

const DECOY_SRC = `class Base { other(): void {} }
interface Shape { other(): number }
function make(): void {}
export const decoy = [Base, make] as const;
export type DecoyShape = Shape;
`;

function consumerSrc(entry: string): string {
  return `import { Base, Shape, make } from '${entry}';
export class Child extends Base implements Shape {
  area(): number { return 1; }
}
export function go(): void { make(); }
export function greet(b: Base): void { b.hello(); }
export function viaChild(c: Child): void { c.hello(); }
`;
}

const NAMED = (from: string): string => `export { Base, Shape, make } from '${from}';\n`;
const STAR = (from: string): string => `export * from '${from}';\n`;
const IMPORT_THEN_EXPORT = (from: string): string =>
  `import { Base, make } from '${from}';\nimport type { Shape } from '${from}';\nexport { Base, make };\nexport type { Shape };\n`;

interface Shape {
  readonly name: string;
  /** Path of the file that declares the three names. */
  readonly leaf: string;
  /** Specifier the consumer imports from, relative to `src/z-consumer.ts`. */
  readonly entry: string;
  /** Files between the leaf and the consumer. */
  readonly between: Readonly<Record<string, string>>;
}

const SHAPES: readonly Shape[] = [
  { name: 'a direct import', leaf: 'src/a-leaf.ts', entry: './a-leaf.js', between: {} },
  {
    name: 'a named re-export',
    leaf: 'src/a-leaf.ts',
    entry: './b1.js',
    between: { 'src/b1.ts': NAMED('./a-leaf.js') },
  },
  {
    name: 'export *',
    leaf: 'src/a-leaf.ts',
    entry: './b1.js',
    between: { 'src/b1.ts': STAR('./a-leaf.js') },
  },
  {
    name: 'a named re-export behind a star (D086)',
    leaf: 'src/a-leaf.ts',
    entry: './b2.js',
    between: { 'src/b1.ts': NAMED('./a-leaf.js'), 'src/b2.ts': STAR('./b1.js') },
  },
  {
    name: 'a star behind a named re-export',
    leaf: 'src/a-leaf.ts',
    entry: './b2.js',
    between: { 'src/b1.ts': STAR('./a-leaf.js'), 'src/b2.ts': NAMED('./b1.js') },
  },
  {
    name: 'three named re-exports deep',
    leaf: 'src/a-leaf.ts',
    entry: './b3.js',
    between: {
      'src/b1.ts': NAMED('./a-leaf.js'),
      'src/b2.ts': NAMED('./b1.js'),
      'src/b3.ts': NAMED('./b2.js'),
    },
  },
  {
    name: 'three stars deep',
    leaf: 'src/a-leaf.ts',
    entry: './b3.js',
    between: {
      'src/b1.ts': STAR('./a-leaf.js'),
      'src/b2.ts': STAR('./b1.js'),
      'src/b3.ts': STAR('./b2.js'),
    },
  },
  {
    name: 'star, named, star',
    leaf: 'src/a-leaf.ts',
    entry: './b3.js',
    between: {
      'src/b1.ts': STAR('./a-leaf.js'),
      'src/b2.ts': NAMED('./b1.js'),
      'src/b3.ts': STAR('./b2.js'),
    },
  },
  {
    name: 'named, star, named',
    leaf: 'src/a-leaf.ts',
    entry: './b3.js',
    between: {
      'src/b1.ts': NAMED('./a-leaf.js'),
      'src/b2.ts': STAR('./b1.js'),
      'src/b3.ts': NAMED('./b2.js'),
    },
  },
  {
    name: 'export type { X } from, beside a value re-export',
    leaf: 'src/a-leaf.ts',
    entry: './b1.js',
    between: {
      'src/b1.ts': `export type { Shape } from './a-leaf.js';\nexport { Base, make } from './a-leaf.js';\n`,
    },
  },
  {
    // n8n's `packages/workflow/src`: `index.ts` stars `errors/index.ts`, which
    // re-exports each error class by name from its own file.
    name: 'a package entry point that stars a directory index of named re-exports',
    leaf: 'src/pkg/errors/base/user.error.ts',
    entry: './pkg/index.js',
    between: {
      'src/pkg/errors/index.ts': NAMED('./base/user.error.js'),
      'src/pkg/index.ts': STAR('./errors/index.js'),
    },
  },
  // D108: the file between imports the names and exports them in a clause of
  // its own, with no `from`. n8n's `@n8n/agents` passes types through so.
  {
    name: 'an import, then an export clause with no from',
    leaf: 'src/a-leaf.ts',
    entry: './b1.js',
    between: { 'src/b1.ts': IMPORT_THEN_EXPORT('./a-leaf.js') },
  },
  {
    name: 'an import, then an export clause, behind a named re-export',
    leaf: 'src/a-leaf.ts',
    entry: './b2.js',
    between: { 'src/b1.ts': IMPORT_THEN_EXPORT('./a-leaf.js'), 'src/b2.ts': NAMED('./b1.js') },
  },
  {
    name: 'an import, then an export clause, behind a star',
    leaf: 'src/a-leaf.ts',
    entry: './b2.js',
    between: { 'src/b1.ts': IMPORT_THEN_EXPORT('./a-leaf.js'), 'src/b2.ts': STAR('./b1.js') },
  },
  {
    name: 'an import under one name, exported under the declared one',
    leaf: 'src/a-leaf.ts',
    entry: './b1.js',
    between: {
      'src/b1.ts': `import { Base as B0, make as m0 } from './a-leaf.js';
import type { Shape as S0 } from './a-leaf.js';
export { B0 as Base, m0 as make };
export type { S0 as Shape };
`,
    },
  },
];

describe.each([
  { variant: 'alone', decoy: false },
  { variant: 'beside a file declaring the same names', decoy: true },
])('edges through a re-export, $variant', ({ decoy }) => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('reexport-shapes');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(SHAPES)('reach the declaring file through $name', async (shape) => {
    writeFiles(dir, {
      [shape.leaf]: LEAF_SRC,
      ...shape.between,
      'src/z-consumer.ts': consumerSrc(shape.entry),
      // `0-` sorts first, so the decoy's rows are the first with these names.
      ...(decoy ? { 'src/0-decoy.ts': DECOY_SRC } : {}),
    });

    await expectEdges(dir, [
      `EXTENDS src/z-consumer.ts:Child -> ${shape.leaf}:Base`,
      `IMPLEMENTS src/z-consumer.ts:Child -> ${shape.leaf}:Shape`,
      `POTENTIAL_CALL src/z-consumer.ts:go -> ${shape.leaf}:make`,
      // A method is exported by nothing; it is reached through its class.
      `POTENTIAL_CALL src/z-consumer.ts:greet -> ${shape.leaf}:Base.hello`,
      // And inherited by a class whose parent is behind the same chain.
      `POTENTIAL_CALL src/z-consumer.ts:viaChild -> ${shape.leaf}:Base.hello`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// A re-export that renames (D105). The consumer knows the class by the name
// the index file gives it; its members are stored under the name the class was
// declared with. n8n's `export { Column as DslColumn }` put `new DslColumn()`
// on the class though it declares a constructor, and gave `c.build()` no edge.
// ---------------------------------------------------------------------------

describe('edges through a re-export that renames', () => {
  let dir: string;

  const COLUMN_SRC = `export class Column {
  constructor(readonly name: string) {}
  build(): string { return this.name; }
  static of(name: string): Column { return new Column(name); }
}
export function fail(): never { throw new Error('x'); }
`;
  const CONSUMER_SRC = `import { DslColumn, raise } from './b-index.js';
export function make(): unknown { return new DslColumn('a'); }
export function use(c: DslColumn): string { return c.build(); }
export function viaStatic(): unknown { return DslColumn.of('a'); }
export function stop(): void { raise(); }
`;
  const EXPECTED = [
    'POTENTIAL_CALL src/z-consumer.ts:make -> src/a-column.ts:Column.constructor',
    'POTENTIAL_CALL src/z-consumer.ts:stop -> src/a-column.ts:fail',
    'POTENTIAL_CALL src/z-consumer.ts:use -> src/a-column.ts:Column.build',
    'POTENTIAL_CALL src/z-consumer.ts:viaStatic -> src/a-column.ts:Column.of',
    'POTENTIAL_CALL src/a-column.ts:Column.of -> src/a-column.ts:Column.constructor',
  ];
  const RENAME = (from: string): string => `export { Column as DslColumn, fail as raise } from '${from}';\n`;

  beforeEach(() => {
    dir = makeProject('reexport-rename');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reach the members of the class under its declared name', async () => {
    writeFiles(dir, {
      'src/a-column.ts': COLUMN_SRC,
      'src/b-index.ts': RENAME('./a-column.js'),
      'src/z-consumer.ts': CONSUMER_SRC,
    });

    await expectEdges(dir, EXPECTED);
  });

  it('reach them when the renaming file sits behind a star', async () => {
    writeFiles(dir, {
      'src/a-column.ts': COLUMN_SRC,
      'src/b-0.ts': RENAME('./a-column.js'),
      'src/b-index.ts': `export * from './b-0.js';\n`,
      'src/z-consumer.ts': CONSUMER_SRC,
    });

    await expectEdges(dir, EXPECTED);
  });
});

// ---------------------------------------------------------------------------
// D096. `export * as ns from './a'` exports one name, `ns`. What `a` declares
// is reachable as `ns.fn` and not as `fn`, so the line is no `export *`.
// ---------------------------------------------------------------------------
describe('a star re-export under a namespace name', () => {
  let dir: string;

  const FN = (value: number): string => `export function fn(): number { return ${String(value)}; }\n`;
  const CONSUMER_SRC = `import { fn } from './barrel.js';\nexport function use(): number { return fn(); }\n`;

  beforeEach(() => {
    dir = makeProject('reexport-namespace-star');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not export the names behind it', async () => {
    writeFiles(dir, {
      'src/a.ts': FN(1),
      'src/barrel.ts': `export * as ns from './a.js';\n`,
      'src/zc.ts': CONSUMER_SRC,
    });

    await expectEdges(dir, []);
  });

  it('leaves a name to the plain star beside it', async () => {
    writeFiles(dir, {
      'src/a.ts': FN(1),
      'src/b.ts': FN(2),
      'src/barrel.ts': `export * as ns from './a.js';\nexport * from './b.js';\n`,
      'src/zc.ts': CONSUMER_SRC,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/zc.ts:use -> src/b.ts:fn']);
  });
});

// ---------------------------------------------------------------------------
// D108, on the incremental path. The file between holds no `from`; what ties it
// to the leaf is its import. An edit to the leaf, and to the file between, has
// to leave the graph a full index would build.
// ---------------------------------------------------------------------------
describe('an import that is then exported, after an edit', () => {
  let dir: string;
  const FILES = {
    'src/a-leaf.ts': LEAF_SRC,
    'src/b1.ts': IMPORT_THEN_EXPORT('./a-leaf.js'),
    'src/z-consumer.ts': consumerSrc('./b1.js'),
  };

  beforeEach(() => {
    dir = makeProject('reexport-import-then-export');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loses the edge to a function the leaf no longer declares, and gets it back', async () => {
    writeFiles(dir, FILES);
    await indexFull(dir);

    editFile(dir, 'src/a-leaf.ts', LEAF_SRC.replace('export function make(): void {}\n', ''));
    await indexIncremental(dir);
    await expectGraphEqualsFullIndex(dir);

    editFile(dir, 'src/a-leaf.ts', LEAF_SRC);
    await indexIncremental(dir);
    await expectGraphEqualsFullIndex(dir);
    await expectStoredEdges(dir, [
      'EXTENDS src/z-consumer.ts:Child -> src/a-leaf.ts:Base',
      'IMPLEMENTS src/z-consumer.ts:Child -> src/a-leaf.ts:Shape',
      'POTENTIAL_CALL src/z-consumer.ts:go -> src/a-leaf.ts:make',
      'POTENTIAL_CALL src/z-consumer.ts:greet -> src/a-leaf.ts:Base.hello',
      'POTENTIAL_CALL src/z-consumer.ts:viaChild -> src/a-leaf.ts:Base.hello',
    ]);
  });

  it('follows the file between when it stops exporting a name, and when it starts again', async () => {
    writeFiles(dir, FILES);
    await indexFull(dir);

    editFile(dir, 'src/b1.ts', FILES['src/b1.ts'].replace('export { Base, make };', 'export { Base };'));
    await indexIncremental(dir);
    await expectGraphEqualsFullIndex(dir);

    editFile(dir, 'src/b1.ts', FILES['src/b1.ts']);
    await indexIncremental(dir);
    await expectGraphEqualsFullIndex(dir);
  });
});

// ---------------------------------------------------------------------------
// D120 — a declaration the imported file does not export is not what the
// import names, whatever it is called.
// ---------------------------------------------------------------------------

const REAL_SRC = `export function helper(): number { return 1; }
export class Client { send(): void {} }
`;
const USER_SRC = `import { helper, Client } from './m-barrel.js';
export function use(c: Client): void { helper(); c.send(); }
`;

describe('a private declaration with the name of an import', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('private-name');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('in a barrel is passed over for the declaration its `export *` supplies', async () => {
    writeFiles(dir, {
      'src/a-real.ts': REAL_SRC,
      'src/m-barrel.ts': `function helper(): number { return 2; }\nclass Client { send(): void { helper(); } }\nvoid Client;\nexport * from './a-real.js';\n`,
      'src/z-user.ts': USER_SRC,
    });

    await expectEdges(dir, [
      'POTENTIAL_CALL src/m-barrel.ts:Client.send -> src/m-barrel.ts:helper',
      'POTENTIAL_CALL src/z-user.ts:use -> src/a-real.ts:Client.send',
      'POTENTIAL_CALL src/z-user.ts:use -> src/a-real.ts:helper',
    ]);
  });

  it('behind an `export *` is passed over for an exported one behind another', async () => {
    writeFiles(dir, {
      'src/a-private.ts': `function helper(): number { return 2; }\nexport function other(): number { return helper(); }\n`,
      'src/b-real.ts': REAL_SRC,
      'src/m-barrel.ts': `export * from './a-private.js';\nexport * from './b-real.js';\n`,
      'src/z-user.ts': USER_SRC,
    });

    await expectEdges(dir, [
      'POTENTIAL_CALL src/a-private.ts:other -> src/a-private.ts:helper',
      'POTENTIAL_CALL src/z-user.ts:use -> src/b-real.ts:Client.send',
      'POTENTIAL_CALL src/z-user.ts:use -> src/b-real.ts:helper',
    ]);
  });

  it('gets no edge when nothing exports the name', async () => {
    writeFiles(dir, {
      'src/m-barrel.ts': `function helper(): number { return 2; }\nclass Client { send(): void { helper(); } }\nvoid Client;\n`,
      'src/z-user.ts': USER_SRC,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/m-barrel.ts:Client.send -> src/m-barrel.ts:helper']);
  });
});

// ---------------------------------------------------------------------------
// A call through a namespace import reaches the file the import names, or the
// file behind its re-exports, and not another file that declares the name
// (adr/proposals/checker-widening, s10).
// ---------------------------------------------------------------------------

describe('a default export behind a star re-export', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeProject('default-behind-star');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // `export *` passes on every export but the default one, so the name the
  // function was declared with is not a name of the barrel (D164).
  it('is not reached by the name it was declared with when another file exports that name', async () => {
    writeFiles(dir, {
      'src/a-default.ts': `export default function dz(): void {}\n`,
      'src/b-named.ts': `export function dz(): void {}\n`,
      'src/c-barrel.ts': `${STAR('./a-default.js')}${STAR('./b-named.js')}`,
      'src/z-consumer.ts': `import { dz } from './c-barrel.js';\nexport function go(): void { dz(); }\n`,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/z-consumer.ts:go -> src/b-named.ts:dz']);
  });
});

describe('calls through a namespace import', () => {
  let dir: string;

  const LEAF = `export function append(): void {}
export class Widget { constructor(readonly id: string) {} }
export class Plain {}
export const later = (): void => {};
`;
  const DECOY = `export function append(): void {}
export class Widget { constructor(readonly id: string) {} }
`;
  const consumer = (entry: string): string => `import * as dom from '${entry}';
export function go(): void { dom.append(); dom.later(); }
export function make(): unknown { return [new dom.Widget('a'), new dom.Plain()]; }
`;
  const EXPECTED = [
    'POTENTIAL_CALL src/z-consumer.ts:go -> src/b-dom.ts:append',
    'POTENTIAL_CALL src/z-consumer.ts:go -> src/b-dom.ts:later',
    'POTENTIAL_CALL src/z-consumer.ts:make -> src/b-dom.ts:Plain',
    'POTENTIAL_CALL src/z-consumer.ts:make -> src/b-dom.ts:Widget.constructor',
  ];

  beforeEach(() => {
    dir = makeProject('namespace-import');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reach the file the import names', async () => {
    writeFiles(dir, { 'src/a-decoy.ts': DECOY, 'src/b-dom.ts': LEAF, 'src/z-consumer.ts': consumer('./b-dom.js') });

    await expectEdges(dir, EXPECTED);
  });

  it('reach the file behind a star re-export', async () => {
    writeFiles(dir, {
      'src/a-decoy.ts': DECOY,
      'src/b-dom.ts': LEAF,
      'src/c-barrel.ts': STAR('./b-dom.js'),
      'src/z-consumer.ts': consumer('./c-barrel.js'),
    });

    await expectEdges(dir, EXPECTED);
  });

  it('are the same after the imported file is edited as after a full index', async () => {
    writeFiles(dir, { 'src/a-decoy.ts': DECOY, 'src/b-dom.ts': LEAF, 'src/z-consumer.ts': consumer('./b-dom.js') });
    await indexFull(dir);

    editFile(dir, 'src/b-dom.ts', LEAF.replace('export function append', 'export function renamed'));
    await indexIncremental(dir);

    await expectGraphEqualsFullIndex(dir);
    await expectStoredEdges(dir, EXPECTED.filter((edge) => !edge.endsWith(':append')));
  });

  // An import row for a namespace lists no name, so an incremental run cannot
  // find its file by the names that changed. Each of these left the stored
  // graph unlike a full index (review of the rule, 2026-10-10).
  it('follow a named re-export that is pointed at another file', async () => {
    writeFiles(dir, {
      'src/b-dom.ts': LEAF,
      'src/b-other.ts': LEAF,
      'src/c-barrel.ts': `export { append, later, Widget, Plain } from './b-dom.js';\n`,
      'src/z-consumer.ts': consumer('./c-barrel.js'),
    });
    await indexFull(dir);

    editFile(dir, 'src/c-barrel.ts', `export { append, later, Widget, Plain } from './b-other.js';\n`);
    await indexIncremental(dir);

    await expectGraphEqualsFullIndex(dir);
    await expectStoredEdges(dir, EXPECTED.map((edge) => edge.replace('src/b-dom.ts', 'src/b-other.ts')));
  });

  it('go to a name the imported file gains over the one behind its star', async () => {
    writeFiles(dir, {
      'src/b-dom.ts': LEAF,
      'src/c-barrel.ts': STAR('./b-dom.js'),
      'src/z-consumer.ts': consumer('./c-barrel.js'),
    });
    await indexFull(dir);

    editFile(dir, 'src/c-barrel.ts', `${STAR('./b-dom.js')}export function append(): void {}\n`);
    await indexIncremental(dir);

    await expectGraphEqualsFullIndex(dir);
    await expectStoredEdges(dir, EXPECTED.map((edge) => edge.replace('src/b-dom.ts:append', 'src/c-barrel.ts:append')));
  });

  it('appear when the imported file gains the name', async () => {
    writeFiles(dir, { 'src/b-dom.ts': `export const unrelated = 1;\n`, 'src/z-consumer.ts': consumer('./b-dom.js') });
    await indexFull(dir);

    editFile(dir, 'src/b-dom.ts', LEAF);
    await indexIncremental(dir);

    await expectGraphEqualsFullIndex(dir);
    await expectStoredEdges(dir, EXPECTED);
  });

  const NAMED = `export { append, later, Widget, Plain } from './b-dom.js';\n`;
  const EDITS: readonly { name: string; before: Readonly<Record<string, string>>; edit: { path: string; content: string } }[] = [
    {
      name: 'the file two stars away gains the name',
      before: { 'src/a-leaf.ts': `export const unrelated = 1;\n`, 'src/b-dom.ts': STAR('./a-leaf.js'), 'src/c-barrel.ts': STAR('./b-dom.js') },
      edit: { path: 'src/a-leaf.ts', content: LEAF },
    },
    {
      name: 'the imported file gains a star',
      before: { 'src/b-dom.ts': LEAF, 'src/c-barrel.ts': `export const unrelated = 1;\n` },
      edit: { path: 'src/c-barrel.ts', content: STAR('./b-dom.js') },
    },
    {
      name: 'the imported file gains a named re-export',
      before: { 'src/b-dom.ts': LEAF, 'src/c-barrel.ts': `export const unrelated = 1;\n` },
      edit: { path: 'src/c-barrel.ts', content: NAMED },
    },
    {
      name: 'the file behind a named re-export gains the name',
      before: { 'src/b-dom.ts': `export const unrelated = 1;\n`, 'src/c-barrel.ts': NAMED },
      edit: { path: 'src/b-dom.ts', content: LEAF },
    },
    {
      name: 'a declaration the imported file had gains its export keyword',
      before: { 'src/c-barrel.ts': LEAF.replaceAll('export ', '') },
      edit: { path: 'src/c-barrel.ts', content: LEAF },
    },
    {
      name: 'the imported file gains a default export of the same name',
      before: { 'src/c-barrel.ts': `export const unrelated = 1;\n` },
      edit: { path: 'src/c-barrel.ts', content: `export default function append(): void {}\n` },
    },
  ];
  it.each(EDITS)('are the same as after a full index when $name', async ({ before, edit }) => {
    writeFiles(dir, { ...before, 'src/z-consumer.ts': consumer('./c-barrel.js') });
    await indexFull(dir);

    editFile(dir, edit.path, edit.content);
    await indexIncremental(dir);

    await expectGraphEqualsFullIndex(dir);
  });

  // The row of `import d, * as dom` lists `default`, so it is known for a
  // namespace import by the local name it keeps, not by listing nothing (D166).
  it('are the same as after a full index when the import has a default beside the namespace', async () => {
    writeFiles(dir, {
      'src/b-dom.ts': `export default 1;\n`,
      'src/z-consumer.ts': `import main, * as dom from './b-dom.js';\nexport function go(): void { dom.append(); void main; }\n`,
    });
    await indexFull(dir);

    editFile(dir, 'src/b-dom.ts', `export default 1;\nexport function append(): void {}\n`);
    await indexIncremental(dir);

    await expectGraphEqualsFullIndex(dir);
    await expectStoredEdges(dir, ['POTENTIAL_CALL src/z-consumer.ts:go -> src/b-dom.ts:append']);
  });

  it('store nothing for a module that is not an indexed file', async () => {
    writeFiles(dir, { 'src/a-decoy.ts': DECOY, 'src/z-consumer.ts': consumer('some-package') });

    await expectEdges(dir, []);
  });
});
