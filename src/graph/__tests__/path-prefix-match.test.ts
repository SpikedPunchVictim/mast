/**
 * Path-prefix matching must be literal, case-sensitive, and index-seekable.
 *
 * Four call sites resolve a file by "path starts with P": the import-case
 * resolver (`populate.ts` `resolveInFileOrReExportChain`), the star re-export
 * second pass (`insertReExportFiles`), the type-context import probe
 * (`queries.ts` `resolveTypeContext`), and the skeleton directory filter
 * (`queryProjectSkeleton`). All four expressed it as `path LIKE P || '%'`,
 * which is wrong in two independent ways:
 *
 *  1. **`_` and `%` in P are wildcards.** A path is not escaped before
 *     interpolation, so `src/my_util.ts` matches `src/my.util.ts` — and since
 *     `.` (0x2E) sorts before `_` (0x5F), `ORDER BY path` hands back the
 *     WRONG FILE. Snake_case is ubiquitous; this is not a corner case.
 *  2. **LIKE is case-insensitive for ASCII by default.** `case_sensitive_like`
 *     is OFF, so `src/Foo.ts` matches `src/FOO.ts`, and `FOO` sorts first.
 *
 * Both bind an edge to a file the import never named. That is a correctness
 * bug, not a performance one — these rows feed `verified_callers`, which the
 * tool documents as safe to act on without re-derivation.
 *
 * The performance defect rides along: because `files.path`'s implicit UNIQUE
 * index is BINARY-collated and `case_sensitive_like` is OFF, SQLite cannot
 * apply the LIKE optimization, so the plan is `SCAN files USING COVERING
 * INDEX` — the only scan among the resolver's five lookups, measured on the
 * 152,969-chunk vscode corpus (FINDINGS.md §2.3).
 *
 * The fix is a half-open range, `path >= P AND path < P||U+10FFFF`, which is
 * literal, case-sensitive, and seekable. These tests pin the semantics; the
 * plan change is verified separately by the T8/T9 build comparison.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Db } from '../db.js';
import { populateFile, insertEdges, insertReExportFiles } from '../populate.js';
import type { FileIndexData } from '../populate.js';
import { resolveTypeContext, queryProjectSkeleton, querySymbolByName, queryVerifiedCallers } from '../queries.js';
import { pathPrefixUpperBound } from '../path-range.js';
import type { Chunk, SymbolRecord, ImportRecord, EdgeRecord } from '../../ast/types.js';
import type { IdentifierRow, StarReExportRecord } from '../../ast/extractor.js';

/**
 * A minimal indexed file declaring exactly the given top-level symbols.
 *
 * Synthetic rather than written to disk on purpose: macOS APFS is
 * case-insensitive, so the `FOO.ts` / `Foo.ts` pair below cannot exist as real
 * files on the machine this suite usually runs on. Driving the DB layer
 * directly is also what makes insertion order deterministic.
 */
function fileData(
  filePath: string,
  symbolNames: readonly string[],
  imports: readonly ImportRecord[] = [],
): Omit<FileIndexData, 'edges'> {
  const chunks: Chunk[] = symbolNames.map((name, i) => ({
    chunk_id: `${filePath}:${i}`,
    file_path: filePath,
    start_line: i * 2 + 1,
    end_line: i * 2 + 2,
    content: `export function ${name}(): string { return '${filePath}'; }`,
    chunk_type: 'function' as const,
    symbol_name: name,
    parent_symbol: null,
    is_exported: true,
    language: 'typescript' as const,
    file_mtime: 1_700_000_000,
  }));
  const symbols: SymbolRecord[] = symbolNames.map((name, i) => ({
    name,
    kind: 'function',
    line: i * 2 + 1,
    isExported: true,
    declarationHash: null,
    bodyHash: null,
  }));
  const identifierRows: IdentifierRow[] = symbolNames.map((name, i) => ({
    chunk_id: `${filePath}:${i}`,
    identifiers: name,
  }));
  return {
    filePath,
    language: 'typescript',
    mtime: 1_700_000_000,
    chunks,
    imports,
    symbols,
    identifierRows,
  };
}

const star = (resolvedPath: string): StarReExportRecord => ({
  module: './whatever',
  resolvedPath,
  line: 1,
});

