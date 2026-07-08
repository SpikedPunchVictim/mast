import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { SearchResponse } from '../../ast/types.js';
import { buildToolStats, recordToolCall } from '../../telemetry/metrics.js';
import { countTokens } from '../../telemetry/tokenizer.js';
import { hybridSearch } from '../../search/hybrid.js';

export function registerSearchTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_search',
    'Hybrid semantic + BM25 search over the indexed codebase. Returns chunks (not full files) ranked by relevance. Use this for code discovery — replaces Grep, Glob, and exploratory Read.',
    {
      query: z.string().describe('Natural language or identifier-based search query'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default: 10)'),
      language: z.enum(['typescript', 'javascript']).nullable().optional(),
      file_pattern: z.string().nullable().optional().describe('Glob pattern to restrict results to matching files'),
      chunk_type: z.enum(['function', 'method', 'class_shell', 'interface', 'type', 'export', 'block']).nullable().optional(),
      only_exported: z.boolean().optional().describe('Restrict to exported symbols only'),
    },
    async (args) => {
      const start = Date.now();
      const { mode, results, suggestions } = await hybridSearch(
        ctx.db,
        ctx.lance,
        ctx.getEmbedder(),
        args,
        { rrf_k: ctx.config.rrf_k, similarity_threshold: ctx.config.similarity_threshold },
      );
      const filesReferenced = [...new Set(results.map((r) => r.file_path))];
      // `suggestions` is present (possibly empty) only on the zero-result assist
      // path; conditional spread keeps it out of the payload otherwise.
      const suggestionsField = suggestions !== undefined ? { suggestions } : {};
      const text = JSON.stringify({ mode, results, ...suggestionsField });
      const tokens = countTokens(text);
      const durationMs = Date.now() - start;
      const response: SearchResponse = {
        mode,
        results,
        ...suggestionsField,
        _stats: buildToolStats('mast_search', tokens, 0, filesReferenced, durationMs, mode),
      };
      void recordToolCall(ctx.db, {
        toolName: 'mast_search', tokensReturned: tokens, tokensFullFileBound: 0,
        durationMs, mode, sessionId: ctx.sessionId, status: 'ok',
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
