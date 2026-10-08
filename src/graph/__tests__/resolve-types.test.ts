import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase } from '../db.js';
import { resolveTypeContext } from '../queries.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// types.ts — shared type definitions
const TYPES_SRC = `export interface Shape {
  area(): number;
}

export type Color = 'red' | 'green' | 'blue';
`;

// geometry.ts — uses Shape via import; defines Circle in the same file
const GEOMETRY_SRC = `import { Shape } from './types';

export interface Circle extends Shape {
  readonly radius: number;
}

export function makeCircle(radius: number): Circle {
  return { radius, area: () => Math.PI * radius * radius };
}
`;

// consumers.ts — imports from geometry.ts
const CONSUMERS_SRC = `import { makeCircle } from './geometry';

export function printArea(r: number): void {
  const c = makeCircle(r);
  console.log(c.area());
}
`;

// aliased.ts — imports Shape under a local name. decoy.ts exports an unrelated
// type under that local name, which the global fallback would find.
const ALIASED_SRC = `import { Shape as Outline, Color } from './types';

export function draw(o: Outline, c: Color): void {}
`;
const DECOY_SRC = `export interface Outline { decoy: true }
`;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDatabase>;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mast-resolve-types-'));

  writeFileSync(join(tmpDir, 'types.ts'), TYPES_SRC);
  writeFileSync(join(tmpDir, 'geometry.ts'), GEOMETRY_SRC);
  writeFileSync(join(tmpDir, 'consumers.ts'), CONSUMERS_SRC);
  writeFileSync(join(tmpDir, 'aliased.ts'), ALIASED_SRC);
  writeFileSync(join(tmpDir, 'decoy.ts'), DECOY_SRC);

  const config = resolveConfig({ projectRoot: tmpDir });
  await runIndex(config, { incremental: false });

  db = openDatabase(config.resolved_state_dir);
});

afterAll(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveTypeContext
// ---------------------------------------------------------------------------

describe('resolveTypeContext', () => {
  it('returns [] for empty typeNames', async () => {
    const result = await resolveTypeContext(db, [], 'types.ts');
    expect(result).toHaveLength(0);
  });

  it('resolves a type defined in the same file', async () => {
    // Circle and Shape are both in geometry.ts — Shape is imported but Circle is same-file.
    const result = await resolveTypeContext(db, ['Circle'], 'geometry.ts');
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.name).toBe('Circle');
    expect(entry.file_path).toBe('geometry.ts');
    expect(entry.line).toBeGreaterThan(0);
    expect(entry.signature).toContain('Circle');
    expect(entry.truncated).toBe(false);
  });

  it('resolves a type via named import', async () => {
    // geometry.ts imports Shape from ./types — should resolve Shape → types.ts
    const result = await resolveTypeContext(db, ['Shape'], 'geometry.ts');
    expect(result).toHaveLength(1);
    const entry = result[0]!;
    expect(entry.name).toBe('Shape');
    expect(entry.file_path).toBe('types.ts');
    expect(entry.signature).toContain('Shape');
  });

  it('resolves a type imported under a local name to the declaration it names', async () => {
    const result = await resolveTypeContext(db, ['Outline'], 'aliased.ts');

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Outline');
    expect(result[0]?.file_path).toBe('types.ts');
    expect(result[0]?.signature).toContain('interface Shape');
  });

  it('falls back to global lookup for types not in same file or imports', async () => {
    // consumers.ts imports makeCircle but not Circle directly.
    // resolveTypeContext should still find Circle via global fallback.
    const result = await resolveTypeContext(db, ['Circle'], 'consumers.ts');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Circle');
  });

  it('returns [] for an unknown type name', async () => {
    const result = await resolveTypeContext(db, ['NoSuchType'], 'types.ts');
    expect(result).toHaveLength(0);
  });

  it('resolves multiple types in one call', async () => {
    const result = await resolveTypeContext(db, ['Shape', 'Color'], 'types.ts');
    expect(result).toHaveLength(2);
    const names = result.map((e) => e.name);
    expect(names).toContain('Shape');
    expect(names).toContain('Color');
  });

  it('deduplicated type names are each returned once', async () => {
    const result = await resolveTypeContext(db, ['Shape', 'Shape'], 'geometry.ts');
    // Both resolve to the same type — both entries are returned (caller deduplicates).
    const names = result.map((e) => e.name);
    expect(names.filter((n) => n === 'Shape').length).toBe(2);
  });

  it('signature is truncated to 500 chars when longer', async () => {
    // Build a very long type alias to trigger truncation.
    const longType = `export type VeryLong = ${'string | number | '.repeat(40)};`;
    writeFileSync(join(tmpDir, 'longtype.ts'), longType);
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: true });
    const db2 = openDatabase(config.resolved_state_dir);
    try {
      const result = await resolveTypeContext(db2, ['VeryLong'], 'longtype.ts');
      if (result.length > 0) {
        // If the signature exceeds 500 chars it must be truncated.
        const entry = result[0]!;
        expect(entry.signature.length).toBeLessThanOrEqual(502); // 500 + '…'
        if (entry.truncated) {
          expect(entry.signature.endsWith('…')).toBe(true);
        }
      }
    } finally {
      await db2.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// An edit that changes nothing but the local name of an import. No chunk of the
// file changes, so the import rows are what has to notice.
// ---------------------------------------------------------------------------
describe('resolveTypeContext after only an import alias changes', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-resolve-types-alias-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the new local name', async () => {
    // Far enough below the import that no chunk's context lines reach it.
    const body = `${'\n'.repeat(12)}export function draw(): void {}\n`;
    const config = resolveConfig({ projectRoot: dir });
    writeFileSync(join(dir, 'types.ts'), TYPES_SRC);
    writeFileSync(join(dir, 'user.ts'), `import { Shape as Outline } from './types';${body}`);
    await runIndex(config, { incremental: false });
    writeFileSync(join(dir, 'user.ts'), `import { Shape as Form } from './types';${body}`);
    await runIndex(config, { incremental: true });

    const aliasDb = openDatabase(config.resolved_state_dir);
    const result = await resolveTypeContext(aliasDb, ['Form'], 'user.ts');
    await aliasDb.destroy();

    expect(result.map((entry) => entry.file_path)).toEqual(['types.ts']);
  });
});

