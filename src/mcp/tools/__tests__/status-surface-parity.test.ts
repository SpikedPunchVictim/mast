// `mast status` (CLI) and `mast_status` (MCP) answer the same question and must
// give the same answer.
//
// They did not. The CLI computes freshness from `file_manifest.json` —
// `diffManifest` over a fresh walk, counting stale + added + deleted. The MCP
// tool called `countStaleFiles`, which enumerated the `files` TABLE and stat'd
// each row. A file that exists on disk and was never indexed is in no row, so
// it was structurally invisible: add one file to a project and the CLI reported
// `stale_files: 1, index_fresh: false` while the MCP tool reported
// `stale_files: 0, index_fresh: true` against the same index, in the same
// instant.
//
// This is the surface an agent reads. `.claude/CLAUDE.md` instructs agents to
// call `mast_status` at session start to confirm the index is fresh, so the
// half that was wrong is the half that gets asked.
//
// The two surfaces now share one producer (`indexer/freshness.ts`). This file
// asserts the agreement rather than either implementation, so a future
// divergence fails here regardless of which side moves.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig } from '../../../store/config.js';
import { runIndex } from '../../../indexer/index.js';
import { openDatabase } from '../../../graph/db.js';
import { SqliteChunkStore } from '../../../store/sqliteChunkStore.js';
import { buildStatus } from '../../../cli/status.js';
import { extractFile } from '../../../ast/extract.js';
import type { AppContext } from '../../context.js';
import { registerStatusTool } from '../status.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

/** Call the registered `mast_status` handler and parse its JSON payload. */
async function callMcpStatus(config: ReturnType<typeof resolveConfig>): Promise<{
  stale_files: number; index_fresh: boolean; freshness_cause: string | null;
}> {
  const db = openDatabase(config.resolved_state_dir);
  try {
    let handler: Handler | null = null;
    const server = {
      tool(_n: string, _d: string, _s: unknown, h: Handler) { handler = h; },
    } as unknown as McpServer;
    const ctx: AppContext = {
      db,
      chunkStore: new SqliteChunkStore(db),
      config,
      sessionId: 'status-parity-test',
    };
    registerStatusTool(server, ctx);
    if (handler === null) throw new Error('status tool not registered');
    const res = await (handler as Handler)({});
    const parsed = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    // Only the three freshness fields are compared — the two surfaces
    // legitimately differ elsewhere (the CLI carries `initialised`, the MCP
    // tool carries `state_dir`), and comparing whole payloads would assert a
    // parity neither is supposed to have.
    return {
      stale_files: parsed['stale_files'] as number,
      index_fresh: parsed['index_fresh'] as boolean,
      freshness_cause: parsed['freshness_cause'] as string | null,
    };
  } finally {
    await db.destroy();
  }
}

/** Both surfaces, reduced to the three fields they are supposed to agree on. */
async function bothSurfaces(config: ReturnType<typeof resolveConfig>, projectRoot: string): Promise<{
  cli: { stale_files: number | null; index_fresh: boolean; freshness_cause: string | null };
  mcp: { stale_files: number; index_fresh: boolean; freshness_cause: string | null };
}> {
  const mcp = await callMcpStatus(config);
  const cli = await buildStatus({ path: projectRoot });
  return {
    cli: { stale_files: cli.stale_files, index_fresh: cli.index_fresh, freshness_cause: cli.freshness_cause },
    mcp,
  };
}

let dir: string;
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

/** One indexed file, freshly and successfully indexed. */
async function seedIndexed(): Promise<ReturnType<typeof resolveConfig>> {
  dir = mkdtempSync(join(tmpdir(), 'mast-status-parity-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'good.ts'), 'export function good(): number { return 1; }\n');
  const config = resolveConfig({ projectRoot: dir });
  await runIndex(config, { incremental: false });
  return config;
}

describe('mast status and mast_status agree', () => {
  it('on a freshly indexed project', async () => {
    const config = await seedIndexed();
    const { cli, mcp } = await bothSurfaces(config, dir);

    expect(mcp).toEqual(cli);
    expect(cli.index_fresh).toBe(true);
  });

  it('after a file is added and never indexed', async () => {
    const config = await seedIndexed();
    writeFileSync(join(dir, 'src', 'brand-new.ts'), 'export function fresh(): number { return 2; }\n');

    const { cli, mcp } = await bothSurfaces(config, dir);

    expect(mcp).toEqual(cli);
    expect(cli.index_fresh).toBe(false);
    expect(cli.stale_files).toBe(1);
  });

  it('after an indexed file is edited', async () => {
    const config = await seedIndexed();
    // The manifest stores whole seconds; advance past it so the edit is
    // unambiguously newer rather than racing the stamp.
    await new Promise((r) => setTimeout(r, 1_100));
    writeFileSync(join(dir, 'src', 'good.ts'), 'export function good(): number { return 999; }\n');

    const { cli, mcp } = await bothSurfaces(config, dir);

    expect(mcp).toEqual(cli);
    expect(cli.index_fresh).toBe(false);
  });

  it('after an indexed file is deleted', async () => {
    const config = await seedIndexed();
    rmSync(join(dir, 'src', 'good.ts'));

    const { cli, mcp } = await bothSurfaces(config, dir);

    expect(mcp).toEqual(cli);
    expect(cli.index_fresh).toBe(false);
  });

  it('after a file failed to index — the hole #2 leaves behind is visible on both', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mast-status-parity-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'good.ts'), 'export function good(): number { return 1; }\n');
    writeFileSync(join(dir, 'src', 'doomed.ts'), 'export function doomed(): number { return 2; }\n');
    const config = resolveConfig({ projectRoot: dir });

    const failing: typeof extractFile = (path, ...rest) => {
      if (path.endsWith('doomed.ts')) throw new Error('simulated extract failure');
      return extractFile(path, ...rest);
    };
    await runIndex(config, { incremental: false, extractFileFn: failing });

    const { cli, mcp } = await bothSurfaces(config, dir);

    expect(mcp).toEqual(cli);
    // Not fresh: one file on disk is absent from the index. Reporting fresh
    // here is the severity-zero case — a caller cannot tell the difference
    // between "not in the codebase" and "never made it into the index".
    expect(cli.index_fresh).toBe(false);
    expect(cli.stale_files).toBe(1);
  });
});
