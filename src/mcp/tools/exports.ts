import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ExportEntry, ExportsResponse } from '../../ast/types.js';
import { join } from 'node:path';
import { buildToolStats, recordToolCall, buildArgsJson, buildResultsJson } from '../../telemetry/metrics.js';
import { countTokens, estimateFullFileBound } from '../../telemetry/tokenizer.js';
import { extractFileSignatures } from '../../ast/extract.js';
import { extractDoc, jitRefreshFile } from './_helpers.js';

export function registerExportsTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_exports',
    'All exported symbols from a single file with type signatures. No function bodies. Use to answer "what does this file expose?" before deciding whether to open it.',
    {
      file_path: z.string().describe('Path to the file, relative to the project root'),
    },
    async (args) => {
      const start = Date.now();

      const { busy } = await jitRefreshFile(ctx.db, ctx.config, args.file_path);

      const chunks = await ctx.chunkStore.getChunksByFilePath(args.file_path);

      // Body-free signatures (params/return stripped of bodies, §10.2), keyed
      // by symbol name. Falls back to chunk content if a symbol isn't found.
      const sigs = extractFileSignatures(join(ctx.config.resolved_project_root, args.file_path));
      const sigByName = new Map(sigs.map((s) => [s.name, s]));

      // Methods surface through their class_shell — omit them here.
      const topLevel = chunks.filter(
        (c) => c.is_exported && c.chunk_type !== 'method',
      );

      const exports: ExportEntry[] = topLevel.map((c) => {
        const sig = c.symbol_name !== null ? sigByName.get(c.symbol_name) : undefined;
        return {
          name: c.symbol_name ?? '',
          kind: c.chunk_type === 'class_shell' ? 'class' : c.chunk_type,
          signature: sig?.signature ?? c.content,
          line: c.start_line,
          doc: sig?.doc ?? extractDoc(c.content),
        };
      });

      const text = JSON.stringify(exports);
      const tokens = countTokens(text);
      const tokensFullFileBound = estimateFullFileBound([args.file_path], ctx.config.resolved_project_root);
      const durationMs = Date.now() - start;

      const response: ExportsResponse = {
        file_path: args.file_path,
        exports,
        // §9.0 TOCTOU policy: omitted when false, never present-and-false.
        ...(busy ? { file_busy_returning_stale_cache: true as const } : {}),
        _stats: buildToolStats('mast_exports', tokens, tokensFullFileBound, [args.file_path], durationMs),
      };
      const resultIdentities = exports.map((e) => ({ file_path: args.file_path, symbol_name: e.name }));
      void recordToolCall(ctx.db, {
        toolName: 'mast_exports', tokensReturned: tokens, tokensFullFileBound,
        durationMs, sessionId: ctx.sessionId, status: 'ok',
        argsJson: buildArgsJson(args),
        resultsJson: buildResultsJson(resultIdentities),
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
