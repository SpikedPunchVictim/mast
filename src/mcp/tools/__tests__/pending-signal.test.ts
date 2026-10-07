import { rmSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../../graph/db.js';
import { SqliteChunkStore } from '../../../store/sqliteChunkStore.js';
import { runIndex } from '../../../indexer/index.js';
import { configFor, editFile, indexFull, makeProject, writeFiles } from '../../../indexer/__tests__/graph-fixture.js';
import { buildStatus } from '../../../cli/status.js';
import type { AppContext } from '../../context.js';
import { registerCallersTool } from '../callers.js';
import { registerImplementorsTool } from '../implementors.js';
import { registerReindexTool } from '../reindex.js';
import { registerRenameImpactTool } from '../rename-impact.js';
import { registerStatusTool } from '../status.js';

// ---------------------------------------------------------------------------
// T13, the layer a caller sees — while files are waiting to be resolved again,
// the status surfaces say so and the three tools that answer from edges carry
// the count; `mast_reindex` finishes the work and the signal goes
// (adr/proposals/incremental-graph-correctness, decision 2).
//
// How files come to be waiting is indexer/__tests__/edge-repair-pending.test.ts.
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: [{ type: string; text: string }] }>;

const FILES = {
  'src/target.ts': `export function compute(): number { return 1; }\nexport interface Port { open(): void }\n`,
  'src/zz-user.ts': `import { compute, type Port } from './target.js';\nexport function use(): number { return compute(); }\nexport class Adapter implements Port { open(): void {} }\n`,
};
const TARGET_EDITED = `export function compute(): number { return 2; }\nexport interface Port { open(): void }\n`;

const EDGE_TOOLS = [
  { tool: 'mast_callers', args: { symbol: 'compute', include_potential: false } },
  { tool: 'mast_implementors', args: { interface_name: 'Port' } },
  { tool: 'mast_rename_impact', args: { symbol: 'compute' } },
];

describe('the signal that files are waiting to be resolved again', () => {
  let dir: string;
  let db: Db;
  let call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

  beforeEach(async () => {
    dir = makeProject('pending-signal');
    writeFiles(dir, FILES);
    await indexFull(dir);
    editFile(dir, 'src/target.ts', TARGET_EDITED);
    // The one caller is left waiting.
    await runIndex(configFor(dir), { incremental: true, edgeRepairBudgetMs: 0 });

    const config = configFor(dir);
    db = openDatabase(config.resolved_state_dir);
    const ctx: AppContext = { db, chunkStore: new SqliteChunkStore(db), config, sessionId: 'test-session' };
    const handlers = new Map<string, ToolHandler>();
    // mast-assertion-rule-allow: a four-line stand-in for the SDK server that
    // records handlers, the same seam tools.test.ts uses.
    const server = {
      tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerCallersTool(server, ctx);
    registerImplementorsTool(server, ctx);
    registerRenameImpactTool(server, ctx);
    registerStatusTool(server, ctx);
    registerReindexTool(server, ctx);
    call = async (name, args) => {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`tool ${name} is not registered`);
      const result = await handler(args);
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    };
  });
  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mast_status reports the count and that the index is not fresh', async () => {
    const status = await call('mast_status', {});

    expect({
      pending: status['pending_edge_repairs'],
      fresh: status['index_fresh'],
      cause: status['freshness_cause'],
    }).toEqual({ pending: 1, fresh: false, cause: 'edge_repair_pending' });
  });

  it('mast status reports the same three values', async () => {
    const status = await buildStatus({ path: dir });

    expect({
      pending: status.pending_edge_repairs,
      fresh: status.index_fresh,
      cause: status.freshness_cause,
    }).toEqual({ pending: 1, fresh: false, cause: 'edge_repair_pending' });
  });

  it.each(EDGE_TOOLS)('$tool carries the count and says what to run', async ({ tool, args }) => {
    const response = await call(tool, args);

    expect(response['pending_edge_repairs']).toBe(1);
    expect(response['pending_edge_repairs_hint']).toContain('mast_reindex');
  });

  it.each(EDGE_TOOLS)('$tool carries nothing once mast_reindex has run', async ({ tool, args }) => {
    await call('mast_reindex', {});

    const response = await call(tool, args);

    expect(Object.keys(response).filter((key) => key.startsWith('pending_edge_repairs'))).toEqual([]);
  });

  it('mast_reindex reports none left and mast_status is fresh again', async () => {
    const reindexed = await call('mast_reindex', {});
    const status = await call('mast_status', {});

    expect({
      left: reindexed['pending_edge_repairs'],
      pending: status['pending_edge_repairs'],
      fresh: status['index_fresh'],
      cause: status['freshness_cause'],
    }).toEqual({ left: 0, pending: 0, fresh: true, cause: null });
  });
});
