import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { SearchResponse } from '../../ast/types.js';
import { buildToolStats, recordToolCall, buildArgsJson, buildResultsJson, buildDeclexJson } from '../../telemetry/metrics.js';
import { countTokens, estimateFullFileBound } from '../../telemetry/tokenizer.js';
import { fusedSearch } from '../../search/fused.js';
import { findStaleFiles } from '../staleness.js';
import { isIndexEmpty , unindexedFilesField} from './_helpers.js';

export function registerSearchTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_search',
    'Lexical BM25 + declaration-exact search over the indexed codebase. Returns chunks (not full files) ranked by relevance. Use this for code discovery — replaces Grep, Glob, and exploratory Read. If a response carries `unindexed_files`, that many files on disk are not in the index yet, so an empty or thin result set may mean "not indexed" rather than "not present" — run mast_reindex before concluding a symbol is absent.',
    {
      query: z.string().describe('Natural language or identifier-based search query'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default: 10)'),
      language: z.enum(['typescript', 'javascript', 'markdown']).nullable().optional(),
      file_pattern: z.string().nullable().optional().describe('Glob pattern to restrict results to matching files'),
      chunk_type: z.enum(['function', 'method', 'class_shell', 'interface', 'type', 'export', 'block', 'doc']).nullable().optional(),
      only_exported: z.boolean().optional().describe('Restrict to exported symbols only'),
    },
    async (args) => {
      const start = Date.now();
      const { results, suggestions, declex } = await fusedSearch(
        ctx.db,
        args,
        { rrf_k: ctx.config.rrf_k, declaration_exact_ranker: ctx.config.declaration_exact_ranker },
        ctx.chunkStore,
      );
      const filesReferenced = [...new Set(results.map((r) => r.file_path))];
      // F7/C1: stat-and-flag, not JIT refresh — surfaced as `stale`, not
      // `file_busy_returning_stale_cache` (that name is reserved for the
      // JIT-refresh tools, where a refresh is actually attempted). See
      // staleness.ts's `findStaleFiles` WHY-comment. Computed against the
      // ranking fusedSearch already produced; flagged results are what gets
      // token-counted and returned below.
      const staleFiles = await findStaleFiles(ctx.db, ctx.config, filesReferenced);
      const flaggedResults = staleFiles.size === 0
        ? results
        : results.map((r) => ({
            ...r,
            ...(staleFiles.has(r.file_path) ? { stale: true as const } : {}),
          }));
      // `suggestions` is present (possibly empty) only on the zero-result assist
      // path; conditional spread keeps it out of the payload otherwise.
      const suggestionsField = suggestions !== undefined ? { suggestions } : {};
      const text = JSON.stringify({ results: flaggedResults, ...suggestionsField });
      const tokens = countTokens(text);
      const tokensFullFileBound = estimateFullFileBound(filesReferenced, ctx.config.resolved_project_root);
      const durationMs = Date.now() - start;
      // M6 (§13.8 item 4): checked ONLY on the empty-result path — a
      // populated response never pays the chunkCount() query.
      const indexEmptyField = flaggedResults.length === 0 && await isIndexEmpty(ctx)
        ? { index_empty: true as const }
        : {};
      // The partial-index warning. `peekUnindexed` is synchronous and returns
      // the server's last cached measurement; it may schedule a background
      // refresh, but this handler never awaits one (freshness-probe.ts, which
      // documents the residual cost). `null` means no measurement has landed
      // yet: unknown, so say nothing rather than imply a clean index we have
      // not verified.
      // Search claims exhaustiveness, so this fires with results as well as
      // without: a ranked list drawn from an incomplete corpus is thin rather
      // than empty, and reads the same as a complete one.
      const unindexedField = unindexedFilesField(ctx, 'exhaustive-set', flaggedResults.length === 0);
      const response: SearchResponse = {
        results: flaggedResults,
        ...suggestionsField,
        ...indexEmptyField,
        ...unindexedField,
        _stats: buildToolStats('mast_search', tokens, tokensFullFileBound, filesReferenced, durationMs),
      };
      // Identity pairs in rank order — the "did a later chain-analysis call
      // target something this search returned?" evidence for the capsule
      // instrumentation decision (IMPLEMENTATION_PLAN_VEXP.md §P, 2026-07-15).
      const resultIdentities = results.map((r) => ({ file_path: r.file_path, symbol_name: r.symbol_name }));
      // Stage 6.3 — D-fire telemetry (M2 decision memo condition 3). Present
      // only when ranker D actually fired (fusedSearch's own contract);
      // never threaded into `response`/`text` above, per this feature's
      // no-leak requirement.
      const declexJsonField = declex !== undefined ? { declexJson: buildDeclexJson(declex) } : {};
      void recordToolCall(ctx.db, {
        toolName: 'mast_search', tokensReturned: tokens, tokensFullFileBound,
        durationMs, sessionId: ctx.sessionId, status: 'ok',
        argsJson: buildArgsJson(args),
        resultsJson: buildResultsJson(resultIdentities),
        ...declexJsonField,
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
