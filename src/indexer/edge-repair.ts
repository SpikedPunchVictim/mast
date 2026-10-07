import type { extractFile } from '../ast/extract.js';
import type { Db } from '../graph/db.js';
import {
  changedExports,
  clearEdgeRepairsPending,
  findFilesShadowedBy,
  findImportersOfNames,
  findReExporters,
  listFilesWithUnresolvedStars,
  listPendingEdgeRepairs,
  markEdgeRepairsPending,
  namesExportedThrough,
  readExportSurface,
  replaceImports,
  type ExportSurface,
} from '../graph/importer-repair.js';
import {
  clearOutgoingEdges,
  findFilesWithEdgesInto,
  insertGraphEdges,
  insertReExportFiles,
  type FileEdgeData,
} from '../graph/populate.js';

// ---------------------------------------------------------------------------
// Putting edges back after files were re-written or deleted
// (D080, D081, D084; adr/proposals/incremental-graph-correctness, M3 and M5).
//
// Re-writing a file deletes its rows, and every edge into them goes by
// cascade. The files that held those edges are not re-written, and a file that
// imports a name the re-written one gained or lost is not either. Both have to
// be resolved again. An incremental run and a read tool's query-time refresh
// both re-write files, so both call this one routine; when only the run did,
// a query-time refresh lost the edges the run kept (D080).
//
// Use: `rememberBeforeRemoval` before the rows go, then the write, then
// `repairEdgesAfterWrites`.
// ---------------------------------------------------------------------------

/** How many files are prepared under one acquisition of the lock (F1). */
const REPAIR_BATCH = 16;

/** What has to be read before a file's rows are deleted, because the delete removes it. */
export interface EdgeRepairMemo {
  /** Files that held an edge or star row into a file about to go. */
  readonly holders: Set<string>;
  /**
   * The holders that re-export. Decided while their star rows exist: a barrel
   * whose only re-export is `export *` of a re-written file has no row left to
   * be recognised by afterwards.
   */
  readonly reExportingHolders: Set<string>;
  /** What each file exported beforehand. A path with no entry had no row. */
  readonly surfaces: Map<string, ExportSurface>;
}

export function newEdgeRepairMemo(): EdgeRepairMemo {
  return { holders: new Set(), reExportingHolders: new Set(), surfaces: new Map() };
}

/**
 * Records into `memo` what the removal of `paths`' rows is about to destroy.
 * Call it BEFORE the write or delete, in the same critical section.
 */
export async function rememberBeforeRemoval(db: Db, memo: EdgeRepairMemo, paths: readonly string[]): Promise<void> {
  const holders = await findFilesWithEdgesInto(db, paths);
  for (const holder of holders) memo.holders.add(holder);
  for (const holder of await findReExporters(db, holders)) memo.reExportingHolders.add(holder);
  for (const path of paths) {
    const surface = await readExportSurface(db, path);
    if (surface !== null) memo.surfaces.set(path, surface);
  }
}

/** The part of a file's extraction that resolving it again needs. */
export type ReResolveRecords = Pick<ReturnType<typeof extractFile>, 'edges' | 'starReExports' | 'imports'>;

export interface EdgeRepairInput {
  readonly memo: EdgeRepairMemo;
  /** The files written since `memo` was started, with their records. */
  readonly written: readonly FileEdgeData[];
  /** The files deleted since `memo` was started. */
  readonly deleted: readonly string[];
  /** False for a file that must not be resolved again: gone from the project, or failed this run. */
  readonly canReResolve: (path: string) => boolean;
  /** Parses a file for its records, or returns undefined when it cannot be read. */
  readonly readRecords: (path: string) => ReResolveRecords | undefined;
  /**
   * Milliseconds to spend on files that only import. Undefined is no limit.
   * Files that re-export are always done, outside it — see `findReExporters`.
   */
  readonly budgetMs: number | undefined;
  /** Runs one batch of writes; the indexer passes a wrapper that takes the structure lock. */
  readonly inLock: <T>(work: () => Promise<T>) => Promise<T>;
}

export interface EdgeRepairResult {
  /** Files resolved again without being re-written. */
  readonly filesReResolved: number;
  /** Files still waiting when the budget ran out. They stay recorded. */
  readonly pending: number;
}

/**
 * Inserts the edges of `written`, and resolves again every file whose edges
 * the writes and deletes put out of date: files an earlier call left waiting,
 * the holders in `memo`, and the files that import a name some file gained,
 * lost or re-pointed.
 */
