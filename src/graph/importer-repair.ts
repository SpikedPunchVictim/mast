import type { ImportRecord } from '../ast/types.js';
import type { Db } from './db.js';
import { pathPrefixUpperBound } from './path-range.js';
import { chunkRowsForSqlite, chunkValuesForSqlite } from './sqliteBatch.js';

// ---------------------------------------------------------------------------
// Which files must be resolved again after other files changed what they
// export (D084; adr/proposals/incremental-graph-correctness, M3b).
//
// A file's edges are resolved against what the files it imports from export at
// that moment. When one of those files later gains, loses or re-points a name,
// the importer is not re-written — its own content did not change — so its
// edges stay as they were. The functions here work out which names changed and
// which files import them.
//
// An `export { a as b }` is found through the `reexport_aliases` table (D112).
// ---------------------------------------------------------------------------

/** What other files can see of one file. */
export interface ExportSurface {
  /** `name|kind` of every declared symbol, members included (`Class.method`). */
  readonly declared: ReadonlySet<string>;
  /** Names the file re-exports by name (`export { x } from`). */
  readonly markers: ReadonlySet<string>;
  /** Paths the file re-exports with `export *`. */
  readonly starTargets: ReadonlySet<string>;
}

/** The surface stored for `filePath`, or null when the file has no row. */
export async function readExportSurface(db: Db, filePath: string): Promise<ExportSurface | null> {
  const file = await db.selectFrom('files').select('id').where('path', '=', filePath).executeTakeFirst();
  if (file === undefined) return null;

  const symbols = await db.selectFrom('symbols').select(['name', 'kind']).where('file_id', '=', file.id).execute();
  const stars = await db
    .selectFrom('re_export_files as r')
    .innerJoin('files as f', 'f.id', 'r.to_file_id')
    .select('f.path')
    .where('r.from_file_id', '=', file.id)
    .execute();

  return {
    declared: new Set(symbols.filter((s) => s.kind !== 'export').map((s) => `${s.name}|${s.kind}`)),
    markers: new Set(symbols.filter((s) => s.kind === 'export').map((s) => s.name)),
    starTargets: new Set(stars.map((s) => s.path)),
  };
}

function symmetricDifference(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...[...a].filter((v) => !b.has(v)), ...[...b].filter((v) => !a.has(v))];
}

const EMPTY_SURFACE: ExportSurface = { declared: new Set(), markers: new Set(), starTargets: new Set() };

/**
 * The names whose meaning to an importer may differ between two surfaces of
 * one file, and the star targets that were added or dropped. Null stands for
 * "the file does not exist".
 *
 * A declaration counts when it appears, disappears or changes kind. A named
 * re-export counts whenever the file was re-written at all: the marker row
 * records the name and not where it points, so a re-pointed one cannot be told
 * from an untouched one.
 */
export function changedExports(
  before: ExportSurface | null,
  after: ExportSurface | null,
): { readonly names: string[]; readonly starTargets: string[] } {
  const from = before ?? EMPTY_SURFACE;
  const to = after ?? EMPTY_SURFACE;
  const declared = symmetricDifference(from.declared, to.declared).map((entry) => entry.slice(0, entry.lastIndexOf('|')));
  return {
    names: [...new Set([...declared, ...from.markers, ...to.markers])],
    starTargets: symmetricDifference(from.starTargets, to.starTargets),
  };
}

async function loadStarRows(db: Db): Promise<{ from: string; to: string }[]> {
  return db
    .selectFrom('re_export_files as r')
    .innerJoin('files as from_f', 'from_f.id', 'r.from_file_id')
    .innerJoin('files as to_f', 'to_f.id', 'r.to_file_id')
    .select(['from_f.path as from', 'to_f.path as to'])
    .execute();
}

/** `start` and everything reachable from it along `next`. */
function closure(start: Iterable<string>, next: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set(start);
  const queue = [...seen];
  for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
    for (const neighbour of next.get(path) ?? []) {
      if (seen.has(neighbour)) continue;
      seen.add(neighbour);
      queue.push(neighbour);
    }
  }
  return seen;
}

function adjacency(rows: readonly { from: string; to: string }[], reversed: boolean): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const [key, value] = reversed ? [row.to, row.from] : [row.from, row.to];
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
  }
  return map;
}

/**
 * Every symbol name stored for `paths` and for the files they reach through
 * `export *`: the names a barrel gains or loses when one of `paths` is added
 * to or dropped from its star re-exports.
 */
