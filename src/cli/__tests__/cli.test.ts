/**
 * Stage 4 integration tests: CLI commands and full Phase 1 pipeline.
 *
 * Each `describe` block creates its own isolated temp directory so tests
 * never share state. Temp directories are removed in `afterAll`.
 *
 * Tests exercise the underlying functions that the CLI commands call rather
 * than shelling out to the binary — this avoids a build step and gives
 * accurate error messages.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig, writeStateConfig, loadStateConfig, CURRENT_SCHEMA_VERSION } from '../../store/config.js';
import { initLockMarkers, acquireLock, withLock } from '../../store/lock.js';
import { runIndex, loadIndexMeta, freshnessCause } from '../../indexer/index.js';
import { walkProject, diffManifest } from '../../indexer/walker.js';
import { openDatabase } from '../../graph/db.js';
import { SqliteChunkStore } from '../../store/sqliteChunkStore.js';
import { searchFts } from '../../search/fts.js';
import type { AppContext } from '../../mcp/context.js';
import { registerAllTools } from '../../mcp/register-tools.js';
import { runQuery, QueryError } from '../query.js';
import { parseExtensionsFlag, parseExcludeFlag } from '../init.js';
import { bootstrapState } from '../../mcp/startup.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const UTILS_SRC = `export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  private total = 0;

  add(n: number): void {
    this.total += n;
  }

  get result(): number {
    return this.total;
  }
}
`;

const TYPES_SRC = `export interface Config {
  name: string;
  value: number;
}

export type Id = string;
`;

const UTILS_V2_SRC = `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`;

// ---------------------------------------------------------------------------
// Full Phase 1 (`mast init` + `mast index`)
// ---------------------------------------------------------------------------

describe('full index', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-cli-test-'));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_SRC);
    writeFileSync(join(tmpDir, 'types.ts'), TYPES_SRC);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the state directory and config.json', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    initLockMarkers(config.resolved_state_dir);

    const result = await runIndex(config, { incremental: false });

    expect(result.filesIndexed).toBe(2);
    expect(result.parseErrors).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes index.json with correct file_count', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });

    const meta = loadIndexMeta(config.resolved_state_dir);
    expect(meta).not.toBeNull();
    expect(meta?.file_count).toBe(2);
    expect(meta?.last_indexed).toBeTruthy();
    expect(meta?.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('populates the graph database with symbols', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });

    const db = openDatabase(config.resolved_state_dir);
    try {
      const symbols = await db
        .selectFrom('symbols')
        .select('name')
        .execute();
      const names = new Set(symbols.map((s) => s.name));
      expect(names.has('Calculator')).toBe(true);
      expect(names.has('add')).toBe(true);
      expect(names.has('Config')).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it('populates the chunk store (graph.db, M1)', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });

    const db = openDatabase(config.resolved_state_dir);
    const count = await new SqliteChunkStore(db).chunkCount();
    await db.destroy();
    expect(count).toBeGreaterThan(0);
  });

  it('populates FTS so chunk content is searchable', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });

    const db = openDatabase(config.resolved_state_dir);
    try {
      const rows = await searchFts(db, 'Calculator', { limit: 5 });
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await db.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Incremental reindex (`mast index --incremental`)
// ---------------------------------------------------------------------------

describe('incremental reindex', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-cli-test-'));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_SRC);
    writeFileSync(join(tmpDir, 'types.ts'), TYPES_SRC);

    // Run full index first to establish the manifest baseline.
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('only reindexes files whose mtime changed', async () => {
    // Overwrite utils.ts — mtime will advance.
    await new Promise<void>((res) => setTimeout(res, 10));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_V2_SRC);

    const config = resolveConfig({ projectRoot: tmpDir });
    const result = await runIndex(config, { incremental: true });

    expect(result.filesIndexed).toBe(1);   // only utils.ts
    expect(result.filesSkipped).toBe(1);   // types.ts unchanged
    expect(result.parseErrors).toBe(0);
  });

  it('reflects updated symbols after incremental reindex', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const db = openDatabase(config.resolved_state_dir);
    try {
      // Calculator was in utils.ts v1; UTILS_V2_SRC replaced it with subtract.
      const symbols = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.name')
        .where('f.path', '=', 'utils.ts')
        .execute();
      const names = new Set(symbols.map((s) => s.name));

      expect(names.has('Calculator')).toBe(false);  // removed in v2
      expect(names.has('subtract')).toBe(true);      // added in v2
    } finally {
      await db.destroy();
    }
  });

  it('unchanged file symbols survive incremental reindex', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const db = openDatabase(config.resolved_state_dir);
    try {
      const sym = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.name')
        .where('f.path', '=', 'types.ts')
        .executeTakeFirst();
      expect(sym).toBeDefined();
    } finally {
      await db.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// `mast status` — accurate file count and staleness
// ---------------------------------------------------------------------------

describe('status — staleness detection', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-cli-test-'));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_SRC);
    writeFileSync(join(tmpDir, 'types.ts'), TYPES_SRC);

    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadIndexMeta returns accurate indexed file count', () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const meta = loadIndexMeta(config.resolved_state_dir);
    expect(meta?.file_count).toBe(2);
    expect(meta?.chunk_count).toBeGreaterThan(0);
  });

  it('reports stale_files = 0 immediately after indexing', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const manifestPath = join(config.resolved_state_dir, 'file_manifest.json');
    const { readFileSync, existsSync } = await import('node:fs');
    const prevManifest: Record<string, number> = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, number>)
      : {};

    const currentFiles = await walkProject(config);
    const { stale, added, deleted } = diffManifest(currentFiles, prevManifest);
    const staleCount = stale.length + added.length + deleted.length;

    expect(staleCount).toBe(0);
  });

  it('reports stale_files = 1 after modifying a file', async () => {
    await new Promise<void>((res) => setTimeout(res, 10));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_V2_SRC);

    const config = resolveConfig({ projectRoot: tmpDir });
    const manifestPath = join(config.resolved_state_dir, 'file_manifest.json');
    const { readFileSync } = await import('node:fs');
    const prevManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, number>;

    const currentFiles = await walkProject(config);
    const { stale, added, deleted } = diffManifest(currentFiles, prevManifest);
    const staleCount = stale.length + added.length + deleted.length;

    expect(staleCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// `mast status` — freshness cause
//
// Stage 7.2 (IMPLEMENTATION_PLAN.md "Stage 7: Vector-store deletion") removed
// the pending-embeddings count and, with it, `freshnessCause`'s second
// parameter and the `'embedding_backlog'`/`'both'` cases — the vector
// subsystem that could produce a distinct Phase 2 backlog was excised in
// Stage 7.1, so a two-cause signature asserted a distinction the code could
// no longer draw.
// ---------------------------------------------------------------------------

describe('freshnessCause', () => {
  it('maps the stale-file count to its cause', () => {
    expect(freshnessCause(0)).toBeNull();
    expect(freshnessCause(3)).toBe('phase1_stale');
  });
});

// ---------------------------------------------------------------------------
// Lock acquisition — concurrent write prevention
// ---------------------------------------------------------------------------

describe('concurrent write prevention', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-cli-test-'));
    initLockMarkers(tmpDir);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('first acquisition succeeds', async () => {
    const release = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    await release();
  });

  it('second acquisition fails while first is held', async () => {
    const release = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    try {
      await expect(
        acquireLock(tmpDir, 'structure', { maxRetries: 0 }),
      ).rejects.toThrow();
    } finally {
      await release();
    }
  });

  it('acquisition succeeds after lock is released', async () => {
    const r1 = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    await r1();

    const r2 = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    await r2();
  });

  it('withLock releases the lock on success', async () => {
    await withLock(tmpDir, 'structure', { maxRetries: 0 }, async () => {
      // lock is held here
    });
    // After withLock returns, lock should be released; re-acquiring must succeed.
    const r = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    await r();
  });

  it('withLock releases the lock on thrown error', async () => {
    await expect(
      withLock(tmpDir, 'structure', { maxRetries: 0 }, async () => {
        throw new Error('simulated failure');
      }),
    ).rejects.toThrow('simulated failure');

    // Lock must be released even after the throw.
    const r = await acquireLock(tmpDir, 'structure', { maxRetries: 0 });
    await r();
  });
});

// ---------------------------------------------------------------------------
// Deleted file cleanup
// ---------------------------------------------------------------------------

describe('deleted file cleanup', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-cli-test-'));
    writeFileSync(join(tmpDir, 'utils.ts'), UTILS_SRC);
    writeFileSync(join(tmpDir, 'types.ts'), TYPES_SRC);

    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes deleted file chunks from the chunk store on next index run', async () => {
    // Delete types.ts from disk.
    unlinkSync(join(tmpDir, 'types.ts'));

    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: true });

    const db = openDatabase(config.resolved_state_dir);
    const rows = await new SqliteChunkStore(db).getChunksByFilePath('types.ts');
    await db.destroy();
    expect(rows).toHaveLength(0);
  });

  it('removes deleted file rows from the graph database', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const db = openDatabase(config.resolved_state_dir);
    try {
      const file = await db
        .selectFrom('files')
        .select('id')
        .where('path', '=', 'types.ts')
        .executeTakeFirst();
      expect(file).toBeUndefined();

      // Cascaded to symbols too.
      const symbols = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.id')
        .where('f.path', '=', 'types.ts')
        .execute();
      expect(symbols).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it('removes deleted file rows from chunk_fts', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const db = openDatabase(config.resolved_state_dir);
    try {
      const rows = await searchFts(db, 'Config', { limit: 10 });
      // Config was defined in types.ts — should no longer appear in FTS.
      // After deletion the only surviving FTS rows are from utils.ts.
      // 'Config' is not in utils.ts — so FTS should return 0 hits.
      expect(rows).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });

  it('surviving file remains fully indexed after peer deletion', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const db = openDatabase(config.resolved_state_dir);
    try {
      const sym = await db
        .selectFrom('symbols as s')
        .innerJoin('files as f', 'f.id', 's.file_id')
        .select('s.name')
        .where('f.path', '=', 'utils.ts')
        .executeTakeFirst();
      expect(sym).toBeDefined();
    } finally {
      await db.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// `mast query <tool> <json>` — D0 (IMPLEMENTATION_PLAN.md "### D0 — CLI query
// surface"). These tests assert DISPATCH and SERIALIZATION parity only — that
// `runQuery` reaches the exact same registered MCP handler an MCP client would
// invoke, and returns its exact response text. Per-tool behavioral coverage
// already lives in mcp/tools/__tests__/tools.test.ts (§5.5 test budget) and is
// deliberately not duplicated here.
// ---------------------------------------------------------------------------

const QUERY_MATH_SRC = `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`;

// Verified caller of \`add\` — gives mast_rename_impact/mast_callers a
// POTENTIAL_CALL edge, same fixture shape mcp/tools/__tests__/tools.test.ts
// uses for the same purpose.
const QUERY_CALC_SRC = `import { add } from './math';

export function double(n: number): number {
  return add(n, n);
}
`;

const QUERY_MODELS_SRC = `export interface Shape {
  area(): number;
}

export class Circle implements Shape {
  constructor(private radius: number) {}

  area(): number {
    return Math.PI * this.radius * this.radius;
  }
}
`;

/**
 * Recursively zero every `duration_ms` field. `_stats.duration_ms` is wall-
 * clock timing captured independently by the CLI's own `runQuery` call and by
 * this suite's comparison call through a directly-registered handler — it
 * WILL differ between the two even when every other field is identical, so
 * comparing it would make the parity assertion flaky rather than meaningful
 * (task brief: "solve this honestly, compare after JSON.parse with duration
 * fields normalized").
 */
