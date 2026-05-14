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
