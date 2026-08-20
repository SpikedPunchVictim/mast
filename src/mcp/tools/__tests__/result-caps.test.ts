import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig } from '../../../store/config.js';
import { runIndex } from '../../../indexer/index.js';
import { openDatabase } from '../../../graph/db.js';
import { SqliteChunkStore } from '../../../store/sqliteChunkStore.js';
import type { AppContext } from '../../context.js';
import { registerExportsTool } from '../exports.js';
import { registerSignatureTool } from '../signature.js';
import { registerImplementorsTool } from '../implementors.js';
import { DEFAULT_RESULT_LIMIT } from '../_helpers.js';

// ---------------------------------------------------------------------------
// LEDGER D043 — three read tools returned unbounded result lists.
//
// Found by the integration harness's capture audit, because the input that
// triggers it does not exist in a small fixture: over n8n,
// `mast_signature{symbol:'execute'}` returned 580 results / 331,159 tokens after
// 78 s, and over MCP exceeded the SDK's 60 s timeout so the caller got an error
// instead of an answer. `mast_implementors` returned 625, `mast_exports` 370.
// The sibling `mast_callers` has capped its potential matches at 50 and reported
// `summary.potential_truncated` since F10 — the concern was understood and
// applied to one tool of four.
//
// These fixtures reproduce the SHAPE at fixture scale: enough same-named
// declarations, implementors, and exports to exceed a small cap. The n8n numbers
// are the motivation; this file is the pin.
//
// The truncation contract copied from F10 (`search/potential-matches.ts`), so
// all four tools agree:
//   * the field carries the REAL, UNCAPPED total — not the number omitted;
//   * it is OMITTED when nothing was truncated, never present-and-zero;
//   * an exactly-full page with no further matches is NOT truncation.
// ---------------------------------------------------------------------------

const OVER_CAP = DEFAULT_RESULT_LIMIT + 7;

type AnyHandler = (args: Record<string, unknown>) => Promise<{ content: [{ type: string; text: string }] }>;

function createMockServer() {
  const handlers = new Map<string, AnyHandler>();
  const server = {
    tool(name: string, _desc: string, _schema: unknown, handler: AnyHandler) { handlers.set(name, handler); },
  } as unknown as McpServer;
  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const h = handlers.get(name);
    if (h == null) throw new Error(`Tool "${name}" not registered`);
    return JSON.parse((await h(args)).content[0]!.text) as T;
  }
  return { server, call };
}

let tmpDir: string;
let db: ReturnType<typeof openDatabase>;
let call: <T>(name: string, args?: Record<string, unknown>) => Promise<T>;

/** Minimal shapes — only the fields these tests read, per the D4 assertion rule. */
type CappedResults = {
  readonly results: ReadonlyArray<{ readonly symbol?: string; readonly file_path?: string }>;
  readonly results_truncated?: number;
  readonly _stats: { readonly files_referenced: readonly string[] };
};
type CappedExports = {
  readonly exports: ReadonlyArray<{ readonly name: string }>;
  readonly exports_truncated?: number;
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mast-result-caps-'));

  // `collide` is declared once per file, in OVER_CAP files — the shape of
  // n8n's `execute`, which is a method name every node package defines.
  mkdirSync(join(tmpDir, 'many'), { recursive: true });
  for (let i = 0; i < OVER_CAP; i++) {
    writeFileSync(
      join(tmpDir, 'many', `m${i}.ts`),
      `export function collide(n: number): number {\n  return n + ${i};\n}\n`,
    );
  }

  // One interface with OVER_CAP implementors — the shape of n8n's `INodeType`.
  writeFileSync(join(tmpDir, 'iface.ts'), `export interface Wide {\n  run(): void;\n}\n`);
  mkdirSync(join(tmpDir, 'impls'), { recursive: true });
  for (let i = 0; i < OVER_CAP; i++) {
    writeFileSync(
      join(tmpDir, 'impls', `i${i}.ts`),
      `import type { Wide } from '../iface.js';\n\nexport class Impl${i} implements Wide {\n  run(): void {}\n}\n`,
    );
  }

  // One file exporting OVER_CAP symbols — the shape of n8n's interfaces.ts.
  writeFileSync(
    join(tmpDir, 'wide-exports.ts'),
    Array.from({ length: OVER_CAP }, (_, i) => `export function e${i}(): number {\n  return ${i};\n}\n`).join('\n'),
  );

  // A file whose export count is comfortably UNDER the cap — the not-truncated
  // arm. Without it these tests would only ever exercise the capped path, and
  // "omitted when not truncated" would be asserted nowhere.
  writeFileSync(join(tmpDir, 'narrow-exports.ts'), `export function only(): number {\n  return 1;\n}\n`);

  const config = resolveConfig({ projectRoot: tmpDir });
  await runIndex(config, { incremental: false });
  db = openDatabase(config.resolved_state_dir);

  const ctx: AppContext = { db, chunkStore: new SqliteChunkStore(db), config, sessionId: 'result-caps-test' };
  const mock = createMockServer();
  registerExportsTool(mock.server, ctx);
  registerSignatureTool(mock.server, ctx);
  registerImplementorsTool(mock.server, ctx);
  call = mock.call;
});

