import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

/**
 * Register every MAST MCP tool against `server`.
 *
 * D0 (IMPLEMENTATION_PLAN.md "Stage 4: Determinism, hygiene, and the
 * measurement harness", "### D0 — CLI query surface"): this list previously
 * existed only inlined in `mcp/server.ts` and duplicated (by hand) in
 * `mcp/tools/__tests__/tools.test.ts`'s `createMockServer` setup. A third copy
 * in the CLI query dispatcher (`cli/query.ts`) would let a new tool ship
 * reachable over one transport but not the other — extracting one function
 * both `serve()` and the CLI import closes that gap by construction.
 *
 * Registration order is preserved from the original `server.ts` inline list
 * (search, project-skeleton, exports, signature, callers, dependencies,
 * implementors, reindex, status, efficiency, rename-impact) — nothing here
 * depends on order today, but changing it silently would be an unannounced
 * behavior change during what is meant to be a behavior-preserving refactor.
 */
export function registerAllTools(server: McpServer, ctx: AppContext): void {
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
}
