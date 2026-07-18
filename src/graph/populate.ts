import type { Db } from './db.js';
import type { Chunk, Language, SymbolRecord, ImportRecord, EdgeRecord, CallerResolution } from '../ast/types.js';
import type { IdentifierRow, StarReExportRecord } from '../ast/extractor.js';

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
  /**
   * Pre-extracted identifier tokens per chunk, produced by the language
   * extractor — what counts as an "identifier" is a language-level judgment
   * (markdown contributes none). This layer only persists them.
   */
  readonly identifierRows: readonly IdentifierRow[];
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
    }

    if (data.identifierRows.length > 0) {
      await trx
        .insertInto('identifier_fts')
        .values(data.identifierRows.map((row) => ({
          identifiers: row.identifiers,
          chunk_id: row.chunk_id,
          file_path: data.filePath,
        })))
        .execute();
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

  // Batch-resolve "from" IDs — must belong to filePath.
  const fromRows = await db
    .selectFrom('symbols as s')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .select(['s.id', 's.name'])
    .where('s.name', 'in', fromNames)
    .where('f.path', '=', filePath)
    .execute();
  const fromMap = new Map(fromRows.map((r) => [r.name, r.id]));

  // Structural edges (IMPLEMENTS/EXTENDS/PARENT_OF) carry no file evidence at
  // all — batch-resolve them exactly as before. POTENTIAL_CALL edges are
  // resolved separately below, file-scoped per §10.3.1's resolution rules.
  // RE_EXPORTS edges DO carry file evidence (`toResolvedPath`, Task 0) and are
  // also resolved separately below — they must NOT fall into this bare-name
  // batch, which is exactly the sibling false-green this fix closes.
  const structuralEdges = edges.filter((e) => e.edgeType !== 'POTENTIAL_CALL' && e.edgeType !== 'RE_EXPORTS');
  const structuralToNames = [...new Set(structuralEdges.map((e) => e.toName))];
  const structuralToRows = structuralToNames.length > 0
    ? await db
      .selectFrom('symbols')
      .select(['id', 'name'])
      .where('name', 'in', structuralToNames)
      .where('kind', '!=', 'export')
      .execute()
    : [];
  const structuralToMap = new Map<string, number>();
  for (const row of structuralToRows) {
    if (!structuralToMap.has(row.name)) structuralToMap.set(row.name, row.id);
  }

  // POTENTIAL_CALL edges: resolve each unique (toName) once, file-scoped by
  // the resolution rule's own evidence (§10.3.1). A bare name has a single
  // deterministic resolution per file (LocalTypeEnvironment's "first
  // recorded wins" seeding — import beats same-file, and receiver bindings
  // are keyed by receiver, not by callee name), so it is safe to resolve
  // once per toName rather than once per edge.
  const callEdgesByToName = new Map<string, EdgeRecord>();
  for (const e of edges) {
    if (e.edgeType === 'POTENTIAL_CALL' && !callEdgesByToName.has(e.toName)) {
      callEdgesByToName.set(e.toName, e);
    }
  }

  const callToMap = new Map<string, number>();
  if (callEdgesByToName.size > 0) {
    const fromFile = await db.selectFrom('files').select('id').where('path', '=', filePath).executeTakeFirst();
    // No `files` row for the calling file is an invariant violation (pass 1
    // always inserts it before pass 2 runs edges) — fromMap would be empty
    // too in that case, so every edge is dropped downstream regardless.
    if (fromFile !== undefined) {
      for (const [toName, edge] of callEdgesByToName) {
        const targetId = await resolveCallTarget(db, fromFile.id, edge.resolution, toName);
        if (targetId !== null) callToMap.set(toName, targetId);
      }
    }
  }

  // RE_EXPORTS edges: resolve each unique (toName, toResolvedPath) pair once,
  // file-scoped by the re-export's own module specifier (Task 0 fix — the
  // named-re-export sibling of the POTENTIAL_CALL false-green above). Keyed by
  // toResolvedPath as well as toName because one barrel file can re-export
  // same-named symbols from two different modules
  // (`export { x } from './a'; export { x as xB } from './b';`).
  const reExportKey = (e: EdgeRecord): string => `${e.toName}::${e.toResolvedPath ?? ''}`;
  const reExportEdgesByKey = new Map<string, EdgeRecord>();
  for (const e of edges) {
    if (e.edgeType === 'RE_EXPORTS' && !reExportEdgesByKey.has(reExportKey(e))) {
      reExportEdgesByKey.set(reExportKey(e), e);
    }
  }
  const reExportToMap = new Map<string, number>();
  for (const [key, edge] of reExportEdgesByKey) {
    // No resolved path (external module, or a relative specifier that didn't
    // probe to a real file) — the honest result is no edge, not a name-only
    // guess across the whole graph.
    if (edge.toResolvedPath == null) continue;
    const targetId = await resolveInFileOrReExportChain(db, edge.toResolvedPath, edge.toName);
    if (targetId !== null) reExportToMap.set(key, targetId);
  }

  const edgeValues = edges.flatMap((edge) => {
    const from_id = fromMap.get(edge.fromName);
    if (from_id === undefined) return [];
    const to_id = edge.edgeType === 'POTENTIAL_CALL'
      ? callToMap.get(edge.toName)
      : edge.edgeType === 'RE_EXPORTS'
        ? reExportToMap.get(reExportKey(edge))
        : structuralToMap.get(edge.toName);
    if (to_id === undefined) return [];
    return [{
      from_id,
      to_id,
      edge_type: edge.edgeType,
      resolution: edge.resolution ?? null,
      call_line: edge.callLine ?? null,
      context: edge.context ?? null,
    }];
  });

  if (edgeValues.length === 0) return;

  // Composite PK on (from_id, to_id, edge_type) — ignore duplicates.
  await db
    .insertInto('edges')
    .values(edgeValues)
    .onConflict((oc) => oc.doNothing())
    .execute();
}

