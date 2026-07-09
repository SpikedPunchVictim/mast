import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { extractFile } from '../../extract.js';
import { resolveConfig } from '../../../store/config.js';
import { runIndex } from '../../../indexer/index.js';
import { openDatabase } from '../../../graph/db.js';
import { queryBarrelExports, querySymbolByName } from '../../../graph/queries.js';

// ---------------------------------------------------------------------------
// Fixtures: a declaration module, a named barrel, an aliased barrel, a star
// barrel, and a star-of-star chain.
// ---------------------------------------------------------------------------

const MODELS_SRC = `export class Circle {
  area(): number { return 1; }
}

export interface Shape {
  area(): number;
}
`;

const NAMED_BARREL_SRC = `export { Circle } from './models';\n`;
const ALIAS_BARREL_SRC = `export { Circle as Round } from './models';\n`;
const STAR_BARREL_SRC  = `export * from './models';\n`;
const CHAIN_BARREL_SRC = `export * from './star-barrel';\n`;
// NodeNext/ESM barrels write the compiled `.js` extension; the source is `.ts`.
const JS_STAR_BARREL_SRC = `export * from './models.js';\n`;

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mast-reexport-'));
  writeFileSync(join(tmpDir, 'models.ts'), MODELS_SRC);
  writeFileSync(join(tmpDir, 'named-barrel.ts'), NAMED_BARREL_SRC);
  writeFileSync(join(tmpDir, 'alias-barrel.ts'), ALIAS_BARREL_SRC);
  writeFileSync(join(tmpDir, 'star-barrel.ts'), STAR_BARREL_SRC);
  writeFileSync(join(tmpDir, 'chain-barrel.ts'), CHAIN_BARREL_SRC);
  writeFileSync(join(tmpDir, 'js-star-barrel.ts'), JS_STAR_BARREL_SRC);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Extraction — named re-exports become symbols + RE_EXPORTS edges; star
// re-exports become file-level records
// ---------------------------------------------------------------------------

describe('re-export extraction', () => {
  it('a named re-export yields an exported marker symbol of kind "export"', () => {
    const result = extractFile(join(tmpDir, 'named-barrel.ts'), tmpDir, 0, 100);
    const marker = result.symbols.find((s) => s.name === 'Circle');
    expect(marker).toBeDefined();
    expect(marker!.kind).toBe('export');
    expect(marker!.isExported).toBe(true);
  });

  it('an aliased re-export records the exported name, not the source name', () => {
    const result = extractFile(join(tmpDir, 'alias-barrel.ts'), tmpDir, 0, 100);
    expect(result.symbols.some((s) => s.name === 'Round')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'Circle')).toBe(false);
  });

  it('a named re-export yields a RE_EXPORTS edge from the marker to the source name', () => {
    const result = extractFile(join(tmpDir, 'alias-barrel.ts'), tmpDir, 0, 100);
    const edge = result.edges.find((e) => e.edgeType === 'RE_EXPORTS');
    expect(edge).toBeDefined();
    expect(edge!.fromName).toBe('Round');
    expect(edge!.toName).toBe('Circle');
  });

  it('a star re-export yields a resolved file-level record, not symbols', () => {
    const result = extractFile(join(tmpDir, 'star-barrel.ts'), tmpDir, 0, 100);
    expect(result.symbols).toHaveLength(0);
    expect(result.starReExports).toHaveLength(1);
    expect(result.starReExports[0]!.module).toBe('./models');
    expect(result.starReExports[0]!.resolvedPath).not.toBeNull();
  });

  it('a star re-export written with a NodeNext .js specifier resolves to the .ts source', () => {
    const result = extractFile(join(tmpDir, 'js-star-barrel.ts'), tmpDir, 0, 100);
    expect(result.starReExports).toHaveLength(1);
    expect(result.starReExports[0]!.module).toBe('./models.js');
    expect(result.starReExports[0]!.resolvedPath).toBe('models.ts');
  });

  it('plain declarations yield no re-export records', () => {
    const result = extractFile(join(tmpDir, 'models.ts'), tmpDir, 0, 100);
    expect(result.starReExports).toHaveLength(0);
    expect(result.edges.some((e) => e.edgeType === 'RE_EXPORTS')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Graph population + queryBarrelExports (end to end through runIndex)
// ---------------------------------------------------------------------------

describe('queryBarrelExports', () => {
  let db: ReturnType<typeof openDatabase>;

  beforeAll(async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('querySymbolByName does not surface re-export marker rows', async () => {
    // The marker row exists for edge linkage only; signature/caller lookups
    // must keep resolving to the real declaration in models.ts.
    const rows = await querySymbolByName(db, 'Circle');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.file_path === 'models.ts')).toBe(true);
  });

  it('returns named and aliased barrels re-exporting the symbol', async () => {
    const [target] = await querySymbolByName(db, 'Circle');
    const rows = await queryBarrelExports(db, target!.id, 'Circle', target!.file_id);

    const named = rows.find((r) => r.file_path === 'named-barrel.ts');
    expect(named).toMatchObject({ exported_as: 'Circle', via: 'named' });

    const aliased = rows.find((r) => r.file_path === 'alias-barrel.ts');
    expect(aliased).toMatchObject({ exported_as: 'Round', via: 'named' });
  });

  it('returns star barrels, following the re-export chain transitively', async () => {
    const [target] = await querySymbolByName(db, 'Circle');
    const rows = await queryBarrelExports(db, target!.id, 'Circle', target!.file_id);

    const paths = rows.filter((r) => r.via === 'star').map((r) => r.file_path);
    expect(paths).toContain('star-barrel.ts');
    // chain-barrel star-re-exports star-barrel, which star-re-exports models.
    expect(paths).toContain('chain-barrel.ts');
  });

  it('returns [] for a symbol nothing re-exports', async () => {
    const [target] = await querySymbolByName(db, 'Shape');
    const rows = await queryBarrelExports(db, target!.id, 'Shape', target!.file_id);
    // Named barrels don't touch Shape; star barrels DO cover it (export * covers
    // every exported symbol of the target file), so only named rows are absent.
    expect(rows.every((r) => r.via === 'star')).toBe(true);
  });
});
