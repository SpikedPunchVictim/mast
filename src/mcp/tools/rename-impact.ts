import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type {
  RenameImpactResponse,
  DeclarationSite,
  BarrelExportSite,
  VerifiedCaller,
  PotentialMatch,
  CallerResolution,
} from '../../ast/types.js';
import { buildToolStats, recordToolCall } from '../../telemetry/metrics.js';
import { countTokens } from '../../telemetry/tokenizer.js';
import { querySymbolByName, queryVerifiedCallers, queryBarrelExports } from '../../graph/queries.js';
import { jitRefreshFile, collectPotentialMatches } from './_helpers.js';

/**
 * Compose the "N verified sites, M review-required sites, K barrel exports"
 * framing the agent acts on. A sentence rather than only counts so the tool
 * output reads as a checklist even when the agent skims.
 */
function buildChecklist(verified: number, potential: number, barrels: number): string {
  return [
    `${verified} verified call site(s) to update`,
    `${potential} review-required identifier match(es)`,
    `${barrels} barrel export(s) to update`,
  ].join(', ') + '.';
}

export function registerRenameImpactTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_rename_impact',
    'Refactor checklist for renaming a symbol: declaration sites, verified call sites (graph), review-required identifier matches (FTS), and barrel re-exports. Composes mast_callers + graph re-export data in one call.',
    {
      symbol: z.string().describe('Symbol to be renamed (methods qualified as ClassName.methodName)'),
      file_path: z.string().nullable().optional().describe('File that declares the symbol (disambiguates duplicate names)'),
    },
    async (args) => {
      const start = Date.now();
      const filePath = args.file_path ?? null;

      // §9.0 staleness: same JIT policy as mast_callers — refresh the named
      // file so declaration/caller line numbers reflect disk.
      if (filePath != null) {
        await jitRefreshFile(ctx.db, ctx.lance, ctx.config, filePath);
      }

      const symbols = await querySymbolByName(ctx.db, args.symbol, filePath ?? undefined);

      const declaration_sites: DeclarationSite[] = symbols.map((s) => ({
        file_path: s.file_path,
        line: s.line,
        kind: s.kind,
        is_exported: s.is_exported === 1,
      }));

      // Impact is computed against the best declaration match — same
      // first-symbol convention as mast_callers. All declarations are still
      // listed so an ambiguous rename is visible in the checklist.
      const target = symbols[0];

      let verified_callers: VerifiedCaller[] = [];
      let potential_matches: PotentialMatch[] = [];
      let barrel_exports: BarrelExportSite[] = [];

      if (target !== undefined) {
        // Direct callers only — a rename edits call sites, and every call site
        // is a direct caller; transitive callers need no edit (deliberate v1 scope).
        const verifiedRows = await queryVerifiedCallers(ctx.db, target.id, false);
        verified_callers = verifiedRows.map((r) => ({
          file_path: r.file_path,
          line: r.line,
          caller_symbol: r.caller_symbol,
          context: r.context,
          resolution: r.resolution as CallerResolution,
        }));

        potential_matches = await collectPotentialMatches(ctx.db, ctx.lance, args.symbol, verified_callers);

        const barrelRows = await queryBarrelExports(ctx.db, target.id, args.symbol, target.file_id);
        barrel_exports = barrelRows.map((b) => ({
          file_path: b.file_path,
          line: b.line,
          exported_as: b.exported_as,
          via: b.via,
        }));
      }

      const filesReferenced = [
        ...new Set([
          ...declaration_sites.map((d) => d.file_path),
          ...verified_callers.map((c) => c.file_path),
          ...potential_matches.map((m) => m.file_path),
          ...barrel_exports.map((b) => b.file_path),
        ]),
      ];
      const body = { declaration_sites, verified_callers, potential_matches, barrel_exports };
      const tokens = countTokens(JSON.stringify(body));
      const durationMs = Date.now() - start;

      const response: RenameImpactResponse = {
        symbol: args.symbol,
        ...body,
        summary: {
          declaration_count: declaration_sites.length,
          verified_count: verified_callers.length,
          potential_count: potential_matches.length,
          barrel_count: barrel_exports.length,
          checklist:
            target === undefined
              ? `Symbol "${args.symbol}" not found in the index — nothing to rename.`
              : buildChecklist(verified_callers.length, potential_matches.length, barrel_exports.length),
        },
        _stats: buildToolStats('mast_rename_impact', tokens, 0, filesReferenced, durationMs),
      };
      void recordToolCall(ctx.db, {
        toolName: 'mast_rename_impact', tokensReturned: tokens, tokensFullFileBound: 0,
        durationMs, sessionId: ctx.sessionId, status: 'ok',
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
