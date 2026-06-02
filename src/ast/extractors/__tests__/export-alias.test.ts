import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFile, extractFileSignatures } from '../../extract.js';

const SRC = `function internalHandle(): number { return 1; }
export { internalHandle as handleLogin };
`;

describe('export { foo as bar } aliases (L4)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-alias-'));
    file = join(dir, 'h.ts');
    writeFileSync(file, SRC);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records the alias as an exported symbol; the local name is not exported as itself', () => {
    const { chunks } = extractFile(file, dir, 0, 100);

    const alias = chunks.find((c) => c.symbol_name === 'handleLogin');
    expect(alias).toBeDefined();
    expect(alias!.is_exported).toBe(true);

    // `internalHandle` is exported only under the name `handleLogin`, so the
    // local declaration itself is not an export.
    const local = chunks.find((c) => c.symbol_name === 'internalHandle');
    expect(local?.is_exported).toBe(false);
  });

  it('exposes the underlying declaration signature under the alias name', () => {
    const sigs = extractFileSignatures(file);
    const alias = sigs.find((s) => s.name === 'handleLogin');
    expect(alias).toBeDefined();
    expect(alias!.signature).toContain('internalHandle');
    expect(alias!.returnType).toBe('number');
  });
});
