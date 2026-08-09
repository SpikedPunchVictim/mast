import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Sqlite from 'better-sqlite3';
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
// stale AND the JIT write is genuinely contended, the tool is about to hand
// back stale line coordinates and must say so. This suite forces the real
// condition — a genuinely stale file plus a genuinely contended write —
// rather than stubbing checkAndRefreshIfStale, so it proves the wiring, not
// a mock of it.
//
// F11 (`IMPLEMENTATION_PLAN.md` "Replace fail-fast advisory locking") removed
// `structure.lock` from the JIT path entirely, so holding that advisory lock
// (this suite's pre-F11 forcing mechanism, `holdStructureLock` below) no
// longer contends with anything here — see the "F11 inversion" describe
// block for the regression test that proves exactly that. The busy-forcing
// mechanism for the F2/F14 suites below is now `holdWriteLock`: a second raw
// better-sqlite3 connection to the SAME `graph.db` holding a genuine
// `BEGIN IMMEDIATE` write reservation, which `populateFile`'s own
// `BEGIN IMMEDIATE` transaction (`graph/populate.ts`) now contends against
// directly. Mirrors `mcp/__tests__/staleness.test.ts`'s second-real-connection
// technique for F13.
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
  // Dedicated fixture for the F11 inversion test below — kept separate from
  // busy.ts/twin-*.ts so that test's assertion on a NEWLY-added export name
  // cannot collide with mutations the other tests in this suite make to
  // their own fixtures.
  const INVERSION_SRC = `export function invertedFn(x: number): number {\n  return x;\n}\n`;

  beforeAll(async () => {
    busyTmpDir = mkdtempSync(join(tmpdir(), 'mast-busy-test-'));
    writeFileSync(join(busyTmpDir, 'busy.ts'), BUSY_SRC);
    writeFileSync(join(busyTmpDir, 'busy-caller.ts'), BUSY_CALLER_SRC);
    writeFileSync(join(busyTmpDir, 'twin-a.ts'), TWIN_A_SRC);
    writeFileSync(join(busyTmpDir, 'twin-b.ts'), TWIN_B_SRC);
    writeFileSync(join(busyTmpDir, 'inversion.ts'), INVERSION_SRC);

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

  /**
   * Hold `structure.lock` — the PRE-F11 forcing mechanism. Kept only for the
   * "F11 inversion" regression test below, which exists specifically to
   * prove this advisory lock no longer gates the JIT path at all. Every
   * other test in this suite uses {@link holdWriteLock} instead, which
   * forces the condition that actually matters post-F11.
   */
  async function holdStructureLock(): Promise<() => Promise<void>> {
    return acquireLock(busyConfig.resolved_state_dir, 'structure', { maxRetries: 0 });
  }

  /**
   * Hold a REAL SQLite write reservation against `busyConfig`'s `graph.db`
   * via a second raw better-sqlite3 connection — the genuine contention
   * `populateFile`'s own `BEGIN IMMEDIATE` transaction (`graph/populate.ts`)
   * now loses to when this suite forces a busy outcome (F11). Synchronous,
   * unlike `holdStructureLock`: `better-sqlite3`'s `BEGIN IMMEDIATE` either
   * acquires the write reservation immediately or throws — there is no
   * retry/backoff to await.
   */
  function holdWriteLock(): () => void {
    const raw = new Sqlite(join(busyConfig.resolved_state_dir, 'graph.db'));
    raw.pragma('journal_mode = WAL');
    raw.exec('begin immediate');
    return () => {
      raw.exec('rollback');
      raw.close();
    };
  }

  describe.each([
    { tool: 'mast_exports', args: { file_path: 'busy.ts' } },
    { tool: 'mast_dependencies', args: { file_path: 'busy.ts' } },
    { tool: 'mast_callers', args: { symbol: 'busyFn', file_path: 'busy.ts' } },
    { tool: 'mast_rename_impact', args: { symbol: 'busyFn', file_path: 'busy.ts' } },
  ])('$tool — envelope-level flag', ({ tool, args }) => {
    it('sets file_busy_returning_stale_cache: true when the file is stale and the write is genuinely contended', async () => {
      makeStale('busy.ts', BUSY_SRC + '// touched\n');
      const release = holdWriteLock();
      try {
        const res = (await busyCall(tool, args)) as Record<string, unknown>;
        expect(res.file_busy_returning_stale_cache).toBe(true);
      } finally {
        release();
      }
    });

    it('omits file_busy_returning_stale_cache entirely once the write is free (not merely false)', async () => {
      // The previous test left busy.ts stale but released the write lock —
      // this call's own JIT refresh succeeds, so the flag must be absent, not
      // present-and-false.
      const res = (await busyCall(tool, args)) as Record<string, unknown>;
      expect(res).not.toHaveProperty('file_busy_returning_stale_cache');
    });
  });

  describe('mast_signature — per-result flag', () => {
    it('flags only the result whose file is stale+contended, leaving the other result untouched', async () => {
      makeStale('twin-a.ts', TWIN_A_SRC + '// touched\n');
      const release = holdWriteLock();
      let res: { results: Array<{ file_path: string; file_busy_returning_stale_cache?: true }> };
      try {
        res = (await busyCall('mast_signature', { symbol: 'twinFn' })) as typeof res;
      } finally {
        release();
      }

      const fromA = res.results.find((r) => r.file_path === 'twin-a.ts');
      const fromB = res.results.find((r) => r.file_path === 'twin-b.ts');
      expect(fromA).toBeDefined();
      expect(fromB).toBeDefined();
      expect(fromA!.file_busy_returning_stale_cache).toBe(true);
      expect(fromB).not.toHaveProperty('file_busy_returning_stale_cache');
    });

    it('flags every result when file_path narrows to the stale+contended file', async () => {
      makeStale('busy.ts', BUSY_SRC + '// touched again\n');
      const release = holdWriteLock();
      let res: { results: Array<{ file_path: string; file_busy_returning_stale_cache?: true }> };
      try {
        res = (await busyCall('mast_signature', { symbol: 'busyFn', file_path: 'busy.ts' })) as typeof res;
      } finally {
        release();
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
    it('sets the envelope flag when file_path narrows to a stale+contended file and no symbol matches', async () => {
      makeStale('busy.ts', BUSY_SRC + '// touched for F14\n');
      const release = holdWriteLock();
      let res: { results: unknown[]; file_busy_returning_stale_cache?: true };
      try {
        res = (await busyCall('mast_signature', { symbol: 'noSuchSymbolF14', file_path: 'busy.ts' })) as typeof res;
      } finally {
        release();
      }

      expect(res.results).toEqual([]);
      expect(res.file_busy_returning_stale_cache).toBe(true);
    });

    it('omits the envelope flag on an empty result once the write is free (not merely false)', async () => {
      // busy.ts is still stale from the previous test, but this call's own
      // JIT refresh succeeds now the write is free — a genuinely-missing
      // symbol must come back as a clean empty result, no flag.
      const res = (await busyCall('mast_signature', { symbol: 'noSuchSymbolF14', file_path: 'busy.ts' })) as {
        results: unknown[];
      };
      expect(res.results).toEqual([]);
      expect(res).not.toHaveProperty('file_busy_returning_stale_cache');
    });

    it('does not duplicate the busy signal onto the envelope when results exist to carry it', async () => {
      makeStale('busy.ts', BUSY_SRC + '// touched again for F14\n');
      const release = holdWriteLock();
      let res: { results: Array<Record<string, unknown>> };
      try {
        res = (await busyCall('mast_signature', { symbol: 'busyFn', file_path: 'busy.ts' })) as typeof res;
      } finally {
        release();
      }

      expect(res.results.length).toBeGreaterThan(0);
      for (const r of res.results) {
        expect(r['file_busy_returning_stale_cache']).toBe(true);
      }
      expect(res).not.toHaveProperty('file_busy_returning_stale_cache');
    });
  });

  // ---------------------------------------------------------------------------
  // F11 inversion — the behavioral proof that structure.lock no longer gates
  // the JIT path (IMPLEMENTATION_PLAN.md "Replace fail-fast advisory
  // locking"). Pre-F11, holding structure.lock while a file was stale forced
  // `busy: true` (exactly what the F2/F14 tests above used to assert via
  // `holdStructureLock`). Post-F11, `checkAndRefreshIfStale` never calls
  // `acquireLock` at all, so holding that SAME advisory lock must have NO
  // effect on the JIT refresh: it should succeed outright, with no busy flag.
  // Asserting on a newly-added export name (not just "flag absent") proves a
  // real re-parse happened, rather than the weaker "staleness merely wasn't
  // detected" explanation for the same absent-flag observation.
  // ---------------------------------------------------------------------------
  describe('F11 inversion — holding the old structure.lock no longer gates JIT', () => {
    it('returns a REFRESHED result with no busy flag while structure.lock is held by another caller', async () => {
      makeStale('inversion.ts', INVERSION_SRC + 'export function invertedFnV2(x: number): number {\n  return x + 1;\n}\n');
      const release = await holdStructureLock();
      let res: { exports: Array<{ name: string }>; file_busy_returning_stale_cache?: true };
      try {
        res = (await busyCall('mast_exports', { file_path: 'inversion.ts' })) as typeof res;
      } finally {
        await release();
      }

      expect(res).not.toHaveProperty('file_busy_returning_stale_cache');
      expect(res.exports.some((e) => e.name === 'invertedFnV2')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // F11 bounded freeze — the hard-constraint proof (IMPLEMENTATION_PLAN.md's
  // "HARD CONSTRAINT ON F11 — busy_timeout IS the process-freeze window"):
  // populateFile's dedicated 200ms busy_timeout, not the inherited 5000ms
  // connection default, governs a genuinely contended JIT write. A 2000ms
  // ceiling is generous relative to the ~400-460ms worst case (F13's bounded
  // retry: 2 attempts x ~200ms busy_timeout each) while staying far below the
  // 5000ms default this test exists to prove is NOT in play.
  // ---------------------------------------------------------------------------
  describe('F11 bounded freeze — busy path resolves well under the old 5s inherited timeout', () => {
    it('returns busy-flagged in well under 2000ms wall-clock against a genuinely contended write', async () => {
      makeStale('busy.ts', BUSY_SRC + '// touched for bounded-freeze\n');
      const release = holdWriteLock();
      const startedAtMs = Date.now();
      try {
        const res = (await busyCall('mast_exports', { file_path: 'busy.ts' })) as Record<string, unknown>;
        const elapsedMs = Date.now() - startedAtMs;
        expect(res.file_busy_returning_stale_cache).toBe(true);
        expect(elapsedMs).toBeLessThan(2_000);
      } finally {
        release();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// F7/C1 — stat-and-flag staleness for mast_search / mast_implementors,
// surfaced as the `stale` field (GITNEXUS_COMPARISON.md §13.3, §13.7). C1
// split this off `file_busy_returning_stale_cache` — see MAST_SPEC.md §9.0's
// "Confidence signals (C1)" table.
//
// Unlike mast_signature's JIT re-parse (F2/F14 above, which keeps the
// `file_busy_returning_stale_cache` name — a refresh IS attempted there),
// mast_search and mast_implementors can return results spanning dozens of
// files, so instead of re-parsing (which would mean up to ~50
// structure.lock acquisitions per call and could invalidate the ranking
// that already selected these results) they only `statSync` each unique
// result file and flag it — no lock, no re-parse, no DB write, and
// therefore never actually "busy" in the other tools' sense. That means:
//   - no `holdStructureLock` needed anywhere in this suite (nothing ever
//     tries to acquire the lock for these two tools);
//   - staleness, once introduced, is NOT self-healing across calls — a
//     second call sees the same stale mtime and flags again (asserted
//     directly below), which is the "flag, don't refresh" contract.
//
// Runs in its own isolated project/db/ctx for the same reason as the F2
// suite above: forcing on-disk mtimes to the future would leak into other
// describe blocks' line-number assertions if they shared a fixture.
// ---------------------------------------------------------------------------

describe('F7/C1 — stat-and-flag staleness, `stale` field (mast_search / mast_implementors)', () => {
  let staleTmpDir: string;
  let staleConfig: ResolvedConfig;
  let staleDb: ReturnType<typeof openDatabase>;
  let staleCall: (name: string, args?: Record<string, unknown>) => Promise<unknown>;

  // Distinctive shared substring so a single lexical query hits both files
  // via the trigram FTS tokenizer (search/fts.ts) without also matching
  // unrelated fixture content from this file's other describe blocks.
  const ZORB_A_SRC = `export function zorbAlpha(a: number): number {\n  return a;\n}\n`;
  const ZORB_B_SRC = `export function zorbBeta(b: number): number {\n  return b;\n}\n`;

  const TWICE_SRC = `export function twiceQuark(n: number): number {\n  return n;\n}\n`;

  const HAPPY_SRC = `export function happyGlint(n: number): number {\n  return n;\n}\n`;

  const DELETED_SRC = `export function vanishSprocket(n: number): number {\n  return n;\n}\n`;

  // C1 regression fixture — a dedicated file so the "old field name is gone"
  // guard test doesn't couple to another test's stale-mtime state.
  const REGRESSION_SRC = `export function regressionWisp(n: number): number {\n  return n;\n}\n`;

  const WIDGET_IFACE_SRC = `export interface Widget {\n  render(): string;\n}\n`;
  const WIDGET_ALPHA_SRC = `import type { Widget } from './widget-iface';\n\nexport class WidgetAlpha implements Widget {\n  render(): string {\n    return 'alpha';\n  }\n}\n`;
  const WIDGET_BETA_SRC = `import type { Widget } from './widget-iface';\n\nexport class WidgetBeta implements Widget {\n  render(): string {\n    return 'beta';\n  }\n}\n`;

  const GADGET_IFACE_SRC = `export interface Gadget {\n  spin(): string;\n}\n`;
  const GADGET_ALPHA_SRC = `import type { Gadget } from './gadget-iface';\n\nexport class GadgetAlpha implements Gadget {\n  spin(): string {\n    return 'alpha';\n  }\n}\n`;
  const GADGET_BETA_SRC = `import type { Gadget } from './gadget-iface';\n\nexport class GadgetBeta implements Gadget {\n  spin(): string {\n    return 'beta';\n  }\n}\n`;

  beforeAll(async () => {
    staleTmpDir = mkdtempSync(join(tmpdir(), 'mast-stale-f7-test-'));
    writeFileSync(join(staleTmpDir, 'zorb-a.ts'), ZORB_A_SRC);
    writeFileSync(join(staleTmpDir, 'zorb-b.ts'), ZORB_B_SRC);
    writeFileSync(join(staleTmpDir, 'twice-src.ts'), TWICE_SRC);
    writeFileSync(join(staleTmpDir, 'happy-src.ts'), HAPPY_SRC);
    writeFileSync(join(staleTmpDir, 'deleted-src.ts'), DELETED_SRC);
    writeFileSync(join(staleTmpDir, 'regression-src.ts'), REGRESSION_SRC);
    writeFileSync(join(staleTmpDir, 'widget-iface.ts'), WIDGET_IFACE_SRC);
    writeFileSync(join(staleTmpDir, 'widget-alpha.ts'), WIDGET_ALPHA_SRC);
    writeFileSync(join(staleTmpDir, 'widget-beta.ts'), WIDGET_BETA_SRC);
    writeFileSync(join(staleTmpDir, 'gadget-iface.ts'), GADGET_IFACE_SRC);
    writeFileSync(join(staleTmpDir, 'gadget-alpha.ts'), GADGET_ALPHA_SRC);
    writeFileSync(join(staleTmpDir, 'gadget-beta.ts'), GADGET_BETA_SRC);

    staleConfig = resolveConfig({ projectRoot: staleTmpDir });
    await runIndex(staleConfig, { incremental: false });

    staleDb = openDatabase(staleConfig.resolved_state_dir);

    const staleCtx: AppContext = {
      db: staleDb,
      chunkStore: new SqliteChunkStore(staleDb),
      config: staleConfig,
      sessionId: 'stale-f7-test-session',
    };

    const mock = createMockServer();
    registerSearchTool(mock.server, staleCtx);
    registerImplementorsTool(mock.server, staleCtx);
    staleCall = mock.call;
  });

  afterAll(async () => {
    await staleDb.destroy();
    rmSync(staleTmpDir, { recursive: true, force: true });
  });

  /**
   * Rewrite `relPath` and force its disk mtime strictly past the indexed
   * mtime, so `findStaleFiles` sees it as stale regardless of the
   * filesystem's mtime resolution.
   */
  function makeStale(relPath: string, newContent: string): void {
    writeFileSync(join(staleTmpDir, relPath), newContent);
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(staleTmpDir, relPath), future, future);
  }

  describe('mast_search', () => {
    it('flags results from the stale file only, leaving the fresh file\'s results untouched', async () => {
      makeStale('zorb-a.ts', ZORB_A_SRC + '// touched\n');

      const res = (await staleCall('mast_search', { query: 'zorb' })) as {
        results: Array<{ file_path: string; symbol_name: string | null; stale?: true }>;
      };

      const fromA = res.results.find((r) => r.file_path === 'zorb-a.ts');
      const fromB = res.results.find((r) => r.file_path === 'zorb-b.ts');
      expect(fromA).toBeDefined();
      expect(fromB).toBeDefined();
      expect(fromA!.symbol_name).toBe('zorbAlpha');
      expect(fromB!.symbol_name).toBe('zorbBeta');
      expect(fromA!.stale).toBe(true);
      expect(fromB).not.toHaveProperty('stale');
    });

    it('flags again on a second call — stat-and-flag does not refresh the index', async () => {
      makeStale('twice-src.ts', TWICE_SRC + '// touched once\n');

      const first = (await staleCall('mast_search', { query: 'twiceQuark' })) as {
        results: Array<{ file_path: string; stale?: true }>;
      };
      const second = (await staleCall('mast_search', { query: 'twiceQuark' })) as {
        results: Array<{ file_path: string; stale?: true }>;
      };

      const firstMatch = first.results.find((r) => r.file_path === 'twice-src.ts');
      const secondMatch = second.results.find((r) => r.file_path === 'twice-src.ts');
      expect(firstMatch).toBeDefined();
      expect(secondMatch).toBeDefined();
      expect(firstMatch!.stale).toBe(true);
      // Still flagged, not refreshed — if the JIT-refresh path had fired
      // instead, this second call's flag would have vanished.
      expect(secondMatch!.stale).toBe(true);
    });

    it('flags nothing on the happy path', async () => {
      const res = (await staleCall('mast_search', { query: 'happyGlint' })) as {
        results: Array<{ file_path: string; symbol_name: string | null }>;
      };

      const match = res.results.find((r) => r.file_path === 'happy-src.ts');
      expect(match).toBeDefined();
      expect(match!.symbol_name).toBe('happyGlint');
      for (const r of res.results) {
        expect(r).not.toHaveProperty('stale');
      }
    });

    it('flags results from a file deleted after indexing', async () => {
      rmSync(join(staleTmpDir, 'deleted-src.ts'));

      const res = (await staleCall('mast_search', { query: 'vanishSprocket' })) as {
        results: Array<{ file_path: string; symbol_name: string | null; stale?: true }>;
      };

      const match = res.results.find((r) => r.file_path === 'deleted-src.ts');
      expect(match).toBeDefined();
      expect(match!.symbol_name).toBe('vanishSprocket');
      expect(match!.stale).toBe(true);
    });

    // C1 regression guard: the split must stick. A stat-and-flag stale
    // result carries ONLY the new `stale` field — the old
    // `file_busy_returning_stale_cache` name (still live on the JIT tools,
    // F2/F14 above) must never reappear on a mast_search result.
    it('never carries the old file_busy_returning_stale_cache name on a stale result', async () => {
      makeStale('regression-src.ts', REGRESSION_SRC + '// touched\n');

      const res = (await staleCall('mast_search', { query: 'regressionWisp' })) as {
        results: Array<{ file_path: string; stale?: true; file_busy_returning_stale_cache?: true }>;
      };

      const match = res.results.find((r) => r.file_path === 'regression-src.ts');
      expect(match).toBeDefined();
      expect(match!.stale).toBe(true);
      expect(match).not.toHaveProperty('file_busy_returning_stale_cache');
    });
  });

  describe('mast_implementors', () => {
    it('flags only the implementor whose file is stale, leaving the other implementor untouched', async () => {
      makeStale('widget-alpha.ts', WIDGET_ALPHA_SRC + '// touched\n');

      const res = (await staleCall('mast_implementors', { interface_name: 'Widget' })) as {
        results: Array<{ class_name: string; file_path: string; stale?: true }>;
      };

      const alpha = res.results.find((r) => r.class_name === 'WidgetAlpha');
      const beta = res.results.find((r) => r.class_name === 'WidgetBeta');
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      expect(alpha!.file_path).toBe('widget-alpha.ts');
      expect(beta!.file_path).toBe('widget-beta.ts');
      expect(alpha!.stale).toBe(true);
      expect(beta).not.toHaveProperty('stale');
    });

    it('flags nothing on the happy path', async () => {
      const res = (await staleCall('mast_implementors', { interface_name: 'Gadget' })) as {
        results: Array<{ class_name: string; file_path: string }>;
      };

      const alpha = res.results.find((r) => r.class_name === 'GadgetAlpha');
      const beta = res.results.find((r) => r.class_name === 'GadgetBeta');
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      for (const r of res.results) {
        expect(r).not.toHaveProperty('stale');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// M6 Part B (eval/GITNEXUS_COMPARISON.md §13.8 item 4): `index_empty` — every
// read tool with a primary result array attaches `index_empty: true` when
// (a) that result set came back empty AND (b) the `chunks` table has zero
// rows at that moment. Distinguishes "[] because nothing is indexed yet" from
// "[] because no match" — the exact ambiguity M6 names. Two fixtures:
//   - a genuinely empty index (indexed over zero files) — every empty-query
//     response below must carry `index_empty: true`.
//   - the SHARED, populated fixture from the top of this file (`call`) — a
//     no-match query must return empty results WITHOUT the flag, and a
//     with-results query must never carry it either.
// ---------------------------------------------------------------------------

describe('index_empty — M6 Part B', () => {
  describe('genuinely empty index (indexed over zero files)', () => {
    let emptyTmpDir: string;
    let emptyDb: ReturnType<typeof openDatabase>;
    let emptyCall: (name: string, args?: Record<string, unknown>) => Promise<unknown>;

    beforeAll(async () => {
      emptyTmpDir = mkdtempSync(join(tmpdir(), 'mast-empty-index-test-'));
      // No source files written. `runIndex` still completes a real (empty)
      // index run — `chunks` has zero rows, which is exactly the condition
      // `isIndexEmpty` (mcp/tools/_helpers.ts) checks, and stands in for the
      // legitimate §7.4 startup-ladder window (a never-indexed dir mid
      // background-reindex looks identical to a read tool: zero chunks).
      const emptyConfig = resolveConfig({ projectRoot: emptyTmpDir });
      await runIndex(emptyConfig, { incremental: false });

      emptyDb = openDatabase(emptyConfig.resolved_state_dir);
      const emptyCtx: AppContext = {
        db: emptyDb,
        chunkStore: new SqliteChunkStore(emptyDb),
        config: emptyConfig,
        sessionId: 'empty-index-test-session',
      };

      const mock = createMockServer();
      registerSearchTool(mock.server, emptyCtx);
      registerProjectSkeletonTool(mock.server, emptyCtx);
      registerExportsTool(mock.server, emptyCtx);
      registerSignatureTool(mock.server, emptyCtx);
      registerCallersTool(mock.server, emptyCtx);
      registerDependenciesTool(mock.server, emptyCtx);
      registerImplementorsTool(mock.server, emptyCtx);
      registerRenameImpactTool(mock.server, emptyCtx);
      emptyCall = mock.call;
    });

    afterAll(async () => {
      await emptyDb.destroy();
      rmSync(emptyTmpDir, { recursive: true, force: true });
    });

    it('mast_search sets index_empty: true on a zero-result query', async () => {
      const res = await emptyCall('mast_search', { query: 'anything' }) as { results: unknown[]; index_empty?: true };
      expect(res.results).toHaveLength(0);
      expect(res.index_empty).toBe(true);
    });

    it('mast_project_skeleton sets index_empty: true when files is empty', async () => {
      const res = await emptyCall('mast_project_skeleton', {}) as { files: unknown[]; index_empty?: true };
      expect(res.files).toHaveLength(0);
      expect(res.index_empty).toBe(true);
    });

    it('mast_exports sets index_empty: true for a file with no chunks', async () => {
      const res = await emptyCall('mast_exports', { file_path: 'nope.ts' }) as { exports: unknown[]; index_empty?: true };
      expect(res.exports).toHaveLength(0);
      expect(res.index_empty).toBe(true);
    });

    it('mast_signature sets index_empty: true on a zero-result query', async () => {
      const res = await emptyCall('mast_signature', { symbol: 'anything' }) as { results: unknown[]; index_empty?: true };
      expect(res.results).toHaveLength(0);
      expect(res.index_empty).toBe(true);
    });

    it('mast_callers sets index_empty: true when both verified and potential sets are empty', async () => {
      const res = await emptyCall('mast_callers', { symbol: 'anything' }) as {
        verified_callers: unknown[];
        potential_matches: unknown[];
        index_empty?: true;
      };
      expect(res.verified_callers).toHaveLength(0);
      expect(res.potential_matches).toHaveLength(0);
      expect(res.index_empty).toBe(true);
    });

    it('mast_dependencies sets index_empty: true for a file with no imports', async () => {
      const res = await emptyCall('mast_dependencies', { file_path: 'nope.ts' }) as { imports: unknown[]; index_empty?: true };
      expect(res.imports).toHaveLength(0);
      expect(res.index_empty).toBe(true);
    });

    it('mast_implementors sets index_empty: true on a zero-result query', async () => {
      const res = await emptyCall('mast_implementors', { interface_name: 'Anything' }) as { results: unknown[]; index_empty?: true };
      expect(res.results).toHaveLength(0);
      expect(res.index_empty).toBe(true);
    });

    it('mast_rename_impact sets index_empty: true when all four sections are empty', async () => {
      const res = await emptyCall('mast_rename_impact', { symbol: 'anything' }) as {
        declaration_sites: unknown[];
        verified_callers: unknown[];
        potential_matches: unknown[];
        barrel_exports: unknown[];
        index_empty?: true;
      };
      expect(res.declaration_sites).toHaveLength(0);
      expect(res.verified_callers).toHaveLength(0);
      expect(res.potential_matches).toHaveLength(0);
      expect(res.barrel_exports).toHaveLength(0);
      expect(res.index_empty).toBe(true);
    });
  });

  describe('populated index (shared fixture) — no-match and with-results queries never carry index_empty', () => {
    it('mast_search: a no-match query returns empty results without index_empty', async () => {
      const res = await call('mast_search', { query: 'zzzNoSuchThing' }) as { results: unknown[]; index_empty?: true };
      expect(res.results).toHaveLength(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_search: a with-results query never carries index_empty', async () => {
      const res = await call('mast_search', { query: 'add' }) as { results: unknown[]; index_empty?: true };
      expect(res.results.length).toBeGreaterThan(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_project_skeleton never carries index_empty against a populated index', async () => {
      const res = await call('mast_project_skeleton', {}) as { files: unknown[]; index_empty?: true };
      expect(res.files.length).toBeGreaterThan(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_exports: a known file with exports never carries index_empty', async () => {
      const res = await call('mast_exports', { file_path: 'math.ts' }) as { exports: unknown[]; index_empty?: true };
      expect(res.exports.length).toBeGreaterThan(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_signature: an unknown symbol returns empty results without index_empty', async () => {
      const res = await call('mast_signature', { symbol: 'zzzNoSuchSymbol' }) as { results: unknown[]; index_empty?: true };
      expect(res.results).toHaveLength(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_signature: a known symbol never carries index_empty', async () => {
      const res = await call('mast_signature', { symbol: 'add' }) as { results: unknown[]; index_empty?: true };
      expect(res.results.length).toBeGreaterThan(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_callers: an unknown symbol returns empty sets without index_empty', async () => {
      const res = await call('mast_callers', { symbol: 'zzzNoSuchSymbol' }) as {
        verified_callers: unknown[];
        potential_matches: unknown[];
        index_empty?: true;
      };
      expect(res.verified_callers).toHaveLength(0);
      expect(res.potential_matches).toHaveLength(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_callers: a with-results query never carries index_empty', async () => {
      const res = await call('mast_callers', { symbol: 'add' }) as { verified_callers: unknown[]; index_empty?: true };
      expect(res.verified_callers.length).toBeGreaterThan(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_dependencies: a file with no imports omits index_empty (non-empty index)', async () => {
      const res = await call('mast_dependencies', { file_path: 'math.ts' }) as { imports: unknown[]; index_empty?: true };
      expect(res.imports).toHaveLength(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_dependencies: a file with imports never carries index_empty', async () => {
      const res = await call('mast_dependencies', { file_path: 'calc.ts' }) as { imports: unknown[]; index_empty?: true };
      expect(res.imports.length).toBeGreaterThan(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_implementors: an unknown interface returns empty results without index_empty', async () => {
      const res = await call('mast_implementors', { interface_name: 'NoSuchInterfaceM6' }) as { results: unknown[]; index_empty?: true };
      expect(res.results).toHaveLength(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_implementors: a with-results query never carries index_empty', async () => {
      const res = await call('mast_implementors', { interface_name: 'Shape' }) as { results: unknown[]; index_empty?: true };
      expect(res.results.length).toBeGreaterThan(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_rename_impact: an unknown symbol returns empty sections without index_empty', async () => {
      const res = await call('mast_rename_impact', { symbol: 'zzzNoSuchSymbol' }) as {
        declaration_sites: unknown[];
        index_empty?: true;
      };
      expect(res.declaration_sites).toHaveLength(0);
      expect(res).not.toHaveProperty('index_empty');
    });

    it('mast_rename_impact: a with-results query never carries index_empty', async () => {
      const res = await call('mast_rename_impact', { symbol: 'add' }) as { declaration_sites: unknown[]; index_empty?: true };
      expect(res.declaration_sites.length).toBeGreaterThan(0);
      expect(res).not.toHaveProperty('index_empty');
    });
  });
});
