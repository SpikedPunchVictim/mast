import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import type { ResolvedConfig } from '../store/config.js';
import { openDatabase } from '../graph/db.js';
import { SqliteChunkStore, type ChunkStore } from '../store/sqliteChunkStore.js';
import { runIndex } from '../indexer/index.js';
import { startWatchMode, type WatchHandle } from '../indexer/watcher.js';
import { bootstrapState } from './startup.js';
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
import { registerRenameImpactTool }     from './tools/rename-impact.js';

// ---------------------------------------------------------------------------
// Startup ladder (§7.4)
// ---------------------------------------------------------------------------

export interface ServeOptions {
  readonly config: ResolvedConfig;
  /** Skip the startup incremental reindex (not recommended). */
  readonly noStartupReindex?: boolean;
  /**
   * Watch source files and incrementally reindex on change (§11.4). Opt-in,
   * for interactive (non-container) use — the SDD container relies on the
   * startup ladder instead.
   */
  readonly watch?: boolean;
}

/**
 * Run the MAST MCP server.
 *
 * Implements the startup ladder from §7.4 (Step 4's embed half was excised in
 * Stage 7.1, IMPLEMENTATION_PLAN.md "Stage 7: Vector-store deletion"):
 *   Step 1 — bootstrap state directory (< 1s)
 *   Step 2 — schema version check + open DB (< 2s)
 *   Step 3 — open MCP transport, register tools, accept connections (< 1s)
 *   Step 4 — background incremental reindex (async)
 */
export async function serve(options: ServeOptions): Promise<void> {
  const { config } = options;

  // ── Steps 1–2: bootstrap state dir + schema-version guard ─────────────────
  // On a schema-version change this wipes all derived state (graph.db,
  // file_manifest.json, plus any orphaned lance/embed_cache/ left behind by a
  // pre-Stage-7 state dir) before any of it is opened. See §7.4.

  const { needsFullReindex } = await bootstrapState(config);

  const db = openDatabase(config.resolved_state_dir);

  // M1 (eval/GITNEXUS_COMPARISON.md §15.1): chunks live in graph.db's
  // `chunks` table — `SqliteChunkStore` wraps the same `db` connection every
  // tool below already uses.
  const chunkStore: ChunkStore = new SqliteChunkStore(db);

  // ── Step 3: open MCP transport and register tools ─────────────────────────

  // Frozen at 'lexical' (Stage 7.1) — nothing mutates it any more now that the
  // embed step that used to flip it to 'hybrid' is gone. Kept as a function on
  // AppContext (not a plain field) so mcp/tools/status.ts's `embedding_mode`
  // read stays a normal ctx call; Stage 7.2 redesigns the surface.
  const currentMode: SearchMode = 'lexical';

  const ctx: AppContext = {
    db,
    chunkStore,
    config,
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
  registerRenameImpactTool(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ── Optional --watch mode (§11.4) ──────────────────────────────────────────
  // Started after the transport so a watcher failure can never block serving.
  // Each batch is one incremental Phase 1 (same structure.lock path as
  // mast_reindex). JIT staleness handling (§9.0) already guarantees read
  // correctness; watch mode only keeps the FTS/graph index fresh between reads.

  const startWatchIfRequested = (): void => {
    if (options.watch !== true) return;
    let watchHandle: WatchHandle | null = null;
    try {
      watchHandle = startWatchMode({
        config,
        runBatch: async (paths) => {
          process.stderr.write(`[mast] watch: reindexing after ${paths.length} change(s)\n`);
          await runIndex(config, { incremental: true });
        },
        onWarn: (message) => process.stderr.write(`${message}\n`),
      });
    } catch (err) {
      // Degrade gracefully (EMFILE, permissions, …) — serve without watch.
      process.stderr.write(`[mast] watch: failed to start watcher, continuing without --watch: ${String(err)}\n`);
      return;
    }

    // Clean shutdown: chokidar's persistent watcher would otherwise keep the
    // process alive after the MCP client disconnects (stdin close) or on
    // SIGTERM/SIGINT.
    const closeWatcher = (): void => {
      const handle = watchHandle;
      watchHandle = null;
      if (handle !== null) void handle.close().catch(() => {});
    };
    process.stdin.on('close', closeWatcher);
    process.once('SIGTERM', closeWatcher);
    process.once('SIGINT', closeWatcher);
  };

  // ── Step 4: background reindex ────────────────────────────────────────────

  if (options.noStartupReindex) {
    startWatchIfRequested();
    return;
  }

  void (async () => {
    try {
      await runIndex(config, { incremental: !needsFullReindex });
    } catch (err) {
      process.stderr.write(`[mast] startup indexing failed: ${String(err)}\n`);
    }
  })();

  startWatchIfRequested();
}
