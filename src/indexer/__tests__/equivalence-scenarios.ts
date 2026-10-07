// ---------------------------------------------------------------------------
// The edit scenarios the equivalence tests run (T2, T3;
// adr/proposals/incremental-graph-correctness). One row per scenario: a
// project, then one or more rounds of edits. The first rows are the
// reproductions in spikes/s0-reproductions. A later defect in this family adds
// a row here, and every test that runs the table picks it up.
//
// Callers are named to sort after what they import, so no row depends on walk
// order; that is walk-order.test.ts.
// ---------------------------------------------------------------------------

/** A path to its new content, or to `null` to delete the file. */
export type Round = Readonly<Record<string, string | null>>;

export interface Scenario {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly rounds: readonly Round[];
  /**
   * Ledger id of an open defect this scenario reproduces. The tables run such a
   * row expecting it to fail, so the fix has to remove the field.
   */
  readonly openDefect?: string;
}

const CALLER = `import { fn } from './x.js';\nexport function use(): void { fn(); }\n`;

export const SCENARIOS: readonly Scenario[] = [
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
    files: {
      'src/x.ts': `export function other(): void {}\n`,
      'src/zc.ts': CALLER,
    },
    rounds: [{ 'src/x.ts': `export function other(): void {}\nexport function fn(): void {}\n` }],
  },
  {
    name: 'a file is created after the file that imports from it',
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
  {
    name: 'a file gains a name that is imported through two named barrels',
    files: {
      'src/x.ts': `export function other(): void {}\n`,
      'src/inner.ts': `export { fn } from './x.js';\n`,
      'src/outer.ts': `export { fn } from './inner.js';\n`,
      'src/zc.ts': `import { fn } from './outer.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/x.ts': `export function other(): void {}\nexport function fn(): void {}\n` }],
  },
  {
    name: 'a file gains a name that is imported through a star barrel behind a named one',
    files: {
      'src/x.ts': `export function other(): void {}\n`,
      'src/star.ts': `export * from './x.js';\n`,
      'src/outer.ts': `export { fn } from './star.js';\n`,
      'src/zc.ts': `import { fn } from './outer.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/x.ts': `export function other(): void {}\nexport function fn(): void {}\n` }],
  },
  {
    name: 'a file behind a star barrel loses a name and another file behind it gains it',
    files: {
      'src/a.ts': `export function fn(): number { return 1; }\n`,
      'src/b.ts': `export function other(): void {}\n`,
      'src/barrel.ts': `export * from './a.js';\nexport * from './b.js';\n`,
      'src/zc.ts': `import { fn } from './barrel.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [
      {
        'src/a.ts': `export function gone(): void {}\n`,
        'src/b.ts': `export function other(): void {}\nexport function fn(): number { return 2; }\n`,
      },
    ],
  },
  {
    name: 'a class gains a method that a subclass elsewhere already calls through super',
    files: {
      'src/x.ts': `export class Base { other(): void {} }\n`,
      'src/zc.ts': `import { Base } from './x.js';\nexport class Child extends Base {\n  go(): void { super.run(); }\n}\n`,
    },
    rounds: [{ 'src/x.ts': `export class Base { other(): void {}\n  run(): void {} }\n` }],
  },
  {
    name: 'a star barrel gains a second target that holds an imported name',
    files: {
      'src/a.ts': `export function other(): void {}\n`,
      'src/b.ts': `export function fn(): void {}\n`,
      'src/barrel.ts': `export * from './a.js';\n`,
      'src/zc.ts': `import { fn } from './barrel.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/barrel.ts': `export * from './a.js';\nexport * from './b.js';\n` }],
  },
  {
    name: 'a file behind a star barrel is deleted',
    files: {
      'src/a.ts': `export function fn(): void {}\n`,
      'src/barrel.ts': `export * from './a.js';\n`,
      'src/zc.ts': `import { fn } from './barrel.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/a.ts': null }],
  },
  {
    name: 'a named barrel is re-pointed at another file and nothing else changes',
    files: {
      'src/a.ts': `export function fn(): number { return 1; }\n`,
      'src/b.ts': `export function fn(): number { return 2; }\n`,
      'src/barrel.ts': `export { fn } from './a.js';\n`,
      'src/zc.ts': `import { fn } from './barrel.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/barrel.ts': `export { fn } from './b.js';\n` }],
  },
  {
    name: 'a star barrel names a file that is created afterwards',
    files: {
      'src/barrel.ts': `export * from './a.js';\n`,
      'src/zc.ts': `import { fn } from './barrel.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/a.ts': `export function fn(): void {}\n` }],
  },
  {
    name: 'a new file takes over a specifier that a directory index answered',
    files: {
      'src/x/index.ts': `export function fn(): number { return 1; }\n`,
      'src/zc.ts': `import { fn } from './x';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/x.ts': `export function fn(): number { return 2; }\n` }],
  },
  {
    name: 'a class gains a method that another file calls on a type it does not import',
    files: {
      'src/a.ts': `export class Widget { other(): void {} }\n`,
      'src/zc.ts': `export function use(w: Widget): void { w.run(); }\n`,
    },
    rounds: [{ 'src/a.ts': `export class Widget { other(): void {}\n  run(): void {} }\n` }],
  },
  // Found by the generated sequences (T10), cut down. In the next three the
  // importer holds no edge into the file and imports no name it exports, so
  // only its import row says where the specifier points.
  {
    name: 'a file is deleted that another imports a name from, which it never exported',
    files: {
      'src/x.ts': `export function other(): void {}\n`,
      'src/zc.ts': `import { fn } from './x';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/x.ts': null }],
  },
  {
    name: 'a file is added where an import pointed at nothing, without the imported name',
    files: {
      'src/a.ts': `export function other(): void {}\n`,
      'src/zc.ts': `import { fn } from './x';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/x.ts': `export function other(): void {}\n` }],
  },
  {
    name: 'a directory index is replaced by a file of the same name',
    files: {
      'src/x/index.ts': `export function other(): void {}\n`,
      'src/zc.ts': `import { fn } from './x';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/x/index.ts': null, 'src/x.ts': `export function other(): void {}\n` }],
  },
  {
    name: 'a name reachable through two stars, and the file it resolved to is edited',
    files: {
      'src/a.ts': `export function fn(): number { return 1; }\n`,
      'src/b.ts': `export function fn(): number { return 2; }\n`,
      'src/barrel.ts': `export * from './a.js';\nexport * from './b.js';\n`,
      'src/zc.ts': `import { fn } from './barrel.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/a.ts': `export function fn(): number { return 3; }\n` }],
  },
  {
    name: 'a file is deleted that stood in front of a directory index others re-export from',
    files: {
      'src/x.ts': `export function other(): void {}\n`,
      'src/x/index.ts': `export function fn(): number { return 1; }\n`,
      'src/c.ts': `export { fn } from './x';\n`,
      'src/zc.ts': `import { fn } from './c.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/x.ts': null }],
  },
  // Added after spike S10 (spikes/s10-mutation): each of these fails when one
  // line of the repair code is removed, and no row above did. The line is named
  // by its mutant id in the spike's mutants.json.
  {
    // E07
    name: 'a new file takes over a specifier that a star re-export reached a directory index through',
    files: {
      'src/x/index.ts': `export function fn(): number { return 1; }\n`,
      'src/barrel.ts': `export * from './x';\n`,
    },
    rounds: [{ 'src/x.ts': `export function other(): void {}\n` }],
  },
  {
    // E09
    name: 'a new file takes over a specifier that an import of a missing name reached a directory index through',
    files: {
      'src/x/index.ts': `export function other(): void {}\n`,
      'src/zc.ts': `import { fn } from './x';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/x.ts': `export function other(): void {}\n` }],
  },
  {
    // E11
    name: 'a star barrel in the middle of a chain of stars is deleted',
    files: {
      'src/a.ts': `export function fn(): void {}\n`,
      'src/mid.ts': `export * from './a.js';\n`,
      'src/outer.ts': `export * from './mid.js';\n`,
      'src/named.ts': `export { fn } from './outer.js';\n`,
      'src/zc.ts': `import { fn } from './named.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/mid.ts': null }],
  },
  {
    // E14
    name: 'a star barrel is deleted from a chain of stars that ends at a named re-export',
    files: {
      'src/impl.ts': `export function fn(): void {}\n`,
      'src/named.ts': `export { fn } from './impl.js';\n`,
      'src/mid.ts': `export * from './named.js';\n`,
      'src/outer.ts': `export * from './mid.js';\n`,
      'src/zc.ts': `import { fn } from './outer.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/mid.ts': null }],
  },
  {
    // I03
    name: 'a star barrel stops re-exporting the file a caller reached through it',
    files: {
      'src/a.ts': `export function fn(): void {}\n`,
      'src/barrel.ts': `export * from './a.js';\n`,
      'src/zc.ts': `import { fn } from './barrel.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/barrel.ts': `export function other(): void {}\n` }],
  },
  {
    // I06
    name: 'a class gains a method that another file already calls on a parameter of its type',
    files: {
      'src/x.ts': `export class Widget { other(): void {} }\n`,
      'src/zc.ts': `import { Widget } from './x.js';\nexport function use(w: Widget): void { w.run(); }\n`,
    },
    rounds: [{ 'src/x.ts': `export class Widget { other(): void {}\n  run(): void {} }\n` }],
  },
  {
    // I09
    name: 'a star barrel stops re-exporting a second star barrel that a caller reached a name through',
    files: {
      'src/a.ts': `export function fn(): void {}\n`,
      'src/inner.ts': `export * from './a.js';\n`,
      'src/outer.ts': `export * from './inner.js';\n`,
      'src/zc.ts': `import { fn } from './outer.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/outer.ts': `export function other(): void {}\n` }],
  },
  {
    // I11
    name: 'a TypeScript file is added beside a JavaScript file of the same name',
    files: {
      'src/x.js': `export function fn() { return 1; }\n`,
      'src/zc.ts': `import { fn } from './x.js';\nexport function use(): void { fn(); }\n`,
    },
    rounds: [{ 'src/x.ts': `export function fn(): number { return 2; }\n` }],
  },
];
