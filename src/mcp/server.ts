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
import { createFreshnessProbe, type FreshnessProbe } from './freshness-probe.js';
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

/**
 * Run an incremental/full index pass and then correct the cached freshness
 * count, which that pass has just made wrong.
 *
 * Extracted from `serve` because the ordering here is the whole contract and it
 * was previously expressed three times in three closures, one of which got it
 * wrong (D060): the invalidate must be in a `finally`. A reindex that FAILS is
 * the case where the cached count is most likely to be stale and most costly to
 * keep — the watcher only fired because files on disk changed, and `runIndex`
 * losing `structure.lock` to a concurrent writer is an ordinary outcome, not an
 * exceptional one. Invalidating only on success leaves `mast_search` reporting
 * a pre-change count as authoritative for a full TTL, and after
 * `maxConsecutiveFailures` the watcher drops the batch, so nothing retries.
 *
 * Errors propagate deliberately. `WatchScheduler` needs the rejection to
 * requeue the batch, and the startup path wants to warn on its own terms; a
 * function that both corrects the cache and swallows the failure would give
 * neither caller what it needs.
 *
 * @param prime `true` measures immediately (startup, so the first search of the
 *   session has a real answer instead of `null`); `false` leaves the next
 *   `peekUnindexed` to schedule it, which is right for a watch batch that may
 *   be one of many in a burst.
 */
export async function reindexAndRemeasure(
  config: ResolvedConfig,
  freshness: FreshnessProbe,
  options: {
    readonly incremental: boolean;
    readonly prime?: boolean;
    /** §4.4 DI seam: tests drive the failure path without standing up a writer. */
    readonly runIndexFn?: (config: ResolvedConfig, opts: { incremental: boolean }) => Promise<unknown>;
  },
): Promise<void> {
  const run = options.runIndexFn ?? runIndex;
  try {
    await run(config, { incremental: options.incremental });
  } finally {
    freshness.invalidate();
    if (options.prime === true) freshness.refresh();
  }
}

export interface ServeOptions {
  readonly config: ResolvedConfig;
  /** Skip the startup incremental reindex (not recommended). */
  readonly noStartupReindex?: boolean;
  /**
   * Watch source files and incrementally reindex on change (§11.4).
   *
   * **Defaults to on** (`undefined` means watch). It was opt-in until
   * 2026-09-03, on the theory that the startup ladder plus JIT staleness kept
   * reads correct. Measurement said otherwise: JIT only re-parses files the
   * index already knows, so a file CREATED during a session is invisible to
   * every read tool until something reindexes — and nothing does. A watcher is
   * the only mechanism here that closes that window without a per-query cost.
   * Watcher construction failures degrade to serving without it, so the
   * default cannot make the server fail to start.
   *
   * Set `false` (CLI `--no-watch`) for container or batch use, where the tree
   * does not change under the server and the fd cost is not worth paying.
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

  // Freshness signal for `mast_search`'s `unindexed_files` warning. Created
  // before the tools are registered because handlers capture `ctx` at
  // registration; primed below so the first search of a session already has a
  // real answer rather than `null`.
  const freshness = createFreshnessProbe(config, db);

  const ctx: AppContext = {
    db,
    chunkStore,
    config,
    sessionId: randomUUID(),
    freshness,
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
    if (options.watch === false) return;
    let watchHandle: WatchHandle | null = null;
    try {
      watchHandle = startWatchMode({
        config,
        runBatch: async (paths) => {
          process.stderr.write(`[mast] watch: reindexing after ${paths.length} change(s)\n`);
          // Not primed: a burst of saves produces a burst of batches, and the
          // next `peekUnindexed` will schedule one measurement for all of them.
          await reindexAndRemeasure(config, freshness, { incremental: true });
        },
        onWarn: (message) => process.stderr.write(`${message}\n`),
        // The success path now announces itself, because the failure path
        // always did: `startWatchMode`'s EMFILE degradation writes a warning,
        // so before this line silence meant "watching", "not watching yet" and
        // "watcher failed to start" alike, and an operator could not tell which
        // (D061). Emitted once, after chokidar's initial scan — files created
        // before it are treated as pre-existing and fire no event, so this is
        // the point from which a change is guaranteed to be seen.
        onReady: () => process.stderr.write('[mast] watch: watching for changes\n'),
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
    // No reindex is coming, so measure the drift the user has chosen to keep.
    freshness.refresh();
    startWatchIfRequested();
    return;
  }

  void (async () => {
    try {
      // Measured AFTER the reindex, in the same background task: a probe run
      // before it would race the indexer and cache a count that the very next
      // moment invalidates. On the failure path the correction is the more
      // important half — the index is behind and nothing else will say so —
      // which is why it lives in `reindexAndRemeasure`'s `finally`.
      await reindexAndRemeasure(config, freshness, { incremental: !needsFullReindex, prime: true });
    } catch (err) {
      process.stderr.write(`[mast] startup indexing failed: ${String(err)}\n`);
    }
  })();

  startWatchIfRequested();
}
