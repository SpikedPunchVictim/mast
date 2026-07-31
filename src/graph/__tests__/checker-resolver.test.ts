import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveConfig } from '../../store/config.js';
import { runIndex } from '../../indexer/index.js';
import { openDatabase, type Db } from '../db.js';
import { SqliteChunkStore } from '../../store/sqliteChunkStore.js';
import { querySymbolByName, queryVerifiedCallers, queryCheckerVerdicts } from '../queries.js';
import { populateFile } from '../populate.js';
import { extractFile } from '../../ast/extract.js';
import {
  discoverTsConfigProjects,
  RealTsProjectResolver,
  runCheckerPass,
  type TsProjectDescriptor,
  type TsProjectHandle,
  type TsProjectResolver,
  type TsProjectDiscoveryResult,
  type CallSiteClassification,
} from '../checker-resolver.js';

// ---------------------------------------------------------------------------
// Shared minimal compiler options for tests that build a `ts.Program`
// directly (skipping tsconfig.json discovery, which is tested separately
// below) — matches the workspace's own tsconfig (NodeNext, ES2022).
// ---------------------------------------------------------------------------

const MINIMAL_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  strict: true,
};

function project(root: string, relFiles: readonly string[]): TsProjectDescriptor {
  return {
    configDir: '.',
    fileNames: relFiles.map((f) => join(root, f)),
    compilerOptions: MINIMAL_OPTIONS,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discoverTsConfigProjects', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-discovery-'));

    // A real, standalone project.
    mkdirSync(join(tmpDir, 'app'));
    writeFileSync(join(tmpDir, 'app', 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext' }, include: ['**/*.ts'] }));
    writeFileSync(join(tmpDir, 'app', 'index.ts'), 'export const x = 1;\n');

    // A base config with no "include"/"files" of its own — meant to be extended.
    mkdirSync(join(tmpDir, 'base'));
    writeFileSync(join(tmpDir, 'base', 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext' } }));

    // A config that fails to parse (invalid JSON).
    mkdirSync(join(tmpDir, 'broken'));
    writeFileSync(join(tmpDir, 'broken', 'tsconfig.json'), '{ this is not json');

    // node_modules noise — must never be visited.
    mkdirSync(join(tmpDir, 'node_modules', 'some-dep'), { recursive: true });
    writeFileSync(join(tmpDir, 'node_modules', 'some-dep', 'tsconfig.json'), JSON.stringify({ include: ['**/*.ts'] }));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers a real project with resolved file names', () => {
    const { projects } = discoverTsConfigProjects(tmpDir);
    const app = projects.find((p) => p.configDir === 'app');
    expect(app).toBeDefined();
    expect(app!.fileNames.some((f) => f.endsWith('index.ts'))).toBe(true);
  });

  it('skips a base config with no own "include" as no_include_base_config', () => {
    const { skipped } = discoverTsConfigProjects(tmpDir);
    const base = skipped.find((s) => s.configDir === 'base');
    expect(base).toBeDefined();
    expect(base!.reason).toBe('no_include_base_config');
  });

  it('skips an unparseable tsconfig with its error text, not a crash', () => {
    const { skipped } = discoverTsConfigProjects(tmpDir);
    const broken = skipped.find((s) => s.configDir === 'broken');
    expect(broken).toBeDefined();
    expect(broken!.reason).toContain('tsconfig_parse_error');
  });

  it('never visits node_modules', () => {
    const { projects, skipped } = discoverTsConfigProjects(tmpDir);
    const all = [...projects.map((p) => p.configDir), ...skipped.map((s) => s.configDir)];
    expect(all.some((d) => d.includes('node_modules'))).toBe(false);
  });
});

