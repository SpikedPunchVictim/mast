import { z } from 'zod';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { SignatureResult, SignatureResponse } from '../../ast/types.js';
import { buildToolStats, recordToolCall, buildArgsJson, buildResultsJson } from '../../telemetry/metrics.js';
import { countTokens, estimateFullFileBound } from '../../telemetry/tokenizer.js';
import { querySymbolByName, resolveTypeContext } from '../../graph/queries.js';
import { extractFileSignatures, type ExtractedSignature } from '../../ast/extract.js';
import { jitRefreshFile } from './_helpers.js';

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

      // §9.0 TOCTOU policy. When `file_path` narrows the query, every result
      // necessarily comes from that one file, so a single busy check up front
      // covers all of them (`topLevelBusy` below). When omitted, results can
      // span many files and each gets its own JIT call inside the loop.
      let topLevelBusy = false;
      if (filePath != null) {
        const r = await jitRefreshFile(ctx.db, ctx.config, filePath);
        topLevelBusy = r.busy;
      }

      const symbols = await querySymbolByName(ctx.db, args.symbol, filePath ?? undefined);

      // Parse each referenced file at most once for its signatures.
      const sigsByFile = new Map<string, readonly ExtractedSignature[]>();
      const sigsFor = (relPath: string): readonly ExtractedSignature[] => {
        let s = sigsByFile.get(relPath);
        if (s === undefined) {
          s = extractFileSignatures(join(ctx.config.resolved_project_root, relPath));
          sigsByFile.set(relPath, s);
        }
        return s;
      };

      const results: SignatureResult[] = [];
      for (const sym of symbols) {
        // Per-result busy flag: when file_path is omitted, each symbol's own
        // file is JIT-refreshed independently, so its busy status must not
        // leak onto results from other (unaffected) files.
        let resultBusy = topLevelBusy;
        if (filePath == null) {
          const r = await jitRefreshFile(ctx.db, ctx.config, sym.file_path);
          resultBusy = r.busy;
        }

        const sigs = sigsFor(sym.file_path);
        // Prefer an exact name+line match; fall back to name only.
        const sig =
          sigs.find((s) => s.name === sym.name && s.line === sym.line) ??
          sigs.find((s) => s.name === sym.name);

        const params = sig?.params ?? [];
        const returnType = sig?.returnType ?? null;
        // type_context is resolved from the parameter/return TYPES only — not
        // the body — so it no longer pulls in unrelated identifiers (§9).
        const typeNames = extractTypeNames(
          [...params.map((p) => p.type), returnType ?? ''].join(' '),
        );
        const typeContext = await resolveTypeContext(ctx.db, typeNames, sym.file_path);

        results.push({
          symbol: sym.name,
          file_path: sym.file_path,
          line: sym.line,
          signature: sig?.signature ?? '',
          doc: sig?.doc ?? null,
          params,
          return_type: returnType,
          type_context: typeContext,
          // §9.0 TOCTOU policy: omitted when false, never present-and-false.
          ...(resultBusy ? { file_busy_returning_stale_cache: true as const } : {}),
        });
      }

      const filesReferenced = [...new Set(results.map((r) => r.file_path))];
      const text = JSON.stringify(results);
      const tokens = countTokens(text);
      const tokensFullFileBound = estimateFullFileBound(filesReferenced, ctx.config.resolved_project_root);
      const durationMs = Date.now() - start;

      const response: SignatureResponse = {
        results,
        // F14: with zero results the per-result busy carrier vanishes, and a
        // stale index would read as "symbol doesn't exist" — surface the
        // top-level busy signal on the envelope in exactly that case.
        ...(topLevelBusy && results.length === 0
          ? { file_busy_returning_stale_cache: true as const }
          : {}),
        _stats: buildToolStats('mast_signature', tokens, tokensFullFileBound, filesReferenced, durationMs),
      };
      // Identity pairs — the "did this signature call target a symbol/file
      // an earlier search surfaced?" evidence for the capsule instrumentation
      // decision (IMPLEMENTATION_PLAN_VEXP.md §P, 2026-07-15).
      const resultIdentities = results.map((r) => ({ file_path: r.file_path, symbol_name: r.symbol }));
      void recordToolCall(ctx.db, {
        toolName: 'mast_signature', tokensReturned: tokens, tokensFullFileBound,
        durationMs, sessionId: ctx.sessionId, status: 'ok',
        argsJson: buildArgsJson(args),
        resultsJson: buildResultsJson(resultIdentities),
      }).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
