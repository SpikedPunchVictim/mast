import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase, type Db } from '../db.js';
import { querySymbolByName, queryVerifiedCallers } from '../queries.js';
import { populateFile, insertEdges, insertReExportFiles } from '../populate.js';
import { extractFile } from '../../ast/extract.js';

// End-to-end: the real pipeline (Phase 1 parse → symbols → two-pass edges) must
// produce POTENTIAL_CALL edges so `verified_callers` is non-empty. This is the
// regression class for C2: before the resolver was wired in, this set was
// always empty.

const HANDLER_SRC = `export function handleLogin(): void {}\n`;
const ROUTES_SRC = `import { handleLogin } from './handler';
export function registerRoutes(): void {
  handleLogin();
}
`;

describe('verified_callers — end to end', () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-callers-'));
    writeFileSync(join(tmpDir, 'handler.ts'), HANDLER_SRC);
    writeFileSync(join(tmpDir, 'routes.ts'), ROUTES_SRC);
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the importing caller for a cross-file call', async () => {
    const [target] = await querySymbolByName(db, 'handleLogin', 'handler.ts');
    expect(target).toBeDefined();

    const callers = await queryVerifiedCallers(db, target!.id, false);

    expect(callers.length).toBeGreaterThan(0);
    const caller = callers.find((c) => c.caller_symbol === 'registerRoutes');
    expect(caller).toBeDefined();
    expect(caller!.file_path).toBe('routes.ts');
    expect(caller!.resolution).toBe('import');
    expect(caller!.context).toContain('handleLogin()');
  });
});

// ---------------------------------------------------------------------------
// Q4b regression — insertEdges must not resolve POTENTIAL_CALL targets by
// bare name across the whole graph (IMPLEMENTATION_PLAN_VEXP.md §P,
// "Shipped-resolver finding", 2026-07-15; eval/spikes/checker-edges/REPORT.md
// Q4b). These tests drive `populateFile` + `insertEdges` directly (rather
// than the full `runIndex` walk) so insertion order is deterministic —
// exactly the coincidence the bug depended on.
// ---------------------------------------------------------------------------

/** Extract + populate one fixture file, in the given insertion order. */
async function populateFixture(
  db: Db,
  tmpDir: string,
  relPath: string,
): Promise<ReturnType<typeof extractFile>> {
  const result = extractFile(join(tmpDir, relPath), tmpDir, 0, 100);
  await populateFile(db, {
    filePath: relPath,
    language: result.language,
    mtime: 1_000,
    chunks: result.chunks,
    imports: result.imports,
    symbols: result.symbols,
    identifierRows: result.identifierRows,
  });
  return result;
}

describe('verified_callers — same-named symbols across files (Q4b false-green regression)', () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-q4b-'));
    mkdirSync(join(tmpDir, 'moduleA'));
    mkdirSync(join(tmpDir, 'moduleB'));
    writeFileSync(join(tmpDir, 'moduleA', 'handler.ts'), `export function handleLogin(): string { return 'A'; }\n`);
    writeFileSync(join(tmpDir, 'moduleB', 'handler.ts'), `export function handleLogin(): string { return 'B'; }\n`);
    writeFileSync(
      join(tmpDir, 'routes.ts'),
      `import { handleLogin } from './moduleB/handler';
export function registerRoutes(): void {
  handleLogin();
}
`,
    );

    db = openDatabase(tmpDir);

    // Insertion order matters: moduleA's `handleLogin` symbol is written to
    // `symbols` BEFORE moduleB's — the exact coincidence that let the
    // pre-fix resolver "pass" when the caller happened to import moduleA.
    // routes.ts imports moduleB (the SECOND-inserted file) — the direction
    // that reproduces the bug.
    const moduleA = await populateFixture(db, tmpDir, 'moduleA/handler.ts');
    const moduleB = await populateFixture(db, tmpDir, 'moduleB/handler.ts');
    const routes = await populateFixture(db, tmpDir, 'routes.ts');

    // Two-pass edge insertion (mirrors indexer/index.ts pass 2): all symbols
    // exist before any edges are written.
    await insertEdges(db, 'moduleA/handler.ts', moduleA.edges);
    await insertEdges(db, 'moduleB/handler.ts', moduleB.edges);
    await insertEdges(db, 'routes.ts', routes.edges);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('links the verified edge to the file the import actually names, not the first-inserted same-named symbol', async () => {
    const [targetA] = await querySymbolByName(db, 'handleLogin', 'moduleA/handler.ts');
    const [targetB] = await querySymbolByName(db, 'handleLogin', 'moduleB/handler.ts');
    expect(targetA).toBeDefined();
    expect(targetB).toBeDefined();

    const callersOfA = await queryVerifiedCallers(db, targetA!.id, false);
    const callersOfB = await queryVerifiedCallers(db, targetB!.id, false);

    // The import's own `resolved_path` (and, independently, the TypeScript
    // checker per the Q4b spike) both say moduleB — the edge must land there.
    expect(callersOfB.some((c) => c.caller_symbol === 'registerRoutes')).toBe(true);
    expect(callersOfA.some((c) => c.caller_symbol === 'registerRoutes')).toBe(false);
  });
});

