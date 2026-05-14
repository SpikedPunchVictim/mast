import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ExportEntry, ExportsResponse } from '../../ast/types.js';
import { buildToolStats, recordToolCall } from '../../telemetry/metrics.js';
import { countTokens } from '../../telemetry/tokenizer.js';
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

      await jitRefreshFile(ctx.db, ctx.lance, ctx.config, args.file_path);

      const chunks = await ctx.lance.getChunksByFilePath(args.file_path);

      // Methods surface through their class_shell — omit them here.
      const topLevel = chunks.filter(
        (c) => c.is_exported && c.chunk_type !== 'method',
      );

      const exports: ExportEntry[] = topLevel.map((c) => ({
        name: c.symbol_name ?? '',
        kind: c.chunk_type === 'class_shell' ? 'class' : c.chunk_type,
        signature: c.content,
        line: c.start_line,
        doc: extractDoc(c.content),
      }));

      const text = JSON.stringify(exports);
      const tokens = countTokens(text);
      const durationMs = Date.now() - start;

      const response: ExportsResponse = {
        file_path: args.file_path,
        exports,
        _stats: buildToolStats('mast_exports', tokens, 0, [args.file_path], durationMs),
      };
      void recordToolCall(ctx.db, {
        toolName: 'mast_exports', tokensReturned: tokens, tokensFullFileBound: 0,
        durationMs, sessionId: ctx.sessionId, status: 'ok',
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
