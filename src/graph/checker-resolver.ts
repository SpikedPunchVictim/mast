import { resolve, sep, dirname } from 'node:path';
import ts from 'typescript';
import fg from 'fast-glob';
import type { Db } from './db.js';
import type { ChunkStore } from '../store/sqliteChunkStore.js';
import type { ResolvedConfig } from '../store/config.js';
import type { VerifiedCaller, CallerResolution } from '../ast/types.js';
import { withLock } from '../store/lock.js';
import { constructorIdsOf, queryVerifiedCallers, querySymbolByName } from './queries.js';
import { collectPotentialMatchCandidates, type ChunkByIdSource, type CandidateChunkRecord } from '../search/potential-matches.js';
import { chunkValuesForSqlite } from './sqliteBatch.js';
import { removeCheckerResults } from './populate.js';

// ---------------------------------------------------------------------------
// `mast index --checker` — opt-in TypeScript-checker enrichment pass
// (IMPLEMENTATION_PLAN_VEXP.md Feature 1 / Stage 1.2, MAST_SPEC §10.3.2).
//
// Upgrades `potential_matches` (identifier-FTS hits the tree-sitter heuristic
// resolver, §10.3.1, could not statically link) into either a verified
// POTENTIAL_CALL edge (resolution 'checker') or a `checker_verdicts` row that
// permanently filters a non-call-site / wrong-declaration candidate out of
// future `potential_matches` responses.
//
// Reshaped from the plan's original "always-on background worker" design to
// an opt-in CLI pass by the Stage 1.1 spike: holding all 25 monorepo
// ts.Programs alive at once measured 2.45 GB peak RSS, over the 2 GB gate
// (eval/spikes/checker-edges/REPORT.md Q2). This module holds exactly ONE
// ts.Program at a time and disposes it before moving to the next tsconfig
// project — the spike's warm-pass anomaly (all-programs-alive made a "warm"
// re-check 42.6s vs 21.8s cold, via GC pressure) is the cautionary tale.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TypeScript-project discovery
// ---------------------------------------------------------------------------

/** One tsconfig project the checker pass can build a `ts.Program` for. */
export interface TsProjectDescriptor {
  /** Directory containing tsconfig.json, relative to the project root (POSIX separators). */
  readonly configDir: string;
  /** Absolute paths TypeScript itself resolved via this tsconfig's "include"/"files". */
  readonly fileNames: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
}

/** A tsconfig.json that was found but is not a standalone checkable project. */
export interface TsProjectSkip {
  readonly configDir: string;
  readonly reason: string;
}

export interface TsProjectDiscoveryResult {
  readonly projects: readonly TsProjectDescriptor[];
  readonly skipped: readonly TsProjectSkip[];
}

/**
 * tsconfig.json locations that are structurally never real, standalone
 * projects — excluded before even attempting to parse them so a large
 * `node_modules` tree costs nothing.
 */
const DISCOVERY_IGNORE = ['**/node_modules/**', '**/dist/**', '**/.build/**', '**/coverage/**'];

// Arrow-wrapped (not `ts.sys.fileExists` directly) so each call stays bound to
// `ts.sys` — @typescript-eslint/unbound-method flags a bare method reference
// as an unintentional-`this`-scoping risk.
const PARSE_CONFIG_HOST: ts.ParseConfigHost = {
  fileExists: (path) => ts.sys.fileExists(path),
  readFile: (path) => ts.sys.readFile(path),
  readDirectory: (path, extensions, exclude, include, depth) =>
    ts.sys.readDirectory(path, extensions, exclude, include, depth),
  useCaseSensitiveFileNames: true,
};

/** Bound wrapper for `ts.sys.readFile`, passed where a bare function reference is needed. */
function readFile(path: string): string | undefined {
  return ts.sys.readFile(path);
}

