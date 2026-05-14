import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { SignatureResult, SignatureResponse } from '../../ast/types.js';
import { buildToolStats, recordToolCall } from '../../telemetry/metrics.js';
import { countTokens } from '../../telemetry/tokenizer.js';
import { querySymbolByName, resolveTypeContext } from '../../graph/queries.js';
import { extractDoc, jitRefreshFile } from './_helpers.js';

// TypeScript built-in types that are never worth resolving as user-defined types.
const BUILTIN_TYPES = new Set([
  'string', 'number', 'boolean', 'void', 'null', 'undefined', 'never', 'any',
  'unknown', 'object', 'symbol', 'bigint', 'Function', 'Object', 'Promise',
  'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Record', 'Partial', 'Required',
  'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable', 'ReturnType',
  'InstanceType', 'Parameters', 'ConstructorParameters', 'Error',
]);

/**
 * Extract user-defined PascalCase type names from a TypeScript signature.
 * Used to populate `type_context` in `mast_signature` responses.
 */
function extractTypeNames(signature: string): string[] {
  const re = /\b([A-Z][A-Za-z0-9]*)\b/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(signature)) !== null) {
    const name = m[1]!;
    if (!BUILTIN_TYPES.has(name)) names.add(name);
  }
  return [...names];
}

export function registerSignatureTool(server: McpServer, ctx: AppContext): void {
  server.tool(
    'mast_signature',
    'Declaration, TSDoc, and resolved parameter type context for a named symbol. Returns an array — always pass file_path to disambiguate when you expect a single result.',
    {
      symbol: z.string().describe('Symbol name to look up (e.g. "handleLogin", "AuthService")'),
      file_path: z.string().nullable().optional().describe('Narrow to a specific file; omit to search across the whole codebase'),
    },
    async (args) => {
      const start = Date.now();
      const filePath = args.file_path ?? null;

      if (filePath != null) {
        await jitRefreshFile(ctx.db, ctx.lance, ctx.config, filePath);
      }

      const symbols = await querySymbolByName(ctx.db, args.symbol, filePath ?? undefined);

      const results: SignatureResult[] = [];
      for (const sym of symbols) {
        if (filePath == null) {
          await jitRefreshFile(ctx.db, ctx.lance, ctx.config, sym.file_path);
        }

        const chunks = await ctx.lance.getChunksByFilePath(sym.file_path);

        // Prefer the chunk whose start_line matches the symbol's declared line;
        // fall back to first chunk with matching symbol_name.
        const chunk =
          chunks.find((c) => c.symbol_name === sym.name && c.start_line === sym.line) ??
          chunks.find((c) => c.symbol_name === sym.name);

        const signature = chunk?.content ?? '';
        const doc = chunk != null ? extractDoc(chunk.content) : null;
        const typeNames = extractTypeNames(signature);
        const typeContext = await resolveTypeContext(ctx.db, typeNames, sym.file_path);

        results.push({
          symbol: sym.name,
          file_path: sym.file_path,
          line: sym.line,
          signature,
          doc,
          params: [],
          return_type: null,
          type_context: typeContext,
        });
      }

      const filesReferenced = [...new Set(results.map((r) => r.file_path))];
      const text = JSON.stringify(results);
      const tokens = countTokens(text);
      const durationMs = Date.now() - start;

      const response: SignatureResponse = {
        results,
        _stats: buildToolStats('mast_signature', tokens, 0, filesReferenced, durationMs),
      };
      void recordToolCall(ctx.db, {
        toolName: 'mast_signature', tokensReturned: tokens, tokensFullFileBound: 0,
        durationMs, sessionId: ctx.sessionId, status: 'ok',
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
