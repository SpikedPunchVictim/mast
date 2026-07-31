import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig } from '../../../store/config.js';
import { runIndex } from '../../../indexer/index.js';
import { openDatabase, type Db } from '../../../graph/db.js';
import { LanceStore } from '../../../store/lance.js';
import type { AppContext } from '../../context.js';
import { registerReindexTool, toReindexResult } from '../reindex.js';
import type { IndexResult } from '../../../indexer/index.js';

// Minimal mock MCP server capturing the registered tool handler.
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
function mockServer() {
  let handler: Handler | null = null;
  const server = {
    tool(_n: string, _d: string, _s: unknown, h: Handler) { handler = h; },
  } as unknown as McpServer;
  return {
    server,
    async call(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      if (handler === null) throw new Error('reindex tool not registered');
      const res = await handler(args);
      return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    },
  };
}

describe('mast_reindex — Phase 2 wiring (H2)', () => {
  let tmpDir: string;
  let db: Db;
  let lance: LanceStore;
  let embedPendingCalls: number;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-reindex-'));
    writeFileSync(join(tmpDir, 'a.ts'), 'export const x = 1;\n');
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
    lance = await LanceStore.open(config.resolved_state_dir);
    embedPendingCalls = 0;
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs Phase 1 then triggers embedding of the new chunks', async () => {
    const config = resolveConfig({ projectRoot: tmpDir });
    const ctx: AppContext = {
      db,
      lance,
      chunkStore: lance,
      config,
      getEmbedder: () => null,
      searchMode: () => 'lexical',
      embedPending: async () => { embedPendingCalls++; },
      sessionId: 'reindex-test',
    };
    const mock = mockServer();
    registerReindexTool(mock.server, ctx);

    // The agent writes a new file, then calls mast_reindex.
    writeFileSync(join(tmpDir, 'b.ts'), 'export function added(): number { return 2; }\n');
    const result = await mock.call({});

    // Phase 1 picked up the new file...
    expect(result.files_indexed).toBeGreaterThan(0);
    // ...and Phase 2 embedding was triggered (the H2 regression).
    expect(embedPendingCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// toReindexResult — pure field mapping (cheapest layer, §5.5)
//
// A required field on `ReindexResult` guarantees `write_errors` is PRESENT
// (tsc rejects a literal missing it), but not that it holds the right VALUE —
// a copy-paste mistake like `write_errors: result.parseErrors` still
// compiles. This is exactly the "right shape, wrong value" bug class this
// whole fix targets (§14.6), so the mapping's values are asserted directly.
// ---------------------------------------------------------------------------

describe('toReindexResult', () => {
  it('maps writeErrors to write_errors, distinct from parseErrors', () => {
    const result: IndexResult = {
      filesIndexed: 3,
      filesSkipped: 1,
      chunksAdded: 5,
      chunksRemoved: 2,
      parseErrors: 4,
      writeErrors: 7,
      durationMs: 123,
    };

    const mapped = toReindexResult(result);

    expect(mapped.write_errors).toBe(7);
    expect(mapped.parse_errors).toBe(4);
  });
});