export async function namesExportedThrough(db: Db, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const reached = closure(paths, adjacency(await loadStarRows(db), false));
  const names = new Set<string>();
  for (const batch of chunkValuesForSqlite([...reached])) {
    const rows = await db
      .selectFrom('symbols as s')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select('s.name')
      .distinct()
      .where('f.path', 'in', batch)
      .execute();
    for (const row of rows) names.add(row.name);
  }
  return [...names];
}

export interface ImporterQuery {
  /** Names that changed, as stored: `fn`, `Class`, `Class.method`. */
  readonly names: readonly string[];
  /** Paths of the files that changed, were deleted, or lost edges this run. */
  readonly sources: readonly string[];
}

/**
 * Paths of the files to resolve again: those that re-export one of `names` by
 * name, and those that import one from a source or from a barrel that reaches
 * a source.
 *
 * Call it once the star rows of every re-written file are back in place; the
 * barrels are found by walking them.
 */
export async function findImportersOfNames(db: Db, query: ImporterQuery): Promise<string[]> {
  if (query.names.length === 0) return [];
  // An import names the class, never the member: `Base.run` is reached by a
  // file that imports `Base`.
  const imported = new Set(query.names.map((name) => name.split('.', 1)[0] ?? name));

  // A name re-exported under another (`export { a as b }`) is imported as the
  // other, and that one may be re-exported under a third (D112).
  const found = new Set<string>();
  for (let fresh = [...imported]; fresh.length > 0; ) {
    const next: string[] = [];
    for (const batch of chunkValuesForSqlite(fresh)) {
      const rows = await db
        .selectFrom('reexport_aliases as a')
        .innerJoin('files as f', 'f.id', 'a.file_id')
        .select(['f.path', 'a.exported_name'])
        .where('a.source_name', 'in', batch)
        .execute();
      for (const row of rows) {
        found.add(row.path);
        if (imported.has(row.exported_name)) continue;
        imported.add(row.exported_name);
        next.push(row.exported_name);
      }
    }
    fresh = next;
  }
  for (const batch of chunkValuesForSqlite([...imported])) {
    const rows = await db
      .selectFrom('symbols as s')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select('f.path')
      .distinct()
      .where('s.kind', '=', 'export')
      .where('s.name', 'in', batch)
      .execute();
    for (const row of rows) found.add(row.path);
  }

  const reach = closure([...query.sources, ...found], adjacency(await loadStarRows(db), true));
  const namesAny = (symbolsJson: string): boolean => {
    try {
      return (JSON.parse(symbolsJson) as string[]).some((symbol) => imported.has(symbol));
    } catch {
      return false; // malformed row names nothing
    }
  };

  for (const batch of chunkValuesForSqlite([...reach])) {
    const rows = await db
      .selectFrom('imports as i')
      .innerJoin('files as f', 'f.id', 'i.file_id')
      .select(['f.path', 'i.symbols'])
      .where('i.resolved_path', 'in', batch)
      .execute();
    for (const row of rows) if (namesAny(row.symbols)) found.add(row.path);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Which classes extend which (adr/proposals/inherited-call-edges, M3a)
//
// A call of a member a class inherits is resolved by following stored
// `EXTENDS` edges upward. So where it lands depends on every class above the
// receiver's, and a file two classes away from the one that changed holds
// neither an edge into it nor an import of it.
// ---------------------------------------------------------------------------

/** A class or interface, named the way it is in two indexes of the same source. */
export interface ClassRef {
  readonly path: string;
  readonly name: string;
}

/** Each class with a stored `EXTENDS` edge, and what it extends. Keyed by `classKey`. */
export type Hierarchy = ReadonlyMap<string, { readonly child: ClassRef; readonly parents: readonly ClassRef[] }>;

export function classKey(ref: ClassRef): string {
  return `${ref.path}\n${ref.name}`;
}

/** Every stored `EXTENDS` edge. Read before a write to know what the write removes. */
export async function readHierarchy(db: Db): Promise<Hierarchy> {
  const rows = await db
    .selectFrom('edges as e')
    .innerJoin('symbols as child', 'child.id', 'e.from_id')
    .innerJoin('files as child_f', 'child_f.id', 'child.file_id')
    .innerJoin('symbols as parent', 'parent.id', 'e.to_id')
    .innerJoin('files as parent_f', 'parent_f.id', 'parent.file_id')
    .select(['child_f.path as childPath', 'child.name as childName', 'parent_f.path as parentPath', 'parent.name as parentName'])
    .where('e.edge_type', '=', 'EXTENDS')
    .execute();
  const hierarchy = new Map<string, { child: ClassRef; parents: ClassRef[] }>();
  for (const row of rows) {
    const child = { path: row.childPath, name: row.childName };
    const entry = hierarchy.get(classKey(child)) ?? { child, parents: [] };
    entry.parents.push({ path: row.parentPath, name: row.parentName });
    hierarchy.set(classKey(child), entry);
  }
  return hierarchy;
}

/** The classes whose parents differ between two readings. */
export function classesWithChangedParents(before: Hierarchy, after: Hierarchy): ClassRef[] {
  const parentsIn = (hierarchy: Hierarchy, key: string): string =>
    (hierarchy.get(key)?.parents ?? []).map(classKey).sort().join('\n\n');
  const changed: ClassRef[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (parentsIn(before, key) === parentsIn(after, key)) continue;
    const entry = before.get(key) ?? after.get(key);
    if (entry !== undefined) changed.push(entry.child);
  }
  return changed;
}

/**
 * `classes`, and every class that extends one of them, directly or not.
 *
 * One reading is enough even though a write removes the edges into the file
 * it re-writes: a class that lost an edge that way is one whose parents
 * changed, so the caller already has it in `classes`.
 */
export function classesAtOrBelow(classes: readonly ClassRef[], hierarchy: Hierarchy): ClassRef[] {
  const children = new Map<string, ClassRef[]>();
  for (const { child, parents } of hierarchy.values()) {
    for (const parent of parents) {
      const list = children.get(classKey(parent));
      if (list === undefined) children.set(classKey(parent), [child]);
      else list.push(child);
    }
  }
  const found = new Map(classes.map((ref) => [classKey(ref), ref]));
  const queue = [...found.values()];
  for (let ref = queue.pop(); ref !== undefined; ref = queue.pop()) {
    for (const child of children.get(classKey(ref)) ?? []) {
      if (found.has(classKey(child))) continue;
      found.set(classKey(child), child);
      queue.push(child);
    }
  }
  return [...found.values()];
}

/**
 * Paths of the files with an import that resolved to one of `paths`, whatever
 * it names.
 *
 * For a file that is gone, or that a new file now stands in front of: where
 * such an import points has changed although no name did. An importer that
 * names nothing the file exported holds no edge into it and is found by no
 * name, and its import row would go on pointing at the old file (D093).
 */
export async function findImportersOfFiles(db: Db, paths: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const batch of chunkValuesForSqlite(paths)) {
    const rows = await db
      .selectFrom('imports as i')
      .innerJoin('files as f', 'f.id', 'i.file_id')
      .select('f.path')
      .distinct()
      .where('i.resolved_path', 'in', batch)
      .execute();
    for (const row of rows) found.add(row.path);
  }
  return [...found];
}

/**
 * Paths of the files with an import of a module inside the project that
 * matched no file. When a file is added, any of them may be importing it,
 * whether or not it exports the name they ask for (D093). Few files have one:
 * 15 of 13,985 on n8n.
 */
export async function listFilesWithUnresolvedImports(db: Db): Promise<string[]> {
  const rows = await db
    .selectFrom('imports as i')
    .innerJoin('files as f', 'f.id', 'i.file_id')
    .select('f.path')
    .distinct()
    .where('i.resolved_path', 'is', null)
    .where('i.is_external', '=', 0)
    .execute();
  return rows.map((row) => row.path);
}

/**
 * Paths of the files holding an `export *` whose module matched no indexed
 * file. When a file is added, any of them may be the barrel that names it.
 */
export async function listFilesWithUnresolvedStars(db: Db): Promise<string[]> {
  const rows = await db
    .selectFrom('star_reexport_unresolved as u')
    .innerJoin('files as f', 'f.id', 'u.file_id')
    .select('f.path')
    .distinct()
    .execute();
  return rows.map((row) => row.path);
}

/**
 * Paths of the indexed files that a file in `addedPaths` now stands in front
 * of when a specifier is resolved (D091).
 *
 * `./x` resolves to `x.ts` before `x/index.ts`, and `./x.js` to `x.ts` before
 * `x.js`. So adding `x.ts` moves every import of the other two to it, although
 * neither changed and no import of them was unresolved. The files returned are
 * the ones whose importers have to be resolved again: the same name with
 * another extension, and an `index` file in a directory of that name. That is
 * wider than the resolver's own order, which costs a few files resolved again
 * for nothing and cannot miss one.
 */
export async function findFilesShadowedBy(db: Db, addedPaths: readonly string[]): Promise<string[]> {
  const shadowed = new Set<string>();
  for (const added of addedPaths) {
    const stem = added.replace(/\.[^./]+$/, '');
    const rows = await db
      .selectFrom('files')
      .select('path')
      .where('path', '>=', stem)
      .where('path', '<', pathPrefixUpperBound(stem))
      .execute();
    for (const { path } of rows) {
      if (path === added) continue;
      const rest = path.slice(stem.length);
      const sameNameOtherExtension = rest.startsWith('.') && !rest.includes('/');
      const directoryIndex = rest.startsWith('/index.') && !rest.slice('/index.'.length).includes('/');
      if (sameNameOtherExtension || directoryIndex) shadowed.add(path);
    }
  }
  return [...shadowed];
}

/**
 * Replaces the stored import rows of `filePath` with `imports`.
 *
 * A file resolved again has to be resolved against where its specifiers point
 * now: a specifier that matched no file when the row was written may match one
 * created since, and one that matched a file since deleted matches nothing.
 */
export async function replaceImports(db: Db, filePath: string, imports: readonly ImportRecord[]): Promise<void> {
  const file = await db.selectFrom('files').select('id').where('path', '=', filePath).executeTakeFirst();
  if (file === undefined) return;
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('imports').where('file_id', '=', file.id).execute();
    const rows = imports.map((imp) => ({
      file_id: file.id,
      module: imp.module,
      symbols: JSON.stringify(imp.symbols),
      is_external: imp.isExternal ? (1 as const) : (0 as const),
      resolved_path: imp.resolvedPath,
    }));
    for (const batch of chunkRowsForSqlite(rows)) await trx.insertInto('imports').values(batch).execute();
  });
}