/**
 * Convert an absolute path to a POSIX-separated path relative to `root`.
 * Returns `.` when `absPath` IS `root` (the fold-app-scale shape: a single
 * package's own directory as project_root, tsconfig.json living directly in
 * it — found running the real pass against align-kimik27-02/packages/core,
 * IMPLEMENTATION_PLAN_VEXP.md Stage 1.2 addendum. Without this case the
 * prefix-strip below never matches — `root` has no trailing slash to align
 * against — and `configDir` came back as the full absolute path instead).
 */
function relPath(absPath: string, root: string): string {
  const norm = absPath.split(sep).join('/');
  const rootNorm = root.split(sep).join('/').replace(/\/$/, '');
  if (norm === rootNorm) return '.';
  const withSlash = rootNorm + '/';
  return norm.startsWith(withSlash) ? norm.slice(withSlash.length) : norm;
}

/**
 * Enumerate every tsconfig project under `projectRoot`.
 *
 * A tsconfig.json is a real, checkable project when `ts.parseJsonConfigFileContent`
 * resolves at least one source file for it. A base config meant to be
 * `extends`-ed (e.g. `tsconfig.base.json`) declares no "include"/"files" of
 * its own and resolves zero files — skipped with reason `no_include_base_config`.
 * A config that fails to parse is skipped with the parser's own error text.
 * This is a generic, project-shape-agnostic rule (unlike the Stage 1.1 spike's
 * hardcoded 25-project list for the kluster monorepo specifically) so it works
 * for any project `mast index --checker` runs against, monorepo or single-app.
 */
export function discoverTsConfigProjects(projectRoot: string): TsProjectDiscoveryResult {
  const configPaths = fg
    .sync('**/tsconfig.json', {
      cwd: projectRoot,
      ignore: DISCOVERY_IGNORE,
      absolute: true,
      onlyFiles: true,
      followSymbolicLinks: false,
    })
    .sort();

  const projects: TsProjectDescriptor[] = [];
  const skipped: TsProjectSkip[] = [];

  for (const configPath of configPaths) {
    const configDir = relPath(dirname(configPath), projectRoot);
    const configFile = ts.readConfigFile(configPath, readFile);
    if (configFile.error !== undefined) {
      skipped.push({
        configDir,
        reason: `tsconfig_parse_error: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')}`,
      });
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(configFile.config, PARSE_CONFIG_HOST, dirname(configPath));
    if (parsed.fileNames.length === 0) {
      skipped.push({ configDir, reason: 'no_include_base_config' });
      continue;
    }
    projects.push({ configDir, fileNames: parsed.fileNames, compilerOptions: parsed.options });
  }

  return { projects, skipped };
}

// ---------------------------------------------------------------------------
// Call-site classification — the TS program/checker boundary
// ---------------------------------------------------------------------------

/** One call-site candidate to classify against a loaded project's program. */
export interface ClassifyInput {
  /** File containing the candidate call site, relative to the project root. */
  readonly relFilePath: string;
  /** Bare (post-`.`) name being searched for — `ClassName.method` → `method`. */
  readonly bareName: string;
  /** The potential match's chunk start/end lines: its declaration's own lines.
   *  A call is looked for on these lines only, so a `resolves_to_queried`
   *  result's `callLine` is always inside them. */
  readonly startLine: number;
  readonly endLine: number;
  /** The queried symbol's own declaration site, for the resolved-declaration comparison. */
  readonly queriedFilePath: string;
  readonly queriedLine: number;
}

export type CallSiteClassification =
  | { readonly kind: 'resolves_to_queried'; readonly callLine: number; readonly context: string }
  | { readonly kind: 'resolves_to_different' }
  | { readonly kind: 'non_call_site' }
  | { readonly kind: 'unresolved' };

/**
 * A loaded TypeScript project — one `ts.Program` + `ts.TypeChecker`.
 *
 * Callers MUST call `dispose()` before loading the next project; the checker
 * pass holds exactly one handle at a time (see module doc — the RSS gate).
 */
export interface TsProjectHandle {
  classify(input: ClassifyInput): CallSiteClassification;
  /** Release the underlying program/checker. Idempotent; `classify()` after `dispose()` throws. */
  dispose(): void;
}

/**
 * Abstraction over "hold a TypeScript program for one project and classify
 * call sites against it." The real implementation wraps `ts.createProgram` +
 * `ts.TypeChecker` (the feature IS the compiler integration — a fake exists
 * only so `runCheckerPass`'s orchestration logic, persistence, and filtering
 * can be unit-tested without paying real compiler cost; the classification
 * logic itself is exercised only by the real implementation, in
 * `checker-resolver.test.ts`'s real-compiler fixtures).
 */
export interface TsProjectResolver {
  discoverProjects(): TsProjectDiscoveryResult;
  loadProgram(descriptor: TsProjectDescriptor): TsProjectHandle;
}

/** Bounded hop count for `ts.Symbol.getAliasedSymbol` chains. MANDATORY per
 *  the Stage 1.1 spike: without alias-following, `getSymbolAtLocation` on an
 *  imported identifier returns the local import binding (not its real
 *  target), and the definite-edge resolution rate collapses 38% -> 2%. */
const ALIAS_HOP_LIMIT = 8;

interface IdentifierOccurrence {
  readonly node: ts.Identifier;
  readonly line: number;
  readonly callShaped: boolean;
}

/** True when `node` is the callee of a CallExpression/NewExpression, direct or via `.property(...)`. */
function isCallShaped(node: ts.Identifier): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (parent === undefined) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isNewExpression(parent) && parent.expression === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    const grandparent = parent.parent as ts.Node | undefined;
    if (grandparent !== undefined && ts.isCallExpression(grandparent) && grandparent.expression === parent) return true;
    if (grandparent !== undefined && ts.isNewExpression(grandparent) && grandparent.expression === parent) return true;
  }
  return false;
}

