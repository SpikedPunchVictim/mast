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

      // Phase 2: embed the chunks just written so subsequent mast_search sees
      // them semantically, not only via FTS (§7.5). Best-effort — Phase 1 is the
      // guarantee; embedPending swallows embedder failures and is a no-op when
      // nothing is pending.
      await ctx.embedPending();

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
