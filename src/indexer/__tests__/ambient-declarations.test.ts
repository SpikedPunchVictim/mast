import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractFileSignatures } from '../../ast/extract.js';
import { dumpSymbols, expectEdges, indexFull, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// D109 — a declaration written under `declare`. The parser wraps it in a node
// of its own, and every reader of top-level declarations looked at the wrapper
// and found nothing it knew: no symbol, no signature, no edge.
// ---------------------------------------------------------------------------

describe('declarations under `declare`', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('ambient-declarations');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('are symbols of the kind they declare, exported when `export` is written', async () => {
    writeFiles(dir, {
      'src/a.ts': `export declare class D { told(): void; }
declare abstract class A { abstract shape(): void; }
declare function g(): void;
export declare function h(a: number): void;
declare interface I { x: number }
export declare type T = string;
`,
    });

    await indexFull(dir);

    expect(await dumpSymbols(dir)).toEqual([
      'class src/a.ts:A',
      'exported class src/a.ts:D',
      'exported function src/a.ts:h',
      'exported method src/a.ts:D.told',
      'exported type src/a.ts:T',
      'function src/a.ts:g',
      'interface src/a.ts:I',
      'method src/a.ts:A.shape',
    ]);
  });

  it('are symbols in a .d.ts file', async () => {
    writeFiles(dir, {
      'src/types.d.ts': `export declare class Client { send(): void; }\nexport declare function connect(): Client;\n`,
    });

    await indexFull(dir);

    expect(await dumpSymbols(dir)).toEqual([
      'exported class src/types.d.ts:Client',
      'exported function src/types.d.ts:connect',
      'exported method src/types.d.ts:Client.send',
    ]);
  });

  it('are one function when a name is declared with overloads', async () => {
    writeFiles(dir, {
      'src/a.ts': `declare function g(a: string): void;\ndeclare function g(a: number): void;\n`,
    });

    await indexFull(dir);

    expect(await dumpSymbols(dir)).toEqual(['function src/a.ts:g']);
  });

  it('leave the overloads of a function with a body as that one function', async () => {
    writeFiles(dir, {
      'src/a.ts': `export function over(a: string): void;\nexport function over(a: number): void;\nexport function over(a: unknown): void {}\n`,
    });

    await indexFull(dir);

    expect(await dumpSymbols(dir)).toEqual(['exported function src/a.ts:over']);
  });

  it('give no symbol to what a `declare module` or `declare global` block holds', async () => {
    writeFiles(dir, {
      'src/a.ts': `declare module 'x' { export function z(): void; }\ndeclare global { interface W { w: number } }\nexport function real(): void {}\n`,
    });

    await indexFull(dir);

    expect(await dumpSymbols(dir)).toEqual(['exported function src/a.ts:real']);
  });

  it('have a signature, with parameters and a return type for a function, and one for a name with overloads', () => {
    writeFiles(dir, {
      'src/a.ts': `/** Sends. */
export declare class Client { send(body: string): void; }
/** Connects. */
declare function connect(url: string): Client;
declare function connect(url: string, retries: number): Client;
`,
    });

    const signatures = extractFileSignatures(join(dir, 'src/a.ts')).map((s) => ({
      name: s.name,
      params: s.params.map((p) => p.name),
      returnType: s.returnType,
      doc: s.doc,
    }));

    expect(signatures).toEqual([
      { name: 'Client', params: [], returnType: null, doc: '/** Sends. */' },
      { name: 'Client.send', params: ['body'], returnType: 'void', doc: null },
      { name: 'connect', params: ['url'], returnType: 'Client', doc: '/** Connects. */' },
    ]);
  });

  it('take the edges any declaration takes: members, a parent, and calls from another file', async () => {
    writeFiles(dir, {
      'src/a.ts': `export declare class D { told(): void; }
export declare class E extends D { more(): void; }
export declare function h(a: number): void;
`,
      'src/b.ts': `import { D, h } from './a.js';
export function use(d: D): void { h(1); d.told(); new D(); }
`,
    });

    await expectEdges(
      dir,
      [
        'EXTENDS src/a.ts:E -> src/a.ts:D',
        'PARENT_OF src/a.ts:D -> src/a.ts:D.told',
        'PARENT_OF src/a.ts:E -> src/a.ts:E.more',
        'POTENTIAL_CALL src/b.ts:use -> src/a.ts:D',
        'POTENTIAL_CALL src/b.ts:use -> src/a.ts:D.told',
        'POTENTIAL_CALL src/b.ts:use -> src/a.ts:h',
      ],
      ['EXTENDS', 'PARENT_OF', 'POTENTIAL_CALL'],
    );
  });
});
