import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
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
import { checkAndRefreshIfStale } from '../../mcp/staleness.js';
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
// D154: a candidate is a chunk the name occurs near, and a chunk's stored text
// runs past its declaration. A call on a neighbour's line is the neighbour's.
// ---------------------------------------------------------------------------

describe('RealTsProjectResolver.classify — a call outside the candidate\'s own lines (D154)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-adjacent-'));
    writeFileSync(join(tmpDir, 'target.ts'), `export function helper(): void {}\n`);
    writeFileSync(
      join(tmpDir, 'adjacent.ts'),
      [
        `import { helper } from './target';`,
        `export function init(): void {`,
        `  helper();`,
        `}`,
        `export function cleanup(): void {}`,
      ].join('\n') + '\n',
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not find a call for a declaration whose neighbour, one line above, makes it', () => {
    const resolver = new RealTsProjectResolver(tmpDir);
    const handle = resolver.loadProgram(project(tmpDir, ['target.ts', 'adjacent.ts']));

    const result = handle.classify({
      relFilePath: 'adjacent.ts',
      bareName: 'helper',
      startLine: 5,
      endLine: 5,
      queriedFilePath: 'target.ts',
      queriedLine: 1,
    });

    expect(result.kind).toBe('non_call_site');
    handle.dispose();
  });

  it('finds the call for the declaration it is written in', () => {
    const resolver = new RealTsProjectResolver(tmpDir);
    const handle = resolver.loadProgram(project(tmpDir, ['target.ts', 'adjacent.ts']));

    const result = handle.classify({
      relFilePath: 'adjacent.ts',
      bareName: 'helper',
      startLine: 2,
      endLine: 4,
      queriedFilePath: 'target.ts',
      queriedLine: 1,
    });

    expect(result).toMatchObject({ kind: 'resolves_to_queried', callLine: 3 });
    handle.dispose();
  });
});

// ---------------------------------------------------------------------------
// runCheckerPass orchestration — fake resolver (no real compiler cost),
// proving persistence/filtering/one-program-at-a-time behaviour.
// ---------------------------------------------------------------------------

/** Deterministic fake: classifications keyed by `relFilePath::bareName`, ignoring line detail. */
class FakeTsProjectResolver implements TsProjectResolver {
  public readonly loadCalls: string[] = [];
  /** The root file names each loaded program was given, by project. */
  public readonly loadedFileNames = new Map<string, readonly string[]>();
  public readonly disposeCalls: string[] = [];

  constructor(
    private readonly discovery: TsProjectDiscoveryResult,
    private readonly classifications: ReadonlyMap<string, CallSiteClassification>,
    /** Runs at every classification: a write by another process while the pass is working. */
    private readonly onClassify: () => void = () => {},
  ) {}

  discoverProjects(): TsProjectDiscoveryResult {
    return this.discovery;
  }

