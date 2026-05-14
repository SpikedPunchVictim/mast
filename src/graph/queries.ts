import { sql } from 'kysely';
import type { Db } from './db.js';
import { EdgeType } from './db.js';
import type {
  DependencyEntry,
  ImplementorResult,
  TypeContextEntry,
} from '../ast/types.js';

// ---------------------------------------------------------------------------
// Callers (verified set — POTENTIAL_CALL edges via recursive CTE)
// ---------------------------------------------------------------------------

export interface VerifiedCallerRow {
  file_path: string;
  line: number;
  caller_symbol: string;
  context: string;
  resolution: string;
}

/**
 * Returns direct or transitive verified callers of `symbolId` using a
 * recursive CTE over `POTENTIAL_CALL` edges. Only the verified set; the
 * `potential_matches` (identifier_fts) set is computed in `search/fts.ts`.
 */
export async function queryVerifiedCallers(
  db: Db,
  symbolId: number,
  transitive: boolean,
): Promise<VerifiedCallerRow[]> {
  const emptyContext = sql<string>`''`;
  const resolutionImport = sql<string>`'import'`;

  // Direct callers: no CTE needed — simple edge join.
  if (!transitive) {
    return db
      .selectFrom('edges as e')
      .innerJoin('symbols as s', 's.id', 'e.from_id')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select([
        'f.path as file_path',
        's.line',
        's.name as caller_symbol',
        emptyContext.as('context'),
        resolutionImport.as('resolution'),
      ])
      .where('e.to_id', '=', symbolId)
      .where('e.edge_type', '=', EdgeType.POTENTIAL_CALL)
      .execute();
  }

  // Transitive callers: recursive CTE walking POTENTIAL_CALL edges.
  return db
    .withRecursive('callers', (qb) =>
      // Anchor: direct callers of `symbolId`.
      qb
        .selectFrom('edges')
        .select('from_id as id')
        .where('to_id', '=', symbolId)
        .where('edge_type', '=', EdgeType.POTENTIAL_CALL)
        .union(
          // Recursive step: callers of callers.
          qb
            .selectFrom('edges as e')
            .innerJoin('callers', 'callers.id', 'e.to_id')
            .select('e.from_id as id')
            .where('e.edge_type', '=', EdgeType.POTENTIAL_CALL),
        ),
    )
    .selectFrom('symbols as s')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .innerJoin('callers', 's.id', 'callers.id')
    .select([
      'f.path as file_path',
      's.line',
      's.name as caller_symbol',
      emptyContext.as('context'),
      resolutionImport.as('resolution'),
    ])
    .execute();
}

// ---------------------------------------------------------------------------
// Symbol lookup
// ---------------------------------------------------------------------------

export interface SymbolRow {
  id: number;
  name: string;
  kind: string;
  file_id: number;
  line: number;
  is_exported: number;
  declaration_hash: string | null;
  body_hash: string | null;
  file_path: string;
}

/** Find all symbols with the given name, optionally restricted to one file. */
export async function querySymbolByName(
  db: Db,
  name: string,
  filePath?: string,
): Promise<SymbolRow[]> {
  let q = db
    .selectFrom('symbols as s')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .select([
      's.id',
      's.name',
      's.kind',
      's.file_id',
      's.line',
      's.is_exported',
      's.declaration_hash',
      's.body_hash',
      'f.path as file_path',
    ])
    .where('s.name', '=', name);

  if (filePath !== undefined) {
    q = q.where('f.path', '=', filePath);
  }

  return q.orderBy('s.is_exported', 'desc').orderBy('f.path', 'asc').execute();
}

// ---------------------------------------------------------------------------
// Dependencies (imports table)
// ---------------------------------------------------------------------------