// ---------------------------------------------------------------------------
// The files still waiting (`edge_repair_pending`)
// ---------------------------------------------------------------------------

/**
 * Records `paths` as waiting to be resolved again. A path with no `files` row
 * is ignored, and one already recorded stays recorded once.
 */
export async function markEdgeRepairsPending(db: Db, paths: readonly string[]): Promise<void> {
  for (const batch of chunkValuesForSqlite(paths)) {
    const files = await db.selectFrom('files').select('id').where('path', 'in', batch).execute();
    if (files.length === 0) continue;
    await db
      .insertInto('edge_repair_pending')
      .values(files.map((file) => ({ file_id: file.id })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

/** Removes `paths` from the waiting list, once each has been resolved again. */
export async function clearEdgeRepairsPending(db: Db, paths: readonly string[]): Promise<void> {
  for (const batch of chunkValuesForSqlite(paths)) {
    await db
      .deleteFrom('edge_repair_pending')
      .where('file_id', 'in', (qb) => qb.selectFrom('files').select('id').where('path', 'in', batch))
      .execute();
  }
}

/** Paths of the files waiting to be resolved again, in path order. */
export async function listPendingEdgeRepairs(db: Db): Promise<string[]> {
  const rows = await db
    .selectFrom('edge_repair_pending as p')
    .innerJoin('files as f', 'f.id', 'p.file_id')
    .select('f.path')
    .orderBy('f.path')
    .execute();
  return rows.map((row) => row.path);
}

/** How many files are waiting to be resolved again. */
export async function countPendingEdgeRepairs(db: Db): Promise<number> {
  const row = await db
    .selectFrom('edge_repair_pending')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/**
 * The members of `paths` that re-export anything, by name or by star.
 *
 * Other files resolve through these, so a run resolves all of them before any
 * file that only imports, and never leaves one waiting: an importer resolved
 * against a barrel that is itself out of date would get a wrong edge, and
 * nothing would bring the importer back once the barrel was put right.
 */
export async function findReExporters(db: Db, paths: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const batch of chunkValuesForSqlite(paths)) {
    const byMarker = await db
      .selectFrom('symbols as s')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select('f.path')
      .distinct()
      .where('s.kind', '=', 'export')
      .where('f.path', 'in', batch)
      .execute();
    const byStar = await db
      .selectFrom('re_export_files as r')
      .innerJoin('files as f', 'f.id', 'r.from_file_id')
      .select('f.path')
      .distinct()
      .where('f.path', 'in', batch)
      .execute();
    for (const row of [...byMarker, ...byStar]) found.add(row.path);
  }
  return found;
}
