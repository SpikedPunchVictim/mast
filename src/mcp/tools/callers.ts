import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type {
  CallersResponse,
  VerifiedCaller,
  PotentialMatch,
  CallerResolution,
} from '../../ast/types.js';
import { buildToolStats, recordToolCall } from '../../telemetry/metrics.js';
import { countTokens } from '../../telemetry/tokenizer.js';
import { querySymbolByName, queryVerifiedCallers } from '../../graph/queries.js';
import { searchIdentifiers } from '../../search/fts.js';
import { jitRefreshFile } from './_helpers.js';

export function registerCallersTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_callers',
    'Call sites of a named symbol, partitioned into verified (graph-resolved) and potential (identifier-FTS) sets. Always check both sets — the graph only covers statically-linked call sites.',
    {
      symbol: z.string().describe('Symbol name whose callers to find'),
      file_path: z.string().nullable().optional().describe('File that defines the symbol (disambiguates overloaded names)'),
      transitive: z.boolean().optional().describe('Follow callers-of-callers recursively via POTENTIAL_CALL edges (verified set only)'),
      include_potential: z.boolean().optional().describe('Include identifier-FTS matches as potential_matches (default: true)'),
    },
    async (args) => {
      const start = Date.now();
      const filePath = args.file_path ?? null;

      if (filePath != null) {
        await jitRefreshFile(ctx.db, ctx.lance, ctx.config, filePath);
      }

      const symbols = await querySymbolByName(ctx.db, args.symbol, filePath ?? undefined);

      if (symbols.length === 0) {
        const response: CallersResponse = {
          verified_callers: [],
          potential_matches: [],
          summary: { verified_count: 0, potential_count: 0, transitive: args.transitive ?? false },
          _stats: buildToolStats(
            'mast_callers', 0, 0,
            filePath != null ? [filePath] : [],
            Date.now() - start,
          ),
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
      }

      // Use the first symbol (querySymbolByName orders by exported-first, then path).
      const target = symbols[0]!;

      const verifiedRows = await queryVerifiedCallers(ctx.db, target.id, args.transitive ?? false);
      const verified_callers: VerifiedCaller[] = verifiedRows.map((r) => ({
        file_path: r.file_path,
        line: r.line,
        caller_symbol: r.caller_symbol,
        context: r.context,
        resolution: r.resolution as CallerResolution,
      }));

      let potential_matches: PotentialMatch[] = [];
      if (args.include_potential !== false) {
        const identRows = await searchIdentifiers(ctx.db, args.symbol, 50);
        const chunkIds = identRows.map((r) => r.chunk_id);
        const chunks = await ctx.lance.getChunksByIds(chunkIds);

        // Exclude chunk IDs already covered by the verified set.
        const verifiedKeys = new Set(
          verified_callers.map((c) => `${c.file_path}:${c.line}`),
        );
        for (const chunk of chunks) {
          if (verifiedKeys.has(`${chunk.file_path}:${chunk.start_line}`)) continue;
          potential_matches.push({
            file_path: chunk.file_path,
            line: chunk.start_line,
            context: chunk.symbol_name ?? '',
            reason: 'identifier_match_no_resolved_edge',
          });
        }
      }

      const filesReferenced = [
        ...new Set([
          ...verified_callers.map((c) => c.file_path),
          ...potential_matches.map((m) => m.file_path),
        ]),
      ];
      const text = JSON.stringify({ verified_callers, potential_matches });
      const tokens = countTokens(text);
      const durationMs = Date.now() - start;

      const response: CallersResponse = {
        verified_callers,
        potential_matches,
        summary: {
          verified_count: verified_callers.length,
          potential_count: potential_matches.length,
          transitive: args.transitive ?? false,
        },
        _stats: buildToolStats('mast_callers', tokens, 0, filesReferenced, durationMs),
      };
      void recordToolCall(ctx.db, {
        toolName: 'mast_callers', tokensReturned: tokens, tokensFullFileBound: 0,
        durationMs, sessionId: ctx.sessionId, status: 'ok',
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
