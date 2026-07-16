import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ImplementorsResponse } from '../../ast/types.js';
import { buildToolStats, recordToolCall } from '../../telemetry/metrics.js';
import { countTokens, estimateFullFileBound } from '../../telemetry/tokenizer.js';
import { queryImplementors } from '../../graph/queries.js';

export function registerImplementorsTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_implementors',
    'All classes that implement a named interface, with the list of methods each class provides.',
    {
      interface_name: z.string().describe('Name of the interface to find implementors of'),
    },
    async (args) => {
      const start = Date.now();

      const results = await queryImplementors(ctx.db, args.interface_name);

      const filesReferenced = [...new Set(results.map((r) => r.file_path))];
      const text = JSON.stringify(results);
      const tokens = countTokens(text);
      const tokensFullFileBound = estimateFullFileBound(filesReferenced, ctx.config.resolved_project_root);
      const durationMs = Date.now() - start;

      const response: ImplementorsResponse = {
        results,
        _stats: buildToolStats('mast_implementors', tokens, tokensFullFileBound, filesReferenced, durationMs),
      };
      void recordToolCall(ctx.db, {
        toolName: 'mast_implementors', tokensReturned: tokens, tokensFullFileBound,
        durationMs, sessionId: ctx.sessionId, status: 'ok',
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
