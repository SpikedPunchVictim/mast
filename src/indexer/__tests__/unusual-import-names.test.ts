import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractFile } from '../../ast/extract.js';
import { resolveTypeContext } from '../../graph/queries.js';
import { openDatabase } from '../../graph/db.js';
import { configFor, dumpSymbols, expectEdges, indexFull, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// D139 — names a style guide would not allow. An import's local name was a key
// of a plain object, so `__proto__` set the object's prototype and was lost; a
// name written as a string kept its quotes and matched no export; and a
// rename in `const { a: b } = await import()` was not stored.
// ---------------------------------------------------------------------------

describe('import and export names that are not plain identifiers', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('unusual-names');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const importsOf = (relativePath: string): readonly { symbols: readonly string[]; aliases?: Readonly<Record<string, string>> }[] =>
    extractFile(join(dir, relativePath), dir, 0, 100).imports.map(({ symbols, aliases }) =>
      aliases === undefined ? { symbols } : { symbols, aliases: { ...aliases } },
    );

  it.each([
    ['a named import', `import { Shape as __proto__ } from './lib.js';\n`, 'Shape'],
    ['a default import', `import __proto__ from './lib.js';\n`, 'default'],
  ])('keeps the local name `__proto__` of %s', (_form, source, exported) => {
    writeFiles(dir, { 'src/use.ts': source });

    const [row] = importsOf('src/use.ts');

    expect(Object.entries(row?.aliases ?? {})).toEqual([['__proto__', exported]]);
  });

  it('gives a parameter typed by an import named `__proto__` its type context', async () => {
    writeFiles(dir, {
      'src/lib.ts': `export interface Shape { real: true }\n`,
      'src/use.ts': `import { Shape as __proto__ } from './lib.js';\nexport function p(a: __proto__): void { void a; }\n`,
    });
    await indexFull(dir);
    const db = openDatabase(configFor(dir).resolved_state_dir);

    const result = await resolveTypeContext(db, ['__proto__'], 'src/use.ts');
    await db.destroy();

    expect(result.map((entry) => [entry.name, entry.file_path])).toEqual([['__proto__', 'src/lib.ts']]);
  });

  it('stores a name written as a string without its quotes', () => {
    writeFiles(dir, { 'src/use.ts': `import { "string name" as sn, 'other' as o } from './lib.js';\n` });

    expect(importsOf('src/use.ts')).toEqual([
      { symbols: ['string name', 'other'], aliases: { sn: 'string name', o: 'other' } },
    ]);
  });

  it('names an alias written as a string without its quotes', async () => {
    writeFiles(dir, {
      'src/lib.ts': `export function run(): void {}\nfunction local(): void {}\nexport { local as "string name" };\n`,
      'src/barrel.ts': `export { run as "other name" } from './lib.js';\n`,
    });

    await indexFull(dir);

    expect(await dumpSymbols(dir)).toEqual([
      'exported export src/barrel.ts:other name',
      'exported function src/lib.ts:run',
      'exported function src/lib.ts:string name',
      'function src/lib.ts:local',
    ]);
  });

  it('links a call through names written as strings to the declarations', async () => {
    writeFiles(dir, {
      'src/lib.ts': `export function run(): void {}\nfunction local(): void {}\nexport { local as "string name" };\n`,
      'src/barrel.ts': `export { run as "other name" } from './lib.js';\n`,
      // Quoted the other way than the export is: with the quotes kept as part
      // of the name the two matched only when written alike.
      'src/use.ts': `import { 'string name' as sn } from './lib.js';\nimport { 'other name' as on } from './barrel.js';\nexport function use(): void { sn(); on(); }\n`,
    });

    await expectEdges(dir, [
      'POTENTIAL_CALL src/use.ts:use -> src/lib.ts:local',
      'POTENTIAL_CALL src/use.ts:use -> src/lib.ts:run',
    ], ['POTENTIAL_CALL']);
  });

  it('stores the rename of a name destructured from a dynamic import', () => {
    writeFiles(dir, {
      'src/use.ts': `export async function d(): Promise<void> {\n  const { Shape: Q, run, other: __proto__ } = await import('./lib.js');\n  void Q; void run; void __proto__;\n}\n`,
    });

    const [row] = importsOf('src/use.ts');

    expect(row?.symbols).toEqual(['Shape', 'run', 'other']);
    expect(Object.entries(row?.aliases ?? {})).toEqual([['Q', 'Shape'], ['__proto__', 'other']]);
  });
});
