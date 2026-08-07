import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig, type ResolvedConfig } from '../../../store/config.js';
import { runIndex } from '../../../indexer/index.js';
import { openDatabase } from '../../../graph/db.js';
import { SqliteChunkStore } from '../../../store/sqliteChunkStore.js';
import { acquireLock } from '../../../store/lock.js';
import type { AppContext } from '../../context.js';
import { registerSearchTool } from '../search.js';
import { registerProjectSkeletonTool } from '../project-skeleton.js';
import { registerExportsTool } from '../exports.js';
import { registerSignatureTool } from '../signature.js';
import { registerCallersTool } from '../callers.js';
import { registerDependenciesTool } from '../dependencies.js';
import { registerImplementorsTool } from '../implementors.js';
import { registerStatusTool }    from '../status.js';
import { registerEfficiencyTool } from '../efficiency.js';
import { registerRenameImpactTool } from '../rename-impact.js';
import { TOKENIZER_LABEL } from '../../../telemetry/tokenizer.js';

// ---------------------------------------------------------------------------
// Fixture sources
// ---------------------------------------------------------------------------

const MATH_SRC = `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

function internalHelper(): void {}
`;

// Verified caller of `add` — gives mast_rename_impact a POTENTIAL_CALL edge.
const CALC_SRC = `import { add } from './math';

export function double(n: number): number {
  return add(n, n);
}
`;

// A single large file whose full-file token count genuinely dominates a
// single-chunk tool response — math.ts/models.ts are small enough that a
// verbose per-result JSON shape (rank, scores, snippet, etc.) can outweigh
// the whole file, which would make efficiency_ratio assertions about "chunks
// beat full files" meaningless on those fixtures.
const LARGE_SRC = Array.from(
  { length: 60 },
  (_, i) => `export function helper${i}(x: number): number {\n  return x + ${i};\n}\n`,
).join('\n');

const MODELS_SRC = `export interface Shape {
  area(): number;
  perimeter(): number;
}

export type Color = 'red' | 'green' | 'blue';

export class Circle implements Shape {
  constructor(private radius: number) {}

  area(): number {
    return Math.PI * this.radius * this.radius;
  }

  perimeter(): number {
    return 2 * Math.PI * this.radius;
  }
}
`;

// ---------------------------------------------------------------------------
// Mock McpServer — captures registered tool handlers for direct invocation
// ---------------------------------------------------------------------------

type AnyHandler = (args: Record<string, unknown>) => Promise<{ content: [{ type: string; text: string }] }>;

function createMockServer() {
  const handlers = new Map<string, AnyHandler>();

  const server = {
    tool(_name: string, _desc: string, _schema: unknown, handler: AnyHandler) {
      handlers.set(_name, handler);
    },
  } as unknown as McpServer;

  async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const h = handlers.get(name);
    if (h == null) throw new Error(`Tool "${name}" not registered`);
    const result = await h(args);
    return JSON.parse(result.content[0]!.text);
  }

  return { server, call };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let db: ReturnType<typeof openDatabase>;
let ctx: AppContext;
let call: (name: string, args?: Record<string, unknown>) => Promise<unknown>;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mast-tools-test-'));

  writeFileSync(join(tmpDir, 'math.ts'), MATH_SRC);
  writeFileSync(join(tmpDir, 'models.ts'), MODELS_SRC);
  // Rename-impact fixtures: a verified caller of `add` plus two barrels.
  writeFileSync(join(tmpDir, 'calc.ts'), CALC_SRC);
  writeFileSync(join(tmpDir, 'barrel.ts'), `export { Circle as Round } from './models';\n`);
  writeFileSync(join(tmpDir, 'star.ts'), `export * from './models';\n`);
  writeFileSync(join(tmpDir, 'large.ts'), LARGE_SRC);

  const config = resolveConfig({ projectRoot: tmpDir });
  await runIndex(config, { incremental: false });

  db = openDatabase(config.resolved_state_dir);

  ctx = {
    db,
    chunkStore: new SqliteChunkStore(db),
    config,
    sessionId: 'test-session',
  };

  const mock = createMockServer();
  registerSearchTool(mock.server, ctx);
  registerProjectSkeletonTool(mock.server, ctx);
  registerExportsTool(mock.server, ctx);
  registerSignatureTool(mock.server, ctx);
  registerCallersTool(mock.server, ctx);
  registerDependenciesTool(mock.server, ctx);
  registerImplementorsTool(mock.server, ctx);
  registerStatusTool(mock.server, ctx);
  registerEfficiencyTool(mock.server, ctx);
  registerRenameImpactTool(mock.server, ctx);

  call = mock.call;
});