describe('path-prefix matching is literal and case-sensitive', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mast-prefix-'));
    db = openDatabase(dir);
  });

  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  // --- site 1: populate.ts resolveInFileOrReExportChain (the import case) ---

  it('binds a call edge to the imported file, not a path where `_` matched a dot', async () => {
    // `src/my.util.ts` sorts BEFORE `src/my_util.ts` (0x2E < 0x5F) and is
    // matched by the pattern `src/my_util.ts%` via the `_` wildcard, so the
    // pre-fix resolver returned it first.
    await populateFile(db, fileData('src/my.util.ts', ['helper']));
    await populateFile(db, fileData('src/my_util.ts', ['helper']));

    const callerImports: ImportRecord[] = [
      { module: './my_util', symbols: ['helper'], isExternal: false, resolvedPath: 'src/my_util.ts' },
    ];
    await populateFile(db, fileData('src/caller.ts', ['run'], callerImports));

    const edges: EdgeRecord[] = [
      { fromName: 'run', toName: 'helper', edgeType: 'POTENTIAL_CALL', resolution: 'import', callLine: 1, context: 'helper()' },
    ];
    await insertEdges(db, 'src/caller.ts', edges);

    const [wrong] = await querySymbolByName(db, 'helper', 'src/my.util.ts');
    const [right] = await querySymbolByName(db, 'helper', 'src/my_util.ts');
    expect(wrong).toBeDefined();
    expect(right).toBeDefined();

    const callersOfWrong = await queryVerifiedCallers(db, wrong!.id, false);
    const callersOfRight = await queryVerifiedCallers(db, right!.id, false);

    expect(callersOfRight.some((c) => c.caller_symbol === 'run')).toBe(true);
    expect(callersOfWrong.some((c) => c.caller_symbol === 'run')).toBe(false);
  });

  // --- site 2: populate.ts insertReExportFiles (the star re-export pass) ---

  it('links a star re-export to the resolved target, not a case-differing sibling', async () => {
    // LIKE is case-insensitive for ASCII, and `FOO` (0x46 0x4F 0x4F) sorts
    // before `Foo` (0x46 0x6F 0x6F), so the pre-fix query preferred `FOO.ts`.
    await populateFile(db, fileData('src/FOO.ts', ['a']));
    await populateFile(db, fileData('src/Foo.ts', ['a']));
    await populateFile(db, fileData('src/barrel.ts', ['b']));

    await insertReExportFiles(db, 'src/barrel.ts', [star('src/Foo.ts')]);

    const links = await db
      .selectFrom('re_export_files as r')
      .innerJoin('files as f', 'f.id', 'r.to_file_id')
      .select('f.path')
      .execute();

    expect(links.map((l) => l.path)).toEqual(['src/Foo.ts']);
  });

  // The extension-less prefix match is load-bearing here and must survive:
  // `resolvedPath` may name `src/x` for a target indexed as `src/x/index.ts`.
  it('still resolves an extension-less star re-export target by prefix', async () => {
    await populateFile(db, fileData('src/x/index.ts', ['a']));
    await populateFile(db, fileData('src/barrel.ts', ['b']));

    await insertReExportFiles(db, 'src/barrel.ts', [star('src/x')]);

    const links = await db
      .selectFrom('re_export_files as r')
      .innerJoin('files as f', 'f.id', 'r.to_file_id')
      .select('f.path')
      .execute();

    expect(links.map((l) => l.path)).toEqual(['src/x/index.ts']);
  });

  // --- site 3: queries.ts resolveTypeContext (the import probe) ---

  it('resolves an imported type from the imported file, not a `_`-matched sibling', async () => {
    await populateFile(db, fileData('src/my.types.ts', ['Widget']));
    await populateFile(db, fileData('src/my_types.ts', ['Widget']));

    const imports: ImportRecord[] = [
      { module: './my_types', symbols: ['Widget'], isExternal: false, resolvedPath: 'src/my_types.ts' },
    ];
    await populateFile(db, fileData('src/consumer.ts', ['use'], imports));

    const entries = await resolveTypeContext(db, ['Widget'], 'src/consumer.ts');

    expect(entries).toHaveLength(1);
    expect(entries[0]!.file_path).toBe('src/my_types.ts');
  });

  // --- site 4: queries.ts queryProjectSkeleton (the directory filter) ---

  it('does not let a `_` in a directory filter match an arbitrary character', async () => {
    await populateFile(db, fileData('src/my_pkg/a.ts', ['inPkg']));
    await populateFile(db, fileData('src/my-pkg/b.ts', ['inOther']));

    const rows = await queryProjectSkeleton(db, 'src/my_pkg');

    expect(rows.map((r) => r.symbol_name)).toEqual(['inPkg']);
  });

  it('treats a `%` in a directory filter as a literal, not a match-everything', async () => {
    await populateFile(db, fileData('src/a.ts', ['plain']));

    const rows = await queryProjectSkeleton(db, '%');

    expect(rows).toEqual([]);
  });

  // The bound must be U+10FFFF, not U+FFFF. Narrowing it to the BMP is the
  // tempting "simplification", and it silently drops any path whose next
  // character is astral — emoji and CJK-extension filenames both qualify.
  it('keeps matching paths whose next character is outside the BMP', async () => {
    await populateFile(db, fileData('src/dir/🚀.ts', ['rocket']));

    const rows = await queryProjectSkeleton(db, 'src/dir/');

    expect(rows.map((r) => r.symbol_name)).toEqual(['rocket']);
  });
});

describe('pathPrefixUpperBound', () => {
  /**
   * SQLite's BINARY collation is `memcmp` over UTF-8, which is NOT the order
   * JavaScript's `<` gives — JS compares UTF-16 code units, under which
   * U+FFFF (0xFFFF) sorts ABOVE the surrogate pair for U+10FFFF (0xDBFF
   * 0xDFFF). Comparing with `<` here would assert the wrong contract and fail
   * on a bound that is in fact correct. Compare the UTF-8 bytes instead.
   */
  const utf8Lt = (a: string, b: string): boolean =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')) < 0;

  it('is strictly greater than the prefix followed by any real character', () => {
    const bound = pathPrefixUpperBound('src/a');

    for (const next of ['', '/', '.', '_', 'z', '~', '\u{FFFF}', '\u{1F680}', '\u{10FFFE}']) {
      expect(utf8Lt(`src/a${next}`, bound)).toBe(true);
    }
  });

  it('excludes the sibling that merely shares a shorter prefix', () => {
    expect(utf8Lt('src/b', pathPrefixUpperBound('src/a'))).toBe(false);
  });
});
