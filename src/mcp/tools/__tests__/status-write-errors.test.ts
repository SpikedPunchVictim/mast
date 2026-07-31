import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig } from '../../../store/config.js';
import { runIndex } from '../../../indexer/index.js';
import { openDatabase, type Db } from '../../../graph/db.js';
import { LanceStore } from '../../../store/lance.js';
import type { AppContext } from '../../context.js';
import { registerStatusTool } from '../status.js';
import type { ChunkRecord } from '../../../store/lance.js';
import type { ChunkStore } from '../../../store/sqliteChunkStore.js';

// ---------------------------------------------------------------------------
// mast_status must surface a persisted write_errors count (not just
// parse_errors) — GITNEXUS_COMPARISON.md §15.3 item 3 / §16. Isolated from
// tools.test.ts's shared fixture corpus so injecting a write failure here
// cannot perturb that file's `stale_files`/`index_fresh` assertions.
// ---------------------------------------------------------------------------

/** Minimal in-memory ChunkStore whose replaceChunksForFile always throws —
 *  this test only needs `write_errors > 0` to reach index.json, not a
 *  specific per-file failure pattern. */
class AlwaysFailingChunkStore implements ChunkStore {
  async replaceChunksForFile(): Promise<number> {
    throw new Error('simulated chunk store write failure');
  }
  async deleteChunksForFiles(): Promise<number> { return 0; }
  async getChunksByFilePath(): Promise<ChunkRecord[]> { return []; }
  async getChunksByIds(): Promise<ChunkRecord[]> { return []; }
  async getAllChunks(): Promise<ChunkRecord[]> { return []; }
  async chunkCount(): Promise<number> { return 0; }
}

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
function mockServer() {
  let handler: Handler | null = null;
  const server = {
    tool(_n: string, _d: string, _s: unknown, h: Handler) { handler = h; },
  } as unknown as McpServer;
  return {
    server,
    async call(): Promise<Record<string, unknown>> {
      if (handler === null) throw new Error('status tool not registered');
      const res = await handler({});
      return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    },
  };
}

describe('mast_status surfaces a persisted write_errors count', () => {
  let dir: string;

  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('reports the write_errors value written to index.json by the last runIndex', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mast-status-write-errors-'));
    writeFileSync(join(dir, 'a.ts'), 'export function ok(): number { return 1; }\n');
    const config = resolveConfig({ projectRoot: dir });

    // Real runIndex run with an injected failing chunk store — persists
    // write_errors: 1 into index.json exactly as the CLI/MCP `mast_reindex`
    // path would on a genuine storage failure.
    await runIndex(config, { incremental: false, chunkStoreOverride: new AlwaysFailingChunkStore() });

    const db: Db = openDatabase(config.resolved_state_dir);
    const lance = await LanceStore.open(config.resolved_state_dir);
    try {
      const ctx: AppContext = {
        db,
        lance,
        chunkStore: lance,
        config,
        getEmbedder: () => null,
        searchMode: () => 'lexical',
        embedPending: async () => {},
        sessionId: 'status-write-errors-test',
      };
      const mock = mockServer();
      registerStatusTool(mock.server, ctx);

      const result = await mock.call();

      expect(result.write_errors).toBe(1);
    } finally {
      await db.destroy();
    }
  });
});