// ---------------------------------------------------------------------------
// POTENTIAL_CALL target resolution — file-scoped by resolution-rule evidence
// ---------------------------------------------------------------------------

/**
 * Resolve a POTENTIAL_CALL edge's target symbol id using the file evidence
 * the resolution rule (§10.3.1) actually carries, instead of matching the
 * bare/qualified name against the *entire* graph.
 *
 * Without this, two files exporting a same-named symbol race on insertion
 * order: `WHERE name = ? LIMIT 1` with no file filter deterministically
 * returns whichever row SQLite happens to have inserted first, regardless of
 * which file the call site's own import (or same-file declaration) actually
 * names. That produced a wrong "verified" edge — see
 * IMPLEMENTATION_PLAN_VEXP.md §P "Shipped-resolver finding" (2026-07-15) and
 * eval/spikes/checker-edges/REPORT.md Q4b. `verified_callers` is documented
 * as "safe to act on" (MAST_SPEC §9) precisely because ambiguity like this is
 * not supposed to reach it — better no edge than a wrong one.
 */
async function resolveCallTarget(
  db: Db,
  fromFileId: number,
  resolution: CallerResolution | undefined,
  toName: string,
): Promise<number | null> {
  switch (resolution) {
    case 'same_file': {
      // The call target must be declared in this exact file — the file
      // itself is the evidence, no lookup needed to establish it.
      const row = await db
        .selectFrom('symbols')
        .select('id')
        .where('name', '=', toName)
        .where('file_id', '=', fromFileId)
        .where('kind', '!=', 'export')
        .executeTakeFirst();
      return row?.id ?? null;
    }

    case 'import': {
      const lookup = await importResolvedPathFor(db, fromFileId, toName);
      // An `import`-resolution edge is only emitted for a name the extractor
      // saw in this file's own import_clause (local-type-env.ts
      // recordImport), so an import row always exists; `lookup === null`
      // is defensive, not an expected path.
      const resolvedPath = lookup?.resolvedPath ?? null;
      // Unresolved (external, or a relative specifier that didn't probe to
      // a real file) — the honest result is no edge, not a name-only guess.
      if (resolvedPath === null) return null;
      return resolveInFileOrReExportChain(db, resolvedPath, toName);
    }

    case 'field_type':
    case 'parameter_type':
    case 'new_expression': {
      // toName is `TypeName.methodName` — the receiver's type must be
      // file-scoped first, then the qualified method name resolved within
      // that file (or its re-export chain).
      const dot = toName.indexOf('.');
      const typeName = dot === -1 ? toName : toName.slice(0, dot);

      const lookup = await importResolvedPathFor(db, fromFileId, typeName);
      if (lookup !== null) {
        if (lookup.resolvedPath === null) return null; // imported but unresolved — no edge
        return resolveInFileOrReExportChain(db, lookup.resolvedPath, toName);
      }

      const sameFileType = await db
        .selectFrom('symbols')
        .select('id')
        .where('name', '=', typeName)
        .where('file_id', '=', fromFileId)
        .where('kind', '!=', 'export')
        .executeTakeFirst();
      if (sameFileType !== undefined) {
        const row = await db
          .selectFrom('symbols')
          .select('id')
          .where('name', '=', toName)
          .where('file_id', '=', fromFileId)
          .where('kind', '!=', 'export')
          .executeTakeFirst();
        return row?.id ?? null;
      }

      // Neither an import nor a same-file declaration names `typeName` —
      // e.g. a default/namespace import (not tracked as a named import, see
      // `extractEdges`' `importedNames` collection) or an ambient/global
      // type. No file evidence exists to scope this edge; preserve the
      // pre-fix global-first-match behaviour rather than silently dropping
      // a potentially-correct edge (MAST_SPEC §10.3.1 documents this as a
      // known coverage gap, not a correctness guarantee).
      return legacyGlobalFirstMatch(db, toName);
    }

    default:
      // A POTENTIAL_CALL edge always carries a resolution (`emitCallEdges`
      // sets it from `LocalTypeEnvironment.resolveCall`'s result); this
      // branch only guards an unexpected shape defensively.
      return legacyGlobalFirstMatch(db, toName);
  }
}