describe('discoverTsConfigProjects — tsconfig.json AT the project root (single-app shape)', () => {
  let rootDir: string;

  beforeAll(() => {
    // Fold-app-scale shape: `mast index --checker` invoked with a single
    // package's own directory as project_root, tsconfig.json living directly
    // in that directory (not a subdirectory) — found running the real pass
    // against align-kimik27-02/packages/core (IMPLEMENTATION_PLAN_VEXP.md
    // Stage 1.2 addendum): `configDir` came back as the full absolute path
    // instead of '.', because `relPath` only strips a `root + '/'` prefix and
    // never matches when `absPath === root` exactly (no trailing slash to align).
    rootDir = mkdtempSync(join(tmpdir(), 'mast-checker-root-tsconfig-'));
    writeFileSync(join(rootDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext' }, include: ['**/*.ts'] }));
    writeFileSync(join(rootDir, 'index.ts'), 'export const x = 1;\n');
  });

  afterAll(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('reports configDir as "." rather than the absolute path', () => {
    const { projects } = discoverTsConfigProjects(rootDir);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.configDir).toBe('.');
  });
});

// ---------------------------------------------------------------------------
// Classification — real compiler, adversarial false-green gate
// (IMPLEMENTATION_PLAN_VEXP.md Stage 1.2: "zero checker edges that name-match
// but point at the wrong declaration — a wrong 'verified' edge is worse than
// no edge").
// ---------------------------------------------------------------------------

describe('RealTsProjectResolver.classify — false-green gate (adversarial fixtures)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-adversarial-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('same method name on two unrelated classes: resolves to the queried one, not the decoy', () => {
    writeFileSync(
      join(tmpDir, 'unrelated.ts'),
      `export class Logger {\n  write(msg: string): void { console.log(msg); }\n}\n`,
    );
    writeFileSync(
      join(tmpDir, 'target.ts'),
      `export class Writer {\n  write(msg: string): void { /* real */ }\n}\n`,
    );
    writeFileSync(
      join(tmpDir, 'caller.ts'),
      `import { Writer } from './target';\nconst w = new Writer();\nw.write('hi');\n`,
    );

    const resolver = new RealTsProjectResolver(tmpDir);
    const handle = resolver.loadProgram(project(tmpDir, ['unrelated.ts', 'target.ts', 'caller.ts']));

    // Queried against the REAL declaration (target.ts) — must resolve.
    const correct = handle.classify({
      relFilePath: 'caller.ts',
      bareName: 'write',
      startLine: 3,
      endLine: 3,
      queriedFilePath: 'target.ts',
      queriedLine: 2,
    });
    expect(correct.kind).toBe('resolves_to_queried');

    // Queried against the DECOY declaration (unrelated.ts, same method name)
    // — must NOT resolve as a match. This is the false-green gate itself.
    const decoy = handle.classify({
      relFilePath: 'caller.ts',
      bareName: 'write',
      startLine: 3,
      endLine: 3,
      queriedFilePath: 'unrelated.ts',
      queriedLine: 2,
    });
    expect(decoy.kind).not.toBe('resolves_to_queried');

    handle.dispose();
  });

  it('interface-typed receiver with two implementors: never claims resolution to a concrete implementor', () => {
    writeFileSync(
      join(tmpDir, 'shape.ts'),
      `export interface Shape {\n  area(): number;\n}\n`,
    );
    writeFileSync(
      join(tmpDir, 'circle.ts'),
      `import { Shape } from './shape';\nexport class Circle implements Shape {\n  area(): number { return 1; }\n}\n`,
    );
    writeFileSync(
      join(tmpDir, 'square.ts'),
      `import { Shape } from './shape';\nexport class Square implements Shape {\n  area(): number { return 2; }\n}\n`,
    );
    writeFileSync(
      join(tmpDir, 'user.ts'),
      `import { Shape } from './shape';\nimport { Circle } from './circle';\nfunction use(s: Shape): void { s.area(); }\nuse(new Circle());\n`,
    );

    const resolver = new RealTsProjectResolver(tmpDir);
    const handle = resolver.loadProgram(project(tmpDir, ['shape.ts', 'circle.ts', 'square.ts', 'user.ts']));

    // The static type of `s` at the call site is the INTERFACE, not either
    // concrete class — querying against Circle.area or Square.area must both
    // fail to resolve as a match (dispatch is genuinely polymorphic here; a
    // wrong "resolves to THIS concrete class" claim would be the false-green).
    const againstCircle = handle.classify({
      relFilePath: 'user.ts',
      bareName: 'area',
      startLine: 3,
      endLine: 3,
      queriedFilePath: 'circle.ts',
      queriedLine: 3,
    });
    expect(againstCircle.kind).not.toBe('resolves_to_queried');

    const againstSquare = handle.classify({
      relFilePath: 'user.ts',
      bareName: 'area',
      startLine: 3,
      endLine: 3,
      queriedFilePath: 'square.ts',
      queriedLine: 3,
    });
    expect(againstSquare.kind).not.toBe('resolves_to_queried');

    handle.dispose();
  });

  it('shadowed import: resolves to the local shadow actually called, not the imported same-named symbol', () => {
    writeFileSync(
      join(tmpDir, 'imported.ts'),
      `export function greet(): string { return 'imported'; }\n`,
    );
    // A nested function declaration legally shadows the imported binding
    // within `run`'s scope — `return greet();` calls the LOCAL one, not the
    // import. A heuristic that resolves purely by "greet is imported here"
    // would get this wrong; the real checker is scope-aware.
    writeFileSync(
      join(tmpDir, 'shadow.ts'),
      `import { greet } from './imported';\nexport function run(): string {\n  function greet(): string { return 'local'; }\n  return greet();\n}\n`,
    );

    const resolver = new RealTsProjectResolver(tmpDir);
    const handle = resolver.loadProgram(project(tmpDir, ['imported.ts', 'shadow.ts']));

    // Queried against the IMPORTED declaration — must NOT match; the call
    // site actually invokes the local shadow.
    const againstImport = handle.classify({
      relFilePath: 'shadow.ts',
      bareName: 'greet',
      startLine: 4,
      endLine: 4,
      queriedFilePath: 'imported.ts',
      queriedLine: 1,
    });
    expect(againstImport.kind).not.toBe('resolves_to_queried');

    // Queried against the LOCAL shadow's own declaration — must match.
    const againstLocal = handle.classify({
      relFilePath: 'shadow.ts',
      bareName: 'greet',
      startLine: 4,
      endLine: 4,
      queriedFilePath: 'shadow.ts',
      queriedLine: 3,
    });
    expect(againstLocal.kind).toBe('resolves_to_queried');

    handle.dispose();
  });

  it('alias-chain (export { real as alias }): follows getAliasedSymbol to the real declaration', () => {
    writeFileSync(
      join(tmpDir, 'real-decl.ts'),
      `export function real(): string { return 'real'; }\n`,
    );
    writeFileSync(
      join(tmpDir, 'barrel.ts'),
      `export { real as alias } from './real-decl';\n`,
    );
    writeFileSync(
      join(tmpDir, 'caller.ts'),
      `import { alias } from './barrel';\nexport function run(): string { return alias(); }\n`,
    );

    const resolver = new RealTsProjectResolver(tmpDir);
    const handle = resolver.loadProgram(project(tmpDir, ['real-decl.ts', 'barrel.ts', 'caller.ts']));

    const result = handle.classify({
      relFilePath: 'caller.ts',
      bareName: 'alias',
      startLine: 2,
      endLine: 2,
      queriedFilePath: 'real-decl.ts',
      queriedLine: 1,
    });
    expect(result.kind).toBe('resolves_to_queried');

    handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// classify() basic outcomes (non-call-site, unresolved)
// ---------------------------------------------------------------------------

describe('RealTsProjectResolver.classify — non-call-site and unresolved outcomes', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-classify-'));
    writeFileSync(join(tmpDir, 'target.ts'), `export function helper(): void {}\n`);
    // No call-shaped occurrence anywhere in this file — only a comment
    // mention, a string literal, and a type position. `findIdentifierOccurrences`
    // legitimately finds all three as Identifier-or-text hits, but none is the
    // callee of a CallExpression/NewExpression, so the verdict must be
    // `non_call_site` regardless of the search window's size.
    writeFileSync(
      join(tmpDir, 'caller-noncall.ts'),
      [
        `import { helper } from './target';`,
        `// helper is mentioned here as a comment, not called`,
        `const label = 'helper';`,
        `let x: typeof helper;`,
        `export function unused(): typeof x { return x; }`,
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(tmpDir, 'caller-call.ts'),
      `import { helper } from './target';\nexport function run(): void { helper(); }\n`,
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('classifies a comment/string/type occurrence with no call-shaped site as non_call_site', () => {
    const resolver = new RealTsProjectResolver(tmpDir);
    const handle = resolver.loadProgram(project(tmpDir, ['target.ts', 'caller-noncall.ts']));
    const result = handle.classify({
      relFilePath: 'caller-noncall.ts',
      bareName: 'helper',
      startLine: 2,
      endLine: 2,
      queriedFilePath: 'target.ts',
      queriedLine: 1,
    });
    expect(result.kind).toBe('non_call_site');
    handle.dispose();
  });

  it('classifies a real call-shaped occurrence as resolves_to_queried', () => {
    const resolver = new RealTsProjectResolver(tmpDir);
    const handle = resolver.loadProgram(project(tmpDir, ['target.ts', 'caller-call.ts']));
    const result = handle.classify({
      relFilePath: 'caller-call.ts',
      bareName: 'helper',
      startLine: 2,
      endLine: 2,
      queriedFilePath: 'target.ts',
      queriedLine: 1,
    });
    expect(result.kind).toBe('resolves_to_queried');
    handle.dispose();
  });

  it('throws a clear error when classify() is called after dispose()', () => {
    const resolver = new RealTsProjectResolver(tmpDir);
    const handle = resolver.loadProgram(project(tmpDir, ['target.ts', 'caller-call.ts']));
    handle.dispose();
    expect(() =>
      handle.classify({ relFilePath: 'caller-call.ts', bareName: 'helper', startLine: 2, endLine: 2, queriedFilePath: 'target.ts', queriedLine: 1 }),
    ).toThrow(/dispose/);
  });
});

// ---------------------------------------------------------------------------
// runCheckerPass orchestration — fake resolver (no real compiler cost),
// proving persistence/filtering/one-program-at-a-time behaviour.
// ---------------------------------------------------------------------------

/** Deterministic fake: classifications keyed by `relFilePath::bareName`, ignoring line detail. */
class FakeTsProjectResolver implements TsProjectResolver {
  public readonly loadCalls: string[] = [];
  public readonly disposeCalls: string[] = [];

  constructor(
    private readonly discovery: TsProjectDiscoveryResult,
    private readonly classifications: ReadonlyMap<string, CallSiteClassification>,
  ) {}

  discoverProjects(): TsProjectDiscoveryResult {
    return this.discovery;
  }

  loadProgram(descriptor: TsProjectDescriptor): TsProjectHandle {
    this.loadCalls.push(descriptor.configDir);
    let disposed = false;
    return {
      classify: (input) => {
        if (disposed) throw new Error('classify() called after dispose() (fake)');
        const key = `${input.relFilePath}::${input.bareName}`;
        return this.classifications.get(key) ?? { kind: 'unresolved' };
      },
      dispose: () => {
        disposed = true;
        this.disposeCalls.push(descriptor.configDir);
      },
    };
  }
}

describe('runCheckerPass — orchestration (fake resolver)', () => {
  let tmpDir: string;
  let db: Db;
  let chunkStore: SqliteChunkStore;
  let config: ReturnType<typeof resolveConfig>;

  const MATH_SRC = `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n`;
  // `multiply` and `subtract` are each referenced once with no import/same-file
  // resolution available to the heuristic — genuine potential matches.
  const CALLER_SRC = `export function run(): void {\n  (globalThis as unknown as { multiply: (a: number, b: number) => number }).multiply(1, 2);\n  (globalThis as unknown as { subtract: (a: number, b: number) => number }).subtract(3, 1);\n}\n`;
  const OUTSIDE_SRC = `export function run2(): void {\n  (globalThis as unknown as { add: (a: number, b: number) => number }).add(1, 2);\n}\n`;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-pass-'));
    writeFileSync(join(tmpDir, 'math.ts'), MATH_SRC);
    writeFileSync(join(tmpDir, 'caller.ts'), CALLER_SRC);
    // A file with NO owning tsconfig project (never listed in the fake
    // discovery's fileNames below) — its candidate must be counted as
    // out-of-scope, not silently dropped.
    writeFileSync(join(tmpDir, 'outside.ts'), OUTSIDE_SRC);

    config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
    chunkStore = new SqliteChunkStore(db);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a checker edge for resolves_to_queried, a verdict for the others, and counts out-of-scope sites', async () => {
    const discovery: TsProjectDiscoveryResult = {
      projects: [project(tmpDir, ['math.ts', 'caller.ts'])],
      skipped: [],
    };
    const fakeResolver = new FakeTsProjectResolver(
      discovery,
      new Map<string, CallSiteClassification>([
        ['caller.ts::multiply', { kind: 'resolves_to_queried', callLine: 2, context: 'multiply(1, 2);' }],
        ['caller.ts::subtract', { kind: 'non_call_site' }],
      ]),
    );

    const result = await runCheckerPass(db, chunkStore, config, { resolver: fakeResolver });

    expect(result.edgesUpgraded).toBeGreaterThanOrEqual(1);
    expect(result.classifiedNonCallSite).toBeGreaterThanOrEqual(0);
    // `outside.ts` was never in the fake discovery's fileNames — its `add`
    // candidate has no owning project.
    expect(result.potentialSitesOutsideScope).toBeGreaterThanOrEqual(1);

    // The written edge is visible via the normal verified-callers query, with
    // the new 'checker' resolution value.
    const [multiplySym] = await querySymbolByName(db, 'multiply', 'math.ts');
    expect(multiplySym).toBeDefined();
    const callers = await queryVerifiedCallers(db, multiplySym!.id, false);
    const checkerCaller = callers.find((c) => c.resolution === 'checker');
    expect(checkerCaller).toBeDefined();
    expect(checkerCaller!.caller_symbol).toBe('run');

    // One ts.Program per project, disposed before the pass finishes.
    expect(fakeResolver.loadCalls).toEqual(['.']);
    expect(fakeResolver.disposeCalls).toEqual(['.']);
  });

  it('re-running the pass is idempotent: edges_upgraded reports actual NEW edge rows, not re-classification attempts', async () => {
    // Same discovery + classifications as the first test — every
    // resolves_to_queried edge already exists in `edges` from that run, so the
    // ON CONFLICT DO NOTHING insert affects zero rows. An agent reading the
    // CLI summary must see 0, not a re-count of classification outcomes
    // (attempts ≠ upgrades; on the monorepo run 3,935 attempts collapsed to
    // 1,885 distinct rows — the summary must report what actually landed).
    const discovery: TsProjectDiscoveryResult = {
      projects: [project(tmpDir, ['math.ts', 'caller.ts'])],
      skipped: [],
    };
    const fakeResolver = new FakeTsProjectResolver(
      discovery,
      new Map<string, CallSiteClassification>([
        ['caller.ts::multiply', { kind: 'resolves_to_queried', callLine: 2, context: 'multiply(1, 2);' }],
        ['caller.ts::subtract', { kind: 'non_call_site' }],
      ]),
    );

    const rerun = await runCheckerPass(db, chunkStore, config, { resolver: fakeResolver });

    expect(rerun.edgesUpgraded).toBe(0);
  });

  it('does not load a program for a project with zero candidates', async () => {
    const discovery: TsProjectDiscoveryResult = {
      projects: [
        project(tmpDir, ['math.ts', 'caller.ts']),
        { configDir: 'empty', fileNames: [], compilerOptions: MINIMAL_OPTIONS },
      ],
      skipped: [],
    };
    const fakeResolver = new FakeTsProjectResolver(discovery, new Map());
    await runCheckerPass(db, chunkStore, config, { resolver: fakeResolver });
    expect(fakeResolver.loadCalls).not.toContain('empty');
  });
});

