import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { expectEdges, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// A file's default export, reached by the name `default` (D148).
//
// `export { default as tool } from './x'` and `import { default as t }` name
// no declaration: `default` is what the export is called, and the declaration
// behind it has a name of its own. The row is found by a flag, not by a name.
// ---------------------------------------------------------------------------

const TYPES = ['POTENTIAL_CALL', 'RE_EXPORTS'] as const;

describe('a default export reached by the name `default`', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('default-export');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const USE = `import { tool } from './barrel.js';\nexport function use(): void { tool(); }\n`;
  const BARREL = `export { default as tool } from './x.js';\n`;

  it('is the declaration written after `export default`, not one that has the new name', async () => {
    writeFiles(dir, {
      'src/x.ts': `export default function main(): void {}\nexport function tool(): void {}\n`,
      'src/barrel.ts': BARREL,
      'src/z.ts': USE,
    });

    await expectEdges(dir, [
      'POTENTIAL_CALL src/z.ts:use -> src/x.ts:main',
      'RE_EXPORTS src/barrel.ts:tool -> src/x.ts:main',
    ], TYPES);
  });

  it('is the declaration an `export default name;` names', async () => {
    writeFiles(dir, {
      'src/x.ts': `function main(): void {}\nexport default main;\n`,
      'src/barrel.ts': BARREL,
      'src/z.ts': USE,
    });

    await expectEdges(dir, [
      'POTENTIAL_CALL src/z.ts:use -> src/x.ts:main',
      'RE_EXPORTS src/barrel.ts:tool -> src/x.ts:main',
    ], TYPES);
  });

  it('is the declaration an `export { name as default }` names', async () => {
    writeFiles(dir, {
      'src/x.ts': `function main(): void {}\nexport { main as default };\n`,
      'src/barrel.ts': BARREL,
      'src/z.ts': USE,
    });

    await expectEdges(dir, [
      'POTENTIAL_CALL src/z.ts:use -> src/x.ts:main',
      'RE_EXPORTS src/barrel.ts:tool -> src/x.ts:main',
    ], TYPES);
  });

  it('is found through a barrel that passes it on as `default`', async () => {
    writeFiles(dir, {
      'src/x.ts': `export default function main(): void {}\n`,
      'src/barrel.ts': `export { default } from './x.js';\n`,
      'src/z.ts': `import { default as t } from './barrel.js';\nexport function use(): void { t(); }\n`,
    });

    await expectEdges(dir, [
      'POTENTIAL_CALL src/z.ts:use -> src/x.ts:main',
      'RE_EXPORTS src/barrel.ts:default -> src/x.ts:main',
    ], TYPES);
  });

  it('is found by an import of `default` under another name', async () => {
    writeFiles(dir, {
      'src/x.ts': `export default function main(): void {}\n`,
      'src/z.ts': `import { default as t } from './x.js';\nexport function use(): void { t(); }\n`,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/z.ts:use -> src/x.ts:main'], TYPES);
  });

  it('gives a class whose methods are called through the new name', async () => {
    writeFiles(dir, {
      'src/x.ts': `export default class K { m(): void {} }\n`,
      'src/barrel.ts': `export { default as J } from './x.js';\n`,
      'src/z.ts': `import { J } from './barrel.js';\nexport function use(j: J): J { j.m(); return new J(); }\n`,
    });

    await expectEdges(dir, [
      'POTENTIAL_CALL src/z.ts:use -> src/x.ts:K',
      'POTENTIAL_CALL src/z.ts:use -> src/x.ts:K.m',
      'RE_EXPORTS src/barrel.ts:J -> src/x.ts:K',
    ], TYPES);
  });

  it('is not passed on by an `export *`', async () => {
    writeFiles(dir, {
      'src/x.ts': `export default function main(): void {}\n`,
      'src/star.ts': `export * from './x.js';\n`,
      'src/barrel.ts': `export { default as tool } from './star.js';\n`,
      'src/z.ts': USE,
    });

    await expectEdges(dir, [], TYPES);
  });

  it('gives no edge when what is exported is not a declaration', async () => {
    writeFiles(dir, {
      'src/x.ts': `export function tool(): void {}\nexport default { tool };\n`,
      'src/barrel.ts': BARREL,
      'src/z.ts': USE,
    });

    await expectEdges(dir, [], TYPES);
  });

  // D130. `import main from './x'` binds the default export under a name the
  // importer chooses, which need not be the declaration's.
  describe('imported with `import name from`', () => {
    it('is called under the name the importer gives it, not a declaration of that name', async () => {
      writeFiles(dir, {
        'src/x.ts': `export default function main(): void {}\nexport function tool(): void {}\n`,
        'src/z.ts': `import tool from './x.js';\nexport function use(): void { tool(); }\n`,
      });

      await expectEdges(dir, ['POTENTIAL_CALL src/z.ts:use -> src/x.ts:main'], TYPES);
    });

    it('is a class that is constructed, has its methods called and is extended', async () => {
      writeFiles(dir, {
        'src/x.ts': `export default class K { m(): void {} }\n`,
        'src/z.ts': `import Base, { type Other } from './x.js';\nexport class Sub extends Base {}\nexport function use(k: Base, s: Sub): Base { k.m(); s.m(); return new Base(); }\n`,
      });

      await expectEdges(
        dir,
        [
          'EXTENDS src/z.ts:Sub -> src/x.ts:K',
          'POTENTIAL_CALL src/z.ts:use -> src/x.ts:K',
          'POTENTIAL_CALL src/z.ts:use -> src/x.ts:K.m',
        ],
        ['POTENTIAL_CALL', 'EXTENDS'],
      );
    });

    it('is found through a barrel that passes the default on', async () => {
      writeFiles(dir, {
        'src/x.ts': `function main(): void {}\nexport default main;\n`,
        'src/barrel.ts': `export { default } from './x.js';\n`,
        'src/z.ts': `import go from './barrel.js';\nexport function use(): void { go(); }\n`,
      });

      await expectEdges(dir, ['POTENTIAL_CALL src/z.ts:use -> src/x.ts:main'], ['POTENTIAL_CALL']);
    });

    it('gives no edge when the default export is not a declaration', async () => {
      writeFiles(dir, {
        'src/x.ts': `export function tool(): void {}\nexport default tool();\n`,
        'src/z.ts': `import tool from './x.js';\nexport function use(): void { tool(); }\n`,
      });

      await expectEdges(dir, [], ['POTENTIAL_CALL']);
    });

    it('is hidden by a local declaration of the name', async () => {
      writeFiles(dir, {
        'src/x.ts': `export default function main(): void {}\n`,
        'src/z.ts': `import go from './x.js';\nexport function use(): void { const go = (): void => {}; go(); }\n`,
      });

      await expectEdges(dir, [], ['POTENTIAL_CALL']);
    });
  });
});