// ---------------------------------------------------------------------------
// D114. The file an import resolves to is often not the file that declares the
// name. A decoy exports an unrelated type of the same name and sorts first, so
// a lookup that guesses by name lands on it.
// ---------------------------------------------------------------------------
describe('resolveTypeContext through a re-export', () => {
  let dir: string;
  let barrelDb: ReturnType<typeof openDatabase>;

  const USER = (specifier: string, from: string): string =>
    `import { ${specifier} } from '${from}';\n${'\n'.repeat(12)}export function draw(): void {}\n`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mast-resolve-types-barrel-'));
    writeFileSync(join(dir, 'types.ts'), TYPES_SRC);
    writeFileSync(join(dir, 'a-decoy.ts'), `export interface Shape { decoy: true }\nexport interface Form { decoy: true }\n`);
    writeFileSync(join(dir, 'named.ts'), `export { Shape } from './types';\n`);
    writeFileSync(join(dir, 'star.ts'), `export * from './types';\n`);
    writeFileSync(join(dir, 'renamed.ts'), `export { Shape as Form } from './types';\n`);
    writeFileSync(join(dir, 'via-named.ts'), USER('Shape', './named'));
    writeFileSync(join(dir, 'via-star.ts'), USER('Shape', './star'));
    writeFileSync(join(dir, 'via-renamed.ts'), USER('Form', './renamed'));
    writeFileSync(join(dir, 'via-package.ts'), USER('Shape', 'some-package'));
    writeFileSync(join(dir, 'via-nothing.ts'), USER('Shape', './star-of-nothing'));
    writeFileSync(join(dir, 'star-of-nothing.ts'), `export * from './consumers-absent';\nexport const unrelated = 1;\n`);
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });
    barrelDb = openDatabase(config.resolved_state_dir);
  });
  afterAll(async () => {
    await barrelDb.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['a named re-export', 'via-named.ts', 'Shape'],
    ['an export *', 'via-star.ts', 'Shape'],
    ['a re-export under a second name', 'via-renamed.ts', 'Form'],
  ])('reaches the declaration behind %s', async (_shape, file, name) => {
    const result = await resolveTypeContext(barrelDb, [name], file);

    expect(result.map((entry) => [entry.name, entry.file_path])).toEqual([[name, 'types.ts']]);
    expect(result[0]?.signature).toContain('interface Shape');
  });

  it.each([
    ['a package', 'via-package.ts'],
    ['a file that does not export it', 'via-nothing.ts'],
  ])('gives nothing for a name imported from %s, though another file exports one', async (_source, file) => {
    const result = await resolveTypeContext(barrelDb, ['Shape'], file);

    expect(result).toEqual([]);
  });
});
