import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { ProjectSkeletonResponse } from '../../ast/types.js';
import { buildToolStats, recordToolCall } from '../../telemetry/metrics.js';
import { countTokens } from '../../telemetry/tokenizer.js';
import { queryProjectSkeleton } from '../../graph/queries.js';
import { globToRegex } from './_helpers.js';

export function registerProjectSkeletonTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_project_skeleton',
    'All file paths in the project with their exported top-level symbol names. Returns names only — no signatures or bodies. Use early in a task for architectural orientation.',
    {
      directory: z.string().nullable().optional().describe('Scope to a subtree of the project (e.g. "api/services/auth")'),
      max_depth: z.number().int().min(1).optional().describe('Max directory depth relative to `directory` (default: unlimited)'),
      file_pattern: z.string().nullable().optional().describe('Glob to further restrict files returned'),
    },
    async (args) => {
      const start = Date.now();

      const directory = args.directory ?? undefined;
      let rows = await queryProjectSkeleton(ctx.db, directory);

      if (args.max_depth != null && directory != null) {
        const prefix = directory.endsWith('/') ? directory : `${directory}/`;
        rows = rows.filter((r) => {
          const rel = r.file_path.startsWith(prefix)
            ? r.file_path.slice(prefix.length)
            : r.file_path.slice(directory.length).replace(/^\//, '');
          const depth = (rel.match(/\//g) ?? []).length;
          return depth < args.max_depth!;
        });
      }

      if (args.file_pattern != null) {
        const rx = globToRegex(args.file_pattern);
        rows = rows.filter((r) => rx.test(r.file_path));
      }

      // Group by file_path, preserving declaration order.
      const fileMap = new Map<string, string[]>();
      for (const row of rows) {
        const symbols = fileMap.get(row.file_path) ?? [];
        symbols.push(row.symbol_name);
        fileMap.set(row.file_path, symbols);
      }

      const files = [...fileMap.entries()].map(([file_path, exports]) => ({
        file_path,
        exports,
      }));

      const text = JSON.stringify(files);
      const tokens = countTokens(text);
      const durationMs = Date.now() - start;
      const filesReferenced = files.map((f) => f.file_path);

      const response: ProjectSkeletonResponse = {
        files,
        _stats: buildToolStats('mast_project_skeleton', tokens, 0, filesReferenced, durationMs),
      };
      void recordToolCall(ctx.db, {
        toolName: 'mast_project_skeleton', tokensReturned: tokens, tokensFullFileBound: 0,
        durationMs, sessionId: ctx.sessionId, status: 'ok',
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
