import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sql } from 'kysely';
import { expect } from 'vitest';
import { resolveConfig, type ResolvedConfig } from '../../store/config.js';
import { openDatabase } from '../../graph/db.js';
import { runIndex } from '../index.js';

// ---------------------------------------------------------------------------
// Shared fixture for graph-correctness tests
// (adr/proposals/incremental-graph-correctness, T1 and T14).
//
// Two comparisons, and they catch different defects:
//
//   expectGraphEqualsFullIndex — the stored graph against a fresh full index
//   of the same tree. Catches an incremental run that loses or keeps an edge
//   (D080, D081, D084). It cannot see an edge the full index itself gets wrong.
//
//   expectEdges — a full index against edges written out by hand. Catches what
//   the first cannot (D083, D085, D086), because the expected side does not
//   come from mast.
//
// Edges are compared by name, never by id: ids change on every re-write.
// ---------------------------------------------------------------------------

/** Edge types a hand-written list covers unless the caller narrows it. */
export const RESOLVED_EDGE_TYPES = ['POTENTIAL_CALL', 'EXTENDS', 'IMPLEMENTS'] as const;

export interface GraphDump {
  /** `TYPE [resolution] from-file:from-symbol -> to-file:to-symbol`, sorted. */
  readonly edges: readonly string[];
  /** `from-file => to-file` for each star re-export row, sorted. */
  readonly stars: readonly string[];
  /** `file <- module {symbols} -> resolved-path|external|unresolved`, sorted. */
  readonly imports: readonly string[];
}

/** Creates an empty scratch project directory. The caller removes it. */
export function makeProject(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `mast-${prefix}-`));
}

