import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z, ZodError, type ZodRawShape } from 'zod';
import type { Command } from 'commander';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveConfig, type ResolvedConfig } from '../store/config.js';
import { runIndex, type IndexResult } from '../indexer/index.js';
import { openDatabase } from '../graph/db.js';
import { SqliteChunkStore } from '../store/sqliteChunkStore.js';
import type { AppContext } from '../mcp/context.js';
import { registerAllTools } from '../mcp/register-tools.js';

/**
 * D0 (IMPLEMENTATION_PLAN.md "Stage 4: Determinism, hygiene, and the
 * measurement harness", "### D0 — CLI query surface"): `mast query <tool>
 * <json>` dispatches through the exact registered MCP tool handlers instead
 * of re-implementing tool logic, so CLI output can never drift from the MCP
 * transport's JIT/staleness/`_stats` behavior.
 *
 * Every user-facing failure mode below is thrown as `QueryError` (project
 * CLAUDE.md §8.2: throw Error subclasses, never strings) so
 * `registerQueryCommand`'s action can map it uniformly to a stderr message +
 * exit 1, distinct from a tool-internal error propagating unchanged.
 */
export class QueryError extends Error {}

// The one shape every `registerXTool(server, ctx)` handler in src/mcp/tools/
// *.ts actually returns — verified by direct inspection of all 11 call sites.
type ToolResult = { readonly content: readonly [{ readonly type: 'text'; readonly text: string }] };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface CapturedTool {
  readonly schemaShape: ZodRawShape;
  readonly handler: ToolHandler;
}

/**
 * Structural stand-in for `McpServer` that records each tool's zod schema
 * shape and handler instead of opening a real MCP transport.
 *
 * `registerAllTools` only ever calls the 4-argument
 * `tool(name, description, schemaShape, handler)` overload — every
 * `registerXTool` in `mcp/tools/*.ts` uses exactly this call shape, and
 * `mcp/tools/__tests__/tools.test.ts`'s `createMockServer` already narrows
 * the same way to unit-test handlers without a transport. `as unknown as
 * McpServer` is the one pre-approved narrowing for this file (task brief,
 * "Capture-server dispatch") — `capture` is not, and never claims to be, a
 * real `McpServer`; it implements only the single method every register
 * function calls.
 */
function createCaptureServer(): { readonly server: McpServer; readonly tools: ReadonlyMap<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  const capture = {
    tool(name: string, _description: string, schemaShape: ZodRawShape, handler: ToolHandler): void {
      tools.set(name, { schemaShape, handler });
    },
  };
  return { server: capture as unknown as McpServer, tools };
}

/**
 * Every tool name the MCP surface registers, sorted.
 *
 * Registration is pure: each `registerXTool(server, ctx)` passes `ctx` into the
 * async handler's closure and never dereferences it while registering (verified
 * across all 11). This enumerates without a database by handing registration a
 * proxy that throws on ANY property access — so if a future tool starts reading
 * `ctx` at registration time, this fails loudly instead of quietly returning a
 * short list, and the drift guard in `docs-cmd.test.ts` keeps its meaning.
 */
export function listRegisteredToolNames(): readonly string[] {
  const { server, tools } = createCaptureServer();
  const forbidden = new Proxy({}, {
    get(_t, prop) {
      throw new Error(
        `tool registration read ctx.${String(prop)}; listRegisteredToolNames assumes registration is pure`,
      );
    },
  }) as AppContext;
  registerAllTools(server, forbidden);
  return [...tools.keys()].sort();
}

export interface RunQueryOptions {
  /** State directory override, same semantics as every other CLI command's `--state-dir`. */
  readonly stateDir?: string;
  /** Project root path (the CLI's positional `[path]`); defaults to cwd via `resolveConfig`. */
  readonly path?: string;
  /**
   * Refresh the index incrementally before dispatching the query.
   *
   * The CLI has neither of the freshness mechanisms the MCP server has — no
   * watcher, and no cached freshness probe, because a one-shot process has no
   * lifetime to amortise a TTL over. This flag is its answer.
   *
   * Opt-in rather than default, because it adds a whole incremental index run
   * to an invocation that would otherwise be a single query. Measured on this
   * repository (212 indexable files) on 2026-09-03: a no-op incremental run
   * reports 25-34 ms of index work inside ~0.5 s of process wall clock, and a
   * run that found 11 changed files reported 424 ms. It scales with the tree,
   * so on a large monorepo it is materially more — which is punishing in the
   * scripts and loops where `mast search` gets used.
   *
   * Incremental, never full. Refreshes an existing index; it does not create
   * one — see the never-indexed guard in {@link runQuery}.
   */
  readonly reindex?: boolean;
  /**
   * Test-only injection point (§4.4 DI): substitutes for the real incremental
   * `runIndex`, so the lock-contention degradation path can be driven without
   * standing up a competing writer. Production passes nothing.
   */
  readonly reindexer?: (config: ResolvedConfig) => Promise<IndexResult>;
  /**
   * Where `--reindex` reports itself. Defaults to stderr, deliberately: the
   * refresh is a side effect of the query, not part of its answer, and
   * `--json` consumers must keep a parseable stdout.
   */
  readonly warn?: (message: string) => void;
}

