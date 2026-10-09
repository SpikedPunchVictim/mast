import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractFileSignatures } from '../../ast/extract.js';
import { dumpSymbols, expectEdges, indexFull, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// D144 — `const f = function () {}`. A `const` holding an arrow function is a
// function to every reader of the file; one holding a function expression was
// one to none of them: no symbol, no signature, and no edge to it or from it.
// ---------------------------------------------------------------------------

describe('a variable that holds a function expression', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('function-expression');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const DECLARED = `export function leaf(): void {}
export const plain = function (): void { leaf(); };
export const named = function inner(a: number): number { leaf(); return a; };
export const later = async function (): Promise<void> { leaf(); };
export const each = function* (): Generator<number> { leaf(); yield 1; };
const kept = function (): void {};
void kept;
export const value = 1;
`;

  it.each(['ts', 'js'])('is a function symbol in a .%s file, exported when `export` is written', async (ext) => {
    const source = ext === 'ts' ? DECLARED : `export function leaf() {}\nexport const plain = function () { leaf(); };\nconst kept = function () {};\nexport const value = 1;\n`;
    writeFiles(dir, { [`src/a.${ext}`]: source });

    await indexFull(dir);

    const expected = ext === 'ts'
      ? ['each', 'later', 'leaf', 'named', 'plain'].map((n) => `exported function src/a.ts:${n}`).concat('function src/a.ts:kept')
      : ['exported function src/a.js:leaf', 'exported function src/a.js:plain', 'function src/a.js:kept'];
    expect(await dumpSymbols(dir)).toEqual(expected.sort());
  });

  it('holds the calls in its body and is the target of a call of its name', async () => {
    writeFiles(dir, {
      'src/a.ts': DECLARED,
      'src/z.ts': `import { plain, named } from './a.js';\nexport function use(): void { plain(); named(1); }\n`,
    });

    await expectEdges(dir, [
      'POTENTIAL_CALL src/a.ts:each -> src/a.ts:leaf',
      'POTENTIAL_CALL src/a.ts:later -> src/a.ts:leaf',
      'POTENTIAL_CALL src/a.ts:named -> src/a.ts:leaf',
      'POTENTIAL_CALL src/a.ts:plain -> src/a.ts:leaf',
      'POTENTIAL_CALL src/z.ts:use -> src/a.ts:named',
      'POTENTIAL_CALL src/z.ts:use -> src/a.ts:plain',
    ], ['POTENTIAL_CALL']);
  });

  it('has a signature with its parameters and return type', () => {
    writeFiles(dir, { 'src/a.ts': `/** Doubles. */\nexport const twice = function (a: number, b?: string): number { void b; return a * 2; };\n` });

    const signatures = extractFileSignatures(join(dir, 'src/a.ts')).map((s) => ({
      name: s.name,
      signature: s.signature,
      params: s.params.map((p) => p.name),
      returnType: s.returnType,
      doc: s.doc,
    }));

    expect(signatures).toEqual([
      {
        name: 'twice',
        signature: 'const twice = function (a: number, b?: string): number',
        params: ['a', 'b'],
        returnType: 'number',
        doc: '/** Doubles. */',
      },
    ]);
  });
});