/** Writes `files` (relative path to content) under `projectDir`. */
export function writeFiles(projectDir: string, files: Readonly<Record<string, string>>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(projectDir, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

/**
 * Rewrites one file and moves its mtime forward by two whole seconds. mast
 * stamps files in seconds, so an edit inside the same second as the last index
 * run is invisible to an incremental run; a real editor never lands there, a
 * test always does.
 */
export function editFile(projectDir: string, relativePath: string, content: string): void {
  const absolute = join(projectDir, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  let previousSeconds = Math.floor(Date.now() / 1000);
  try {
    previousSeconds = Math.max(previousSeconds, Math.floor(statSync(absolute).mtimeMs / 1000));
  } catch {
    // A file being created has no previous stamp; the clock reading stands.
  }
  writeFileSync(absolute, content);
  const next = previousSeconds + 2;
  utimesSync(absolute, next, next);
}

export function configFor(projectDir: string, stateDir?: string): ResolvedConfig {
  return resolveConfig({
    projectRoot: projectDir,
    ...(stateDir !== undefined ? { stateDirOverride: stateDir } : {}),
  });
}

export async function indexFull(projectDir: string, stateDir?: string): Promise<void> {
  await runIndex(configFor(projectDir, stateDir), { incremental: false });
}

export async function indexIncremental(projectDir: string): Promise<void> {
  await runIndex(configFor(projectDir), { incremental: true });
}

/**
 * The graph as names. `withResolution` is on for index-against-index
 * comparisons, where the label must match too, and off for hand-written lists,
 * where it would make every expected line restate an implementation detail.
 */
export async function dumpGraph(
  config: ResolvedConfig,
  options: { readonly withResolution: boolean; readonly edgeTypes?: readonly string[] },
): Promise<GraphDump> {
  const db = openDatabase(config.resolved_state_dir);
  try {
    const edgeRows = (
      await sql<{ t: string; r: string; fp: string; fn: string; tp: string; tn: string }>`
        SELECT e.edge_type AS t, COALESCE(e.resolution, '') AS r,
               ff.path AS fp, fs.name AS fn, tf.path AS tp, ts.name AS tn
        FROM edges e
        JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
        JOIN symbols ts ON ts.id = e.to_id   JOIN files tf ON tf.id = ts.file_id
        WHERE COALESCE(e.resolution, '') != 'checker'`.execute(db)
    ).rows;
    const starRows = (
      await sql<{ f: string; t: string }>`
        SELECT a.path AS f, b.path AS t FROM re_export_files x
        JOIN files a ON a.id = x.from_file_id JOIN files b ON b.id = x.to_file_id`.execute(db)
    ).rows;
    const importRows = (
      await sql<{ f: string; m: string; s: string; x: number; p: string | null }>`
        SELECT f.path AS f, i.module AS m, i.symbols AS s, i.is_external AS x,
               i.resolved_path AS p
        FROM imports i JOIN files f ON f.id = i.file_id`.execute(db)
    ).rows;

    const wanted = options.edgeTypes === undefined ? null : new Set(options.edgeTypes);
    const edges = edgeRows
      .filter((e) => wanted === null || wanted.has(e.t))
      .map((e) => {
        const label = options.withResolution && e.r !== '' ? `${e.t} [${e.r}]` : e.t;
        return `${label} ${e.fp}:${e.fn} -> ${e.tp}:${e.tn}`;
      });
    return {
      // A set first: two call sites in one function are two rows and one fact.
      edges: [...new Set(edges)].sort(),
      stars: starRows.map((s) => `${s.f} => ${s.t}`).sort(),
      imports: importRows
        .map((i) => `${i.f} <- ${i.m} ${i.s} -> ${i.p ?? (i.x === 1 ? 'external' : 'unresolved')}`)
        .sort(),
    };
  } finally {
    await db.destroy();
  }
}

/**
 * The symbols of the stored graph of `projectDir`, as `kind file:name`, with
 * `exported ` before the kind of an exported one. Sorted; a name declared
 * twice in a file is listed twice.
 */
export async function dumpSymbols(projectDir: string): Promise<readonly string[]> {
  const db = openDatabase(configFor(projectDir).resolved_state_dir);
  try {
    const rows = (
      await sql<{ k: string; p: string; n: string; x: number }>`
        SELECT s.kind AS k, f.path AS p, s.name AS n, s.is_exported AS x
        FROM symbols s JOIN files f ON f.id = s.file_id`.execute(db)
    ).rows;
    return rows.map((r) => `${r.x === 1 ? 'exported ' : ''}${r.k} ${r.p}:${r.n}`).sort();
  } finally {
    await db.destroy();
  }
}

/**
 * T14. Runs a full index of `projectDir` and requires its edges of the given
 * types to equal `expected`, in both directions: a missing edge and an extra
 * one both fail.
 */
export async function expectEdges(
  projectDir: string,
  expected: readonly string[],
  edgeTypes: readonly string[] = RESOLVED_EDGE_TYPES,
): Promise<void> {
  await indexFull(projectDir);
  await expectStoredEdges(projectDir, expected, edgeTypes);
}

/** As `expectEdges`, against the graph as it stands, with no index run first. */
export async function expectStoredEdges(
  projectDir: string,
  expected: readonly string[],
  edgeTypes: readonly string[] = RESOLVED_EDGE_TYPES,
): Promise<void> {
  const dump = await dumpGraph(configFor(projectDir), { withResolution: false, edgeTypes });
  expect(dump.edges).toEqual([...expected].sort());
}

/**
 * T1. Requires the stored graph of `projectDir` to equal a fresh full index of
 * the same tree, built into a state directory of its own so the stored graph
 * is not disturbed.
 */
export async function expectGraphEqualsFullIndex(projectDir: string): Promise<void> {
  const freshStateDir = mkdtempSync(join(tmpdir(), 'mast-fresh-state-'));
  try {
    await indexFull(projectDir, freshStateDir);
    const stored = await dumpGraph(configFor(projectDir), { withResolution: true });
    const fresh = await dumpGraph(configFor(projectDir, freshStateDir), { withResolution: true });
    expect(stored).toEqual(fresh);
  } finally {
    rmSync(freshStateDir, { recursive: true, force: true });
  }
}