/**
 * Dispatch a single CLI query through the exact registered MCP tool handler
 * and return its serialized response text — byte-identical to what an MCP
 * client would receive for the same tool + args.
 *
 * @throws QueryError when the resolved state dir has never been indexed, the
 * JSON argument string fails to parse, `toolName` does not match a
 * registered tool, or the parsed args fail that tool's own zod schema. Any
 * other error (a tool-internal failure) propagates unchanged, same as it
 * would over the MCP transport.
 */
export async function runQuery(toolName: string, jsonArgs: string, options: RunQueryOptions = {}): Promise<string> {
  const config = resolveConfig({ projectRoot: options.path, stateDirOverride: options.stateDir });

  // openDatabase() creates graph.db on first open (better-sqlite3's default
  // behavior for a missing file), so the never-indexed case must be caught
  // BEFORE opening it — otherwise "no index" would silently succeed against a
  // freshly-created empty database instead of failing fast. M6 (empty-state
  // read semantics) is explicitly out of scope; this is only a guard against
  // openDatabase's own create-on-open side effect.
  const graphDbPath = join(config.resolved_state_dir, 'graph.db');
  if (!existsSync(graphDbPath)) {
    throw new QueryError(
      `no index found at ${config.resolved_state_dir}; run \`mast init\` / \`mast index\` first`,
    );
  }

  // AFTER the never-indexed guard above, and deliberately so. Running the
  // indexer first would create graph.db as a side effect and let the guard
  // pass, silently promoting `--reindex` from "refresh" to "bootstrap" and
  // masking the very state the guard reports — the same ordering hazard its
  // own comment describes for `openDatabase`. `mast index` creates; this
  // refreshes.
  if (options.reindex === true) {
    const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
    const reindex = options.reindexer ?? ((c: ResolvedConfig) => runIndex(c, { incremental: true }));
    try {
      const result = await reindex(config);
      warn(
        `[mast] reindexed: ${String(result.filesIndexed)} file(s) indexed, ` +
        `${String(result.filesSkipped)} unchanged, +${String(result.chunksAdded)}/` +
        `-${String(result.chunksRemoved)} chunks (${String(result.durationMs)} ms)`,
      );
    } catch (err) {
      // Never fatal. `runIndex` takes `structure.lock`, and `mast serve` now
      // watches by default, so losing the race to a concurrent writer is an
      // ordinary outcome. Failing the query over a refresh that did not happen
      // would be a worse answer than a slightly stale one — but staying silent
      // about it would be worse than both, because the caller asked for fresh.
      warn(`[mast] --reindex failed, querying the existing index instead: ${String(err)}`);
    }
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(jsonArgs);
  } catch (err) {
    throw new QueryError(
      `malformed JSON argument: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const db = openDatabase(config.resolved_state_dir);
  try {
    const chunkStore = new SqliteChunkStore(db);
    // Each CLI invocation is its own metrics session — unlike `serve()`,
    // there is no long-lived MCP connection to key session-scoped telemetry
    // (mast_efficiency's "session" scope) to.
    const ctx: AppContext = { db, chunkStore, config, sessionId: randomUUID() };

    const { server, tools } = createCaptureServer();
    registerAllTools(server, ctx);

    const tool = tools.get(toolName);
    if (tool === undefined) {
      const available = [...tools.keys()].sort().join(', ');
      throw new QueryError(`unknown tool "${toolName}"; available tools: ${available}`);
    }

    let validatedArgs: Record<string, unknown>;
    try {
      // The CLI arg string crosses a trust boundary (project CLAUDE.md §3.2);
      // this reuses the exact per-tool zod shape the MCP layer validates
      // with, so a CLI call can never see a tool accept input the MCP
      // transport would have rejected, or vice versa.
      validatedArgs = z.object(tool.schemaShape).parse(parsedArgs);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new QueryError(`invalid arguments for "${toolName}": ${JSON.stringify(err.issues, null, 2)}`);
      }
      throw err;
    }

    const result = await tool.handler(validatedArgs);
    return result.content[0].text;
  } finally {
    await db.destroy();
  }
}

/**
 * @param run Injected so the flag wiring can be tested without a real index
 *   (§4.4). Production passes {@link runQuery}. A `--reindex` flag that is
 *   declared but never threaded through would be an asserted-and-unimplemented
 *   property (SHAPES S-04), which is why it is pinned rather than assumed.
 */
export function registerQueryCommand(program: Command, run: typeof runQuery = runQuery): void {
  program
    .command('query <tool> [json] [path]')
    .description('Invoke an MCP read tool directly from the CLI — identical output to the MCP transport (MAST_SPEC.md §8)')
    .option('--state-dir <dir>', 'State directory')
    .option('--reindex', 'Incrementally reindex before querying — the CLI has no watcher (see `mast serve`)')
    .option('--json', 'Emit the exact single-line MCP response text (machine use); default pretty-prints for humans')
    .action(async (
      toolName: string,
      jsonArg: string | undefined,
      path: string | undefined,
      opts: { stateDir?: string; json?: boolean; reindex?: boolean },
    ) => {
      try {
        const text = await run(toolName, jsonArg ?? '{}', {
          stateDir: opts.stateDir, path, reindex: opts.reindex === true,
        });
        if (opts.json) {
          process.stdout.write(text + '\n');
        } else {
          process.stdout.write(JSON.stringify(JSON.parse(text), null, 2) + '\n');
        }
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}