/**
 * Look up whether `name` is one of `fromFileId`'s own named imports.
 *
 * Returns `null` when `name` is not imported by this file at all (no
 * evidence). Returns `{ resolvedPath }` when it is — `resolvedPath` is
 * itself `null` for an external or otherwise-unresolvable module, which the
 * caller must treat as "no edge", not "no evidence" (the import statement
 * proves the receiver came from *some* module; that module just isn't ours).
 */
async function importResolvedPathFor(
  db: Db,
  fromFileId: number,
  name: string,
): Promise<{ resolvedPath: string | null } | null> {
  const rows = await db
    .selectFrom('imports')
    .select(['symbols', 'resolved_path'])
    .where('file_id', '=', fromFileId)
    .execute();

  for (const row of rows) {
    let importedSymbols: string[];
    try {
      importedSymbols = JSON.parse(row.symbols) as string[];
    } catch {
      continue; // malformed row — treat as not naming `name`
    }
    if (importedSymbols.includes(name)) return { resolvedPath: row.resolved_path };
  }
  return null;
}

/**
 * Resolve `toName` within `resolvedPath`, following the barrel re-export
 * machinery (§6.3) when the resolved file doesn't declare it directly:
 * a named re-export leaves an `export`-kind marker symbol with a RE_EXPORTS
 * edge to the real declaration; a star re-export (`export * from`) leaves a
 * `re_export_files` row. Both are walked before giving up.
 */
async function resolveInFileOrReExportChain(
  db: Db,
  resolvedPath: string,
  toName: string,
): Promise<number | null> {
  // The import resolver (`src/indexer/import-resolver.ts`) always returns an
  // extension-inclusive path, but LIKE-prefix matching mirrors the existing
  // precedent (`resolveTypeContext`, `insertReExportFiles`) defensively.
  const targetFile = await db
    .selectFrom('files')
    .select('id')
    .where('path', 'like', `${resolvedPath}%`)
    .orderBy('path', 'asc')
    .executeTakeFirst();
  if (targetFile === undefined) return null;

  const direct = await db
    .selectFrom('symbols')
    .select('id')
    .where('name', '=', toName)
    .where('file_id', '=', targetFile.id)
    .where('kind', '!=', 'export')
    .executeTakeFirst();
  if (direct !== undefined) return direct.id;

  // Named re-export: a marker symbol (kind 'export') anchors a RE_EXPORTS
  // edge to the real declaration (§10.1).
  const marker = await db
    .selectFrom('symbols')
    .select('id')
    .where('name', '=', toName)
    .where('file_id', '=', targetFile.id)
    .where('kind', '=', 'export')
    .executeTakeFirst();
  if (marker !== undefined) {
    const declared = await followReExportEdgeChain(db, marker.id);
    if (declared !== null) return declared;
  }

  // Star re-export: no per-symbol marker exists, only a file-level
  // `re_export_files` row (§10.3). Walk the chain forward to the file that
  // actually declares `toName` — the recursive CTE from MAST_SPEC §6.3.
  return resolveThroughStarChain(db, targetFile.id, toName);
}

