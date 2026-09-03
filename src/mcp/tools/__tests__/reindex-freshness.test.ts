// `mast_reindex` is the one tool that makes the cached freshness count wrong on
// purpose: it indexes the very files the count is counting. Leaving the count
// alone would have `mast_search` warn `unindexed_files: N` about files this call
// just finished indexing — a false warning on the signal added to stop callers
// trusting an incomplete answer.
//
// The invalidation was one line with no test until D055's review. This runs a
// real incremental index against a real temp project, because the point is that
// the tool's handler does it, not that a mock can be told to.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig } from '../../../store/config.js';
import { runIndex } from '../../../indexer/index.js';
import { openDatabase } from '../../../graph/db.js';
import { SqliteChunkStore } from '../../../store/sqliteChunkStore.js';
import type { AppContext } from '../../context.js';
import type { FreshnessProbe } from '../../freshness-probe.js';
import { registerReindexTool } from '../reindex.js';

type AnyHandler = (args: Record<string, unknown>) => Promise<{ content: [{ text: string }] }>;

function recordingProbe(): FreshnessProbe & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  return {
    calls,
    peekUnindexed: () => { calls.push('peek'); return 7; },
    invalidate: () => { calls.push('invalidate'); },
    refresh: () => { calls.push('refresh'); },
    settled: () => Promise.resolve(),
  };
}

describe('mast_reindex — freshness invalidation', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;
  let ctx: AppContext;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mast-reindex-freshness-'));
    writeFileSync(join(tmpDir, 'alpha.ts'), 'export function alphaOne(): number { return 1; }\n');
    const config = resolveConfig({ projectRoot: tmpDir });
    await runIndex(config, { incremental: false });
    db = openDatabase(config.resolved_state_dir);
    ctx = { db, chunkStore: new SqliteChunkStore(db), config, sessionId: 'test' };
  });

  afterAll(async () => {
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function reindexWith(probe: FreshnessProbe | undefined): (args?: Record<string, unknown>) => Promise<unknown> {
    const handlers = new Map<string, AnyHandler>();
    const server = {
      tool(name: string, _d: string, _s: unknown, handler: AnyHandler) { handlers.set(name, handler); },
    } as unknown as McpServer;
    registerReindexTool(server, { ...ctx, ...(probe !== undefined ? { freshness: probe } : {}) });
    return async (args = {}) => JSON.parse((await handlers.get('mast_reindex')!(args)).content[0].text);
  }

  it('invalidates the cached count after an incremental reindex', async () => {
    const probe = recordingProbe();

    await reindexWith(probe)();

    expect(probe.calls).toContain('invalidate');
  });

  it('invalidates after a full reindex too', async () => {
    const probe = recordingProbe();

    await reindexWith(probe)({ full: true });

    expect(probe.calls).toContain('invalidate');
  });

  /**
   * The probe is optional on `AppContext` because the CLI's one-shot process has
   * no lifetime to amortise a TTL over — `mast query` builds a ctx without one.
   * The tool must stay callable there rather than assuming the MCP wiring.
   */
  it('reindexes normally when no probe is wired, as on the CLI path', async () => {
    const result = await reindexWith(undefined)() as { files_skipped: number };

    expect(result).toHaveProperty('files_indexed');
    expect(result.files_skipped).toBeGreaterThanOrEqual(0);
  });

  it('still returns the indexer result, not just the side effect', async () => {
    const result = await reindexWith(recordingProbe())() as Record<string, unknown>;

    expect(result).toHaveProperty('chunks_added');
    expect(result).toHaveProperty('duration_ms');
  });
});