function normalizeDurations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDurations);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = key === 'duration_ms' ? 0 : normalizeDurations(v);
    }
    return out;
  }
  return value;
}

describe('mast query — dispatch/serialization parity', () => {
  let tmpDir: string;

  // The comparison path: register every tool against a real AppContext with a
  // capture object, exactly like mcp/tools/__tests__/tools.test.ts's
  // createMockServer — this is the independent "what would the MCP transport
  // have returned" oracle runQuery's output is checked against.
  let compareHandlers: Map<string, (args: Record<string, unknown>) => Promise<{ content: readonly [{ type: string; text: string }] }>>;
  let compareDb: ReturnType<typeof openDatabase>;

  async function compareCall(name: string, args: Record<string, unknown>): Promise<string> {
    const handler = compareHandlers.get(name);
    if (handler === undefined) throw new Error(`Tool "${name}" not registered`);
    const result = await handler(args);
    return result.content[0].text;
  }

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-query-cli-test-'));
    writeFileSync(join(tmpDir, 'math.ts'), QUERY_MATH_SRC);
    writeFileSync(join(tmpDir, 'calc.ts'), QUERY_CALC_SRC);
    writeFileSync(join(tmpDir, 'models.ts'), QUERY_MODELS_SRC);

    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });

    compareDb = openDatabase(config.resolved_state_dir);
    const compareCtx: AppContext = {
      db: compareDb,
      chunkStore: new SqliteChunkStore(compareDb),
      config,
      sessionId: 'query-parity-comparison-session',
    };

    compareHandlers = new Map();
    const captureServer = {
      tool(name: string, _description: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: readonly [{ type: string; text: string }] }>) {
        compareHandlers.set(name, handler);
      },
      // WHY `as unknown as McpServer`: registerAllTools's parameter type is the
      // real McpServer; `captureServer` only implements the one `tool(...)`
      // method every registerXTool call actually uses (verified across all 11
      // src/mcp/tools/*.ts call sites) — the same structural narrowing
      // mcp/tools/__tests__/tools.test.ts's createMockServer already relies on
      // to unit test handlers without a real MCP transport.
    } as unknown as McpServer;
    registerAllTools(captureServer, compareCtx);
  });

  afterAll(async () => {
    await compareDb.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe.each([
    { tool: 'mast_search', args: { query: 'add', limit: 5 } },
    { tool: 'mast_project_skeleton', args: {} },
    { tool: 'mast_exports', args: { file_path: 'math.ts' } },
    { tool: 'mast_signature', args: { symbol: 'add', file_path: 'math.ts' } },
    { tool: 'mast_callers', args: { symbol: 'add' } },
    { tool: 'mast_dependencies', args: { file_path: 'calc.ts' } },
    { tool: 'mast_implementors', args: { interface_name: 'Shape' } },
    { tool: 'mast_rename_impact', args: { symbol: 'add', file_path: 'math.ts' } },
    { tool: 'mast_status', args: {} },
  ])('$tool', ({ tool, args }) => {
    it('CLI --json output structurally matches the registered MCP handler output (duration_ms normalized)', async () => {
      const cliText = await runQuery(tool, JSON.stringify(args), { path: tmpDir });
      const expectedText = await compareCall(tool, args);

      expect(normalizeDurations(JSON.parse(cliText))).toEqual(
        normalizeDurations(JSON.parse(expectedText)),
      );
    });
  });

  // mast_efficiency is deliberately NOT in the describe.each above: every row
  // there fires an async, unawaited `recordToolCall` write (search/exports/
  // signature/callers/rename_impact all call it) against this SAME fixture's
  // metrics table, and `mast_efficiency`'s own response reads that table —
  // comparing it here would race those in-flight writes non-deterministically.
  // It gets its own isolated fixture below instead.
  it('mast_efficiency: CLI --json output matches the MCP handler output (isolated fixture, scope=global)', async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), 'mast-query-efficiency-test-'));
    try {
      writeFileSync(join(isolatedDir, 'math.ts'), QUERY_MATH_SRC);
      const config = resolveConfig({ projectRoot: isolatedDir });
      await runIndex(config, { incremental: false });

      const db = openDatabase(config.resolved_state_dir);
      try {
        const ctx: AppContext = {
          db,
          chunkStore: new SqliteChunkStore(db),
          config,
          sessionId: 'query-efficiency-comparison-session',
        };
        const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: readonly [{ type: string; text: string }] }>>();
        const captureServer = {
          tool(name: string, _description: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: readonly [{ type: string; text: string }] }>) {
            handlers.set(name, handler);
          },
        } as unknown as McpServer;
        registerAllTools(captureServer, ctx);

        // scope: 'global' with no since_minutes is timing-safe here — neither
        // call path writes a metrics row for mast_efficiency itself
        // (efficiency.ts never calls recordToolCall), and window_started_at
        // for that combination is the fixed epoch constant, not wall-clock
        // time, so no normalization is even needed for this one.
        const args = { scope: 'global' as const };
        const cliText = await runQuery('mast_efficiency', JSON.stringify(args), { path: isolatedDir });
        const expectedHandler = handlers.get('mast_efficiency');
        if (expectedHandler === undefined) throw new Error('mast_efficiency not registered');
        const expectedResult = await expectedHandler(args);

        expect(JSON.parse(cliText)).toEqual(JSON.parse(expectedResult.content[0].text));
      } finally {
        await db.destroy();
      }
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// `mast query` — error paths
// ---------------------------------------------------------------------------