/** Bounded hop count for chained named re-exports (barrel re-exporting a barrel). */
const MAX_RE_EXPORT_HOPS = 5;

/** Follow RE_EXPORTS edges from a marker symbol to the real (non-marker) declaration. */
async function followReExportEdgeChain(db: Db, markerId: number): Promise<number | null> {
  let currentId = markerId;
  for (let hop = 0; hop < MAX_RE_EXPORT_HOPS; hop++) {
    const edge = await db
      .selectFrom('edges')
      .select('to_id')
      .where('from_id', '=', currentId)
      .where('edge_type', '=', 'RE_EXPORTS')
      .executeTakeFirst();
    if (edge === undefined) return null;

    const target = await db
      .selectFrom('symbols')
      .select(['id', 'kind'])
      .where('id', '=', edge.to_id)
      .executeTakeFirst();
    if (target === undefined) return null;
    if (target.kind !== 'export') return target.id;
    currentId = target.id;
  }
  return null;
}

/**
 * Walk `re_export_files` forward from `startFileId` (a barrel doing
 * `export * from '...'`) to find the file that actually declares `toName`.
 * Mirrors the `re_export_chain` recursive CTE documented in MAST_SPEC §6.3.
 */
async function resolveThroughStarChain(db: Db, startFileId: number, toName: string): Promise<number | null> {
  const row = await db
    .withRecursive('re_export_chain', (qb) =>
      qb
        .selectFrom('re_export_files')
        .select('to_file_id as file_id')
        .where('from_file_id', '=', startFileId)
        .union(
          qb
            .selectFrom('re_export_files as rf')
            .innerJoin('re_export_chain', 're_export_chain.file_id', 'rf.from_file_id')
            .select('rf.to_file_id as file_id'),
        ),
    )
    .selectFrom('symbols as s')
    .innerJoin('re_export_chain as rec', 'rec.file_id', 's.file_id')
    .select('s.id')
    .where('s.name', '=', toName)
    .where('s.kind', '!=', 'export')
    .orderBy('s.file_id', 'asc')
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Pre-fix behaviour: match `toName` against any indexed symbol, first match
 * wins (excluding re-export markers). Only reached when a resolution rule
 * has no file evidence available at all (see `resolveCallTarget`'s
 * `field_type`/`parameter_type`/`new_expression` default-import/ambient-type
 * fallback) — a known, documented coverage gap, not a silent regression.
 */
async function legacyGlobalFirstMatch(db: Db, toName: string): Promise<number | null> {
  const row = await db
    .selectFrom('symbols')
    .select('id')
    .where('name', '=', toName)
    .where('kind', '!=', 'export')
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Second-pass star re-export insertion (`export * from './x'` → one
 * `re_export_files` row per resolved target). Runs after all files' rows
 * exist, like `insertEdges`, because the target file may be indexed later in
 * the same run. Unresolved or unindexed targets are silently skipped.
 */
export async function insertReExportFiles(
  db: Db,
  filePath: string,
  stars: readonly StarReExportRecord[],
): Promise<void> {
  if (stars.length === 0) return;

  const fromFile = await db
    .selectFrom('files')
    .select('id')
    .where('path', '=', filePath)
    .executeTakeFirst();
  if (fromFile === undefined) return;

  for (const star of stars) {
    if (star.resolvedPath === null) continue;
    // resolved_path may lack an extension — LIKE prefix matches `x.ts`,
    // `x/index.ts`, etc. (same convention as resolveTypeContext, §13.7).
    const target = await db
      .selectFrom('files')
      .select('id')
      .where('path', 'like', `${star.resolvedPath}%`)
      .orderBy('path', 'asc')
      .executeTakeFirst();
    if (target === undefined || target.id === fromFile.id) continue;

    await db
      .insertInto('re_export_files')
      .values({ from_file_id: fromFile.id, to_file_id: target.id })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
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
