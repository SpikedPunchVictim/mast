import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFile } from '../../ast/extract.js';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import type { SymbolRecord } from '../../ast/types.js';

// ---------------------------------------------------------------------------
// AST-derived stability hashes (M3 fix)
// ---------------------------------------------------------------------------

describe('declaration_hash / body_hash are AST-derived, not text-split', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mast-hash-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function symbolsOf(src: string): Map<string, SymbolRecord> {
    const p = join(dir, 'x.ts');
    writeFileSync(p, src);
    const { symbols } = extractFile(p, dir, 0, 100);
    return new Map(symbols.map((s) => [s.name, s]));
  }

  it('a signature change moves declaration_hash, not body_hash — even with `{` in a param type', () => {
    // The old first-`{` split would cut the declaration inside the param type,
    // misattributing a signature change to body_hash. The AST version does not.
    const a = symbolsOf('export function f(a: { x: number }): void { doStuff(); }').get('f')!;
    const b = symbolsOf('export function f(a: { x: string }): void { doStuff(); }').get('f')!;

    expect(a.declarationHash).not.toBe(b.declarationHash); // signature changed
    expect(a.bodyHash).toBe(b.bodyHash);                   // body identical
  });

  it('a body change moves body_hash, not declaration_hash', () => {
    const a = symbolsOf('export function g(n: number): number { return n; }').get('g')!;
    const b = symbolsOf('export function g(n: number): number { return n + 1; }').get('g')!;

    expect(a.declarationHash).toBe(b.declarationHash);
    expect(a.bodyHash).not.toBe(b.bodyHash);
  });

  it('class_shell body_hash is stable to method-body edits but moves on rename', () => {
    const base = symbolsOf('export class S { m(): void { return; } }').get('S')!;
    const bodyEdit = symbolsOf('export class S { m(): void { doX(); } }').get('S')!;
    const renamed = symbolsOf('export class S { n(): void { return; } }').get('S')!;

    expect(bodyEdit.bodyHash).toBe(base.bodyHash);   // member signatures unchanged
    expect(renamed.bodyHash).not.toBe(base.bodyHash); // member renamed
  });
});

// ---------------------------------------------------------------------------
// Safe file-level stability skip (M3 consumer)
// ---------------------------------------------------------------------------

describe('runIndex skips touched-but-unchanged files (§7.1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-skip-'));
    writeFileSync(join(dir, 'm.ts'), 'export function a(): number { return 1; }\n');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('re-parses but does not re-write a file whose content is identical', async () => {
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });

    // Bump mtime without changing content so the file is "stale" by mtime.
    const p = join(dir, 'm.ts');
    const future = statSync(p).mtimeMs / 1000 + 10;
    utimesSync(p, future, future);

    const result = await runIndex(config, { incremental: true });
    expect(result.filesIndexed).toBe(0);      // nothing re-written
    expect(result.filesSkipped).toBeGreaterThanOrEqual(1);
  });

  it('re-writes a file whose content actually changed', async () => {
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });

    writeFileSync(join(dir, 'm.ts'), 'export function a(): number { return 2; }\n');
    const result = await runIndex(config, { incremental: true });
    expect(result.filesIndexed).toBe(1);
  });
});
