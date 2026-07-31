import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { DependenciesResponse } from '../../ast/types.js';
import { buildToolStats, recordToolCall } from '../../telemetry/metrics.js';
import { countTokens, estimateFullFileBound } from '../../telemetry/tokenizer.js';
import { queryDependencies } from '../../graph/queries.js';
import { jitRefreshFile } from './_helpers.js';

export function registerDependenciesTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_dependencies',
    'All imports for a file — what it depends on, whether each dependency is external or internal, and the resolved path for monorepo imports.',
    {
      file_path: z.string().describe('Path to the file, relative to the project root'),
    },
    async (args) => {
      const start = Date.now();

      const { busy } = await jitRefreshFile(ctx.db, ctx.config, args.file_path);

      const imports = await queryDependencies(ctx.db, args.file_path);

      const text = JSON.stringify(imports);
      const tokens = countTokens(text);
      const tokensFullFileBound = estimateFullFileBound([args.file_path], ctx.config.resolved_project_root);
      const durationMs = Date.now() - start;

      const response: DependenciesResponse = {
        file_path: args.file_path,
        imports,
        // §9.0 TOCTOU policy: omitted when false, never present-and-false.
        ...(busy ? { file_busy_returning_stale_cache: true as const } : {}),
        _stats: buildToolStats('mast_dependencies', tokens, tokensFullFileBound, [args.file_path], durationMs),
      };
      void recordToolCall(ctx.db, {
        toolName: 'mast_dependencies', tokensReturned: tokens, tokensFullFileBound,
        durationMs, sessionId: ctx.sessionId, status: 'ok',
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