/**
 * All `Identifier` nodes named `name` whose 1-indexed line falls in
 * `[startLine, endLine]`, in line then source order.
 *
 * A chunk's stored text runs `context_lines` (MAST_SPEC §6.1) past its
 * declaration, so the name can be matched from a line outside these. That
 * line belongs to a neighbouring declaration, which is a candidate of its own.
 * The window was once padded by five lines to reach it, and the edge was then
 * written from this chunk's symbol: 2,637 of 5,591 checker edges on n8n named
 * a caller that does not contain the call (D154).
 */
function findIdentifierOccurrences(
  sourceFile: ts.SourceFile,
  name: string,
  startLine: number,
  endLine: number,
): IdentifierOccurrence[] {
  const occurrences: IdentifierOccurrence[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const line1 = line + 1;
      if (line1 >= startLine && line1 <= endLine) {
        occurrences.push({ node, line: line1, callShaped: isCallShaped(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  occurrences.sort((a, b) => a.line - b.line || a.node.getStart(sourceFile) - b.node.getStart(sourceFile));
  return occurrences;
}

class RealTsProjectHandle implements TsProjectHandle {
  private program: ts.Program | null;
  private checker: ts.TypeChecker | null;

  constructor(descriptor: TsProjectDescriptor, private readonly projectRoot: string) {
    this.program = ts.createProgram({ rootNames: descriptor.fileNames, options: descriptor.compilerOptions });
    this.checker = this.program.getTypeChecker();
  }

  classify(input: ClassifyInput): CallSiteClassification {
    if (this.program === null || this.checker === null) {
      throw new Error('RealTsProjectHandle.classify() called after dispose()');
    }
    const absPath = resolve(this.projectRoot, input.relFilePath).split(sep).join('/');
    const sourceFile = this.program.getSourceFile(absPath);
    // Defensive only: the orchestrator only routes candidates whose file was
    // discovered as a member of THIS project's fileNames.
    if (sourceFile === undefined) return { kind: 'unresolved' };

    const occurrences = findIdentifierOccurrences(sourceFile, input.bareName, input.startLine, input.endLine);
    const callSite = occurrences.find((o) => o.callShaped);
    if (callSite === undefined) return { kind: 'non_call_site' };

    let symbol: ts.Symbol | undefined = this.checker.getSymbolAtLocation(callSite.node);
    for (let hops = 0; symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && hops < ALIAS_HOP_LIMIT; hops++) {
      let aliased: ts.Symbol;
      try {
        aliased = this.checker.getAliasedSymbol(symbol);
      } catch {
        break;
      }
      if (aliased === symbol) break;
      symbol = aliased;
    }
    const declarations = symbol?.getDeclarations() ?? [];
    const firstDecl = declarations[0];
    if (symbol === undefined || firstDecl === undefined) return { kind: 'unresolved' };

    const declSourceFile = firstDecl.getSourceFile();
    const declLine = declSourceFile.getLineAndCharacterOfPosition(firstDecl.getStart(declSourceFile)).line + 1;
    const declFilePath = relPath(resolve(declSourceFile.fileName), this.projectRoot);

    const sameFile = declFilePath === input.queriedFilePath;
    const lineClose = Math.abs(declLine - input.queriedLine) <= 3;
    if (!(sameFile && lineClose)) return { kind: 'resolves_to_different' };

    const lineText = sourceFile.getFullText().split('\n')[callSite.line - 1] ?? '';
    return { kind: 'resolves_to_queried', callLine: callSite.line, context: lineText.trim() };
  }

  dispose(): void {
    // Drop references so nothing keeps this project's Program (and the
    // source ASTs/type graph it retains) alive once the orchestrator moves to
    // the next project — the Stage 1.1 Q2 anomaly (hold-all-programs made
    // "warm" 2x slower than cold via GC pressure) is what this guards against.
    this.program = null;
    this.checker = null;
  }
}

export class RealTsProjectResolver implements TsProjectResolver {
  constructor(private readonly projectRoot: string) {}

  discoverProjects(): TsProjectDiscoveryResult {
    return discoverTsConfigProjects(this.projectRoot);
  }

  loadProgram(descriptor: TsProjectDescriptor): TsProjectHandle {
    return new RealTsProjectHandle(descriptor, this.projectRoot);
  }
}

/** `queried.name` may be qualified (`ClassName.methodName`, §9 mast_signature convention) — only the bare name is a real identifier token. */
function bareName(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1] ?? name;
}

// ---------------------------------------------------------------------------
// Orchestration — the CLI pass itself
// ---------------------------------------------------------------------------

export interface CheckerPassOptions {
  /** DI seam for tests — defaults to `RealTsProjectResolver`. */
  readonly resolver?: TsProjectResolver;
  readonly onProject?: (configDir: string, index: number, total: number) => void;
}

export interface CheckerProjectTiming {
  readonly configDir: string;
  readonly fileCount: number;
  readonly candidateCount: number;
  readonly durationMs: number;
}

export interface CheckerPassResult {
  readonly projectsChecked: number;
  readonly projectsSkipped: readonly TsProjectSkip[];
  readonly symbolsChecked: number;
  /** Potential-match candidates whose file has no owning tsconfig project — left untouched, not silently dropped. */
  readonly potentialSitesOutsideScope: number;
  /** Distinct edge rows this run stored, not classification attempts:
   *  several call sites in one caller, and a pair a heuristic rule already
   *  verified, collapse on the (from_id, to_id, edge_type) key. A run starts by
   *  removing the run before's, so a rerun over an unchanged tree reports the
   *  same number. Zero when `indexChangedDuringPass`. */
  readonly edgesUpgraded: number;
  readonly classifiedDifferentDeclaration: number;
  readonly classifiedNonCallSite: number;
  readonly unresolved: number;
  readonly perProjectTiming: readonly CheckerProjectTiming[];
  /**
   * Self-sampled peak RSS across the whole pass (`process.memoryUsage().rss`,
   * polled every 250ms). This is an approximation, not the Stage 1.1 spike's
   * external `ps`-on-a-child-process measurement — production runs in-process
   * (the same one-shot-process reasoning `index-cmd.ts` uses throughout),
   * and an in-process sampler can miss a spike inside a long synchronous
   * stretch that never yields the event loop. Reported honestly as an
   * approximation, not hidden.
   */
  readonly peakRssBytes: number;
  readonly durationMs: number;
  /**
   * True when a file's row changed between the start of the pass and one of
   * its writes. The pass then stores nothing and removes what it had stored:
   * the programs it classified against were of a tree that no longer exists.
   */
  readonly indexChangedDuringPass: boolean;
}

/**
 * Every indexed file's row id and stamp, as one string. Any write of a file
 * gives it a new stamp, and a deleted or added file changes the ids.
 */
async function indexedTreeStamp(db: Db): Promise<string> {
  const rows = await db.selectFrom('files').select(['id', 'mtime']).orderBy('id').execute();
  return rows.map((r) => `${r.id}:${r.mtime}`).join(',');
}

interface Candidate {
  readonly symbolId: number;
  readonly symbolName: string;
  readonly queriedFilePath: string;
  readonly queriedLine: number;
  readonly candidateFilePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly chunkSymbolName: string | null;
}

/**
 * Whether the candidate chunk is the innermost declaration around `callLine`.
 *
 * A class has a chunk spanning its whole body and each method has its own, so
 * a call in a method is on the lines of two candidates. The caller is the
 * method; the class's candidate must not write a second edge (D154).
 */
function isInnermostDeclaration(
  candidate: Pick<Candidate, 'startLine' | 'endLine' | 'chunkSymbolName'>,
  callLine: number,
  declarationsInFile: readonly CandidateChunkRecord[],
): boolean {
  return !declarationsInFile.some(
    (other) =>
      other.symbol_name !== candidate.chunkSymbolName &&
      other.start_line <= callLine &&
      callLine <= other.end_line &&
      other.start_line >= candidate.startLine &&
      other.end_line <= candidate.endLine &&
      (other.end_line - other.start_line < candidate.endLine - candidate.startLine ||
        // A class written on one line has the same lines as its method.
        (candidate.chunkSymbolName !== null && other.symbol_name?.startsWith(`${candidate.chunkSymbolName}.`) === true)),
  );
}

type PendingWrite =
  | { readonly kind: 'verdict'; readonly queriedSymbolId: number; readonly fileId: number; readonly line: number; readonly verdict: string; readonly mtime: number }
  | { readonly kind: 'edge'; readonly fromId: number; readonly toId: number; readonly callLine: number; readonly context: string };

/**
 * Run the checker pass over every tsconfig project in `config.resolved_project_root`.
 *
 * Two phases per project, kept strictly separate so the DB write lock is held
 * in short batches (§7.6) rather than across the compiler-heavy classify loop:
 * 1. Classify every candidate for the project against its `ts.Program` (no lock).
 * 2. Flush the resulting edge/verdict writes under `structure.lock` (short batch).
 */
/** One `files` row's identity and freshness stamp, keyed by path. */
export interface FileMeta {
  readonly id: number;
  readonly mtime: number;
}

/**
 * Look up `files` rows for `paths` in one pass, batched under SQLite's bound
 * parameter ceiling.
 *
 * Extracted from the checker pass so the batching is testable without standing
 * up a TypeScript program: the path list is every distinct candidate file in
 * one tsconfig project, accumulated across every symbol the pass examines, so
 * nothing in its construction bounds it below SQLite's bound-parameter ceiling
 * (`SQLITE_MAX_VARIABLES`, `./sqliteBatch.ts`). A single `IN` list past that
 * ceiling throws `too many SQL variables` and fails
 * the whole project's checker pass.
 *
 * Paths with no row are simply absent from the returned map — the caller
 * already treats that as "file row vanished mid-run" and skips the candidate.
 */
export async function loadFileMetaByPath(
  db: Db,
  paths: readonly string[],
): Promise<Map<string, FileMeta>> {
  const meta = new Map<string, FileMeta>();
  for (const batch of chunkValuesForSqlite(paths)) {
    const rows = await db
      .selectFrom('files')
      .select(['id', 'path', 'mtime'])
      .where('path', 'in', [...batch])
      .execute();
    for (const r of rows) meta.set(r.path, { id: r.id, mtime: r.mtime });
  }
  return meta;
}

export async function runCheckerPass(
  db: Db,
  chunkStore: Pick<ChunkStore, 'getAllChunks'>,
  config: ResolvedConfig,
  options: CheckerPassOptions = {},
): Promise<CheckerPassResult> {
  const startMs = Date.now();
  const resolver = options.resolver ?? new RealTsProjectResolver(config.resolved_project_root);

  let peakRssBytes = process.memoryUsage().rss;
  const rssTimer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
  }, 250);

  try {
    const { projects, skipped } = resolver.discoverProjects();
    const lockOptions = { maxRetries: 5, retryIntervalMs: 1_000, caller: 'checker-resolver' };

    // The results are a snapshot of one tree, so a run starts from none: what
    // an earlier run stored is computed again or is gone. Without this an edge
    // the pass no longer finds stays for as long as no file is written.
    const treeAtStart = await withLock(config.resolved_state_dir, 'structure', lockOptions, async () => {
      await removeCheckerResults(db);
      return indexedTreeStamp(db);
    });
    let indexChangedDuringPass = false;

    // --- Phase A: gather candidates (pure DB/FTS reads, no compiler) ---
    const allSymbols = await db
      .selectFrom('symbols as s')
      .innerJoin('files as f', 'f.id', 's.file_id')
      .select(['s.id', 's.name', 'f.path as file_path', 's.line'])
      .where('s.kind', '!=', 'export')
      .execute();

    // A file named by two projects is given to the deeper. `ownedFiles` is what
    // each project's program is then built from: a root tsconfig that names
    // every package's files again is given the few no package names, and a
    // program of all of them is what ran the pass out of memory on n8n (D153).
    // A file a project names without owning is still loaded when an owned file
    // imports it.
    const fileToProject = new Map<string, TsProjectDescriptor>();
    const ownedFiles = new Map<string, string[]>();
    // Deepest first: discovery sorts by path, which puts a root `tsconfig.json`
    // ahead of `web/` and behind `packages/`, and the root must not own a
    // package's files in either case.
    const depth = (project: TsProjectDescriptor): number =>
      project.configDir === '.' || project.configDir === '' ? 0 : project.configDir.split('/').length;
    for (const project of [...projects].sort((a, b) => depth(b) - depth(a))) {
      const owned: string[] = [];
      for (const absFile of project.fileNames) {
        const rel = relPath(absFile, config.resolved_project_root);
        if (fileToProject.has(rel)) continue;
        fileToProject.set(rel, project);
        owned.push(absFile);
      }
      ownedFiles.set(project.configDir, owned);
    }

    const byProject = new Map<string, Candidate[]>();
    let potentialSitesOutsideScope = 0;

    // One full chunk scan up front, then Map lookups. Candidate collection
    // runs once per indexed symbol below; fetching chunks one-by-one instead
    // was measured at 50+ CPU-minutes on this monorepo (10,733 symbols)
    // without completing Phase A. Semantics are identical —
    // `collectPotentialMatchCandidates` only needs "chunks by id".
    const allChunks = await chunkStore.getAllChunks();
    const chunkById = new Map<string, CandidateChunkRecord>(allChunks.map((c) => [c.chunk_id, c]));
    const declarationsByFile = new Map<string, CandidateChunkRecord[]>();
    for (const chunk of allChunks) {
      if (chunk.symbol_name === null) continue;
      const inFile = declarationsByFile.get(chunk.file_path) ?? [];
      inFile.push(chunk);
      declarationsByFile.set(chunk.file_path, inFile);
    }
    const chunkSource: ChunkByIdSource = {
      getChunksByIds: (ids) =>
        Promise.resolve(ids.flatMap((id) => {
          const chunk = chunkById.get(id);
          return chunk === undefined ? [] : [chunk];
        })),
    };

    for (const sym of allSymbols) {
      const verifiedRows = await queryVerifiedCallers(db, [sym.id], false);
      const verified: VerifiedCaller[] = verifiedRows.map((r) => ({
        file_path: r.file_path,
        line: r.line,
        caller_symbol: r.caller_symbol,
        context: r.context,
        resolution: r.resolution as CallerResolution,
      }));
      // F10 (Stage 3): collectPotentialMatchCandidates now also returns an
      // optional truncatedMatchCount — Phase A has no use for it (it isn't a
      // tool-response summary), so it's destructured away and ignored here.
      const { candidates } = await collectPotentialMatchCandidates(db, chunkSource, sym.name, verified);
      for (const c of candidates) {
        const project = fileToProject.get(c.file_path);
        if (project === undefined) {
          potentialSitesOutsideScope++;
          continue;
        }
        const bucket = byProject.get(project.configDir) ?? [];
        bucket.push({
          symbolId: sym.id,
          symbolName: sym.name,
          queriedFilePath: sym.file_path,
          queriedLine: sym.line,
          candidateFilePath: c.file_path,
          startLine: c.start_line,
          endLine: c.end_line,
          chunkSymbolName: c.chunk_symbol_name,
        });
        byProject.set(project.configDir, bucket);
      }
    }

    // --- Phase B: classify project by project, ONE ts.Program at a time ---
    let edgesUpgraded = 0;
    let classifiedDifferentDeclaration = 0;
    let classifiedNonCallSite = 0;
    let unresolved = 0;
    const perProjectTiming: CheckerProjectTiming[] = [];

    for (let i = 0; i < projects.length; i++) {
      const project = projects[i]!;
      options.onProject?.(project.configDir, i + 1, projects.length);
      const bucket = byProject.get(project.configDir);
      if (bucket === undefined || bucket.length === 0) continue; // nothing to check — don't pay program cost

      const t0 = Date.now();
      const handle = resolver.loadProgram({ ...project, fileNames: ownedFiles.get(project.configDir) ?? project.fileNames });
      const pending: PendingWrite[] = [];
      try {
        // File id/mtime cache — one query for the whole project's bucket
        // instead of one per candidate.
        const filePaths = [...new Set(bucket.map((c) => c.candidateFilePath))];
        const fileMeta = await loadFileMetaByPath(db, filePaths);

        for (const c of bucket) {
          const meta = fileMeta.get(c.candidateFilePath);
          if (meta === undefined) continue; // file row vanished mid-run — defensive

          const result = handle.classify({
            relFilePath: c.candidateFilePath,
            bareName: bareName(c.symbolName),
            startLine: c.startLine,
            endLine: c.endLine,
            queriedFilePath: c.queriedFilePath,
            queriedLine: c.queriedLine,
          });

          if (result.kind === 'unresolved') {
            unresolved++;
            continue;
          }

          // Every non-'unresolved' outcome gets a verdict row keyed by the
          // candidate's OWN chunk identity (not the checker's more-precise
          // call line) — this must match collectPotentialMatchCandidates'
          // dedup key exactly, see _helpers.ts.
          pending.push({
            kind: 'verdict',
            queriedSymbolId: c.symbolId,
            fileId: meta.id,
            line: c.startLine,
            verdict: result.kind,
            mtime: meta.mtime,
          });

          if (result.kind === 'non_call_site') {
            classifiedNonCallSite++;
            continue;
          }
          if (result.kind === 'resolves_to_different') {
            classifiedDifferentDeclaration++;
            continue;
          }

          // result.kind === 'resolves_to_queried' — write the caller edge too,
          // but only when the call site sits inside a chunk with a real
          // enclosing symbol. Top-level block code has none (chunk_symbol_name
          // is null) — a narrow, documented gap: still classified (so it never
          // re-surfaces as a review site), just not upgraded to a graph edge,
          // because there is no valid `from_id` to write one against.
          if (c.chunkSymbolName === null) continue;
          if (!isInnermostDeclaration(c, result.callLine, declarationsByFile.get(c.candidateFilePath) ?? [])) continue;
          const [fromSymbol] = await querySymbolByName(db, c.chunkSymbolName, c.candidateFilePath);
          if (fromSymbol === undefined) continue;

          // A call that resolves to a class is `new X()`, and the resolver's
          // rule for it stores the caller on the constructor X declares
          // (§10.3.1 rule 9). Stored on the class, the two rules disagree and
          // one caller is listed under both (D155).
          const [constructorId] = await constructorIdsOf(db, c.symbolId);

          pending.push({ kind: 'edge', fromId: fromSymbol.id, toId: constructorId ?? c.symbolId, callLine: result.callLine, context: result.context });
        }
      } finally {
        handle.dispose();
      }

      // --- Flush this project's writes in one short lock-held batch (§7.6) ---
      if (pending.length > 0) {
        await withLock(config.resolved_state_dir, 'structure', lockOptions, async () => {
          // Classification holds no lock, so the watcher or a read-time refresh
          // can have written a file since the programs were built. Its write
          // removed everything stored so far; storing more would put back
          // results of the tree before it.
          if ((await indexedTreeStamp(db)) !== treeAtStart) {
            await removeCheckerResults(db);
            indexChangedDuringPass = true;
            return;
          }
          for (const w of pending) {
            if (w.kind === 'verdict') {
              await db
                .insertInto('checker_verdicts')
                .values({
                  queried_symbol_id: w.queriedSymbolId,
                  call_site_file_id: w.fileId,
                  call_site_line: w.line,
                  verdict: w.verdict,
                  call_site_mtime: w.mtime,
                })
                .onConflict((oc) =>
                  oc.columns(['queried_symbol_id', 'call_site_file_id', 'call_site_line']).doUpdateSet((eb) => ({
                    verdict: eb.ref('excluded.verdict'),
                    call_site_mtime: eb.ref('excluded.call_site_mtime'),
                  })),
                )
                .execute();
            } else {
              const [insert] = await db
                .insertInto('edges')
                .values({
                  from_id: w.fromId,
                  to_id: w.toId,
                  edge_type: 'POTENTIAL_CALL',
                  resolution: 'checker',
                  call_line: w.callLine,
                  context: w.context,
                })
                .onConflict((oc) => oc.doNothing())
                .execute();
              // Rows that landed, not attempts: ON CONFLICT collapses several
              // call sites in one caller and a pair a heuristic rule already
              // verified (3,935 attempts to 1,885 rows on the first monorepo run).
              edgesUpgraded += Number(insert?.numInsertedOrUpdatedRows ?? 0n);
            }
          }
        });
      }

      perProjectTiming.push({
        configDir: project.configDir,
        fileCount: project.fileNames.length,
        candidateCount: bucket.length,
        durationMs: Date.now() - t0,
      });
      if (indexChangedDuringPass) break;
    }

    return {
      projectsChecked: perProjectTiming.length,
      projectsSkipped: skipped,
      symbolsChecked: allSymbols.length,
      potentialSitesOutsideScope,
      edgesUpgraded: indexChangedDuringPass ? 0 : edgesUpgraded,
      classifiedDifferentDeclaration,
      classifiedNonCallSite,
      unresolved,
      perProjectTiming,
      peakRssBytes,
      durationMs: Date.now() - startMs,
      indexChangedDuringPass,
    };
  } finally {
    clearInterval(rssTimer);
  }
}
