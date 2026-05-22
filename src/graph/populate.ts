import type { Db } from './db.js';
import type { Chunk, Language, SymbolRecord, ImportRecord, EdgeRecord } from '../ast/types.js';
import { extractIdentifiers } from '../ast/extractors/typescript.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// SymbolRecord, ImportRecord, and EdgeRecord are defined in ast/types.ts so that
// ast/extract.ts can return them without creating a circular import chain.
export type { SymbolRecord, ImportRecord, EdgeRecord };

export interface FileIndexData {
  readonly filePath: string;
  readonly language: Language;
  readonly mtime: number;
  readonly chunks: readonly Chunk[];
  readonly imports: readonly ImportRecord[];
  readonly symbols: readonly SymbolRecord[];
  /** Populated on the second pass after all symbols are inserted. */
  readonly edges: readonly EdgeRecord[];
}

/**
 * Delete all rows for `filePath` from files, symbols, edges, imports,
 * re_export_files (cascaded via FK), and FTS5 tables, then re-insert
 * everything from `data` — all within a single SQLite transaction.
 *
 * The two-pass structure (insert all symbols first, then insert all edges
 * via `insertEdges`) is required for cross-file POTENTIAL_CALL resolution.
 */
export async function populateFile(
  db: Db,
  data: Omit<FileIndexData, 'edges'>,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    // Delete-and-replace: FK cascades remove symbols, edges, imports.
    await trx.deleteFrom('files').where('path', '=', data.filePath).execute();

    const [file] = await trx
      .insertInto('files')
      .values({
        path: data.filePath,
        language: data.language,
        mtime: data.mtime,
      })
      .returning('id')
      .execute();

    if (file === undefined) throw new Error(`Insert into files returned no id for ${data.filePath}`);

    const fileId = file.id;

    // Insert symbols.
    if (data.symbols.length > 0) {
      await trx
        .insertInto('symbols')
        .values(
          data.symbols.map((s) => ({
            name: s.name,
            kind: s.kind,
            file_id: fileId,
            line: s.line,
            is_exported: s.isExported ? 1 : 0,
            declaration_hash: s.declarationHash,
            body_hash: s.bodyHash,
          })),
        )
        .execute();
    }

    // Insert imports.
    if (data.imports.length > 0) {
      await trx
        .insertInto('imports')
        .values(
          data.imports.map((imp) => ({
            file_id: fileId,
            module: imp.module,
            symbols: JSON.stringify(imp.symbols),
            is_external: imp.isExternal ? 1 : 0,
            resolved_path: imp.resolvedPath,
          })),
        )
        .execute();
    }

    // FTS5 updates — same transaction as graph writes (§7.1 step 5).
    // Delete existing rows by file_path (UNINDEXED column, supported by FTS5).
    await trx.deleteFrom('chunk_fts').where('file_path', '=', data.filePath).execute();
    await trx.deleteFrom('identifier_fts').where('file_path', '=', data.filePath).execute();

    // Batch-insert all chunks in one statement instead of one INSERT per chunk.
    if (data.chunks.length > 0) {
      await trx
        .insertInto('chunk_fts')
        .values(data.chunks.map((chunk) => ({
          content: chunk.content,
          symbol_name: chunk.symbol_name,
          chunk_id: chunk.chunk_id,
          file_path: data.filePath,
        })))
        .execute();

      const identifierRows = data.chunks.flatMap((chunk) => {
        const identifiers = extractIdentifiers(chunk.content);
        return identifiers.length > 0
          ? [{ identifiers, chunk_id: chunk.chunk_id, file_path: data.filePath }]
          : [];
      });
      if (identifierRows.length > 0) {
        await trx.insertInto('identifier_fts').values(identifierRows).execute();
      }
    }

    return fileId;
  });
}

/**
 * Second-pass edge insertion. Run after ALL files' symbols have been inserted
 * so cross-file references resolve correctly.
 *
 * Each `EdgeRecord` uses symbol names, which are resolved to IDs here.
 * Unresolved names are silently skipped (external or not-yet-indexed).
 */
export async function insertEdges(db: Db, filePath: string, edges: readonly EdgeRecord[]): Promise<void> {
  if (edges.length === 0) return;

  const fromNames = [...new Set(edges.map((e) => e.fromName))];
  const toNames   = [...new Set(edges.map((e) => e.toName))];

  // Batch-resolve "from" IDs — must belong to filePath.
  const fromRows = await db
    .selectFrom('symbols as s')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .select(['s.id', 's.name'])
    .where('s.name', 'in', fromNames)
    .where('f.path', '=', filePath)
    .execute();

  // Batch-resolve "to" IDs — any file; first match per name preserves prior behaviour.
  const toRows = await db
    .selectFrom('symbols')
    .select(['id', 'name'])
    .where('name', 'in', toNames)
    .execute();

  const fromMap = new Map(fromRows.map((r) => [r.name, r.id]));
  const toMap   = new Map<string, number>();
  for (const row of toRows) {
    if (!toMap.has(row.name)) toMap.set(row.name, row.id);
  }

  const edgeValues = edges.flatMap((edge) => {
    const from_id = fromMap.get(edge.fromName);
    const to_id   = toMap.get(edge.toName);
    if (from_id === undefined || to_id === undefined) return [];
    return [{ from_id, to_id, edge_type: edge.edgeType }];
  });

  if (edgeValues.length === 0) return;

  // Composite PK on (from_id, to_id, edge_type) — ignore duplicates.
  await db
    .insertInto('edges')
    .values(edgeValues)
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/**
 * Remove all data for files that were present in the previous manifest but
 * are absent from the current filesystem scan (deleted files).
 *
 * FTS5 virtual tables (chunk_fts, identifier_fts) do not participate in
 * SQLite FK cascades, so they must be cleaned up explicitly before the
 * files row is deleted.
 */
export async function removeDeletedFiles(db: Db, deletedPaths: readonly string[]): Promise<void> {
  if (deletedPaths.length === 0) return;
  for (const filePath of deletedPaths) {
    await db.deleteFrom('chunk_fts').where('file_path', '=', filePath).execute();
    await db.deleteFrom('identifier_fts').where('file_path', '=', filePath).execute();
  }
  await db.deleteFrom('files').where('path', 'in', deletedPaths).execute();
}
