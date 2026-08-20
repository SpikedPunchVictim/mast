import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFile } from '../../ast/extract.js';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase } from '../../graph/db.js';
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

  it('class_shell counts field declarations as members (L3)', () => {
    // Fields (public_field_definition) are part of the shared member set, so a
    // field signature change moves the class_shell body_hash.
    const a = symbolsOf('export class S { x: number; m(): void { return; } }').get('S')!;
    const b = symbolsOf('export class S { x: string; m(): void { return; } }').get('S')!;
    expect(a.bodyHash).not.toBe(b.bodyHash);
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

// ---------------------------------------------------------------------------
// D030 — the stability skip's equivalence check must cover everything the
// write covers, not just symbols
// ---------------------------------------------------------------------------

/**
 * The §7.1 skip decides "this file need not be re-written" from chunk IDs and
 * symbol hashes alone. Neither moves when the edit lands OUTSIDE every symbol
 * body — and an `import` statement is always outside every symbol body.
 *
 * `populateFile` writes `imports` (and `insertEdges` consumes the same parse
 * result), so a skip on an import-only edit strands the import row and every
 * edge resolved through it, permanently: the file's mtime is stamped into the
 * manifest by the finalise phase whether or not it was written, so the next
 * run does not see it as stale either. Measured before the fix (D030):
 * `mast index --incremental` reported `0 indexed, 2 skipped` and `imports.module`
 * still read `./alpha.js` three edits after that path stopped existing.
 */
describe('the §7.1 skip does not fire on an edit outside every symbol body (D030)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-d030-'));
    writeFileSync(join(dir, 'alpha.ts'), 'export function alphaFunction(n: number): number { return n + 1; }\n');
    writeFileSync(
      join(dir, 'beta.ts'),
      "import { alphaFunction } from './alpha.js';\n\nexport function betaCaller(): number { return alphaFunction(41); }\n",
    );
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('re-writes a file whose only change is its import specifier', async () => {
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });

    // Move the declaration and repoint the importer. `betaCaller`'s declaration
    // and body are untouched — the whole edit is on line 1.
    mkdirSync(join(dir, 'moved'), { recursive: true });
    renameSync(join(dir, 'alpha.ts'), join(dir, 'moved', 'alpha.ts'));
    writeFileSync(
      join(dir, 'beta.ts'),
      "import { alphaFunction } from './moved/alpha.js';\n\nexport function betaCaller(): number { return alphaFunction(41); }\n",
    );

    const result = await runIndex(config, { incremental: true });

    // beta.ts (changed) + moved/alpha.ts (added) — the skip must claim neither.
    expect(result.filesIndexed).toBe(2);
  });

  it('leaves no import row pointing at a path the move deleted', async () => {
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });

    mkdirSync(join(dir, 'moved'), { recursive: true });
    renameSync(join(dir, 'alpha.ts'), join(dir, 'moved', 'alpha.ts'));
    writeFileSync(
      join(dir, 'beta.ts'),
      "import { alphaFunction } from './moved/alpha.js';\n\nexport function betaCaller(): number { return alphaFunction(41); }\n",
    );
    await runIndex(config, { incremental: true });

    const db = openDatabase(config.resolved_state_dir, {});
    const modules = await db.selectFrom('imports').select('module').execute();
    await db.destroy();

    expect(modules.map((r) => r.module)).toEqual(['./moved/alpha.js']);
  });

  /**
   * Isolates the imports check from the chunk-content check. With
   * `context_lines: 0` and the declaration far below the import, the import
   * statement falls outside every chunk — verified against `extractFile`:
   * the sole chunk spans line 32-32 and its content does not contain the
   * import line. So chunk content cannot see this edit, and only the
   * `imports` comparison can.
   */
  it('re-writes when the import moves and no chunk contains the import line', async () => {
    writeFileSync(join(dir, 'mast.config.json'), JSON.stringify({ context_lines: 0 }));
    const far = (spec: string) =>
      `import { alphaFunction } from '${spec}';\n${'\n'.repeat(30)}export function betaCaller(): number { return alphaFunction(41); }\n`;
    writeFileSync(join(dir, 'beta.ts'), far('./alpha.js'));

    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });

    mkdirSync(join(dir, 'moved'), { recursive: true });
    renameSync(join(dir, 'alpha.ts'), join(dir, 'moved', 'alpha.ts'));
    writeFileSync(join(dir, 'beta.ts'), far('./moved/alpha.js'));

    const result = await runIndex(config, { incremental: true });

    expect(result.filesIndexed).toBe(2);
  });

  /**
   * Isolates the chunk-content check. A chunk carries `context_lines` of
   * surrounding source, so an edit to a comment ABOVE a declaration changes
   * the stored chunk text while leaving chunk ids, symbol hashes and imports
   * all identical — verified against `extractFile`. `mast search` returns
   * that stored text, so skipping this write serves the pre-edit source to
   * the agent indefinitely.
   */
  it('re-writes when only a chunk\'s context lines changed', async () => {
    const withComment = (note: string) => `// ${note}\nexport function gamma(): number { return 1; }\n`;
    writeFileSync(join(dir, 'gamma.ts'), withComment('ORIGINAL note'));

    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });

    writeFileSync(join(dir, 'gamma.ts'), withComment('REWRITTEN note'));
    await runIndex(config, { incremental: true });

    const db = openDatabase(config.resolved_state_dir, {});
    const stored = await db
      .selectFrom('chunks').select('content').where('file_path', '=', 'gamma.ts').execute();
    await db.destroy();

    expect(stored.map((c) => c.content).join('')).toContain('REWRITTEN note');
  });
});