/** Return all imports recorded for `filePath`. */
export async function queryDependencies(
  db: Db,
  filePath: string,
): Promise<DependencyEntry[]> {
  const rows = await db
    .selectFrom('imports as i')
    .innerJoin('files as f', 'f.id', 'i.file_id')
    .select([
      'i.module',
      'i.symbols',
      'i.is_external',
      'i.resolved_path',
    ])
    .where('f.path', '=', filePath)
    .execute();

  return rows.map((r) => ({
    module: r.module,
    symbols: JSON.parse(r.symbols) as string[],
    is_external: r.is_external === 1,
    resolved_path: r.resolved_path ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// Implementors (IMPLEMENTS edges)
// ---------------------------------------------------------------------------

/** Find concrete classes that implement `interfaceName`. */
export async function queryImplementors(
  db: Db,
  interfaceName: string,
): Promise<ImplementorResult[]> {
  // Find the interface symbol(s) first.
  const ifaces = await db
    .selectFrom('symbols')
    .select(['id'])
    .where('name', '=', interfaceName)
    .where('kind', '=', 'interface')
    .execute();

  if (ifaces.length === 0) return [];

  const ifaceIds = ifaces.map((r) => r.id);

  const rows = await db
    .selectFrom('edges as e')
    .innerJoin('symbols as s', 's.id', 'e.from_id')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .select(['s.name as class_name', 'f.path as file_path', 's.line'])
    .where('e.to_id', 'in', ifaceIds)
    .where('e.edge_type', '=', EdgeType.IMPLEMENTS)
    .execute();

  // For each implementing class, collect its methods via PARENT_OF edges.
  const results: ImplementorResult[] = [];
  for (const row of rows) {
    const classSymbol = await db
      .selectFrom('symbols')
      .select(['id'])
      .where('name', '=', row.class_name)
      .where('kind', '=', 'class')
      .executeTakeFirst();

    const methods: string[] = [];
    if (classSymbol !== undefined) {
      const methodRows = await db
        .selectFrom('edges as e')
        .innerJoin('symbols as s', 's.id', 'e.to_id')
        .select(['s.name'])
        .where('e.from_id', '=', classSymbol.id)
        .where('e.edge_type', '=', EdgeType.PARENT_OF)
        .execute();
      methods.push(...methodRows.map((m) => m.name));
    }

    results.push({
      class_name: row.class_name,
      file_path: row.file_path,
      line: row.line,
      methods,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Type context resolution (used by mast_signature)
// ---------------------------------------------------------------------------

/**
 * Resolve type context entries for a list of type names.
 *
 * Priority order (one level deep only):
 *   1. Same file — symbol defined in `containingFilePath`
 *   2. Named imports — symbol explicitly imported in the file's import list
 *   3. Global fallback — any exported interface/type/class in the index
 *
 * External types (no resolved_path in the imports table) are omitted.
 * The signature is taken from `chunk_fts.content`; long content is truncated
 * to `SIGNATURE_LIMIT` characters to keep responses compact.
 */
export async function resolveTypeContext(
  db: Db,
  typeNames: readonly string[],
  containingFilePath: string,
): Promise<TypeContextEntry[]> {
  if (typeNames.length === 0) return [];

  const SIGNATURE_LIMIT = 500;
  const results: TypeContextEntry[] = [];

  for (const typeName of typeNames) {
    const entry = await resolveOneType(db, typeName, containingFilePath, SIGNATURE_LIMIT);
    if (entry !== null) results.push(entry);
  }

  return results;
}

async function resolveOneType(
  db: Db,
  typeName: string,
  containingFilePath: string,
  signatureLimit: number,
): Promise<TypeContextEntry | null> {
  // 1. Same-file lookup.
  const sameFile = await db
    .selectFrom('symbols as s')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .select(['s.name', 'f.path as file_path', 's.line'])
    .where('s.name', '=', typeName)
    .where('f.path', '=', containingFilePath)
    .executeTakeFirst();

  if (sameFile !== undefined) {
    return buildEntry(db, typeName, sameFile.file_path, sameFile.line, signatureLimit);
  }

  // 2. Named imports — walk each internal import for the file and check if the
  //    type is in the imported symbols list.
  const imports = await db
    .selectFrom('imports as i')
    .innerJoin('files as f', 'f.id', 'i.file_id')
    .select(['i.symbols', 'i.resolved_path'])
    .where('f.path', '=', containingFilePath)
    .where('i.is_external', '=', 0)
    .execute();

  for (const imp of imports) {
    if (imp.resolved_path === null) continue;
    const importedSymbols = JSON.parse(imp.symbols) as string[];
    if (!importedSymbols.includes(typeName)) continue;

    // The resolved_path may lack an extension — use LIKE prefix to match
    // `resolved/path.ts`, `resolved/path/index.ts`, etc.
    const importedRow = await db
      .selectFrom('symbols as s')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select(['s.name', 'f.path as file_path', 's.line'])
      .where('s.name', '=', typeName)
      .where('f.path', 'like', `${imp.resolved_path}%`)
      .executeTakeFirst();

    if (importedRow !== undefined) {
      return buildEntry(db, typeName, importedRow.file_path, importedRow.line, signatureLimit);
    }
  }

  // 3. Global fallback — any exported interface, type alias, or class.
  const globalRow = await db
    .selectFrom('symbols as s')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .select(['s.name', 'f.path as file_path', 's.line'])
    .where('s.name', '=', typeName)
    .where('s.kind', 'in', ['interface', 'type', 'class'])
    .where('s.is_exported', '=', 1)
    .orderBy('f.path', 'asc')
    .executeTakeFirst();

  if (globalRow !== undefined) {
    return buildEntry(db, typeName, globalRow.file_path, globalRow.line, signatureLimit);
  }

  return null;
}

/**
 * Fetch chunk content from `chunk_fts` and build a `TypeContextEntry`.
 *
 * FTS5 UNINDEXED columns support equality predicates in queries that do not
 * use MATCH — this is a plain predicate scan, not a full-text search.
 */
async function buildEntry(
  db: Db,
  name: string,
  filePath: string,
  line: number,
  signatureLimit: number,
): Promise<TypeContextEntry> {
  const rows = await db
    .selectFrom('chunk_fts')
    .select('content')
    .where('symbol_name', '=', name)
    .where('file_path', '=', filePath)
    .limit(1)
    .execute();

  const raw = rows[0]?.content ?? name;
  const truncated = raw.length > signatureLimit;
  return {
    name,
    signature: truncated ? raw.slice(0, signatureLimit) + '…' : raw,
    file_path: filePath,
    line,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Project skeleton (exported symbols, by directory)
// ---------------------------------------------------------------------------

export interface SkeletonRow {
  file_path: string;
  symbol_name: string;
}

/** Return all exported top-level symbols, optionally within a directory prefix. */
export async function queryProjectSkeleton(
  db: Db,
  directoryPrefix?: string,
): Promise<SkeletonRow[]> {
  let q = db
    .selectFrom('symbols as s')
    .innerJoin('files as f', 'f.id', 's.file_id')
    .select(['f.path as file_path', 's.name as symbol_name'])
    .where('s.is_exported', '=', 1)
    .where('s.kind', '!=', 'method'); // methods surface via class_shell

  if (directoryPrefix !== undefined) {
    q = q.where('f.path', 'like', `${directoryPrefix}%`);
  }

  return q.orderBy('f.path', 'asc').orderBy('s.line', 'asc').execute();
}
