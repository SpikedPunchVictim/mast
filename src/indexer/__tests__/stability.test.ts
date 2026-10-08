import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractFile } from '../../ast/extract.js';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase } from '../../graph/db.js';
import { measureFreshness } from '../freshness.js';
import type { SymbolRecord } from '../../ast/types.js';
import { expectGraphEqualsFullIndex } from './graph-fixture.js';

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

  it('leaves the index reading fresh after skipping a touched-but-unchanged file (D072)', async () => {
    // The skip writes nothing, so the `files` row kept its old stamp while the
    // manifest took the new one. `measureFreshness` reads both and called the
    // file changed; `diffManifest` reads the manifest alone and never queued it
    // again, so no incremental run could clear the count.
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });
    const p = join(dir, 'm.ts');
    const future = statSync(p).mtimeMs / 1000 + 10;
    utimesSync(p, future, future);

    await runIndex(config, { incremental: true });

    const db = openDatabase(config.resolved_state_dir);
    try {
      expect((await measureFreshness(config, db)).stale).toBe(0);
    } finally {
      await db.destroy();
    }
  });

  it('an incremental run clears a row stamp that an earlier build left behind the manifest (D072)', async () => {
    // The state a pre-fix build leaves on disk: manifest and disk agree, the
    // `files` row is older. The manifest diff sees nothing to do here.
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });
    const db = openDatabase(config.resolved_state_dir);
    try {
      await db.updateTable('files').set({ mtime: 1 }).where('path', '=', 'm.ts').execute();

      await runIndex(config, { incremental: true });

      expect((await measureFreshness(config, db)).stale).toBe(0);
    } finally {
      await db.destroy();
    }
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
  // T9 (adr/proposals/incremental-graph-correctness): whatever a test here
  // leaves behind must be the graph a full index of the same tree gives.
  afterEach(async () => {
    try {
      await expectGraphEqualsFullIndex(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

// ---------------------------------------------------------------------------
// D132, D133 — statements that sit in no chunk and change no hash
// ---------------------------------------------------------------------------

/**
 * `export { foo };` thirty lines below `foo` is outside the chunk's context
 * lines, and an `export *` that resolves to nothing has no `re_export_files`
 * row. Adding or removing either changed nothing the §7.1 skip compared, so the
 * file was passed over and kept the rows of the text before the edit.
 */
describe('the stability skip does not pass over a statement outside every chunk (D132, D133)', () => {
  let dir: string;
  const FAR = '\n'.repeat(30);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-far-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function indexThenEdit(before: string, after: string): Promise<ReturnType<typeof openDatabase>> {
    writeFileSync(join(dir, 'x.ts'), before);
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });
    writeFileSync(join(dir, 'x.ts'), after);
    await runIndex(config, { incremental: true });
    return openDatabase(config.resolved_state_dir, {});
  }

  it.each([
    { edit: 'removed', before: `${FAR}export { foo };\n`, after: `${FAR}\n`, expected: 0 },
    { edit: 'added', before: `${FAR}\n`, after: `${FAR}export { foo };\n`, expected: 1 },
  ])('stores the export flag of a function whose far export list was $edit', async ({ before, after, expected }) => {
    const declaration = 'function foo(): number { return 1; }\n';

    const db = await indexThenEdit(declaration + before, declaration + after);
    const stored = await db.selectFrom('symbols').select('is_exported').where('name', '=', 'foo').execute();
    await db.destroy();

    expect(stored.map((s) => s.is_exported)).toEqual([expected]);
  });

  it('forgets an unresolved `export *` that was removed', async () => {
    const own = `${FAR}export function own(): void {}\n`;

    const db = await indexThenEdit(`export * from './missing';\n${own}`, `\n${own}`);
    const stored = await db.selectFrom('star_reexport_unresolved').select('module').execute();
    await db.destroy();

    expect(stored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D079 — a file that extracts to nothing but `export *` lines
// ---------------------------------------------------------------------------

/**
 * A barrel of `export * from` lines has no chunks, no symbols and no imports,
 * so every comparison the §7.1 skip makes is empty-against-empty and it reads
 * as unchanged. Two things followed: such a file first seen by an incremental
 * run was never written at all, and a changed re-export target was never
 * re-written.
 */
describe('the stability skip does not pass over star re-exports (D079)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-barrel-'));
    writeFileSync(join(dir, 'a.ts'), 'export function a(): number { return 1; }\n');
    writeFileSync(join(dir, 'b.ts'), 'export function b(): number { return 2; }\n');
  });
  // T9 (adr/proposals/incremental-graph-correctness): whatever a test here
  // leaves behind must be the graph a full index of the same tree gives.
  afterEach(async () => {
    try {
      await expectGraphEqualsFullIndex(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function reExportTargets(config: ReturnType<typeof resolveConfig>): Promise<string[]> {
    const db = openDatabase(config.resolved_state_dir);
    try {
      const rows = await db
        .selectFrom('re_export_files as r')
        .innerJoin('files as f', 'f.id', 'r.from_file_id')
        .innerJoin('files as t', 't.id', 'r.to_file_id')
        .select(['t.path as target'])
        .where('f.path', '=', 'index.ts')
        .execute();
      return rows.map((r) => r.target);
    } finally {
      await db.destroy();
    }
  }

  it('indexes a barrel file that an incremental run is the first to see', async () => {
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });
    writeFileSync(join(dir, 'index.ts'), "export * from './a.js';\n");

    await runIndex(config, { incremental: true });

    const db = openDatabase(config.resolved_state_dir);
    try {
      expect((await measureFreshness(config, db)).paths.unindexed).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it('follows a star re-export to its new target', async () => {
    writeFileSync(join(dir, 'index.ts'), "export * from './a.js';\n");
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });
    const p = join(dir, 'index.ts');
    writeFileSync(p, "export * from './b.js';\n");
    const future = statSync(p).mtimeMs / 1000 + 10;
    utimesSync(p, future, future);

    await runIndex(config, { incremental: true });

    expect(await reExportTargets(config)).toEqual(['b.ts']);
  });

  it('drops a star re-export that was removed', async () => {
    writeFileSync(join(dir, 'index.ts'), "export * from './a.js';\n");
    const config = resolveConfig({ projectRoot: dir });
    await runIndex(config, { incremental: false });
    const p = join(dir, 'index.ts');
    writeFileSync(p, '// nothing re-exported any more\n');
    const future = statSync(p).mtimeMs / 1000 + 10;
    utimesSync(p, future, future);

    await runIndex(config, { incremental: true });

    expect(await reExportTargets(config)).toEqual([]);
  });
});
