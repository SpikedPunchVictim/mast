import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import type { ResolvedConfig } from '../store/config.js';
import { openDatabase } from '../graph/db.js';
import { LanceStore } from '../store/lance.js';
import { Embedder } from '../indexer/embedder.js';
import { runIndex } from '../indexer/index.js';
import { bootstrapState } from './startup.js';
import {
  warmEmbeddings,
  embedChunks,
  pendingChunkIds,
  forkEmbedderChild,
  type EmbedderChildHandle,
} from '../indexer/background-embedder.js';
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

  // ── Steps 1–2: bootstrap state dir + schema-version guard ─────────────────
  // On a schema-version change this wipes all derived state (lance/, graph.db,
  // file_manifest.json, embed_cache/) before any of it is opened. See §7.4.

  const { needsFullReindex } = await bootstrapState(config);

  const db = openDatabase(config.resolved_state_dir);
  const lance = await LanceStore.open(config.resolved_state_dir);
  await lance.ensureChunksTable();

  // ── Step 3: open MCP transport and register tools ─────────────────────────

  let currentMode: SearchMode = 'lexical';
  let currentEmbedder: Embedder | null = null;

  // Single long-lived embedder child, shared by startup warm-up and every
  // mast_reindex. Embed requests are serialised through `embedChain`, which is
  // gated on `warmupSettled` so a mid-task reindex never spawns a second child
  // while startup warm-up is still choosing/creating one.
  let embedChild: EmbedderChildHandle | null = null;
  let resolveWarmup!: () => void;
  const warmupSettled = new Promise<void>((resolve) => { resolveWarmup = resolve; });
  let embedChain: Promise<void> = warmupSettled;
  process.on('exit', () => { embedChild?.kill(); });

  // Make subsequent searches use vectors. Setting an embedder with no vectors
  // present is harmless — hybridSearch self-corrects to lexical per query.
  const ensureHybrid = (): void => {
    currentEmbedder ??= new Embedder(
      config.embedding_model,
      config.resolved_transformers_cache_dir,
      config.resolved_state_dir,
    );
    currentMode = 'hybrid';
  };

  const embedPending = (): Promise<void> => {
    embedChain = embedChain
      .then(async () => {
        const ids = await pendingChunkIds(lance);
        if (ids.length === 0) return;
        embedChild ??= forkEmbedderChild(config.embedding_model, config.resolved_state_dir, config.resolved_transformers_cache_dir);
        await embedChunks(embedChild, ids);
        ensureHybrid();
      })
      .catch((err: unknown) => {
        process.stderr.write(`[mast] mid-task embedding failed: ${String(err)}\n`);
      });
    return embedChain;
  };

  const ctx: AppContext = {
    db,
    lance,
    config,
    getEmbedder: () => currentEmbedder,
    searchMode: () => currentMode,
    embedPending,
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

  if (options.noStartupReindex) {
    // No startup work — let any reindex-driven embedding proceed immediately.
    resolveWarmup();
    return;
  }

  void (async () => {
    try {
      await runIndex(config, { incremental: !needsFullReindex });

      // Drive the forked embedder to embed all pending chunks and adopt its
      // child as the shared one reused by later mast_reindex calls. Resolves
      // immediately when nothing is pending (e.g. a fully-embedded seed), in
      // which case we still flip to hybrid because vectors already exist. §7.4.
      const { child } = await warmEmbeddings({
        modelId: config.embedding_model,
        stateDir: config.resolved_state_dir,
        transformersCacheDir: config.resolved_transformers_cache_dir,
        lance,
      });
      embedChild = child;
      ensureHybrid();
    } catch (err) {
      process.stderr.write(`[mast] startup embedding failed: ${String(err)}\n`);
    } finally {
      // Unblock mast_reindex embedding regardless of warm-up outcome.
      resolveWarmup();
    }
  })();
}