// ---------------------------------------------------------------------------
// Verdict staleness — the feature's severity-zero failure mode
// (IMPLEMENTATION_PLAN_VEXP.md Stage 1.2: "a stale verdict silently
// suppressing a REAL new call site"). A verdict must not outlive the file
// content it was computed for: `populateFile`'s delete-and-replace on any
// content change cascades away `checker_verdicts` for that file (same FK as
// symbols/edges/imports) — proven directly against the real Phase 1 pipeline,
// not a fake.
// ---------------------------------------------------------------------------

describe('checker_verdicts — staleness (severity-zero invariant)', () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-staleness-'));
    writeFileSync(join(tmpDir, 'target.ts'), `export function helper(): void {}\n`);
    writeFileSync(join(tmpDir, 'caller.ts'), `// helper mentioned only in a comment here, line 1\n`);

    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a verdict no longer applies after the file it was computed against is edited and reindexed', async () => {
    const [helperSym] = await querySymbolByName(db, 'helper', 'target.ts');
    expect(helperSym).toBeDefined();
    const fileRow = await db.selectFrom('files').select(['id', 'mtime']).where('path', '=', 'caller.ts').executeTakeFirstOrThrow();

    // Simulate what runCheckerPass would have written for the comment mention.
    await db
      .insertInto('checker_verdicts')
      .values({
        queried_symbol_id: helperSym!.id,
        call_site_file_id: fileRow.id,
        call_site_line: 1,
        verdict: 'non_call_site',
        call_site_mtime: fileRow.mtime,
      })
      .execute();

    const before = await queryCheckerVerdicts(db, helperSym!.id);
    expect(before.some((v) => v.file_path === 'caller.ts' && v.call_site_line === 1)).toBe(true);

    // Edit the fixture file so it now GENUINELY calls helper() on line 1 —
    // exactly the "real new call site" the severity-zero failure mode is
    // about — and reindex through the real Phase 1 pipeline.
    writeFileSync(join(tmpDir, 'caller.ts'), `export function run(): void { helper(); }\n`);
    const result = extractFile(join(tmpDir, 'caller.ts'), tmpDir, 3, 100);
    await populateFile(db, {
      filePath: 'caller.ts',
      language: result.language,
      // Strictly newer than the real (epoch-scale) mtime `beforeAll`'s
      // `runIndex` call already stamped `fileRow.mtime` with — a hardcoded
      // small literal here would be REJECTED by populateFile's monotonic
      // write-guard (F12), which refuses to replace a row with an
      // older-stamped write. This must represent a genuine "edited later",
      // not an arbitrary placeholder.
      mtime: fileRow.mtime + 1_000,
      chunks: result.chunks,
      imports: result.imports,
      symbols: result.symbols,
      identifierRows: result.identifierRows,
    });

    const after = await queryCheckerVerdicts(db, helperSym!.id);
    expect(after.some((v) => v.file_path === 'caller.ts' && v.call_site_line === 1)).toBe(false);
  });
});
