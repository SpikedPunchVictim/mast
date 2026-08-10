import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type {
  CallersResponse,
  VerifiedCaller,
  PotentialMatch,
  CallerResolution,
} from '../../ast/types.js';
import { buildToolStats, recordToolCall, buildArgsJson, buildResultsJson } from '../../telemetry/metrics.js';
import { countTokens, estimateFullFileBound } from '../../telemetry/tokenizer.js';
import { querySymbolByName, queryVerifiedCallers } from '../../graph/queries.js';
import { jitRefreshFile, collectPotentialMatches, isIndexEmpty } from './_helpers.js';

export function registerCallersTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_callers',
    'Call sites of a named symbol, partitioned into verified (graph-resolved) and potential (identifier-FTS) sets. Always check both sets — the graph only covers statically-linked call sites. Verified entries with resolution "checker" were proven by the opt-in `mast index --checker` TypeScript pass; the same pass drops non-call-site / wrong-declaration noise out of potential_matches (summary.checker_classified_* report how many).',
    {
      symbol: z.string().describe('Symbol name whose callers to find'),
      file_path: z.string().nullable().optional().describe('File that defines the symbol (disambiguates overloaded names)'),
      transitive: z.boolean().optional().describe('Follow callers-of-callers recursively via POTENTIAL_CALL edges (verified set only)'),
      include_potential: z.boolean().optional().describe('Include identifier-FTS matches as potential_matches (default: true)'),
    },
    async (args) => {
      const start = Date.now();
      const filePath = args.file_path ?? null;

      // §9.0 TOCTOU policy. This JITs the file that DECLARES the symbol (not
      // each caller's file — see CallersResponse.file_busy_returning_stale_cache
      // for why that puts the flag at the envelope, not per-VerifiedCaller).
      let fileBusy = false;
      if (filePath != null) {
        const r = await jitRefreshFile(ctx.db, ctx.config, filePath);
        fileBusy = r.busy;
      }

      const symbols = await querySymbolByName(ctx.db, args.symbol, filePath ?? undefined);

      if (symbols.length === 0) {
        const noSymbolFiles = filePath != null ? [filePath] : [];
        // M6 (§13.8 item 4): both sets are unconditionally empty on this
        // branch (no symbol to look up callers of), so the only question is
        // whether the index itself is empty.
        const indexEmptyField = await isIndexEmpty(ctx) ? { index_empty: true as const } : {};
        const response: CallersResponse = {
          verified_callers: [],
          potential_matches: [],
          // §9.0 TOCTOU policy: omitted when false, never present-and-false.
          ...(fileBusy ? { file_busy_returning_stale_cache: true as const } : {}),
          ...indexEmptyField,
          summary: {
            verified_count: 0,
            potential_count: 0,
            transitive: args.transitive ?? false,
            checker_classified_non_call_site: 0,
            checker_classified_different_declaration: 0,
          },
          _stats: buildToolStats(
            'mast_callers', 0,
            estimateFullFileBound(noSymbolFiles, ctx.config.resolved_project_root),
            noSymbolFiles,
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

      let potential_matches: readonly PotentialMatch[] = [];
      let checkerClassifiedNonCallSite = 0;
      let checkerClassifiedDifferentDeclaration = 0;
      let potentialTruncated: number | undefined;
      if (args.include_potential !== false) {
        const potentialResult = await collectPotentialMatches(ctx.db, ctx.chunkStore, target.id, args.symbol, verified_callers);
        potential_matches = potentialResult.matches;
        checkerClassifiedNonCallSite = potentialResult.checkerClassifiedNonCallSite;
        checkerClassifiedDifferentDeclaration = potentialResult.checkerClassifiedDifferentDeclaration;
        potentialTruncated = potentialResult.truncatedMatchCount;
      }

      const filesReferenced = [
        ...new Set([
          ...verified_callers.map((c) => c.file_path),
          ...potential_matches.map((m) => m.file_path),
        ]),
      ];
      const text = JSON.stringify({ verified_callers, potential_matches });
      const tokens = countTokens(text);
      const tokensFullFileBound = estimateFullFileBound(filesReferenced, ctx.config.resolved_project_root);
      const durationMs = Date.now() - start;

      // M6 (§13.8 item 4): checked ONLY when BOTH sets came back empty.
      const indexEmptyField = verified_callers.length === 0 && potential_matches.length === 0 && await isIndexEmpty(ctx)
        ? { index_empty: true as const }
        : {};
      const response: CallersResponse = {
        verified_callers,
        potential_matches,
        // §9.0 TOCTOU policy: omitted when false, never present-and-false.
        ...(fileBusy ? { file_busy_returning_stale_cache: true as const } : {}),
        ...indexEmptyField,
        summary: {
          verified_count: verified_callers.length,
          potential_count: potential_matches.length,
          transitive: args.transitive ?? false,
          checker_classified_non_call_site: checkerClassifiedNonCallSite,
          checker_classified_different_declaration: checkerClassifiedDifferentDeclaration,
          // F10: omitted-when-false — present only when the identifier-FTS cap was hit.
          ...(potentialTruncated !== undefined ? { potential_truncated: potentialTruncated } : {}),
        },
        _stats: buildToolStats('mast_callers', tokens, tokensFullFileBound, filesReferenced, durationMs),
      };
      const resultIdentities = [
        ...verified_callers.map((c) => ({ file_path: c.file_path, symbol_name: c.caller_symbol })),
        ...potential_matches.map((m) => ({ file_path: m.file_path, symbol_name: m.context || null })),
      ];
      void recordToolCall(ctx.db, {
        toolName: 'mast_callers', tokensReturned: tokens, tokensFullFileBound,
        durationMs, sessionId: ctx.sessionId, status: 'ok',
        argsJson: buildArgsJson(args),
        resultsJson: buildResultsJson(resultIdentities),
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
