import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { expectEdges, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// T15 — every re-export shape, on a full index, against edges written by hand
// (adr/proposals/incremental-graph-correctness).
//
// A consumer imports a class, an interface and a function through an entry
// file, then extends, implements and calls them. The three edges must reach
// the declaring file whatever sits between. A comparison against a full index
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
`;
}

const NAMED = (from: string): string => `export { Base, Shape, make } from '${from}';\n`;
const STAR = (from: string): string => `export * from '${from}';\n`;

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
    ]);
  });
});
