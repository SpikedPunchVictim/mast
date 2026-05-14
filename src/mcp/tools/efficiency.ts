import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { EfficiencyResult } from '../../ast/types.js';
import { queryMetricsSummary, querySessionSummary } from '../../telemetry/metrics.js';

export function registerEfficiencyTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_efficiency',
    'Token savings report: how many tokens MAST returned vs. how many a naive full-file read would have cost, for this session or globally.',
    {
      scope: z.enum(['session', 'global']).describe('"session" = current MCP session only; "global" = all-time from metrics DB'),
      since_minutes: z.number().int().min(1).optional().describe('Only include calls within the last N minutes (global scope only)'),
    },
    async (args) => {
      const rows =
        args.scope === 'session'
          ? await querySessionSummary(ctx.db, ctx.sessionId)
          : await queryMetricsSummary(
              ctx.db,
              args.since_minutes !== undefined
                ? Date.now() - args.since_minutes * 60_000
                : 0,
            );

      const tokensReturned = rows.reduce((s, r) => s + r.tokens_returned_total, 0);
      const tokensFullFile = rows.reduce((s, r) => s + r.tokens_full_file_total, 0);
      const callsTotal     = rows.reduce((s, r) => s + r.calls, 0);
      const callsByTool    = Object.fromEntries(rows.map((r) => [r.tool_name, r.calls]));

      const efficiencyRatio =
        tokensFullFile > 0 ? 1 - tokensReturned / tokensFullFile : 0;

      const saved = tokensFullFile - tokensReturned;
      const windowStartedAt =
        args.scope === 'global' && args.since_minutes !== undefined
          ? new Date(Date.now() - args.since_minutes * 60_000).toISOString()
          : new Date(0).toISOString();

      const result: EfficiencyResult = {
        scope:                        args.scope,
        window_started_at:            windowStartedAt,
        tokens_returned:              tokensReturned,
        tokens_full_file_upper_bound: tokensFullFile,
        efficiency_ratio:             efficiencyRatio,
        calls_total:                  callsTotal,
        calls_by_tool:                callsByTool,
        tokenizer:                    'anthropic/cl100k',
        counterfactual:
          tokensFullFile > 0
            ? `Would have cost ~${tokensFullFile} tokens with naive full-file reads; saved ~${saved} tokens (${(efficiencyRatio * 100).toFixed(1)}%).`
            : 'No tool calls recorded yet.',
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