describe('verified_callers — same_file resolution stays file-scoped', () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-samefile-'));
    // Decoy, inserted FIRST: an unrelated file that happens to declare a
    // same-named top-level function.
    writeFileSync(join(tmpDir, 'decoy.ts'), `export function bar(): string { return 'decoy'; }\n`);
    // Inserted SECOND: declares and calls its own same-named `bar` with no
    // import — a `same_file`-resolution call.
    writeFileSync(
      join(tmpDir, 'caller.ts'),
      `function bar(): string { return 'real'; }
export function foo(): void {
  bar();
}
`,
    );

    db = openDatabase(tmpDir);
    const decoy = await populateFixture(db, tmpDir, 'decoy.ts');
    const caller = await populateFixture(db, tmpDir, 'caller.ts');
    await insertEdges(db, 'decoy.ts', decoy.edges);
    await insertEdges(db, 'caller.ts', caller.edges);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a same_file call to its own file\'s declaration, not an earlier-inserted decoy', async () => {
    const [decoyBar] = await querySymbolByName(db, 'bar', 'decoy.ts');
    const [callerBar] = await querySymbolByName(db, 'bar', 'caller.ts');
    expect(decoyBar).toBeDefined();
    expect(callerBar).toBeDefined();

    const callersOfCallerBar = await queryVerifiedCallers(db, callerBar!.id, false);
    const callersOfDecoyBar = await queryVerifiedCallers(db, decoyBar!.id, false);

    expect(callersOfCallerBar.some((c) => c.caller_symbol === 'foo')).toBe(true);
    expect(callersOfDecoyBar.some((c) => c.caller_symbol === 'foo')).toBe(false);
  });
});

describe('verified_callers — barrel re-export chain', () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-barrel-chain-'));
    // Decoy, inserted FIRST: unrelated file with a same-named export.
    writeFileSync(join(tmpDir, 'decoy.ts'), `export function handleLogin(): string { return 'decoy'; }\n`);
    // The real declaration.
    writeFileSync(join(tmpDir, 'real.ts'), `export function handleLogin(): string { return 'real'; }\n`);
    // A barrel that star-re-exports the real declaration (`re_export_files`,
    // resolved file-to-file — see MAST_SPEC §6.3's `re_export_chain` CTE,
    // the precedent `resolveThroughStarChain` below mirrors).
    writeFileSync(join(tmpDir, 'barrel.ts'), `export * from './real';\n`);
    // Imports from the barrel, not from `real.ts` directly.
    writeFileSync(
      join(tmpDir, 'routes.ts'),
      `import { handleLogin } from './barrel';
export function registerRoutes(): void {
  handleLogin();
}
`,
    );

    db = openDatabase(tmpDir);
    const decoy = await populateFixture(db, tmpDir, 'decoy.ts');
    const real = await populateFixture(db, tmpDir, 'real.ts');
    const barrel = await populateFixture(db, tmpDir, 'barrel.ts');
    const routes = await populateFixture(db, tmpDir, 'routes.ts');

    await insertEdges(db, 'decoy.ts', decoy.edges);
    await insertEdges(db, 'real.ts', real.edges);
    await insertEdges(db, 'barrel.ts', barrel.edges);
    // barrel.ts's `re_export_files` row must exist before routes.ts's edge
    // resolution follows the star chain through it.
    await insertReExportFiles(db, 'barrel.ts', barrel.starReExports);
    await insertEdges(db, 'routes.ts', routes.edges);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('follows the re-export chain to the real declaration instead of the barrel marker or an earlier decoy', async () => {
    const [decoyTarget] = await querySymbolByName(db, 'handleLogin', 'decoy.ts');
    const [realTarget] = await querySymbolByName(db, 'handleLogin', 'real.ts');
    expect(decoyTarget).toBeDefined();
    expect(realTarget).toBeDefined();

    const callersOfReal = await queryVerifiedCallers(db, realTarget!.id, false);
    const callersOfDecoy = await queryVerifiedCallers(db, decoyTarget!.id, false);

    expect(callersOfReal.some((c) => c.caller_symbol === 'registerRoutes')).toBe(true);
    expect(callersOfDecoy.some((c) => c.caller_symbol === 'registerRoutes')).toBe(false);
  });
});

describe('verified_callers — ambiguity fallback (no file evidence)', () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-ambiguous-'));
    // An unrelated, indexed function that coincidentally shares a name with
    // an identifier imported from an external (unresolvable) package.
    writeFileSync(join(tmpDir, 'unrelated.ts'), `export function externalHelper(): string { return 'unrelated'; }\n`);
    writeFileSync(
      join(tmpDir, 'routes.ts'),
      `import { externalHelper } from 'some-external-package';
export function useExternal(): void {
  externalHelper();
}
`,
    );

    db = openDatabase(tmpDir);
    const unrelated = await populateFixture(db, tmpDir, 'unrelated.ts');
    const routes = await populateFixture(db, tmpDir, 'routes.ts');
    await insertEdges(db, 'unrelated.ts', unrelated.edges);
    await insertEdges(db, 'routes.ts', routes.edges);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces no verified edge for an unresolved external import, rather than linking to a same-named local symbol', async () => {
    const [unrelatedTarget] = await querySymbolByName(db, 'externalHelper', 'unrelated.ts');
    expect(unrelatedTarget).toBeDefined();

    const callers = await queryVerifiedCallers(db, unrelatedTarget!.id, false);
    expect(callers.some((c) => c.caller_symbol === 'useExternal')).toBe(false);
  });
});
