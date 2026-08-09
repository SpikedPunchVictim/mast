import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../store/config.js';
import { openDatabase } from '../graph/db.js';
import { SqliteChunkStore, type ChunkStore } from '../store/sqliteChunkStore.js';
import { runIndex, loadIndexMeta } from '../indexer/index.js';
import { startWatchMode, type WatchHandle } from '../indexer/watcher.js';
import { bootstrapState } from './startup.js';
import type { AppContext } from './context.js';
import { registerAllTools } from './register-tools.js';

// ---------------------------------------------------------------------------
// M6 Part A (eval/GITNEXUS_COMPARISON.md §13.8 item 4): refuse to serve only
// where nothing can EVER fill the index — see assertServableIndex below.
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link assertServableIndex} when `mast serve --no-startup-reindex`
 * targets a state directory that has never completed an index run. Extends
 * `Error` per project convention (never throw a plain string/object) —
 * mirrors `cli/query.ts`'s `QueryError` precedent for a typed, CLI-surfaced
 * failure mode.
 */
export class NeverIndexedError extends Error {}

/**
 * True when `config.resolved_state_dir` has never completed an index run:
 * either `graph.db` itself is absent (nothing has ever opened the database),
 * or `index.json` reports zero chunks AND a null/absent `last_indexed` (the
 * database was opened — e.g. by a prior aborted run — but no index write
 * ever landed). Read via `loadIndexMeta` (`indexer/index.ts`), the same
 * unvalidated `JSON.parse` reader every other `index.json` consumer uses.
 *
 * Deliberately NOT "chunk_count === 0" alone — a state dir indexed over a
 * genuinely empty file set (no matching files) still writes a live
 * `graph.db` and `index.json` with `last_indexed` set. That is Part B's
 * territory
 * (`mcp/tools/_helpers.ts`'s `isIndexEmpty`), not Part A's: the index CAN be
 * queried honestly (with `index_empty: true`), it just has nothing in it.
 * This function only fires for the state that will NEVER produce anything
 * different, because nothing (that this server process controls) is ever
 * going to index it.
 *
 * MUST be called before `openDatabase` runs (`serve()`'s Step 2, below):
 * `openDatabase` creates `graph.db` with an empty schema as a side effect of
 * opening a missing file (`graph/db.ts`), which would flip this check to
 * "not absent" a moment later — the same ordering hazard `cli/query.ts`'s
 * `runQuery` already documents for its own graph.db existence check.
 */
function isNeverIndexed(config: ResolvedConfig): boolean {
  const graphDbPath = join(config.resolved_state_dir, 'graph.db');
  if (!existsSync(graphDbPath)) return true;
  const meta = loadIndexMeta(config.resolved_state_dir);
  return (meta?.chunk_count ?? 0) === 0 && (meta?.last_indexed ?? null) === null;
}

/**
 * Refuse to start serving when nothing can ever fill the index (M6 Part A).
 *
 * A blanket "refuse whenever the state dir is empty" is wrong: §7.4's
 * startup ladder LEGITIMATELY serves from an empty state dir while Step 4's
 * background reindex fills it in — that window is the designed SDD
 * container flow and must keep working untouched. This function is a no-op
 * whenever the startup reindex is enabled (the default) — see the early
 * return below — so it can never gate or delay that path.
 *
 * The refusal fires only for the one combination where an empty index can
 * NEVER be filled by this server process: `--no-startup-reindex` disables
 * the one mechanism that would have filled it, permanently pinning every
 * query at `{"results":[]}` — indistinguishable from "symbol doesn't exist",
 * the exact ambiguity M6 (`eval/GITNEXUS_COMPARISON.md` §13.8 item 4) names.
 * Part B (`mcp/tools/_helpers.ts`'s `isIndexEmpty`, consumed by every read
 * tool) covers the legitimate empty window this function deliberately
 * leaves alone.
 *
 * @throws NeverIndexedError naming the state dir and suggesting `mast init`
 * / `mast index`, or dropping `--no-startup-reindex`.
 */
export function assertServableIndex(
  config: ResolvedConfig,
  options: { readonly noStartupReindex?: boolean },
): void {
  if (options.noStartupReindex !== true) return;
  if (!isNeverIndexed(config)) return;
  throw new NeverIndexedError(
    `mast serve: state directory "${config.resolved_state_dir}" has never been indexed, and ` +
    '--no-startup-reindex disables the startup reindex that would normally fill it — every ' +
    'query would return {"results":[]} forever, indistinguishable from "symbol doesn\'t exist". ' +
    'Run `mast init` or `mast index` against this state directory first, or drop --no-startup-reindex.',
  );
}

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

  // M6 Part A: refuse before openDatabase (which would create graph.db as a
  // side effect and mask the never-indexed state this check exists to catch)
  // — see assertServableIndex's docstring above for the full ordering hazard.
  assertServableIndex(config, { noStartupReindex: options.noStartupReindex });

  const db = openDatabase(config.resolved_state_dir);

  // M1 (eval/GITNEXUS_COMPARISON.md §15.1): chunks live in graph.db's
  // `chunks` table — `SqliteChunkStore` wraps the same `db` connection every
  // tool below already uses.
  const chunkStore: ChunkStore = new SqliteChunkStore(db);

  // ── Step 3: open MCP transport and register tools ─────────────────────────

  const ctx: AppContext = {
    db,
    chunkStore,
    config,
    sessionId: randomUUID(),
  };

  const server = new McpServer({ name: 'mast', version: '0.1.0' });

  registerAllTools(server, ctx);

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