afterAll(async () => {
  await db.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('mast_signature result cap (D043)', () => {
  it('returns at most the default limit and reports the real uncapped total', async () => {
    const res = await call<CappedResults>('mast_signature', { symbol: 'collide' });

    expect(res.results.length).toBe(DEFAULT_RESULT_LIMIT);
    expect(res.results_truncated).toBe(OVER_CAP);
  });

  it('omits results_truncated when nothing was truncated', async () => {
    const res = await call<CappedResults>('mast_signature', { symbol: 'only' });

    expect(res.results_truncated).toBeUndefined();
  });

  it('honours an explicit limit', async () => {
    const res = await call<CappedResults>('mast_signature', { symbol: 'collide', limit: 3 });

    expect(res.results.length).toBe(3);
    expect(res.results_truncated).toBe(OVER_CAP);
  });

  // The token blowup was only half of D043; the other half was 78 seconds, and
  // it came from work done PER SYMBOL inside the result loop — a file parse and
  // a type-context resolution each. Capping the response after that loop would
  // have fixed the payload and left the latency exactly where it was. Asserting
  // on files_referenced is the observable proxy: it is derived from the results
  // actually returned, so a cap applied too late shows up here as an oversized
  // list even though `results` looks correct.
  it('does not do work for symbols it will not return', async () => {
    const res = await call<CappedResults>('mast_signature', { symbol: 'collide', limit: 2 });
    expect(res._stats.files_referenced.length).toBe(2);
  });
});

describe('mast_implementors result cap (D043)', () => {
  it('returns at most the default limit and reports the real uncapped total', async () => {
    const res = await call<CappedResults>('mast_implementors', { interface_name: 'Wide' });

    expect(res.results.length).toBe(DEFAULT_RESULT_LIMIT);
    expect(res.results_truncated).toBe(OVER_CAP);
  });

  it('omits results_truncated when nothing was truncated', async () => {
    const res = await call<CappedResults>('mast_implementors', { interface_name: 'Nonexistent' });

    expect(res.results_truncated).toBeUndefined();
  });

  it('honours an explicit limit', async () => {
    const res = await call<CappedResults>('mast_implementors', { interface_name: 'Wide', limit: 5 });

    expect(res.results.length).toBe(5);
    expect(res.results_truncated).toBe(OVER_CAP);
  });
});

describe('mast_exports result cap (D043)', () => {
  it('returns at most the default limit and reports the real uncapped total', async () => {
    const res = await call<CappedExports>('mast_exports', { file_path: 'wide-exports.ts' });

    expect(res.exports.length).toBe(DEFAULT_RESULT_LIMIT);
    expect(res.exports_truncated).toBe(OVER_CAP);
  });

  it('omits exports_truncated when nothing was truncated', async () => {
    const res = await call<CappedExports>('mast_exports', { file_path: 'narrow-exports.ts' });

    expect(res.exports.length).toBe(1);
    expect(res.exports_truncated).toBeUndefined();
  });

  it('honours an explicit limit', async () => {
    const res = await call<CappedExports>('mast_exports', { file_path: 'wide-exports.ts', limit: 4 });

    expect(res.exports.length).toBe(4);
    expect(res.exports_truncated).toBe(OVER_CAP);
  });
});

describe('the cap is one constant, not four (D043)', () => {
  // The defect was never "a tool had no cap" — it was a cap on one tool of four. Four agreeing
  // literals would be the same defect wearing the same number, so the tools share ONE exported
  // constant and this asserts that identity rather than an equality between copies. Per §5.4a
  // this is the structural half: `_helpers.ts` re-exports `search/potential-matches.ts`'s
  // constant, so a tool cannot opt into a different page size without importing a different name.
  it('is the same binding mast_callers has used since F10', async () => {
    const { DEFAULT_RESULT_LIMIT: fromSearch } = await import('../../../search/potential-matches.js');

    expect(DEFAULT_RESULT_LIMIT).toBe(fromSearch);
  });
});
