import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dumpSymbols,
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
// A method of an interface has a symbol row, named as a class's method is
// (adr/proposals/checker-widening, "A row for each method of an interface").
// A call on a receiver whose written type is the interface goes to it: the
// compiler's target for that call is the member of the interface, and which
// class runs is not known from the call.
// ---------------------------------------------------------------------------

const STORE = `export interface Store {
  get(key: string): string;
  has?(key: string): boolean;
  put: (key: string, value: string) => void;
}
`;

describe('a method of an interface', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('interface-method-edges');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a symbol, and a property with a function type is not', async () => {
    writeFiles(dir, { 'src/store.ts': STORE });
    await indexFull(dir);

    const methods = (await dumpSymbols(dir)).filter((row) => row.includes('Store.'));
    expect(methods.map((row) => row.replace(/^.*(Store\.\w+).*$/, '$1')).sort()).toEqual(['Store.get', 'Store.has']);
  });

  it('is a member of its interface', async () => {
    writeFiles(dir, { 'src/store.ts': STORE });

    await expectEdges(
      dir,
      ['PARENT_OF src/store.ts:Store -> src/store.ts:Store.get', 'PARENT_OF src/store.ts:Store -> src/store.ts:Store.has'],
      ['PARENT_OF'],
    );
  });

  it('is one symbol when it is written as overloads, and when the interface is on one line', async () => {
    writeFiles(dir, {
      'src/a.ts': `export interface Over {\n  pick(key: string): string;\n  pick(key: number): number;\n}\nexport interface Line { one(): void; two(): void }\n`,
    });
    await indexFull(dir);

    const names = (await dumpSymbols(dir)).filter((row) => /Over\.|Line\./.test(row)).map((row) => row.replace(/^.*((?:Over|Line)\.\w+).*$/, '$1'));
    expect(names.sort()).toEqual(['Line.one', 'Line.two', 'Over.pick']);
  });

  it('is one symbol when it is written as a getter and a setter', async () => {
    writeFiles(dir, { 'src/a.ts': `export interface Sized {\n  get size(): number;\n  set size(value: number);\n}\n` });
    await indexFull(dir);

    const names = (await dumpSymbols(dir)).filter((row) => row.includes('Sized.')).map((row) => row.replace(/^.*(Sized\.\w+).*$/, '$1'));
    expect(names).toEqual(['Sized.size']);
  });

  it('is the target of a call on a parameter, a field and a constructor parameter typed as the interface', async () => {
    writeFiles(dir, {
      'src/store.ts': STORE,
      'src/use.ts': `import type { Store } from './store.js';
export function byParam(store: Store): void { store.get('a'); }
export class ByField {
  private store!: Store;
  run(): void { this.store.get('a'); }
}
export class ByCtor {
  constructor(private readonly store: Store) {}
  run(): void { this.store.has?.('a'); }
}
`,
    });

    await expectEdges(
      dir,
      [
        'POTENTIAL_CALL src/use.ts:ByCtor.run -> src/store.ts:Store.has',
        'POTENTIAL_CALL src/use.ts:ByField.run -> src/store.ts:Store.get',
        'POTENTIAL_CALL src/use.ts:byParam -> src/store.ts:Store.get',
      ],
      ['POTENTIAL_CALL'],
    );
  });

  it('is not the target of a call of a property that holds a function', async () => {
    writeFiles(dir, {
      'src/store.ts': STORE,
      'src/use.ts': `import type { Store } from './store.js';\nexport function byParam(store: Store): void { store.put('a', 'b'); }\n`,
    });

    await expectEdges(dir, [], ['POTENTIAL_CALL']);
  });

  it('leaves a call on a receiver typed as the class on the class\'s method', async () => {
    writeFiles(dir, {
      'src/store.ts': STORE,
      'src/impl.ts': `import type { Store } from './store.js';
export class MemoryStore implements Store {
  get(key: string): string { return key; }
  put = (key: string, value: string): void => { void key; void value; };
}
`,
      'src/use.ts': `import { MemoryStore } from './impl.js';\nexport function byParam(store: MemoryStore): void { store.get('a'); }\n`,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/use.ts:byParam -> src/impl.ts:MemoryStore.get'], ['POTENTIAL_CALL']);
  });

  it('is found on the interface above, and not when two are above', async () => {
    writeFiles(dir, {
      'src/base.ts': `export interface Readable { read(): string; }\nexport interface Closable { close(): void; }\n`,
      'src/file.ts': `import type { Closable, Readable } from './base.js';
export interface Source extends Readable {}
export interface File extends Readable, Closable {}
`,
      'src/use.ts': `import type { File, Source } from './file.js';
export function one(source: Source): void { source.read(); }
export function two(file: File): void { file.read(); }
`,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/use.ts:one -> src/base.ts:Readable.read'], ['POTENTIAL_CALL']);
  });

  // The nearest declaration is the property, and what it holds is not stored.
  it('is not found on the interface above when the interface between declares the name as a property', async () => {
    writeFiles(dir, {
      'src/base.ts': `export interface Readable { read(): string; }\n`,
      'src/file.ts': `import type { Readable } from './base.js';\nexport interface Lazy extends Readable { read: () => string; }\n`,
      'src/use.ts': `import type { Lazy } from './file.js';\nexport function one(lazy: Lazy): void { lazy.read(); }\n`,
    });

    await expectEdges(dir, [], ['POTENTIAL_CALL']);
  });

  // A second declaration of the interface, or of the class's name as an interface,
  // declares the property as well as the first would.
  it('is not found on the interface above when a later declaration of the receiver\'s type declares the name as a property', async () => {
    writeFiles(dir, {
      'src/a.ts': `export interface Readable { read(): string; }
export interface Lazy extends Readable {}
export interface Lazy { read: () => string; }
export class Base { read(): string { return ''; } }
export class Sub extends Base {}
export interface Sub { read: () => string; }
export interface Far extends Lazy {}
export function one(lazy: Lazy, sub: Sub, far: Far): void { lazy.read(); sub.read(); far.read(); }
`,
    });

    await expectEdges(dir, [], ['POTENTIAL_CALL']);
  });

  it('is not stored beside a method of the same name of a class written after the interface', async () => {
    writeFiles(dir, { 'src/x.ts': `export interface X { both(): void; added(): void; }\nexport class X { both(): void {} }\n` });
    await indexFull(dir);

    const names = (await dumpSymbols(dir)).filter((row) => row.includes('X.')).map((row) => row.replace(/^.*(X\.\w+).*$/, '$1'));
    expect(names.sort()).toEqual(['X.added', 'X.both']);
  });

  it('is not stored beside a method of the same name of a class the interface is merged with', async () => {
    writeFiles(dir, {
      'src/x.ts': `export class X { both(): void {} }\nexport interface X { both(): void; added(): void; }\n`,
      'src/use.ts': `import { X } from './x.js';\nexport function byParam(x: X): void { x.both(); x.added(); }\n`,
    });
    await indexFull(dir);

    const names = (await dumpSymbols(dir)).filter((row) => row.includes('X.')).map((row) => row.replace(/^.*(X\.\w+).*$/, '$1'));
    expect(names.sort()).toEqual(['X.added', 'X.both']);
    await expectEdges(
      dir,
      ['POTENTIAL_CALL src/use.ts:byParam -> src/x.ts:X.added', 'POTENTIAL_CALL src/use.ts:byParam -> src/x.ts:X.both'],
      ['POTENTIAL_CALL'],
    );
  });

  it('is one symbol when two declarations of the interface both have it', async () => {
    writeFiles(dir, {
      'src/row.ts': `export interface Row { id(): string; }\nexport interface Row { id(): string; name(): string; }\n`,
      'src/use.ts': `import type { Row } from './row.js';\nexport function byParam(row: Row): void { row.id(); row.name(); }\n`,
    });
    await indexFull(dir);

    const names = (await dumpSymbols(dir)).filter((row) => row.includes('Row.')).map((row) => row.replace(/^.*(Row\.\w+).*$/, '$1'));
    expect(names.sort()).toEqual(['Row.id', 'Row.name']);
    await expectEdges(
      dir,
      ['POTENTIAL_CALL src/use.ts:byParam -> src/row.ts:Row.id', 'POTENTIAL_CALL src/use.ts:byParam -> src/row.ts:Row.name'],
      ['POTENTIAL_CALL'],
    );
  });

  it('is not the target of a call written on the interface\'s name', async () => {
    writeFiles(dir, {
      'src/store.ts': `${STORE}export const Store = { get: (key: string): string => key };\n`,
      'src/use.ts': `import { Store } from './store.js';\nexport function onTheName(): void { Store.get('a'); }\n`,
    });

    await expectEdges(dir, [], ['POTENTIAL_CALL']);
  });

  it('gives the same graph after it is renamed as a full index does', async () => {
    writeFiles(dir, {
      'src/store.ts': STORE,
      'src/use.ts': `import type { Store } from './store.js';\nexport function byParam(store: Store): void { store.get('a'); }\n`,
    });
    await indexFull(dir);

    editFile(dir, 'src/store.ts', STORE.replace('get(key', 'fetch(key'));
    await indexIncremental(dir);

    await expectStoredEdges(dir, [], ['POTENTIAL_CALL']);
    await expectGraphEqualsFullIndex(dir);
  });

  it('gives the same graph after it is added as a full index does', async () => {
    writeFiles(dir, {
      'src/store.ts': STORE.replace('get(key', 'fetch(key'),
      'src/use.ts': `import type { Store } from './store.js';\nexport function byParam(store: Store): void { store.get('a'); }\n`,
    });
    await indexFull(dir);

    editFile(dir, 'src/store.ts', STORE);
    await indexIncremental(dir);

    await expectStoredEdges(dir, ['POTENTIAL_CALL src/use.ts:byParam -> src/store.ts:Store.get'], ['POTENTIAL_CALL']);
    await expectGraphEqualsFullIndex(dir);
  });
});
