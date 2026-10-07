import { rmSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../../graph/db.js';
import { SqliteChunkStore } from '../../../store/sqliteChunkStore.js';
import {
  configFor,
  editFile,
  indexFull,
  indexIncremental,
  makeProject,
  writeFiles,
} from '../../../indexer/__tests__/graph-fixture.js';
import type { AppContext } from '../../context.js';
import { registerCallersTool } from '../callers.js';
import { registerImplementorsTool } from '../implementors.js';
import { registerRenameImpactTool } from '../rename-impact.js';

// ---------------------------------------------------------------------------
// T7 — a tool gives the same answer before and after the body of the file it
// was asked about is edited (D081; adr/proposals/incremental-graph-correctness).
//
// The graph-level table is indexer/__tests__/incremental-equivalence.test.ts.
// This is the layer a caller sees: before the fix `mast_callers` answered
// `verified_count: 0` for a function whose body had just been edited, with a
// fresh status, and a caller acting on that would conclude it was unused.
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: [{ type: string; text: string }] }>;

const FILES = {
  'src/target.ts': `export function compute(): number { return 1; }
export interface Port { open(): void }
`,
  'src/zz-user.ts': `import { compute, type Port } from './target.js';
export function use(): number { return compute(); }
export class Adapter implements Port { open(): void {} }
`,
};
const TARGET_EDITED = `export function compute(): number { return 2; }
export interface Port { open(): void }
`;

/** The answer without what legitimately differs between two calls. */
function withoutStats(response: unknown): unknown {
  if (typeof response !== 'object' || response === null) return response;
  return Object.fromEntries(Object.entries(response).filter(([key]) => key !== '_stats'));
}

describe('tool answers across a body edit of the file asked about', () => {
  let dir: string;
  let db: Db;
  let call: (name: string, args: Record<string, unknown>) => Promise<unknown>;

  beforeEach(async () => {
    dir = makeProject('answers-after-edit');
    writeFiles(dir, FILES);
    await indexFull(dir);

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
    call = async (name, args) => {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`tool ${name} is not registered`);
      const result = await handler(args);
      return withoutStats(JSON.parse(result.content[0].text));
    };
  });
  afterEach(async () => {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    { tool: 'mast_callers', args: { symbol: 'compute', include_potential: false }, mustMention: 'use' },
    { tool: 'mast_implementors', args: { interface_name: 'Port' }, mustMention: 'Adapter' },
    { tool: 'mast_rename_impact', args: { symbol: 'compute' }, mustMention: 'use' },
  ])('$tool answers the same', async ({ tool, args, mustMention }) => {
    const before = await call(tool, args);
    // Guards the comparison below: two empty answers would also be equal.
    expect(JSON.stringify(before)).toContain(mustMention);

    editFile(dir, 'src/target.ts', TARGET_EDITED);
    await indexIncremental(dir);
    const after = await call(tool, args);

    expect(after).toEqual(before);
  });

  // D080: no index run between the edit and the question. Naming the file
  // makes the tool re-write it before answering, and that re-write deleted
  // the caller's edge: `verified_count: 0`, with nothing on the response to
  // say so. `mast_implementors` re-writes nothing and is not in this table.
  it.each([
    { tool: 'mast_callers', args: { symbol: 'compute', file_path: 'src/target.ts', include_potential: false } },
    { tool: 'mast_rename_impact', args: { symbol: 'compute', file_path: 'src/target.ts' } },
  ])('$tool answers the same when its own refresh is what picks the edit up', async ({ tool, args }) => {
    const before = await call(tool, args);
    expect(JSON.stringify(before)).toContain('use');

    editFile(dir, 'src/target.ts', TARGET_EDITED);
    const after = await call(tool, args);

    expect(after).toEqual(before);
  });
});
