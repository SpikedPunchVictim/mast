import type { extractFile } from '../ast/extract.js';
import type { Db } from '../graph/db.js';
import {
  changedExports,
  classesAtOrBelow,
  classesWithChangedParents,
  clearEdgeRepairsPending,
  findFilesShadowedBy,
  findImportersOfFiles,
  findImportersOfNames,
  findReExporters,
  listFilesWithUnresolvedImports,
  listFilesWithUnresolvedStars,
  listPendingEdgeRepairs,
  markEdgeRepairsPending,
  namesExportedThrough,
  readExportSurface,
  readHierarchy,
  replaceImports,
  type ClassRef,
  type ExportSurface,
  type Hierarchy,
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
  /**
   * Which class extends which, read before the first removal. A write removes
   * the `EXTENDS` edges into the file it re-writes, and the classes that lost
   * one are found by comparing with this.
   */
  hierarchy: Hierarchy | undefined;
}

export function newEdgeRepairMemo(): EdgeRepairMemo {
  return { holders: new Set(), reExportingHolders: new Set(), surfaces: new Map(), hierarchy: undefined };
}

/**
 * Records into `memo` what the removal of `paths`' rows is about to destroy.
 * Call it BEFORE the write or delete, in the same critical section.
 */
export async function rememberBeforeRemoval(db: Db, memo: EdgeRepairMemo, paths: readonly string[]): Promise<void> {
  memo.hierarchy ??= await readHierarchy(db);
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
  const writtenData = new Map(input.written.map((file) => [file.filePath, file]));
  const writtenPaths = new Set(writtenData.keys());
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
          // A file this call wrote has current import rows and its records to hand.
          const own = writtenData.get(path);
          if (own !== undefined) {
            await clearOutgoingEdges(db, path);
            prepared.push(own);
            continue;
          }
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
  // A deleted file is the same case from the other side: what it stood in
  // front of is where those specifiers point now (D095).
  const shadowed = await findFilesShadowedBy(db, [...added, ...input.deleted]);
  if (added.length > 0) {
    const barrels = await listFilesWithUnresolvedStars(db);
    const importingNothingYet = await listFilesWithUnresolvedImports(db);
    for (const path of [...barrels, ...importingNothingYet]) candidates.add(path);
    extractForReResolve(barrels);
  }
  for (const path of await findFilesWithEdgesInto(db, shadowed)) candidates.add(path);
  // Where an import of a deleted or shadowed file points has changed even if
  // the importer names nothing that file exported (D093).
  for (const path of await findImportersOfFiles(db, [...input.deleted, ...shadowed])) candidates.add(path);

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
  // A class that gained or lost a member, or came or went itself.
  const changedClasses: ClassRef[] = [];
  for (const path of new Set([...input.deleted, ...writtenPaths])) {
    const after = writtenPaths.has(path) ? await readExportSurface(db, path) : null;
    const changed = changedExports(memo.surfaces.get(path) ?? null, after);
    for (const name of changed.names) {
      changedNames.add(name);
      changedClasses.push({ path, name: name.split('.', 1)[0] ?? name });
    }
    for (const target of changed.starTargets) changedStarTargets.add(target);
  }
  for (const name of await namesExportedThrough(db, [...changedStarTargets, ...shadowed])) changedNames.add(name);
  const importers = await findImportersOfNames(db, {
    names: [...changedNames],
    sources: [...input.deleted, ...writtenPaths, ...memo.holders, ...shadowed],
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

  // A call of an inherited member is resolved along stored `EXTENDS` edges
  // (`resolveInheritedMember`), so it is out of date when any class above the
  // receiver's changed its members or its parent. The files that can hold
  // such a call are the one declaring a class at or below the changed one and
  // the ones importing it. They are looked for after every group resolved,
  // because resolving a file again can itself change what its classes extend.
  let hierarchy = memo.hierarchy ?? (await readHierarchy(db));
  const filesToResolveAfter = async (changed: readonly ClassRef[], justResolved: ReadonlySet<string>): Promise<string[]> => {
    const now = await readHierarchy(db);
    const affected = classesAtOrBelow([...changed, ...classesWithChangedParents(hierarchy, now)], now);
    hierarchy = now;
    if (affected.length === 0) return [];
    const declaring = [...new Set(affected.map((ref) => ref.path))];
    const importing = await findImportersOfNames(db, { names: [...new Set(affected.map((ref) => ref.name))], sources: declaring });
    // A file in the group just resolved had its calls resolved after the
    // group's `EXTENDS` edges went in, so it is current.
    return [...new Set([...declaring, ...importing])].filter((path) => input.canReResolve(path) && !justResolved.has(path));
  };

  // Files that re-export are resolved in full, with the written files,
  // whatever the budget — see `findReExporters`.
  const reExporters = await findReExporters(db, toReResolve);
  const reExporterPaths = toReResolve.filter((path) => reExporters.has(path));
  const reExporterData = await prepareReResolve(reExporterPaths);
  let filesReResolved = reExporterData.length;
  edgeData.push(...reExporterData);
  const waiting = new Set(toReResolve.filter((path) => !reExporters.has(path)));
  await insertGraphEdges(db, edgeData, inLock);

  // What a group put out of date is recorded before the group is taken off
  // the list, so a process that stops in between leaves the larger list.
  const queue = async (paths: readonly string[]): Promise<void> => {
    if (paths.length === 0) return;
    for (const path of paths) waiting.add(path);
    await inLock(() => markEdgeRepairsPending(db, paths));
  };
  await queue(await filesToResolveAfter(changedClasses, new Set([...reExporterPaths, ...writtenPaths])));
  await inLock(() => clearEdgeRepairsPending(db, [...reExporterPaths, ...writtenPaths]));

  // The rest only import. Each is right as soon as it is resolved against the
  // finished barrels and classes, so they can be done a batch at a time and
  // stopped at the budget; what is left stays recorded.
  const repairStart = Date.now();
  const budgetMs = input.budgetMs ?? Number.POSITIVE_INFINITY;
  while (waiting.size > 0 && Date.now() - repairStart < budgetMs) {
    const batch = [...waiting].sort().slice(0, REPAIR_BATCH);
    for (const path of batch) waiting.delete(path);
    const batchData = await prepareReResolve(batch);
    filesReResolved += batchData.filter((file) => !writtenPaths.has(file.filePath)).length;
    await insertGraphEdges(db, batchData, inLock);
    if (batchData.some((file) => file.edges.some((edge) => edge.edgeType === 'EXTENDS'))) {
      await queue(await filesToResolveAfter([], new Set(batch)));
    }
    await inLock(() => clearEdgeRepairsPending(db, batch));
  }

  return { filesReResolved, pending: waiting.size };
}