  loadProgram(descriptor: TsProjectDescriptor): TsProjectHandle {
    this.loadCalls.push(descriptor.configDir);
    this.loadedFileNames.set(descriptor.configDir, descriptor.fileNames);
    let disposed = false;
    return {
      classify: (input) => {
        if (disposed) throw new Error('classify() called after dispose() (fake)');
        this.onClassify();
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
    const callers = await queryVerifiedCallers(db, [multiplySym!.id], false);
    const checkerCaller = callers.find((c) => c.resolution === 'checker');
    expect(checkerCaller).toBeDefined();
    expect(checkerCaller!.caller_symbol).toBe('run');

    // One ts.Program per project, disposed before the pass finishes.
    expect(fakeResolver.loadCalls).toEqual(['.']);
    expect(fakeResolver.disposeCalls).toEqual(['.']);
  });

  it('a second run stores the same edges again, and not a second copy of them', async () => {
    // The pass removes what the run before it stored and computes it again, so
    // `edges_upgraded` is what this run stored and the table holds it once.
    const discovery: TsProjectDiscoveryResult = {
      projects: [project(tmpDir, ['math.ts', 'caller.ts'])],
      skipped: [],
    };
    const classifications = new Map<string, CallSiteClassification>([
      ['caller.ts::multiply', { kind: 'resolves_to_queried', callLine: 2, context: 'multiply(1, 2);' }],
      ['caller.ts::subtract', { kind: 'non_call_site' }],
    ]);
    const first = await runCheckerPass(db, chunkStore, config, { resolver: new FakeTsProjectResolver(discovery, classifications) });

    const rerun = await runCheckerPass(db, chunkStore, config, { resolver: new FakeTsProjectResolver(discovery, classifications) });

    const stored = await db.selectFrom('edges').select((eb) => eb.fn.countAll<number>().as('n')).where('resolution', '=', 'checker').executeTakeFirstOrThrow();
    expect(rerun.edgesUpgraded).toBe(first.edgesUpgraded);
    expect(stored.n).toBe(first.edgesUpgraded);
  });

  it('gives a file two projects name to the deeper one, whichever is found first (D153)', async () => {
    // Discovery sorts by path, so a root `tsconfig.json` comes before `web/`.
    const discovery: TsProjectDiscoveryResult = {
      projects: [
        project(tmpDir, ['math.ts', 'caller.ts']),
        { configDir: 'web', fileNames: [join(tmpDir, 'caller.ts')], compilerOptions: MINIMAL_OPTIONS },
      ],
      skipped: [],
    };
    const fakeResolver = new FakeTsProjectResolver(discovery, new Map());

    await runCheckerPass(db, chunkStore, config, { resolver: fakeResolver });

    expect(fakeResolver.loadedFileNames.get('web')).toEqual([join(tmpDir, 'caller.ts')]);
  });

  it('builds a project\'s program from the files no earlier project names (D153)', async () => {
    // A root tsconfig names every package's files again. n8n's names 19,018
    // and is given 103 of them; a program of all 19,018 ran out of memory.
    const discovery: TsProjectDiscoveryResult = {
      projects: [
        { configDir: 'one', fileNames: [join(tmpDir, 'math.ts')], compilerOptions: MINIMAL_OPTIONS },
        project(tmpDir, ['math.ts', 'caller.ts']),
      ],
      skipped: [],
    };
    const fakeResolver = new FakeTsProjectResolver(discovery, new Map());

    await runCheckerPass(db, chunkStore, config, { resolver: fakeResolver });

    expect(fakeResolver.loadedFileNames.get('.')).toEqual([join(tmpDir, 'caller.ts')]);
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
// D154, the second way: a class has a chunk of its whole body and each method
// has its own, so a call in a method is inside two candidates.
// ---------------------------------------------------------------------------

describe('runCheckerPass — the caller is the innermost declaration around the call (D154)', () => {
  let tmpDir: string;
  let db: Db;
  let chunkStore: SqliteChunkStore;
  let config: ReturnType<typeof resolveConfig>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-innermost-'));
    writeFileSync(join(tmpDir, 'math.ts'), `export function multiply(a: number, b: number): number {\n  return a * b;\n}\n`);
    writeFileSync(
      join(tmpDir, 'service.ts'),
      [
        // The field puts the name in the class's own chunk, which holds the
        // class's members without the method bodies.
        `export class Service {`,
        `  multiply = 0;`,
        `  start(): void {`,
        `    (globalThis as unknown as { multiply: (a: number, b: number) => number }).multiply(1, 2);`,
        `  }`,
        `}`,
      ].join('\n') + '\n',
    );
    config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
    chunkStore = new SqliteChunkStore(db);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores a call in a one-line class from its method, where the two chunks have the same lines', async () => {
    writeFileSync(
      join(tmpDir, 'oneline.ts'),
      `export class Tiny { multiply = 0; go(): void { (globalThis as unknown as { multiply: (a: number, b: number) => number }).multiply(1, 2); } }\n`,
    );
    await runIndex(config, { incremental: true });
    const fakeResolver = new FakeTsProjectResolver(
      { projects: [project(tmpDir, ['math.ts', 'oneline.ts'])], skipped: [] },
      new Map<string, CallSiteClassification>([
        ['oneline.ts::multiply', { kind: 'resolves_to_queried', callLine: 1, context: 'multiply(1, 2);' }],
      ]),
    );
    const freshDb = openDatabase(config.resolved_state_dir);
    try {
      await runCheckerPass(freshDb, new SqliteChunkStore(freshDb), config, { resolver: fakeResolver });

      const [multiplySym] = await querySymbolByName(freshDb, 'multiply', 'math.ts');
      const callers = await queryVerifiedCallers(freshDb, [multiplySym!.id], false);
      expect(callers.filter((c) => c.resolution === 'checker').map((c) => c.caller_symbol)).toEqual(['Tiny.go']);
    } finally {
      await freshDb.destroy();
    }
  });

  it('stores a call in a method from the method and not from its class', async () => {
    const fakeResolver = new FakeTsProjectResolver(
      { projects: [project(tmpDir, ['math.ts', 'service.ts'])], skipped: [] },
      new Map<string, CallSiteClassification>([
        ['service.ts::multiply', { kind: 'resolves_to_queried', callLine: 4, context: 'multiply(1, 2);' }],
      ]),
    );

    await runCheckerPass(db, chunkStore, config, { resolver: fakeResolver });

    const [multiplySym] = await querySymbolByName(db, 'multiply', 'math.ts');
    const callers = await queryVerifiedCallers(db, [multiplySym!.id], false);
    expect(callers.filter((c) => c.resolution === 'checker').map((c) => c.caller_symbol)).toEqual(['Service.start']);
  });
});

// ---------------------------------------------------------------------------
// A decorator on a method is the method's call (§10.3.1), and it is written
// above the method: on the class's lines and outside the method's chunk.
// ---------------------------------------------------------------------------

describe('a decorator on a member is that member\'s call', () => {
  let tmpDir: string;
  let db: Db;
  let chunkStore: SqliteChunkStore;
  let config: ReturnType<typeof resolveConfig>;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-decorator-'));
    writeFileSync(join(tmpDir, 'lib.ts'), [
      `export function Before(): MethodDecorator & ClassDecorator & PropertyDecorator & ParameterDecorator {`,
      `  return () => undefined;`,
      `}`,
    ].join('\n') + '\n');
    writeFileSync(join(tmpDir, 'entity.ts'), [
      // The method has the decorator's name in another case, which is how the
      // class comes to be a potential match for it: the identifier index does
      // not tell `before` from `Before`, and holds a class's member names. On
      // n8n it is `@BeforeInsert() beforeInsert()`.
      `import { Before } from './lib';`,
      `export class Entity {`,
      `  @Before()`,
      `  before(): void {}`,
      `}`,
    ].join('\n') + '\n');
    writeFileSync(join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, experimentalDecorators: true },
      include: ['*.ts'],
    }));
    // The decorators below are reached through a namespace another file
    // exports, which the heuristic resolver does not follow, so the edges are
    // the pass's own. (Through \`import * as lib\` it reads them itself.)
    writeFileSync(join(tmpDir, 'ns.ts'), `export * as lib from './lib';\n`);
    writeFileSync(join(tmpDir, 'others.ts'), [
      `import { lib } from './ns';`,
      `@lib.Before()`,
      `export class OnClass {}`,
      `export class OnField {`,
      `  @lib.Before()`,
      `  name = '';`,
      `}`,
      `export class OnParameter {`,
      `  constructor(@lib.Before() readonly a: string) {}`,
      `}`,
    ].join('\n') + '\n');
    config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
    chunkStore = new SqliteChunkStore(db);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const decorators: ts.CompilerOptions = { ...MINIMAL_OPTIONS, experimentalDecorators: true };
  function classify(relFilePath: string, startLine: number, endLine: number): CallSiteClassification {
    const handle = new RealTsProjectResolver(tmpDir).loadProgram({
      ...project(tmpDir, ['lib.ts', 'entity.ts', 'others.ts']),
      compilerOptions: decorators,
    });
    try {
      return handle.classify({ relFilePath, bareName: 'Before', startLine, endLine, queriedFilePath: 'lib.ts', queriedLine: 1 });
    } finally {
      handle.dispose();
    }
  }