export async function repairEdgesAfterWrites(db: Db, input: EdgeRepairInput): Promise<EdgeRepairResult> {
  const { memo, inLock } = input;
  const writtenPaths = new Set(input.written.map((file) => file.filePath));
  const edgeData: FileEdgeData[] = [...input.written];

  // Files resolved again without being re-written: their own rows are current
  // and keep their ids, so each is parsed for its records and nothing else.
  const reExtracted = new Map<string, ReResolveRecords>();
  const extractForReResolve = (paths: Iterable<string>): void => {
    for (const path of paths) {
      if (!input.canReResolve(path) || writtenPaths.has(path) || reExtracted.has(path)) continue;
      const records = input.readRecords(path);
      if (records !== undefined) reExtracted.set(path, records);
    }
  };
  /** Clears and re-reads what `paths` hold, and returns their records for `insertGraphEdges`. */
  const prepareReResolve = async (paths: readonly string[]): Promise<FileEdgeData[]> => {
    extractForReResolve(paths);
    const prepared: FileEdgeData[] = [];
    for (let i = 0; i < paths.length; i += REPAIR_BATCH) {
      await inLock(async () => {
        for (const path of paths.slice(i, i + REPAIR_BATCH)) {
          const records = reExtracted.get(path);
          if (records === undefined) continue;
          await clearOutgoingEdges(db, path);
          await replaceImports(db, path, records.imports);
          prepared.push({ filePath: path, edges: records.edges, starReExports: records.starReExports });
        }
      });
    }
    return prepared;
  };

  const candidates = new Set([...(await listPendingEdgeRepairs(db)), ...memo.holders]);

  // A file new to the index can change what unchanged files resolve to in two
  // ways the lookups below would not see. A barrel indexed before it may name
  // it in an `export *` that matched nothing then (D090): those barrels are
  // read again, so their star rows go in with the rest. And it may stand in
  // front of a file already imported (D091): the files holding edges into
  // that one are resolved again, and its names count as changed.
  const added = [...writtenPaths].filter((path) => !memo.surfaces.has(path));
  const shadowed = added.length > 0 ? await findFilesShadowedBy(db, added) : [];
  if (added.length > 0) {
    const barrels = await listFilesWithUnresolvedStars(db);
    for (const path of [...barrels, ...(await findFilesWithEdgesInto(db, shadowed))]) candidates.add(path);
    extractForReResolve(barrels);
  }

  // The importers of a changed name are found by walking star rows, so the
  // rows of every file written or held go in first. `insertGraphEdges` writes
  // them again, which changes nothing.
  extractForReResolve(memo.reExportingHolders);
  await inLock(async () => {
    for (const file of input.written) await insertReExportFiles(db, file.filePath, file.starReExports);
    for (const [path, records] of reExtracted) await insertReExportFiles(db, path, records.starReExports);
  });
  const changedNames = new Set<string>();
  const changedStarTargets = new Set<string>();
  for (const path of new Set([...input.deleted, ...writtenPaths])) {
    const after = writtenPaths.has(path) ? await readExportSurface(db, path) : null;
    const changed = changedExports(memo.surfaces.get(path) ?? null, after);
    for (const name of changed.names) changedNames.add(name);
    for (const target of changed.starTargets) changedStarTargets.add(target);
  }
  for (const name of await namesExportedThrough(db, [...changedStarTargets, ...shadowed])) changedNames.add(name);
  const importers = await findImportersOfNames(db, {
    names: [...changedNames],
    sources: [...input.deleted, ...writtenPaths, ...memo.holders, ...shadowed],
    includeUnresolved: added.length > 0,
  });
  for (const path of importers) candidates.add(path);

  // Recorded before any of it is done, so a process that stops here leaves a
  // list the next run picks up instead of edges nobody knows are missing. A
  // written file that was waiting stays so until its own edges are in.
  const toReResolve = [...candidates].filter((path) => input.canReResolve(path) && !writtenPaths.has(path));
  await inLock(async () => {
    await clearEdgeRepairsPending(db, [...candidates].filter((path) => !writtenPaths.has(path)));
    await markEdgeRepairsPending(db, toReResolve);
  });

  // Files that re-export are resolved in full, with the written files,
  // whatever the budget — see `findReExporters`.
  const reExporters = await findReExporters(db, toReResolve);
  const reExporterPaths = toReResolve.filter((path) => reExporters.has(path));
  const reExporterData = await prepareReResolve(reExporterPaths);
  let filesReResolved = reExporterData.length;
  edgeData.push(...reExporterData);
  let waiting = toReResolve.filter((path) => !reExporters.has(path)).sort();
  await insertGraphEdges(db, edgeData, inLock);
  await inLock(() => clearEdgeRepairsPending(db, [...reExporterPaths, ...writtenPaths]));

  // The rest only import. Each is right as soon as it is resolved against the
  // finished barrels, so they can be done a batch at a time and stopped at the
  // budget; what is left stays recorded.
  const repairStart = Date.now();
  const budgetMs = input.budgetMs ?? Number.POSITIVE_INFINITY;
  while (waiting.length > 0 && Date.now() - repairStart < budgetMs) {
    const batch = waiting.slice(0, REPAIR_BATCH);
    waiting = waiting.slice(REPAIR_BATCH);
    const batchData = await prepareReResolve(batch);
    filesReResolved += batchData.length;
    await insertGraphEdges(db, batchData, inLock);
    await inLock(() => clearEdgeRepairsPending(db, batch));
  }

  return { filesReResolved, pending: waiting.length };
}