describe('mast query — error paths', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-query-errors-test-'));
    writeFileSync(join(tmpDir, 'math.ts'), QUERY_MATH_SRC);
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects an unknown tool name and lists the available tools', async () => {
    await expect(runQuery('mast_does_not_exist', '{}', { path: tmpDir })).rejects.toThrow(QueryError);
    await expect(runQuery('mast_does_not_exist', '{}', { path: tmpDir })).rejects.toThrow(
      /unknown tool "mast_does_not_exist".*mast_search/s,
    );
  });

  it('rejects malformed JSON with a message naming the parse failure', async () => {
    await expect(runQuery('mast_status', '{not valid json', { path: tmpDir })).rejects.toThrow(QueryError);
    await expect(runQuery('mast_status', '{not valid json', { path: tmpDir })).rejects.toThrow(
      /malformed JSON argument/,
    );
  });

  it('rejects args that fail the tool\'s zod schema with the zod issues', async () => {
    await expect(
      runQuery('mast_search', JSON.stringify({ query: 42 }), { path: tmpDir }),
    ).rejects.toThrow(QueryError);
    await expect(
      runQuery('mast_search', JSON.stringify({ query: 42 }), { path: tmpDir }),
    ).rejects.toThrow(/invalid arguments for "mast_search"/);
  });

  it('rejects a state dir with no graph.db (never-indexed project)', async () => {
    const neverIndexedDir = mkdtempSync(join(tmpdir(), 'mast-query-never-indexed-test-'));
    try {
      await expect(runQuery('mast_status', '{}', { path: neverIndexedDir })).rejects.toThrow(QueryError);
      await expect(runQuery('mast_status', '{}', { path: neverIndexedDir })).rejects.toThrow(
        /no index found at/,
      );
    } finally {
      rmSync(neverIndexedDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F9 (Stage 3.5, eval/GITNEXUS_COMPARISON.md M3): `mast init --extensions` /
// `--exclude` are parsed and honoured — previously they were parsed and
// silently ignored, and `serve`'s bootstrap overwrote the persisted
// config.json with fresh defaults on every startup.
// ---------------------------------------------------------------------------

describe('mast init — --extensions/--exclude flag parsing (F9)', () => {
  it('parses a comma-separated extensions list, normalizing bare names to leading-dot form', () => {
    expect(parseExtensionsFlag('.py,ts')).toEqual(['.py', '.ts']);
  });

  it('parses a comma-separated exclude-pattern list without dot normalization', () => {
    expect(parseExcludeFlag('**/skipme.ts,**/fixtures/**')).toEqual(['**/skipme.ts', '**/fixtures/**']);
  });

  it('trims whitespace and drops empty entries for both flags', () => {
    expect(parseExtensionsFlag(' a , ,b ')).toEqual(['.a', '.b']);
    expect(parseExcludeFlag(' a , ,b ')).toEqual(['a', 'b']);
  });

  it('returns undefined when the flag is absent — flag absence keeps resolveConfig behavior byte-identical', () => {
    expect(parseExtensionsFlag(undefined)).toBeUndefined();
    expect(parseExcludeFlag(undefined)).toBeUndefined();
  });
});

describe('mast init — --extensions/--exclude end-to-end (F9, M3 repro inverted)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-init-flags-e2e-'));
    // Indexed: matches the custom `--extensions .js` scope.
    writeFileSync(join(tmpDir, 'ok.js'), 'export function ok() { return 1; }\n');
    // NOT indexed: a `.ts` file would be indexed under DEFAULTS.file_extensions,
    // but the custom `--extensions .js` narrows the scope to `.js` only — this
    // is what proves the flag is honoured, not just parsed.
    writeFileSync(join(tmpDir, 'ignored.ts'), 'export function ignored(): number { return 2; }\n');
    // NOT indexed: matches `--exclude '**/skipme.js'` despite being in scope.
    writeFileSync(join(tmpDir, 'skipme.js'), 'export function skip() { return 3; }\n');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes only the custom extension, honours the exclude pattern, and survives a serve-style bootstrap', async () => {
    // Equivalent of `mast init --extensions .js --exclude '**/skipme.js'`.
    const config = resolveConfig({
      projectRoot: tmpDir,
      extensions: parseExtensionsFlag('.js'),
      excludePatterns: parseExcludeFlag('**/skipme.js'),
    });

    initLockMarkers(config.resolved_state_dir);
    writeStateConfig(config.resolved_state_dir, config);
    const result = await runIndex(config, { incremental: false });

    // Only ok.js: ignored.ts is out of the custom extension scope, skipme.js
    // is excluded despite being in scope.
    expect(result.filesIndexed).toBe(1);

    const db = openDatabase(config.resolved_state_dir);
    try {
      const symbols = await db.selectFrom('symbols').select('name').execute();
      const names = new Set(symbols.map((s) => s.name));
      expect(names.has('ok')).toBe(true);
      expect(names.has('ignored')).toBe(false);
      expect(names.has('skip')).toBe(false);
    } finally {
      await db.destroy();
    }

    // Simulate `mast serve`'s bootstrap path (mcp/startup.ts's bootstrapState,
    // via cli/serve.ts:17's `resolveConfig({ stateDirOverride })` — no
    // projectRoot, so this re-resolution against the same state dir mirrors
    // what serve actually does). A nonexistent seed path is passed, same as
    // mcp/__tests__/startup.test.ts's `NO_SEED` convention, so the Docker-seed
    // copy step is a no-op in this test environment.
    const serveConfig = resolveConfig({ stateDirOverride: config.resolved_state_dir });
    await bootstrapState(serveConfig, join(tmpdir(), 'mast-no-such-seed-dir'));

    // The regression this proves: before F9, bootstrapState's writeStateConfig
    // call persisted a FRESH default resolution over the customization every
    // time `mast serve` started, silently discarding `--extensions`/`--exclude`.
    const persisted = loadStateConfig(config.resolved_state_dir);
    expect(persisted?.file_extensions).toEqual(['.js']);
    expect(persisted?.exclude_patterns).toEqual(['**/skipme.js']);
  });
});

