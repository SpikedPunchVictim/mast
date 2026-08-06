import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { StatusResult } from '../../ast/types.js';
import { loadIndexMeta, freshnessCause } from '../../indexer/index.js';
import { countStaleFiles } from './_helpers.js';

export function registerStatusTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_status',
    'Index health summary: last-indexed time, file/chunk counts, stale file count, pending embeddings, freshness cause, current search mode.',
    // No input parameters.
    {},
    async (_args) => {
      const meta = loadIndexMeta(ctx.config.resolved_state_dir);
      const stale_files = await countStaleFiles(ctx.db, ctx.config.resolved_project_root);
      // Stage 7.2 removes this field — frozen at 0 during excision (the vector
      // subsystem that produced it, countPendingEmbeddings, was deleted in
      // Stage 7.1; IMPLEMENTATION_PLAN.md "Stage 7").
      const pending_embeddings = 0;
      const result: StatusResult = {
        state_dir:      ctx.config.resolved_state_dir,
        last_indexed:   meta?.last_indexed ?? null,
        indexed_files:  meta?.file_count ?? 0,
        chunk_count:    meta?.chunk_count ?? 0,
        stale_files,
        pending_embeddings,
        parse_errors:   meta?.parse_errors ?? 0,
        write_errors:   meta?.write_errors ?? 0,
        index_fresh:    meta !== null && stale_files === 0,
        freshness_cause: freshnessCause(stale_files, pending_embeddings),
        model:          ctx.config.embedding_model,
        seed_commit:    meta?.seed_commit,
        embedding_mode: ctx.searchMode(),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
