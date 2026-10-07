import type { ImportRecord } from '../ast/types.js';
import type { Db } from './db.js';
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
// Known not covered, each because the index stores nothing to find the file by:
//   - an `import { a as b }` or `export { a as b } from`, which is recorded
//     under one of the two names only (D087's neighbour, deferred);
//   - an `export *` of a file that did not exist when the barrel was indexed;
//   - a call resolved with no file evidence (`legacyGlobalFirstMatch`);
//   - a new file that takes over a specifier another file already answered
//     (`./x` moving from `x/index.ts` to a new `x.ts`).
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
  /**
   * Also return files importing one of the names from a module that resolved
   * to no file. Set when a file was added: that module may be the new file.
   */
  readonly includeUnresolved: boolean;
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

  const found = new Set<string>();
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
  if (query.includeUnresolved) {
    const rows = await db
      .selectFrom('imports as i')
      .innerJoin('files as f', 'f.id', 'i.file_id')
      .select(['f.path', 'i.symbols'])
      .where('i.resolved_path', 'is', null)
      .where('i.is_external', '=', 0)
      .execute();
    for (const row of rows) if (namesAny(row.symbols)) found.add(row.path);
  }
  return [...found];
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
