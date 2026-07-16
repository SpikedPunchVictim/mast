import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig } from '../../../store/config.js';
import { runIndex, runEmbed } from '../../../indexer/index.js';
import { openDatabase } from '../../../graph/db.js';
import { LanceStore } from '../../../store/lance.js';
import { JINA_V2_DIM, type EmbedderLike } from '../../../indexer/embedder.js';
import type { Chunk, VectorEntry } from '../../../ast/types.js';
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
// Fake embedder — deterministic, no ONNX runtime
// ---------------------------------------------------------------------------

function makeFakeEmbedder(): EmbedderLike {
  return {
    async load() {},
    async embed(chunks: readonly Chunk[]): Promise<VectorEntry[]> {
      return chunks.map((c, i) => ({
        chunk_id:      c.chunk_id,
        embedding:     Array.from({ length: JINA_V2_DIM }, (_, d) => d === i % JINA_V2_DIM ? 1 : 0),
        model_version: 'fake-1.0',
      }));
    },
    get dimension() { return JINA_V2_DIM; },
  };
}

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
let lance: LanceStore;
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
  await runEmbed(config, { embedder: makeFakeEmbedder() });

  db = openDatabase(config.resolved_state_dir);
  lance = await LanceStore.open(config.resolved_state_dir);

  ctx = {
    db,
    lance,
    config,
    getEmbedder: () => null,
    searchMode: () => 'lexical',
    embedPending: async () => {},
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
  it('returns results and mode', async () => {
    const res = await call('mast_search', { query: 'add' }) as { mode: string; results: unknown[]; _stats: unknown };
    expect(res.mode).toBe('lexical');
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
      embedding_mode: string;
    };
    expect(res.indexed_files).toBeGreaterThan(0);
    expect(res.chunk_count).toBeGreaterThan(0);
    expect(res.stale_files).toBe(0);
    expect(res.index_fresh).toBe(true);
    expect(res.embedding_mode).toBe('lexical');
  });

  it('reports no pending embeddings and a null freshness_cause when fully fresh', async () => {
    const res = await call('mast_status') as {
      pending_embeddings: number;
      freshness_cause: string | null;
    };
    expect(res.pending_embeddings).toBe(0);
    expect(res.freshness_cause).toBeNull();
  });

  it('reports an embedding backlog after a Phase-1-only index of a new file', async () => {
    // Runs last in this describe: it grows the corpus (Phase 1 only, no
    // embed), which is exactly the cold-start state §11.1 describes.
    writeFileSync(join(tmpDir, 'extra.ts'), 'export function extra(): number { return 42; }\n');
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: true });

    const res = await call('mast_status') as {
      stale_files: number;
      pending_embeddings: number;
      freshness_cause: string | null;
      index_fresh: boolean;
    };

    expect(res.stale_files).toBe(0);
    expect(res.pending_embeddings).toBeGreaterThan(0);
    expect(res.freshness_cause).toBe('embedding_backlog');
    // index_fresh keeps its Phase 1 meaning — the backlog does not flip it.
    expect(res.index_fresh).toBe(true);
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