  it('classify gives the line of the method a decorator is on', () => {
    expect(classify('entity.ts', 2, 5)).toEqual({ kind: 'resolves_to_queried', callLine: 3, context: '@Before()', decoratedMemberLine: 4 });
  });

  it('classify gives the constructor\'s line for a decorator on its parameter', () => {
    expect(classify('others.ts', 8, 10)).toMatchObject({ kind: 'resolves_to_queried', callLine: 9, decoratedMemberLine: 9 });
  });

  it('classify gives no member line for a decorator on a class or on a field', () => {
    expect([classify('others.ts', 2, 3), classify('others.ts', 4, 7)]).toEqual([
      { kind: 'resolves_to_queried', callLine: 2, context: '@lib.Before()' },
      { kind: 'resolves_to_queried', callLine: 5, context: '@lib.Before()' },
    ]);
  });

  it('the pass, with the compiler, leaves the method as the only caller', async () => {
    await runCheckerPass(db, chunkStore, config);

    const [before] = await querySymbolByName(db, 'Before', 'lib.ts');
    const callers = await queryVerifiedCallers(db, [before!.id], false);
    // `OnClass` is not found: its decorator is on the line above the class's
    // own lines, and the name comes through a namespace import.
    expect(callers.map((c) => `${c.file_path} ${c.caller_symbol}`).sort()).toEqual([
      'entity.ts Entity.before',
      'others.ts OnField',
      'others.ts OnParameter.constructor',
    ]);
  });