// ---------------------------------------------------------------------------
// D1 — deterministic walk order (IMPLEMENTATION_PLAN.md Stage 4)
//
// fast-glob returns filesystem order, which varies between identical runs;
// edge insertion order feeds insertEdges' bare-name fallback resolution, so
// two identical index runs produced edge sets differing by ±4/3,940 (§15.5).
// walkProject now sorts by relativePath at the source. Honest red-phase note:
// the pre-fix order was ARBITRARY, not reliably unsorted, so this test cannot
// be guaranteed to fail on unfixed code — it is the executable spec of the
// new ordering contract, and the nondeterminism evidence lives in §15.5.
// ---------------------------------------------------------------------------

describe('D1 — walkProject deterministic ordering', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-walk-order-'));
    // Created in deliberately non-lexicographic order, across nested dirs.
    mkdirSync(join(tmpDir, 'zeta'), { recursive: true });
    mkdirSync(join(tmpDir, 'alpha', 'nested'), { recursive: true });
    writeFileSync(join(tmpDir, 'zeta', 'z.ts'), 'export const z = 1;\n');
    writeFileSync(join(tmpDir, 'mid.ts'), 'export const m = 1;\n');
    writeFileSync(join(tmpDir, 'alpha', 'nested', 'deep.ts'), 'export const d = 1;\n');
    writeFileSync(join(tmpDir, 'alpha', 'a.ts'), 'export const a = 1;\n');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns entries sorted lexicographically by relativePath', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const entries = await walkProject(config);

    const paths = entries.map((e) => e.relativePath);
    expect(paths).toEqual(['alpha/a.ts', 'alpha/nested/deep.ts', 'mid.ts', 'zeta/z.ts']);
  });

  it('two consecutive walks return identical orderings', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const first = (await walkProject(config)).map((e) => e.relativePath);
    const second = (await walkProject(config)).map((e) => e.relativePath);
    expect(second).toEqual(first);
    expect(first.length).toBe(4);
  });
});
