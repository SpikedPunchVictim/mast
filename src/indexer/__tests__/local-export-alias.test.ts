import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../graph/db.js';
import { querySymbolByName, queryVerifiedCallers } from '../../graph/queries.js';
import { configFor, expectEdges, indexFull, makeProject, writeFiles } from './graph-fixture.js';

// ---------------------------------------------------------------------------
// `export { a as b }` with no `from` (D124).
//
// The file gets a second row, `b`, of `a`'s kind (§10.1), so that the exported
// name can be searched for. An import of `b` means the declaration `a`: that
// is where the edge belongs, and where "who calls `a`" looks for it.
// ---------------------------------------------------------------------------

describe('a declaration exported under another name', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeProject('local-alias');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function callersOf(name: string): Promise<readonly string[]> {
    await indexFull(dir);
    const db = openDatabase(configFor(dir).resolved_state_dir);
    try {
      const [target] = await querySymbolByName(db, name);
      if (target === undefined) throw new Error(`no symbol ${name}`);
      const rows = await queryVerifiedCallers(db, [target.id], false);
      return rows.map((r) => r.caller_symbol).sort();
    } finally {
      await db.destroy();
    }
  }

  const LOC = `function a(): void {}\nexport { a as b };\n`;
  const USE = `import { b } from './loc.js';\nexport function h(): void { b(); }\n`;

  it('is called through the other name', async () => {
    writeFiles(dir, { 'src/loc.ts': LOC, 'src/z.ts': USE });

    await expectEdges(dir, ['POTENTIAL_CALL src/z.ts:h -> src/loc.ts:a']);
  });

  it('is called through the other name beside a private declaration of a third', async () => {
    writeFiles(dir, {
      'src/loc.ts': `function internalFmt(): string { return ''; }\nfunction fmt(): string { return 'p'; }\nvoid fmt;\nexport { internalFmt as fmt2 };\n`,
      'src/z.ts': `import { fmt2 } from './loc.js';\nexport function h(): void { fmt2(); }\n`,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/z.ts:h -> src/loc.ts:internalFmt']);
  });

  it('is not a private declaration that has the exported name', async () => {
    writeFiles(dir, {
      'src/loc.ts': `function a(): void {}\nfunction b(): void {}\nvoid b;\nexport { a as b };\n`,
      'src/z.ts': USE,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/z.ts:h -> src/loc.ts:a']);
  });

  it('is constructed and has its methods called through the other name', async () => {
    writeFiles(dir, {
      'src/loc.ts': `class K { m(): void {} }\nexport { K as J };\n`,
      'src/z.ts': `import { J } from './loc.js';\nexport function h(j: J): J { j.m(); return new J(); }\n`,
    });

    await expectEdges(dir, [
      'POTENTIAL_CALL src/z.ts:h -> src/loc.ts:K',
      'POTENTIAL_CALL src/z.ts:h -> src/loc.ts:K.m',
    ]);
  });

  it('is reached through an `export *` of its file', async () => {
    writeFiles(dir, {
      'src/loc.ts': LOC,
      'src/barrel.ts': `export * from './loc.js';\n`,
      'src/z.ts': `import { b } from './barrel.js';\nexport function h(): void { b(); }\n`,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/z.ts:h -> src/loc.ts:a']);
  });

  it('is reached through a re-export of the other name, renamed again', async () => {
    writeFiles(dir, {
      'src/loc.ts': LOC,
      'src/barrel.ts': `export { b as c } from './loc.js';\n`,
      'src/z.ts': `import { c } from './barrel.js';\nexport function h(): void { c(); }\n`,
    });

    await expectEdges(dir, ['POTENTIAL_CALL src/z.ts:h -> src/loc.ts:a']);
  });

  describe('asked who calls it', () => {
    beforeEach(() => {
      writeFiles(dir, { 'src/loc.ts': LOC, 'src/z.ts': USE });
    });

    it('answers under its own name', async () => {
      expect(await callersOf('a')).toEqual(['h']);
    });

    it('answers under the name it is exported as', async () => {
      expect(await callersOf('b')).toEqual(['h']);
    });
  });
});