  it('the pass stores no edge when the class has no member on the line given', async () => {
    const fakeResolver = new FakeTsProjectResolver(
      { projects: [project(tmpDir, ['lib.ts', 'entity.ts'])], skipped: [] },
      new Map<string, CallSiteClassification>([
        ['entity.ts::Before', { kind: 'resolves_to_queried', callLine: 3, context: '@Before()', decoratedMemberLine: 99 }],
      ]),
    );

    await runCheckerPass(db, chunkStore, config, { resolver: fakeResolver });

    const [before] = await querySymbolByName(db, 'Before', 'lib.ts');
    const callers = await queryVerifiedCallers(db, [before!.id], false);
    expect(callers.filter((c) => c.resolution === 'checker')).toEqual([]);
  });
});

describe('a decorator on a member — the member is found by its line, not its name', () => {
  let tmpDir: string;
  let db: Db;
  let config: ReturnType<typeof resolveConfig>;

  // Every file takes the decorator through a namespace import, which the
  // resolver does not read, so each edge here is the pass's own. Each class has
  // a member named `before`, which is what makes the class a potential match.
  const FILES: Record<string, string[]> = {
    'method.ts': [`export class OnMethod {`, `  @lib.Before()`, `  before(): void {}`, `}`],
    'comment.ts': [`export class Commented {`, `  @lib.Before()`, `  // a comment between the two`, `  before(): void {}`, `}`],
    'accessors.ts': [`export class GetSet {`, `  get before(): number { return 1; }`, `  @lib.Before()`, `  set before(x: number) { void x; }`, `}`],
    'static.ts': [`export class Dup {`, `  static before(): void {}`, `  @lib.Before()`, `  before(): void {}`, `}`],
    'private.ts': [`export class Priv {`, `  before = 1;`, `  @lib.Before()`, `  #secret(): void {}`, `  go(): void { this.#secret(); }`, `}`],
    // No decorator: an ordinary call in the second of two members of one name (D159).
    'plain-setter.ts': [`export class PlainSet {`, `  get value(): number { return 1; }`, `  set value(x: number) { lib.Before(); void x; }`, `}`],
    'plain-static.ts': [`export class PlainDup {`, `  static run(): void {}`, `  run(): void { lib.Before(); }`, `}`],
    // Two members of one name on one line: nothing stored tells their rows apart.
    'one-line.ts': [`export class OneLine { get value(): number { return 1; } set value(x: number) { lib.Before(); void x; } }`],
    // A function long enough to be split into chunks: the later chunks start on
    // no row's line. An interface of its name is the first row of that name.
    'long.ts': [
      `export interface Long { readonly size: number }`,
      `export function Long(): void {`,
      ...Array.from({ length: 130 }, () => `  void 0;`),
      `  lib.Before();`,
      `}`,
    ],
    'nested.ts': [
      `export class Outer {`,
      `  before(): void {}`,
      `  static Inner = class {`,
      `    @lib.Before()`,
      `    before(): void {}`,
      `  };`,
      `}`,
    ],
  };

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-decorator-line-'));
    writeFileSync(join(tmpDir, 'lib.ts'), [
      `export function Before(): (...args: unknown[]) => void {`,
      `  return () => undefined;`,
      `}`,
    ].join('\n') + '\n');
    // Reached through a namespace another file exports, which the heuristic
    // resolver does not follow: every edge here is the pass's own.
    writeFileSync(join(tmpDir, 'ns.ts'), `export * as lib from './lib';\n`);
    for (const [name, lines] of Object.entries(FILES)) {
      writeFileSync(join(tmpDir, name), [`import { lib } from './ns';`, ...lines].join('\n') + '\n');
    }
    writeFileSync(join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', strict: true, experimentalDecorators: true },
      include: ['*.ts'],
    }));
    config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
    await runCheckerPass(db, new SqliteChunkStore(db), config);
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** `caller symbol @ the line of its row` for every checker edge from `file`. */
  async function checkerCallersIn(file: string): Promise<string[]> {
    const rows = await db
      .selectFrom('edges as e')
      .innerJoin('symbols as s', 's.id', 'e.from_id')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select(['s.name', 's.line'])
      .where('e.resolution', '=', 'checker')
      .where('f.path', '=', file)
      .execute();
    return rows.map((r) => `${r.name} @ ${String(r.line)}`).sort();
  }

  it('writes the edge from the method below the decorator', async () => {
    expect(await checkerCallersIn('method.ts')).toEqual(['OnMethod.before @ 4']);
  });

  it('writes it from the method when a comment is between the two', async () => {
    expect(await checkerCallersIn('comment.ts')).toEqual(['Commented.before @ 5']);
  });

  it('writes it from the setter when the getter of the same name is not decorated', async () => {
    expect(await checkerCallersIn('accessors.ts')).toEqual(['GetSet.before @ 5']);
  });

  it('writes it from the instance method when a static one has the name', async () => {
    expect(await checkerCallersIn('static.ts')).toEqual(['Dup.before @ 5']);
  });

  it('writes it from a method with a private name', async () => {
    expect(await checkerCallersIn('private.ts')).toEqual(['Priv.#secret @ 5']);
  });

  it('writes an ordinary call in a setter from the setter, not the getter of its name', async () => {
    expect(await checkerCallersIn('plain-setter.ts')).toEqual(['PlainSet.value @ 4']);
  });

  it('writes an ordinary call in an instance method from it, not the static one of its name', async () => {
    expect(await checkerCallersIn('plain-static.ts')).toEqual(['PlainDup.run @ 4']);
  });

  it('writes none when two members of the name start on the candidate\'s line', async () => {
    expect(await checkerCallersIn('one-line.ts')).toEqual([]);
  });

  it('writes a call far down a long function from the function, not from a type of its name above it', async () => {
    expect(await checkerCallersIn('long.ts')).toEqual(['Long @ 3']);
  });

  it('writes none for a method of a class nested in the candidate', async () => {
    expect(await checkerCallersIn('nested.ts')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D155: the resolver's rule for `new X()` stores the caller on `X.constructor`
// when the class declares one (§10.3.1 rule 9). The pass has to agree with it.
// ---------------------------------------------------------------------------

describe('runCheckerPass — `new X()` is a call of the constructor X declares (D155)', () => {
  let tmpDir: string;
  let db: Db;
  let chunkStore: SqliteChunkStore;
  let config: ReturnType<typeof resolveConfig>;

  const CONSTRUCT = (name: string): string =>
    `  new (globalThis as unknown as { ${name}: new () => object }).${name}();`;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-construct-'));
    writeFileSync(
      join(tmpDir, 'widgets.ts'),
      [
        `export class Widget {`,
        `  constructor() {}`,
        `}`,
        ``,
        `export class Plain {}`,
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(tmpDir, 'caller.ts'),
      [`export function build(): void {`, CONSTRUCT('Widget'), CONSTRUCT('Plain'), `}`].join('\n') + '\n',
    );
    config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
    chunkStore = new SqliteChunkStore(db);

    const fakeResolver = new FakeTsProjectResolver(
      { projects: [project(tmpDir, ['widgets.ts', 'caller.ts'])], skipped: [] },
      new Map<string, CallSiteClassification>([
        ['caller.ts::Widget', { kind: 'resolves_to_queried', callLine: 2, context: 'new Widget();' }],
        ['caller.ts::Plain', { kind: 'resolves_to_queried', callLine: 3, context: 'new Plain();' }],
      ]),
    );
    await runCheckerPass(db, chunkStore, config, { resolver: fakeResolver });
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function checkerCallees(): Promise<string[]> {
    const rows = await db
      .selectFrom('edges as e')
      .innerJoin('symbols as callee', 'callee.id', 'e.to_id')
      .select('callee.name')
      .where('e.resolution', '=', 'checker')
      .orderBy('callee.name')
      .execute();
    return rows.map((r) => r.name);
  }

  it('stores the edge on the constructor when the class declares one, on the class otherwise', async () => {
    expect(await checkerCallees()).toEqual(['Plain', 'Widget.constructor']);
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

// ---------------------------------------------------------------------------
// D150, D151: what a call resolves to depends on files other than the two an
// edge joins, so the pass's results are a snapshot of one tree. Any write of a
// file removes them all, and the run says how many.
// ---------------------------------------------------------------------------

describe('checker results — removed when any file is written again (D150, D151)', () => {
  let tmpDir: string;
  let config: ReturnType<typeof resolveConfig>;
  let later = Date.now() / 1_000;

  /** Rewrites `name` with a stamp later than any before it. */
  function edit(name: string, content: string): void {
    writeFileSync(join(tmpDir, name), content);
    later += 100;
    utimesSync(join(tmpDir, name), later, later);
  }

  /** A fresh index of the fixture with one checker edge, `run > multiply`, and one verdict. */
  async function indexWithCheckerResults(): Promise<void> {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'math.ts'), `export function multiply(a: number, b: number): number {\n  return a * b;\n}\n`);
    writeFileSync(
      join(tmpDir, 'caller.ts'),
      `export function run(): void {\n  (globalThis as unknown as { multiply: (a: number, b: number) => number }).multiply(1, 2);\n}\n`,
    );
    writeFileSync(join(tmpDir, 'third.ts'), `export const unrelated = 1;\n`);
    config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    await runPass();
  }

  /** The pass over the fixture; `duringThePass` gets the pass's own connection at every classification. */
  async function runPass(duringThePass: (db: Db) => void = () => {}): Promise<Awaited<ReturnType<typeof runCheckerPass>>> {
    const db = openDatabase(config.resolved_state_dir);
    try {
      const fakeResolver = new FakeTsProjectResolver(
        { projects: [project(tmpDir, ['math.ts', 'caller.ts', 'third.ts'])], skipped: [] },
        new Map<string, CallSiteClassification>([
          ['caller.ts::multiply', { kind: 'resolves_to_queried', callLine: 2, context: 'multiply(1, 2);' }],
        ]),
        () => duringThePass(db),
      );
      return await runCheckerPass(db, new SqliteChunkStore(db), config, { resolver: fakeResolver });
    } finally {
      await db.destroy();
    }
  }

  async function stored(): Promise<{ edges: number; verdicts: number }> {
    const db = openDatabase(config.resolved_state_dir);
    try {
      const edges = await db.selectFrom('edges').select((eb) => eb.fn.countAll<number>().as('n')).where('resolution', '=', 'checker').executeTakeFirstOrThrow();
      const verdicts = await db.selectFrom('checker_verdicts').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
      return { edges: edges.n, verdicts: verdicts.n };
    } finally {
      await db.destroy();
    }
  }

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-checker-lifetime-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the fixture has one checker edge and one verdict to lose', async () => {
    await indexWithCheckerResults();

    expect(await stored()).toEqual({ edges: 1, verdicts: 1 });
  });

  it('an incremental run that writes a third file removes them and reports the counts', async () => {
    await indexWithCheckerResults();
    edit('third.ts', `export const unrelated = 2;\n`);

    const result = await runIndex(config, { incremental: true });

    expect(result.checkerResultsRemoved).toEqual({ edges: 1, verdicts: 1 });
    expect(await stored()).toEqual({ edges: 0, verdicts: 0 });
  });

  it('an incremental run that writes nothing keeps them', async () => {
    await indexWithCheckerResults();

    const result = await runIndex(config, { incremental: true });

    expect(result.checkerResultsRemoved).toEqual({ edges: 0, verdicts: 0 });
    expect(await stored()).toEqual({ edges: 1, verdicts: 1 });
  });

  it('a full run reports the ones it removed', async () => {
    await indexWithCheckerResults();

    const result = await runIndex(config, { incremental: false });

    expect(result.checkerResultsRemoved).toEqual({ edges: 1, verdicts: 1 });
  });

  it('an incremental run after a file is deleted removes them', async () => {
    await indexWithCheckerResults();
    rmSync(join(tmpDir, 'third.ts'));

    const result = await runIndex(config, { incremental: true });

    expect(result.checkerResultsRemoved).toEqual({ edges: 1, verdicts: 1 });
    expect(await stored()).toEqual({ edges: 0, verdicts: 0 });
  });

  it('a refresh on read of a third file removes them', async () => {
    await indexWithCheckerResults();
    edit('third.ts', `export const unrelated = 3;\n`);
    const db = openDatabase(config.resolved_state_dir);
    try {
      const row = await db.selectFrom('files').select('mtime').where('path', '=', 'third.ts').executeTakeFirstOrThrow();

      await checkAndRefreshIfStale(db, config, 'third.ts', row.mtime);
    } finally {
      await db.destroy();
    }

    expect(await stored()).toEqual({ edges: 0, verdicts: 0 });
  });

  it('a second pass removes an edge the first stored and no longer finds', async () => {
    // An index the pass ran on before D154 holds callers that do not call, and
    // no file has to change for them to be wrong.
    await indexWithCheckerResults();
    const db = openDatabase(config.resolved_state_dir);
    try {
      const [multiplySym] = await querySymbolByName(db, 'multiply', 'math.ts');
      await db
        .insertInto('edges')
        .values({ from_id: multiplySym!.id, to_id: multiplySym!.id, edge_type: 'POTENTIAL_CALL', resolution: 'checker', call_line: 1, context: '' })
        .execute();
    } finally {
      await db.destroy();
    }

    await runPass();

    expect((await stored()).edges).toBe(1);
  });

  it('stores nothing and says so when a file is written while the pass is working', async () => {
    await indexWithCheckerResults();
    let written = false;

    const result = await runPass((db) => {
      if (written) return;
      written = true;
      // Queued on the pass's connection ahead of its next statement.
      void db.updateTable('files').set((eb) => ({ mtime: eb('mtime', '+', 1) })).where('path', '=', 'third.ts').execute();
    });

    expect(result.indexChangedDuringPass).toBe(true);
    expect(await stored()).toEqual({ edges: 0, verdicts: 0 });
  });
});
