import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ImplementorsResponse } from '../../ast/types.js';
import { buildToolStats, recordToolCall } from '../../telemetry/metrics.js';
import { countTokens, estimateFullFileBound } from '../../telemetry/tokenizer.js';
import { queryImplementors } from '../../graph/queries.js';
import { findStaleFiles } from '../staleness.js';
import { isIndexEmpty, DEFAULT_RESULT_LIMIT , unindexedFilesField} from './_helpers.js';

export function registerImplementorsTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_implementors',
    'All classes that implement a named interface, with the list of methods each class provides.',
    {
      interface_name: z.string().describe('Name of the interface to find implementors of'),
      limit: z.number().int().min(1).max(500).optional().describe('Max implementors to return (default: 50). The response reports the real total in `results_truncated` when it caps.'),
    },
    async (args) => {
      const start = Date.now();

      const allResults = await queryImplementors(ctx.db, args.interface_name);

      // D043. Capped before the staleness stat below, so a truncated response
      // does not pay to stat files it will not mention.
      const limit = args.limit ?? DEFAULT_RESULT_LIMIT;
      const results = allResults.slice(0, limit);
      const resultsTruncated = allResults.length > limit ? allResults.length : undefined;

      const filesReferenced = [...new Set(results.map((r) => r.file_path))];
      // F7/C1: stat-and-flag, not JIT refresh — surfaced as `stale`, not
      // `file_busy_returning_stale_cache` (that name is reserved for the
      // JIT-refresh tools, where a refresh is actually attempted). See
      // staleness.ts's `findStaleFiles` WHY-comment. Flag before token
      // counting so `_stats.tokens_returned` reflects the payload actually
      // returned.
      const staleFiles = await findStaleFiles(ctx.db, ctx.config, filesReferenced);
      const flaggedResults = staleFiles.size === 0
        ? results
        : results.map((r) => ({
            ...r,
            ...(staleFiles.has(r.file_path) ? { stale: true as const } : {}),
          }));
      const text = JSON.stringify(flaggedResults);
      const tokens = countTokens(text);
      const tokensFullFileBound = estimateFullFileBound(filesReferenced, ctx.config.resolved_project_root);
      const durationMs = Date.now() - start;

      // M6 (§13.8 item 4): checked ONLY on the empty-result path.
      const indexEmptyField = flaggedResults.length === 0 && await isIndexEmpty(ctx)
        ? { index_empty: true as const }
        : {};
      const response: ImplementorsResponse = {
        results: flaggedResults,
        ...(resultsTruncated !== undefined ? { results_truncated: resultsTruncated } : {}),
        ...indexEmptyField,
        ...unindexedFilesField(ctx, 'exhaustive-set', flaggedResults.length === 0),
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
