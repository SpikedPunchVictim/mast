import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ReindexResult } from '../../ast/types.js';
import { runIndex } from '../../indexer/index.js';

export function registerReindexTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_reindex',
    'Synchronously reindex changed files. Call this immediately after writing files so subsequent queries see your changes. Incremental by default — only re-parses files whose mtime changed.',
    {
      full: z.boolean().optional().describe('Force a full reindex of all files (slow; use only after large structural changes)'),
    },
    async (args) => {
      const result = await runIndex(ctx.config, { incremental: !(args.full ?? false) });
      const reindexResult: ReindexResult = {
        files_indexed:   result.filesIndexed,
        files_skipped:   result.filesSkipped,
        chunks_added:    result.chunksAdded,
        chunks_removed:  result.chunksRemoved,
        parse_errors:    result.parseErrors,
        duration_ms:     result.durationMs,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(reindexResult) }] };
    },
  );
}
