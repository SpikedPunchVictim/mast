// Shared read-only DB/lance helpers + shipped potential-match semantics for
// the checker-edges spike. Mirrors src/mcp/tools/_helpers.ts:collectPotentialMatches
// and src/graph/queries.ts:queryVerifiedCallers exactly (imported from dist/,
// not reimplemented) so Q1/Q3 numbers describe the actually-shipped contract.

import Sqlite from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { join } from 'node:path';
import { queryVerifiedCallers } from '../../../dist/graph/queries.js';
import { searchIdentifiers } from '../../../dist/search/fts.js';
import { LanceStore } from '../../../dist/store/lance.js';

/**
 * Open graph.db READ-ONLY. Deliberately bypasses the shipped `openDatabase`
 * (src/graph/db.ts), which opens read-write and runs schema-migration DDL —
 * unnecessary and undesired here since this frozen corpus's schema is already
 * current, and the task requires read-only access to a foreign session's state.
 */
export function openReadOnlyDb(stateDir) {
  const sqlite = new Sqlite(join(stateDir, 'graph.db'), { readonly: true });
  return new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
}

export async function openLanceReadOnly(stateDir) {
  return LanceStore.open(stateDir);
}

/**
 * Shipped potential-match semantics (src/mcp/tools/_helpers.ts:collectPotentialMatches),
 * reimplemented read-only against a plain Kysely `Db` (the shipped helper takes
 * an `AppContext`-shaped `ctx.db`/`ctx.lance`, which this spike does not construct).
 *
 * For a given symbol name: exact-identifier_fts hits (limit 50, the shipped
 * default) minus chunks whose (file_path, start_line) is already covered by a
 * verified caller of THIS symbol id.
 *
 * @returns {Promise<{file_path: string, line: number, symbol_name: string|null, chunk_id: string}[]>}
 */
export async function computePotentialMatches(db, lance, symbolName, verifiedRows, limit = 50) {
  const identRows = await searchIdentifiers(db, symbolName, limit);
  const chunks = await lance.getChunksByIds(identRows.map((r) => r.chunk_id));
  const verifiedKeys = new Set(verifiedRows.map((c) => `${c.file_path}:${c.line}`));
  const matches = [];
  for (const chunk of chunks) {
    if (verifiedKeys.has(`${chunk.file_path}:${chunk.start_line}`)) continue;
    matches.push({
      file_path: chunk.file_path,
      line: chunk.start_line,
      end_line: chunk.end_line,
      // The CALL-SITE chunk's own enclosing symbol (e.g. the component/function
      // the call appears inside) — NOT the queried symbol. Named distinctly so
      // callers never confuse it with the symbol being queried for.
      chunk_symbol_name: chunk.symbol_name ?? null,
      chunk_id: chunk.chunk_id,
    });
  }
  return matches;
}

export { queryVerifiedCallers };