afterAll(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * `recordToolCall` is fire-and-forget from a tool handler's perspective
 * (§14.3 "writes are non-blocking"). The underlying better-sqlite3 driver is
 * synchronous, so its write completes within a handful of microtasks; a
 * macrotask boundary is guaranteed to run after all of them, giving a
 * deterministic (not timing-dependent) way to observe the row it wrote.
 */
async function flushPendingMetricsWrite(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// mast_search
// ---------------------------------------------------------------------------

describe('mast_search', () => {
  it('returns results', async () => {
    const res = await call('mast_search', { query: 'add' }) as { results: unknown[]; _stats: unknown };
    expect(res.results.length).toBeGreaterThan(0);
    expect(res._stats).toMatchObject({ tool: 'mast_search' });
  });

  it('returns empty results for empty query', async () => {
    const res = await call('mast_search', { query: '' }) as { results: unknown[] };
    expect(res.results).toHaveLength(0);
  });

  it('file_pattern restricts results', async () => {
    const mathOnly = await call('mast_search', { query: 'function', file_pattern: 'math.ts' }) as { results: Array<{ file_path: string }> };
    expect(mathOnly.results.every((r) => r.file_path === 'math.ts')).toBe(true);
  });

  it('only_exported hides internalHelper', async () => {
    const exported = await call('mast_search', { query: 'Helper', only_exported: true }) as { results: Array<{ symbol_name: string | null }> };
    expect(exported.results.some((r) => r.symbol_name === 'internalHelper')).toBe(false);
  });

  // M1 (eval/GITNEXUS_COMPARISON.md §15.1): `is_exported` is `boolean` on the
  // `Chunk`/`ChunkRecord` domain type but SQLite's `chunks` table stores it as
  // 0|1 (BoolCol convention, graph/db.ts). SqliteChunkStore.getChunksByIds
  // converts back to `boolean` at the store boundary (store/sqliteChunkStore.ts)
  // — this asserts that conversion actually survives the full round trip
  // through fusedSearch, JSON.stringify in the tool handler, and JSON.parse
  // on the way back, not just at the store's own unit-test layer
  // (store/__tests__/sqliteChunkStore.test.ts covers that layer directly).
  it('is_exported round-trips as a real boolean, not 0|1, through the tool response', async () => {
    const exportedRes = await call('mast_search', { query: 'add' }) as {
      results: Array<{ symbol_name: string | null; is_exported: unknown }>;
    };
    const addResult = exportedRes.results.find((r) => r.symbol_name === 'add');
    expect(addResult).toBeDefined();
    expect(addResult!.is_exported).toBe(true);
    expect(typeof addResult!.is_exported).toBe('boolean');

    const privateRes = await call('mast_search', { query: 'internalHelper' }) as {
      results: Array<{ symbol_name: string | null; is_exported: unknown }>;
    };
    const helperResult = privateRes.results.find((r) => r.symbol_name === 'internalHelper');
    expect(helperResult).toBeDefined();
    expect(helperResult!.is_exported).toBe(false);
    expect(typeof helperResult!.is_exported).toBe('boolean');
  });

  it('limit is respected', async () => {
    const res = await call('mast_search', { query: 'a', limit: 2 }) as { results: unknown[] };
    expect(res.results.length).toBeLessThanOrEqual(2);
  });

  it('returns advisory suggestions on a zero-result query', async () => {
    const res = await call('mast_search', { query: 'adddd' }) as {
      results: unknown[];
      suggestions?: Array<{ symbol: string; file_path: string; reason: string }>;
    };
    expect(res.results).toHaveLength(0);
    expect(res.suggestions).toBeDefined();
    expect(res.suggestions!.length).toBeGreaterThan(0);
    expect(res.suggestions![0]).toMatchObject({
      symbol: expect.any(String),
      file_path: expect.any(String),
      reason: expect.any(String),
    });
  });

  it('omits the suggestions field when results are present', async () => {
    const res = await call('mast_search', { query: 'add' }) as { suggestions?: unknown };
    expect(res.suggestions).toBeUndefined();
  });

  it('computes a real, nonzero full-file token bound and a bounded efficiency ratio', async () => {
    // Regression test for the telemetry finding recorded in
    // IMPLEMENTATION_PLAN_VEXP.md §P (2026-07-15): estimateFullFileBound was
    // an unimplemented stub returning 0 for every recorded row, which made
    // efficiency_ratio a constant 0 and killed the mast_efficiency signal.
    // Targets large.ts (60 functions) specifically: on the tiny math.ts/
    // models.ts fixtures a single verbose result's JSON overhead can exceed
    // the whole file, which would make the "chunks beat full files" ratio
    // assertion below meaningless.
    const res = await call('mast_search', { query: 'helper42', file_pattern: 'large.ts' }) as {
      _stats: { tokens_full_file_upper_bound: number; efficiency_ratio: number };
    };
    expect(res._stats.tokens_full_file_upper_bound).toBeGreaterThan(0);
    expect(res._stats.efficiency_ratio).toBeGreaterThan(0);
    expect(res._stats.efficiency_ratio).toBeLessThanOrEqual(1);
  });

  it('records the query in args_json and the returned identity pairs in results_json', async () => {
    await call('mast_search', { query: 'add', limit: 3 });
    await flushPendingMetricsWrite();

    const row = await db
      .selectFrom('metrics')
      .selectAll()
      .where('tool_name', '=', 'mast_search')
      .where('session_id', '=', 'test-session')
      .orderBy('id', 'desc')
      .executeTakeFirst();

    expect(row).toBeDefined();
    const parsedArgs = JSON.parse(row!.args_json!) as { query: string; limit: number };
    expect(parsedArgs).toMatchObject({ query: 'add', limit: 3 });

    const parsedResults = JSON.parse(row!.results_json!) as Array<{ file_path: string; symbol_name: string | null }>;
    expect(parsedResults.length).toBeGreaterThan(0);
    expect(parsedResults[0]).toHaveProperty('file_path');
    expect(parsedResults[0]).toHaveProperty('symbol_name');
  });

  // Stage 6.3 — D-fire telemetry is persisted to `metrics.declex_json` for the
  // kill-switch/re-entry decision (M2 decision memo condition 3), but must
  // NEVER leak into the tool's own response payload (only `{mode, results,
  // suggestions}` is contracted, ast/types.ts's SearchResponse). `Circle` is
  // D-eligible (uppercase) and matches `models.ts`'s `Circle` class exactly,
  // so this exercises the D-fired path specifically, not just D-absent.
  it('records D-fire telemetry into metrics.declex_json without leaking a declex field into the response', async () => {
    const res = await call('mast_search', { query: 'Circle' }) as Record<string, unknown>;
    expect(Object.keys(res)).not.toContain('declex');
    expect(JSON.stringify(res)).not.toContain('declex');

    await flushPendingMetricsWrite();

    const row = await db
      .selectFrom('metrics')
      .selectAll()
      .where('tool_name', '=', 'mast_search')
      .where('session_id', '=', 'test-session')
      .orderBy('id', 'desc')
      .executeTakeFirst();

    expect(row).toBeDefined();
    expect(row!.declex_json).not.toBeNull();
    const parsedDeclex = JSON.parse(row!.declex_json!) as { fired: boolean };
    expect(parsedDeclex.fired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mast_project_skeleton
// ---------------------------------------------------------------------------

describe('mast_project_skeleton', () => {
  it('returns files with exported symbols', async () => {
    const res = await call('mast_project_skeleton') as { files: Array<{ file_path: string; exports: string[] }> };
    expect(res.files.length).toBeGreaterThan(0);
    const mathFile = res.files.find((f) => f.file_path === 'math.ts');
    expect(mathFile).toBeDefined();
    expect(mathFile!.exports).toContain('add');
    expect(mathFile!.exports).toContain('multiply');
  });

  it('directory scoping restricts to prefix', async () => {
    const res = await call('mast_project_skeleton', { directory: 'nonexistent' }) as { files: unknown[] };
    expect(res.files).toHaveLength(0);
  });

  it('file_pattern filters files', async () => {
    const res = await call('mast_project_skeleton', { file_pattern: 'math.ts' }) as { files: Array<{ file_path: string }> };
    expect(res.files.every((f) => f.file_path === 'math.ts')).toBe(true);
  });

  it('_stats is present', async () => {
    const res = await call('mast_project_skeleton') as { _stats: { tool: string } };
    expect(res._stats.tool).toBe('mast_project_skeleton');
  });
});

// ---------------------------------------------------------------------------
// mast_exports
// ---------------------------------------------------------------------------

describe('mast_exports', () => {
  it('returns exported symbols from math.ts', async () => {
    const res = await call('mast_exports', { file_path: 'math.ts' }) as { exports: Array<{ name: string; kind: string }> };
    expect(res.exports.length).toBeGreaterThan(0);
    const names = res.exports.map((e) => e.name);
    expect(names).toContain('add');
    expect(names).toContain('multiply');
  });

  it('does not include non-exported symbols', async () => {
    const res = await call('mast_exports', { file_path: 'math.ts' }) as { exports: Array<{ name: string }> };
    expect(res.exports.some((e) => e.name === 'internalHelper')).toBe(false);
  });

  it('returns exports from models.ts including interface and class', async () => {
    const res = await call('mast_exports', { file_path: 'models.ts' }) as { exports: Array<{ name: string; kind: string }> };
    const names = res.exports.map((e) => e.name);
    expect(names).toContain('Shape');
    expect(names).toContain('Circle');
    const circle = res.exports.find((e) => e.name === 'Circle');
    expect(circle?.kind).toBe('class');
  });

  it('does not include method chunks (methods surface via class_shell)', async () => {
    const res = await call('mast_exports', { file_path: 'models.ts' }) as { exports: Array<{ name: string | null; kind: string }> };
    expect(res.exports.some((e) => e.kind === 'method')).toBe(false);
  });

  it('signatures exclude function bodies (M2)', async () => {
    const res = await call('mast_exports', { file_path: 'math.ts' }) as { exports: Array<{ name: string; signature: string }> };
    const add = res.exports.find((e) => e.name === 'add')!;
    expect(add.signature).toContain('add(a: number, b: number): number');
    expect(add.signature).not.toContain('return a + b');
  });
});

// ---------------------------------------------------------------------------
// mast_signature
// ---------------------------------------------------------------------------

describe('mast_signature', () => {
  it('returns signature for a known symbol', async () => {
    const res = await call('mast_signature', { symbol: 'add' }) as { results: Array<{ symbol: string; line: number; signature: string }> };
    expect(res.results.length).toBeGreaterThan(0);
    const result = res.results[0]!;
    expect(result.symbol).toBe('add');
    expect(result.line).toBeGreaterThan(0);
    expect(result.signature).toContain('add');
  });

  it('file_path narrows to one result', async () => {
    const res = await call('mast_signature', { symbol: 'add', file_path: 'math.ts' }) as { results: Array<{ file_path: string }> };
    expect(res.results.every((r) => r.file_path === 'math.ts')).toBe(true);
  });

  it('returns empty results for unknown symbol', async () => {
    const res = await call('mast_signature', { symbol: 'doesNotExist' }) as { results: unknown[] };
    expect(res.results).toHaveLength(0);
  });

  it('_stats is present', async () => {
    const res = await call('mast_signature', { symbol: 'Circle' }) as { _stats: { tool: string } };
    expect(res._stats.tool).toBe('mast_signature');
  });

  it('returns a body-free signature with structured params and return type (M2)', async () => {
    const res = await call('mast_signature', { symbol: 'add', file_path: 'math.ts' }) as {
      results: Array<{ signature: string; params: Array<{ name: string; type: string }>; return_type: string | null }>;
    };
    const r = res.results[0]!;
    expect(r.signature).toContain('add(a: number, b: number): number');
    expect(r.signature).not.toContain('return');           // body excluded
    expect(r.params).toEqual([{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }]);
    expect(r.return_type).toBe('number');
  });

  it('a class signature is the declaration header, no member outline (M2)', async () => {
    const res = await call('mast_signature', { symbol: 'Circle', file_path: 'models.ts' }) as {
      results: Array<{ signature: string }>;
    };
    expect(res.results[0]!.signature).toContain('class Circle implements Shape');
    expect(res.results[0]!.signature).not.toContain('area(');
  });

  it('computes a real, nonzero full-file token bound and a bounded efficiency ratio', async () => {
    // Targets large.ts for the same reason as the mast_search variant above —
    // a single signature's response is small relative to a 60-function file.
    const res = await call('mast_signature', { symbol: 'helper42', file_path: 'large.ts' }) as {
      _stats: { tokens_full_file_upper_bound: number; efficiency_ratio: number };
    };
    expect(res._stats.tokens_full_file_upper_bound).toBeGreaterThan(0);
    expect(res._stats.efficiency_ratio).toBeGreaterThan(0);
    expect(res._stats.efficiency_ratio).toBeLessThanOrEqual(1);
  });

  it('records the symbol/file_path in args_json and the returned identity pairs in results_json', async () => {
    await call('mast_signature', { symbol: 'add', file_path: 'math.ts' });
    await flushPendingMetricsWrite();

    const row = await db
      .selectFrom('metrics')
      .selectAll()
      .where('tool_name', '=', 'mast_signature')
      .where('session_id', '=', 'test-session')
      .orderBy('id', 'desc')
      .executeTakeFirst();

    expect(row).toBeDefined();
    const parsedArgs = JSON.parse(row!.args_json!) as { symbol: string; file_path: string };
    expect(parsedArgs).toMatchObject({ symbol: 'add', file_path: 'math.ts' });

    const parsedResults = JSON.parse(row!.results_json!) as Array<{ file_path: string; symbol_name: string | null }>;
    expect(parsedResults).toEqual([{ file_path: 'math.ts', symbol_name: 'add' }]);
  });
});

// ---------------------------------------------------------------------------
// mast_callers
// ---------------------------------------------------------------------------

describe('mast_callers', () => {
  it('returns summary with verified and potential counts', async () => {
    const res = await call('mast_callers', { symbol: 'add' }) as {
      verified_callers: unknown[];
      potential_matches: unknown[];
      summary: { verified_count: number; potential_count: number; transitive: boolean };
    };
    expect(typeof res.summary.verified_count).toBe('number');
    expect(typeof res.summary.potential_count).toBe('number');
    expect(res.summary.transitive).toBe(false);
  });

  it('returns empty result for unknown symbol', async () => {
    const res = await call('mast_callers', { symbol: 'neverDefined' }) as {
      verified_callers: unknown[];
      potential_matches: unknown[];
    };
    expect(res.verified_callers).toHaveLength(0);
    expect(res.potential_matches).toHaveLength(0);
  });

  it('include_potential: false returns no potential_matches', async () => {
    const res = await call('mast_callers', { symbol: 'add', include_potential: false }) as {
      potential_matches: unknown[];
    };
    expect(res.potential_matches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mast_callers / mast_rename_impact — checker verdict filtering (Stage 1.2,
// `mast index --checker` consumption). Seeds a `checker_verdicts` row
// directly rather than running the real compiler — the classification logic
// itself (real ts.Program, alias-following, adversarial fixtures) is covered
// by src/graph/__tests__/checker-resolver.test.ts; this suite only proves the
// two tools *consume* a verdict correctly once one exists.
// ---------------------------------------------------------------------------

describe('mast_callers / mast_rename_impact — checker verdict filtering', () => {
  it('drops a checker-classified non_call_site candidate out of potential_matches and reports the count', async () => {
    const before = await call('mast_callers', { symbol: 'multiply' }) as {
      potential_matches: { file_path: string; line: number }[];
      summary: {
        potential_count: number;
        checker_classified_non_call_site: number;
        checker_classified_different_declaration: number;
      };
    };
    // Nothing has run `--checker` yet — both counts start honest-zero.
    expect(before.summary.checker_classified_non_call_site).toBe(0);
    expect(before.summary.checker_classified_different_declaration).toBe(0);
    expect(before.potential_matches.length).toBeGreaterThan(0);

    const target = before.potential_matches[0]!;
    const symbolRow = await db
      .selectFrom('symbols')
      .select('id')
      .where('name', '=', 'multiply')
      .where('kind', '!=', 'export')
      .executeTakeFirstOrThrow();
    const fileRow = await db
      .selectFrom('files')
      .select(['id', 'mtime'])
      .where('path', '=', target.file_path)
      .executeTakeFirstOrThrow();

    // Simulate what `runCheckerPass` would have written for this exact candidate.
    await db
      .insertInto('checker_verdicts')
      .values({
        queried_symbol_id: symbolRow.id,
        call_site_file_id: fileRow.id,
        call_site_line: target.line,
        verdict: 'non_call_site',
        call_site_mtime: fileRow.mtime,
      })
      .execute();

    const after = await call('mast_callers', { symbol: 'multiply' }) as {
      potential_matches: { file_path: string; line: number }[];
      summary: {
        potential_count: number;
        checker_classified_non_call_site: number;
        checker_classified_different_declaration: number;
      };
    };

    expect(after.potential_matches.some((m) => m.file_path === target.file_path && m.line === target.line)).toBe(false);
    expect(after.summary.potential_count).toBe(before.summary.potential_count - 1);
    expect(after.summary.checker_classified_non_call_site).toBe(1);
    expect(after.summary.checker_classified_different_declaration).toBe(0);
  });

  it('mast_rename_impact reports the same checker-classified count for the same symbol', async () => {
    // The verdict seeded in the previous test is still live in `db` — both
    // tools share `collectPotentialMatches`, so they must agree.
    const res = await call('mast_rename_impact', { symbol: 'multiply' }) as {
      summary: { checker_classified_non_call_site: number };
    };
    expect(res.summary.checker_classified_non_call_site).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mast_dependencies
// ---------------------------------------------------------------------------

describe('mast_dependencies', () => {
  it('returns file_path and imports array', async () => {
    const res = await call('mast_dependencies', { file_path: 'math.ts' }) as {
      file_path: string;
      imports: unknown[];
    };
    expect(res.file_path).toBe('math.ts');
    expect(Array.isArray(res.imports)).toBe(true);
  });

  it('returns empty imports for a file with no imports', async () => {
    const res = await call('mast_dependencies', { file_path: 'math.ts' }) as {
      imports: unknown[];
    };
    // math.ts fixture has no imports.
    expect(res.imports).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mast_implementors
// ---------------------------------------------------------------------------

describe('mast_implementors', () => {
  it('returns Circle as implementor of Shape', async () => {
    const res = await call('mast_implementors', { interface_name: 'Shape' }) as {
      results: Array<{ class_name: string; file_path: string; methods: string[] }>;
    };
    expect(res.results.length).toBeGreaterThan(0);
    const circle = res.results.find((r) => r.class_name === 'Circle');
    expect(circle).toBeDefined();
    expect(circle!.file_path).toBe('models.ts');
    expect(circle!.methods.length).toBeGreaterThan(0);
  });

  it('returns empty for unknown interface', async () => {
    const res = await call('mast_implementors', { interface_name: 'NoSuchInterface' }) as {
      results: unknown[];
    };
    expect(res.results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mast_rename_impact
// ---------------------------------------------------------------------------

interface RenameImpactResult {
  symbol: string;
  declaration_sites: Array<{ file_path: string; line: number; kind: string }>;
  verified_callers: Array<{ file_path: string; caller_symbol: string }>;
  potential_matches: Array<{ file_path: string; line: number }>;
  barrel_exports: Array<{ file_path: string; exported_as: string; via: string }>;
  summary: {
    declaration_count: number;
    verified_count: number;
    potential_count: number;
    barrel_count: number;
    checklist: string;
  };
  _stats: { tool: string };
}

describe('mast_rename_impact', () => {
  it('lists the declaration site of the symbol', async () => {
    const res = await call('mast_rename_impact', { symbol: 'add' }) as RenameImpactResult;
    expect(res.symbol).toBe('add');
    expect(res.declaration_sites.some((d) => d.file_path === 'math.ts')).toBe(true);
  });

  it('reports verified callers from the graph', async () => {
    const res = await call('mast_rename_impact', { symbol: 'add' }) as RenameImpactResult;
    expect(res.verified_callers.some(
      (c) => c.file_path === 'calc.ts' && c.caller_symbol === 'double',
    )).toBe(true);
    expect(res.summary.verified_count).toBe(res.verified_callers.length);
  });

  it('reports identifier near-misses as review-required potential matches', async () => {
    const res = await call('mast_rename_impact', { symbol: 'add' }) as RenameImpactResult;
    // The declaration chunk itself mentions `add` without a resolved edge —
    // on a rename it genuinely needs editing, so it belongs in the checklist.
    expect(res.potential_matches.length).toBeGreaterThan(0);
    expect(res.summary.potential_count).toBe(res.potential_matches.length);
  });

  it('reports named and star barrel exports needing updates', async () => {
    const res = await call('mast_rename_impact', { symbol: 'Circle' }) as RenameImpactResult;

    const named = res.barrel_exports.find((b) => b.file_path === 'barrel.ts');
    expect(named).toMatchObject({ exported_as: 'Round', via: 'named' });

    const star = res.barrel_exports.find((b) => b.file_path === 'star.ts');
    expect(star).toMatchObject({ via: 'star' });
    expect(res.summary.barrel_count).toBe(res.barrel_exports.length);
  });

  it('summary carries a human-readable checklist string', async () => {
    const res = await call('mast_rename_impact', { symbol: 'add' }) as RenameImpactResult;
    expect(res.summary.checklist).toContain('verified');
    expect(res.summary.checklist).toContain('review');
    expect(res.summary.checklist).toContain('barrel');
  });

  it('returns empty sections for an unknown symbol', async () => {
    const res = await call('mast_rename_impact', { symbol: 'neverDefined' }) as RenameImpactResult;
    expect(res.declaration_sites).toHaveLength(0);
    expect(res.verified_callers).toHaveLength(0);
    expect(res.potential_matches).toHaveLength(0);
    expect(res.barrel_exports).toHaveLength(0);
  });

  it('supports qualified method names like mast_callers does', async () => {
    const res = await call('mast_rename_impact', { symbol: 'Circle.area' }) as RenameImpactResult;
    expect(res.declaration_sites.some((d) => d.file_path === 'models.ts')).toBe(true);
  });

  it('attaches _stats like every read tool', async () => {
    const res = await call('mast_rename_impact', { symbol: 'add' }) as RenameImpactResult;
    expect(res._stats.tool).toBe('mast_rename_impact');
  });
});

// ---------------------------------------------------------------------------
// mast_status
// ---------------------------------------------------------------------------

describe('mast_status', () => {
  it('returns valid status snapshot', async () => {
    const res = await call('mast_status') as {
      indexed_files: number;
      chunk_count: number;
      stale_files: number;
      index_fresh: boolean;
    };
    expect(res.indexed_files).toBeGreaterThan(0);
    expect(res.chunk_count).toBeGreaterThan(0);
    expect(res.stale_files).toBe(0);
    expect(res.index_fresh).toBe(true);
  });

  it('reports a null freshness_cause when fully fresh', async () => {
    const res = await call('mast_status') as {
      freshness_cause: string | null;
    };
    expect(res.freshness_cause).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mast_efficiency
// ---------------------------------------------------------------------------

describe('mast_efficiency', () => {
  it('returns a valid session efficiency result (empty session)', async () => {
    const res = await call('mast_efficiency', { scope: 'session' }) as {
      scope: string;
      calls_total: number;
      tokens_returned: number;
      efficiency_ratio: number;
      calls_by_tool: Record<string, number>;
      counterfactual: string;
      tokenizer: string;
    };
    expect(res.scope).toBe('session');
    expect(typeof res.calls_total).toBe('number');
    expect(typeof res.tokens_returned).toBe('number');
    expect(typeof res.efficiency_ratio).toBe('number');
    // Single source of truth: the tool must report exactly the shared label.
    expect(res.tokenizer).toBe(TOKENIZER_LABEL);
    expect(typeof res.counterfactual).toBe('string');
  });

  it('returns a valid global efficiency result', async () => {
    // Run a search so there is at least one metric row to aggregate.
    await call('mast_search', { query: 'add' });

    const res = await call('mast_efficiency', { scope: 'global' }) as {
      scope: string;
      calls_total: number;
    };
    expect(res.scope).toBe('global');
    // The recordToolCall from mast_search is fire-and-forget; it may not have
    // completed before this call, so we only assert on shape, not count.
    expect(typeof res.calls_total).toBe('number');
  });

  it('since_minutes limits the global window', async () => {
    const res = await call('mast_efficiency', { scope: 'global', since_minutes: 60 }) as {
      scope: string;
      window_started_at: string;
    };
    expect(res.scope).toBe('global');
    // window_started_at should be within the last hour
    const windowTs = new Date(res.window_started_at).getTime();
    expect(windowTs).toBeGreaterThan(Date.now() - 61 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// F2 — file_busy_returning_stale_cache wiring (GITNEXUS_COMPARISON.md §13.7)
//
// checkAndRefreshIfStale's `busy` result must reach the agent: when a file is
// stale AND structure.lock is genuinely held by someone else, the tool is
// about to hand back stale line coordinates and must say so. This suite
// forces the real condition — a genuinely stale file plus a genuinely held
// lock (see src/store/__tests__/lock.test.ts's `maxRetries: 0` pattern) —
// rather than stubbing checkAndRefreshIfStale, so it proves the wiring, not
// a mock of it.
//
// Runs in its own isolated project/db/ctx (not the shared `tmpDir` fixture
// above): forcing staleness mutates on-disk mtimes and DB rows, which would
// leak into the other describe blocks' line-number assertions.
// ---------------------------------------------------------------------------

describe('F2 — file_busy_returning_stale_cache', () => {
  let busyTmpDir: string;
  let busyConfig: ResolvedConfig;
  let busyDb: ReturnType<typeof openDatabase>;
  let busyCall: (name: string, args?: Record<string, unknown>) => Promise<unknown>;

  const BUSY_SRC = `export function busyFn(a: number): number {\n  return a;\n}\n`;
  const BUSY_CALLER_SRC = `import { busyFn } from './busy';\n\nexport function callBusy(n: number): number {\n  return busyFn(n);\n}\n`;
  // Same symbol name declared in two different files — lets the per-result
  // signature test prove ONE result carries the flag and the OTHER omits it,
  // rather than a blanket true/false on the whole array (§14.6: assert
  // values, not shape).
  const TWIN_A_SRC = `export function twinFn(x: number): number {\n  return x;\n}\n`;
  const TWIN_B_SRC = `export function twinFn(y: number): number {\n  return y;\n}\n`;

  beforeAll(async () => {
    busyTmpDir = mkdtempSync(join(tmpdir(), 'mast-busy-test-'));
    writeFileSync(join(busyTmpDir, 'busy.ts'), BUSY_SRC);
    writeFileSync(join(busyTmpDir, 'busy-caller.ts'), BUSY_CALLER_SRC);
    writeFileSync(join(busyTmpDir, 'twin-a.ts'), TWIN_A_SRC);
    writeFileSync(join(busyTmpDir, 'twin-b.ts'), TWIN_B_SRC);

    busyConfig = resolveConfig({ projectRoot: busyTmpDir });
    await runIndex(busyConfig, { incremental: false });

    busyDb = openDatabase(busyConfig.resolved_state_dir);

    const busyCtx: AppContext = {
      db: busyDb,
      chunkStore: new SqliteChunkStore(busyDb),
      config: busyConfig,
      sessionId: 'busy-test-session',
    };

    const mock = createMockServer();
    registerExportsTool(mock.server, busyCtx);
    registerDependenciesTool(mock.server, busyCtx);
    registerCallersTool(mock.server, busyCtx);
    registerRenameImpactTool(mock.server, busyCtx);
    registerSignatureTool(mock.server, busyCtx);
    busyCall = mock.call;
  });

  afterAll(async () => {
    await busyDb.destroy();
    rmSync(busyTmpDir, { recursive: true, force: true });
  });

  /**
   * Rewrite `relPath` and force its disk mtime strictly past the indexed
   * mtime, so `checkAndRefreshIfStale` sees it as stale regardless of the
   * filesystem's mtime resolution.
   */
  function makeStale(relPath: string, newContent: string): void {
    writeFileSync(join(busyTmpDir, relPath), newContent);
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(busyTmpDir, relPath), future, future);
  }

  /** Hold structure.lock so the JIT re-parse this test triggers cannot acquire it. */
  async function holdStructureLock(): Promise<() => Promise<void>> {
    return acquireLock(busyConfig.resolved_state_dir, 'structure', { maxRetries: 0 });
  }

  describe.each([
    { tool: 'mast_exports', args: { file_path: 'busy.ts' } },
    { tool: 'mast_dependencies', args: { file_path: 'busy.ts' } },
    { tool: 'mast_callers', args: { symbol: 'busyFn', file_path: 'busy.ts' } },
    { tool: 'mast_rename_impact', args: { symbol: 'busyFn', file_path: 'busy.ts' } },
  ])('$tool — envelope-level flag', ({ tool, args }) => {
    it('sets file_busy_returning_stale_cache: true when the file is stale and the lock is genuinely held', async () => {
      makeStale('busy.ts', BUSY_SRC + '// touched\n');
      const release = await holdStructureLock();
      try {
        const res = (await busyCall(tool, args)) as Record<string, unknown>;
        expect(res.file_busy_returning_stale_cache).toBe(true);
      } finally {
        await release();
      }
    });

    it('omits file_busy_returning_stale_cache entirely once the lock is free (not merely false)', async () => {
      // The previous test left busy.ts stale but released the lock — this
      // call's own JIT refresh succeeds, so the flag must be absent, not
      // present-and-false.
      const res = (await busyCall(tool, args)) as Record<string, unknown>;
      expect(res).not.toHaveProperty('file_busy_returning_stale_cache');
    });
  });

  describe('mast_signature — per-result flag', () => {
    it('flags only the result whose file is stale+locked, leaving the other result untouched', async () => {
      makeStale('twin-a.ts', TWIN_A_SRC + '// touched\n');
      const release = await holdStructureLock();
      let res: { results: Array<{ file_path: string; file_busy_returning_stale_cache?: true }> };
      try {
        res = (await busyCall('mast_signature', { symbol: 'twinFn' })) as typeof res;
      } finally {
        await release();
      }

      const fromA = res.results.find((r) => r.file_path === 'twin-a.ts');
      const fromB = res.results.find((r) => r.file_path === 'twin-b.ts');
      expect(fromA).toBeDefined();
      expect(fromB).toBeDefined();
      expect(fromA!.file_busy_returning_stale_cache).toBe(true);
      expect(fromB).not.toHaveProperty('file_busy_returning_stale_cache');
    });

    it('flags every result when file_path narrows to the stale+locked file', async () => {
      makeStale('busy.ts', BUSY_SRC + '// touched again\n');
      const release = await holdStructureLock();
      let res: { results: Array<{ file_path: string; file_busy_returning_stale_cache?: true }> };
      try {
        res = (await busyCall('mast_signature', { symbol: 'busyFn', file_path: 'busy.ts' })) as typeof res;
      } finally {
        await release();
      }

      expect(res.results.length).toBeGreaterThan(0);
      for (const r of res.results) {
        expect(r.file_busy_returning_stale_cache).toBe(true);
      }
    });

    it('omits the field entirely on the happy path', async () => {
      const res = (await busyCall('mast_signature', { symbol: 'twinFn' })) as {
        results: Array<Record<string, unknown>>;
      };
      expect(res.results.length).toBeGreaterThan(0);
      for (const r of res.results) {
        expect(r).not.toHaveProperty('file_busy_returning_stale_cache');
      }
    });
  });

  // F14 — with zero results there is no per-result carrier for the busy
  // signal, so "no results" + stale index would read as "symbol doesn't
  // exist". The envelope must carry the flag in exactly that case.
  describe('mast_signature — F14 empty-result envelope flag', () => {
    it('sets the envelope flag when file_path narrows to a stale+locked file and no symbol matches', async () => {
      makeStale('busy.ts', BUSY_SRC + '// touched for F14\n');
      const release = await holdStructureLock();
      let res: { results: unknown[]; file_busy_returning_stale_cache?: true };
      try {
        res = (await busyCall('mast_signature', { symbol: 'noSuchSymbolF14', file_path: 'busy.ts' })) as typeof res;
      } finally {
        await release();
      }

      expect(res.results).toEqual([]);
      expect(res.file_busy_returning_stale_cache).toBe(true);
    });

    it('omits the envelope flag on an empty result once the lock is free (not merely false)', async () => {
      // busy.ts is still stale from the previous test, but this call's own
      // JIT refresh succeeds now the lock is free — a genuinely-missing
      // symbol must come back as a clean empty result, no flag.
      const res = (await busyCall('mast_signature', { symbol: 'noSuchSymbolF14', file_path: 'busy.ts' })) as {
        results: unknown[];
      };
      expect(res.results).toEqual([]);
      expect(res).not.toHaveProperty('file_busy_returning_stale_cache');
    });

    it('does not duplicate the busy signal onto the envelope when results exist to carry it', async () => {
      makeStale('busy.ts', BUSY_SRC + '// touched again for F14\n');
      const release = await holdStructureLock();
      let res: { results: Array<Record<string, unknown>> };
      try {
        res = (await busyCall('mast_signature', { symbol: 'busyFn', file_path: 'busy.ts' })) as typeof res;
      } finally {
        await release();
      }

      expect(res.results.length).toBeGreaterThan(0);
      for (const r of res.results) {
        expect(r['file_busy_returning_stale_cache']).toBe(true);
      }
      expect(res).not.toHaveProperty('file_busy_returning_stale_cache');
    });
  });
});
