import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import type { ResolvedConfig } from '../store/config.js';
import { CURRENT_SCHEMA_VERSION, writeStateConfig } from '../store/config.js';
import { initLockMarkers } from '../store/lock.js';
import { openDatabase } from '../graph/db.js';
import { LanceStore } from '../store/lance.js';
import { Embedder } from '../indexer/embedder.js';
import { loadIndexMeta, writeIndexMeta, runIndex } from '../indexer/index.js';
import { startBackgroundEmbedder } from '../indexer/background-embedder.js';
import type { SearchMode } from '../ast/types.js';
import type { AppContext } from './context.js';
import { registerSearchTool }           from './tools/search.js';
import { registerProjectSkeletonTool }  from './tools/project-skeleton.js';
import { registerExportsTool }          from './tools/exports.js';
import { registerSignatureTool }        from './tools/signature.js';
import { registerCallersTool }          from './tools/callers.js';
import { registerDependenciesTool }     from './tools/dependencies.js';
import { registerImplementorsTool }     from './tools/implementors.js';
import { registerReindexTool }          from './tools/reindex.js';
import { registerStatusTool }           from './tools/status.js';
import { registerEfficiencyTool }       from './tools/efficiency.js';

// ---------------------------------------------------------------------------
// Startup ladder (§7.4)
// ---------------------------------------------------------------------------

export interface ServeOptions {
  readonly config: ResolvedConfig;
  /** Skip the startup incremental reindex (not recommended). */
  readonly noStartupReindex?: boolean;
}

/**
 * Run the MAST MCP server.
 *
 * Implements the four-step startup ladder from §7.4:
 *   Step 1 — bootstrap state directory (< 1s)
 *   Step 2 — schema version check + open DB (< 2s)
 *   Step 3 — open MCP transport, register tools, accept connections (< 1s)
 *   Step 4 — background incremental reindex + embedding (async)
 */
export async function serve(options: ServeOptions): Promise<void> {
  const { config } = options;

  // ── Step 1: bootstrap state directory ────────────────────────────────────

  const seedPath = '/opt/mast-seed';
  if (!existsSync(config.resolved_state_dir) && existsSync(seedPath)) {
    await cp(seedPath, config.resolved_state_dir, { recursive: true });
  }
  initLockMarkers(config.resolved_state_dir);
  writeStateConfig(config.resolved_state_dir, config);

  // ── Step 2: schema version check + open DB ────────────────────────────────

  let meta = loadIndexMeta(config.resolved_state_dir);
  let needsFullReindex = false;

  if (meta !== null && meta.schema_version !== CURRENT_SCHEMA_VERSION) {
    // Schema changed — wipe index-derived state; keep config.
    needsFullReindex = true;
    meta = null;
    writeIndexMeta(config.resolved_state_dir, {
      schema_version: CURRENT_SCHEMA_VERSION,
      last_indexed: null,
      file_count: 0,
      chunk_count: 0,
      model: config.embedding_model,
    });
  }

  const db = openDatabase(config.resolved_state_dir);
  const lance = await LanceStore.open(config.resolved_state_dir);
  await lance.ensureChunksTable();

  // ── Step 3: open MCP transport and register tools ─────────────────────────

  let currentMode: SearchMode = 'lexical';
  let currentEmbedder: Embedder | null = null;

  const ctx: AppContext = {
    db,
    lance,
    config,
    getEmbedder: () => currentEmbedder,
    searchMode: () => currentMode,
    sessionId: randomUUID(),
  };

  const server = new McpServer({ name: 'mast', version: '0.1.0' });

  registerSearchTool(server, ctx);
  registerProjectSkeletonTool(server, ctx);
  registerExportsTool(server, ctx);
  registerSignatureTool(server, ctx);
  registerCallersTool(server, ctx);
  registerDependenciesTool(server, ctx);
  registerImplementorsTool(server, ctx);
  registerReindexTool(server, ctx);
  registerStatusTool(server, ctx);
  registerEfficiencyTool(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ── Step 4: background reindex + embedding ───────────────────────────────

  if (options.noStartupReindex) return;

  void (async () => {
    try {
      await runIndex(config, { incremental: !needsFullReindex });

      // Fork embedding child process; flip mode to 'hybrid' on completion.
      const child = startBackgroundEmbedder({
        modelId: config.embedding_model,
        stateDir: config.resolved_state_dir,
        onComplete: () => {
          currentEmbedder = new Embedder(
            config.embedding_model,
            '/opt/transformers-cache',
            config.resolved_state_dir,
          );
          currentMode = 'hybrid';
        },
        onError: (err) => {
          process.stderr.write(`[mast] embedder error: ${err.message}\n`);
        },
      });

      // Keep reference alive; child process runs until server exits.
      process.on('exit', () => { child.kill(); });
    } catch (err) {
      process.stderr.write(`[mast] startup reindex failed: ${String(err)}\n`);
    }
  })();
}
