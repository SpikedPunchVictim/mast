import { existsSync, statSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import fg from 'fast-glob';
import { loadConfig, createMatchPath, type MatchPath } from 'tsconfig-paths';

// Module/import path resolution (§13.7).
//
// Turns an import specifier into a project-relative path that matches an
// indexed `files.path` (extension included), or marks it external. Handles:
//   1. relative imports (`./x`, `../y`) — probed for the real file on disk;
//   2. tsconfig `paths` aliases (`@api/types`) — via tsconfig-paths, read from
//      the nearest tsconfig.json above the importing file that declares any;
//   3. pnpm workspace package names (`@kluster/shared`) — via the workspace map;
//   4. everything else — external (node_modules / built-ins).
// `realpathSync.native` collapses pnpm symlinks so resolved paths point at real
// files, and reports the on-disk casing (see safeRealpath).

const CANDIDATE_EXTS = ['.ts', '.tsx', '.js', '.jsx'] as const;

// NodeNext/ESM TypeScript writes the *output* extension in relative specifiers
// (`import { x } from './x.js'`) while the on-disk source is `./x.ts`. tsc resolves
// such a specifier against the TypeScript source first, and only falls back to the
// literal file — e.g. `./mod.js` looks up `mod.ts`, then `mod.tsx`, then `mod.js`.
// We mirror that source-first precedence here (declaration files are out of scope
// since MAST indexes implementation files, not `.d.ts`). See the TypeScript Modules
// Reference, "File extension substitution":
// https://www.typescriptlang.org/docs/handbook/modules/reference.html
const JS_TO_TS_EXTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
];

/**
 * A specifier that resolved only because the filesystem ignored its casing.
 *
 * The import is broken on a case-sensitive filesystem — a Linux CI box will
 * fail to compile it — so this is a defect in the indexed repository, not in
 * MAST. MAST resolves it to the on-disk path anyway (see `safeRealpath`) and
 * reports it rather than dropping the edge.
 */
export interface MiscasedImport {
  /** Project-relative path of the importing file. */
  readonly fromFile: string;
  /** The module specifier exactly as written. */
  readonly specifier: string;
  /** The target as it is actually spelled on disk. */
  readonly onDiskPath: string;
}

export interface MiscasedImportReport {
  /** Total observations. Not capped. */
  readonly count: number;
  /** The first `MISCASED_SAMPLE_LIMIT` observations, in first-seen order. */
  readonly samples: readonly MiscasedImport[];
}

/**
 * Samples are capped because a resolver outlives a single index run in the MCP
 * server (it is cached per project root for the process lifetime), and a repo
 * that mis-cases one import usually mis-cases many. The count stays exact; only
 * the retained detail is bounded.
 */
export const MISCASED_SAMPLE_LIMIT = 20;

export interface ResolvedImport {
  /** Project-relative path (with extension) of the resolved file, or null. */
  readonly resolvedPath: string | null;
  /** True for node_modules / built-in modules (no intra-repo target). */
  readonly isExternal: boolean;
}

export interface ImportResolver {
  resolve(moduleSpecifier: string, fromFileRel: string): ResolvedImport;
  /**
   * Mis-cased specifiers observed since the last drain, clearing them.
   *
   * Draining rather than reading keeps the accumulator bounded across the many
   * index runs one cached resolver serves, and makes each run's report describe
   * that run alone.
   */
  drainMiscased(): MiscasedImportReport;
}

// Built once per project root — reading tsconfig and globbing the workspace is
// not free, and the inputs are stable for the life of an index run / session.
const cache = new Map<string, ImportResolver>();

export function getImportResolver(projectRoot: string): ImportResolver {
  const key = resolve(projectRoot);
  let resolver = cache.get(key);
  if (resolver === undefined) {
    resolver = buildResolver(key);
    cache.set(key, resolver);
  }
  return resolver;
}

/** Test seam: forget cached resolvers (inputs may change between tests). */
export function clearImportResolverCache(): void {
  cache.clear();
}

/** The call being resolved, carried so a case discrepancy can name its source. */
interface ResolveContext {
  readonly specifier: string;
  readonly fromFileRel: string;
}

function buildResolver(projectRoot: string): ImportResolver {
  const matcherFor = buildTsconfigMatchers(projectRoot);
  const workspace = buildWorkspaceMap(projectRoot);

  // Relativise against the realpath of the root as well, so a symlinked root
  // (e.g. macOS /tmp → /private/tmp) cancels out and the result matches the
  // walker's `files.path`. realpathSync also collapses pnpm package symlinks.
  const realRoot = safeRealpath(projectRoot);

  let miscasedCount = 0;
  const miscasedSamples: MiscasedImport[] = [];

  const norm = (p: string): string => p.split('\\').join('/');

  /**
   * Project-relative path of `abs` as it is spelled on disk, noting the case
   * discrepancy when the specifier's own spelling differed by case alone.
   *
   * The comparison uses the raw `abs` rather than a second (case-preserving)
   * realpath call, so detection costs no extra syscall on the resolution path.
   * The price is that a mis-casing reached THROUGH a symlinked directory
   * differs by more than case and so goes unreported — it still resolves to the
   * right file, it just is not named in the report.
   */
  const toRel = (abs: string, ctx: ResolveContext): string => {
    const onDisk = norm(relative(realRoot, safeRealpath(abs)));
    // Relative to `projectRoot`, not `realRoot`: `abs` was built from
    // `projectRoot`, and on a symlinked root (macOS /tmp -> /private/tmp) the
    // two roots differ, which would make every path look like a mismatch.
    const asWritten = norm(relative(projectRoot, abs));
    if (asWritten !== onDisk && asWritten.toLowerCase() === onDisk.toLowerCase()) {
      miscasedCount++;
      if (miscasedSamples.length < MISCASED_SAMPLE_LIMIT) {
        miscasedSamples.push({
          fromFile: ctx.fromFileRel,
          specifier: ctx.specifier,
          onDiskPath: onDisk,
        });
      }
    }
    return onDisk;
  };

  /** Resolve a base path (possibly without extension) to a real indexed file. */
  const probe = (base: string, ctx: ResolveContext): string | null => {
    // D047: a specifier written with a trailing slash names a DIRECTORY and
    // nothing else — `require.resolve('./routes/')` throws MODULE_NOT_FOUND
    // when only `routes.ts` exists. `base` cannot carry that intent, because
    // `path.resolve`/`join` normalise the slash away before we are called, so
    // it is read off the specifier the caller preserved on `ctx`. Without this
    // the sibling probes below win over the directory the author explicitly
    // asked for: `Routes.ts` importing `./routes/` resolved to *itself* on a
    // case-insensitive filesystem, and `routes/index.ts` — which had a live
    // importer — was recorded with none.
    const directoryOnly = ctx.specifier.endsWith('/');

    if (!directoryOnly) {
      // NodeNext source-first precedence: when the specifier carries a compiled
      // JS extension (`./x.js`), prefer the TypeScript source (`x.ts`) that would
      // emit it, ahead of any literal `x.js` on disk (see JS_TO_TS_EXTS).
      for (const [jsExt, tsExts] of JS_TO_TS_EXTS) {
        if (base.endsWith(jsExt)) {
          const stem = base.slice(0, -jsExt.length);
          for (const tsExt of tsExts) {
            if (isFile(stem + tsExt)) return toRel(stem + tsExt, ctx);
          }
          break; // a base ends in at most one of these extensions
        }
      }
      if (isFile(base)) return toRel(base, ctx);
      for (const ext of CANDIDATE_EXTS) {
        if (isFile(base + ext)) return toRel(base + ext, ctx);
      }
    }

    for (const ext of CANDIDATE_EXTS) {
      const idx = join(base, `index${ext}`);
      if (isFile(idx)) return toRel(idx, ctx);
    }
    return null;
  };

  return {
    resolve(spec, fromFileRel) {
      const ctx: ResolveContext = { specifier: spec, fromFileRel };

      // 1. Relative / absolute imports.
      if (spec.startsWith('.')) {
        const fromDir = dirname(join(projectRoot, fromFileRel));
        return { resolvedPath: probe(resolve(fromDir, spec), ctx), isExternal: false };
      }
      if (spec.startsWith('/')) {
        return { resolvedPath: probe(spec, ctx), isExternal: false };
      }

      // 2. tsconfig path alias.
      const matchPath = matcherFor(dirname(join(projectRoot, fromFileRel)));
      if (matchPath !== null) {
        const aliasBase = matchPath(spec, undefined, undefined, [...CANDIDATE_EXTS]);
        if (aliasBase !== undefined) {
          const rel = probe(aliasBase, ctx);
          if (rel !== null) return { resolvedPath: rel, isExternal: false };
        }
      }

      // 3. pnpm workspace package.
      const ws = resolveWorkspace(spec, workspace, (base) => probe(base, ctx));
      if (ws !== null) return { resolvedPath: ws, isExternal: false };

      // 4. External.
      return { resolvedPath: null, isExternal: true };
    },

    drainMiscased() {
      const report: MiscasedImportReport = {
        count: miscasedCount,
        samples: [...miscasedSamples],
      };
      miscasedCount = 0;
      miscasedSamples.length = 0;
      return report;
    },
  };
}

/** Resolve `@scope/pkg` or `@scope/pkg/sub` against the workspace package map. */
function resolveWorkspace(
  spec: string,
  workspace: ReadonlyMap<string, string>,
  probe: (base: string) => string | null,
): string | null {
  for (const [name, dir] of workspace) {
    if (spec === name) {
      // Bare package import → its entry point.
      const main = packageMain(dir);
      const candidates = [
        main !== null ? join(dir, main) : null,
        join(dir, 'src', 'index'),
        join(dir, 'index'),
      ].filter((c): c is string => c !== null);
      for (const c of candidates) {
        const rel = probe(c);
        if (rel !== null) return rel;
      }
      return null;
    }
    if (spec.startsWith(`${name}/`)) {
      const sub = spec.slice(name.length + 1);
      return probe(join(dir, sub)) ?? probe(join(dir, 'src', sub));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// tsconfig paths
// ---------------------------------------------------------------------------

/**
 * The alias matcher for a file in a given directory: the one built from the
 * nearest `tsconfig.json` at or above that directory that declares `paths`.
 *
 * A monorepo's root `tsconfig.json` often holds only `references`, and each
 * package maps the same alias (`@/*`) to its own sources, so one matcher for
 * the whole project resolves none of them (D087).
 *
 * This is nearer to what the compiler does, not the same. The compiler asks
 * which tsconfig *includes* the file; this asks which is nearest. And a
 * tsconfig with no `paths` of its own is passed over for the next one up,
 * where the compiler would stop. That keeps a root alias working for a file
 * under a nested tsconfig that does not extend the root, which is what this
 * resolver did before it looked below the root at all. `extends` is followed
 * by tsconfig-paths. Only files named `tsconfig.json` are read.
 */
function buildTsconfigMatchers(projectRoot: string): (fromDir: string) => MatchPath | null {
  // Keyed by directory. Every directory walked through is filled in, so a
  // package's files cost one walk between them.
  const byDir = new Map<string, MatchPath | null>();

  const lookup = (dir: string): MatchPath | null => {
    const cached = byDir.get(dir);
    if (cached !== undefined) return cached;

    let matcher: MatchPath | null;
    const parent = dirname(dir);
    if (dir === projectRoot || parent === dir || !isInside(dir, projectRoot)) {
      // `loadConfig` itself walks upward from here, so a project root below
      // its tsconfig still finds it, as it always has.
      matcher = buildTsconfigMatcher(projectRoot);
    } else {
      matcher = nestedMatcher(dir) ?? lookup(parent);
    }
    byDir.set(dir, matcher);
    return matcher;
  };
  return lookup;
}

/**
 * The matcher for a `tsconfig.json` below the project root, or null when the
 * directory has none, it declares no `paths`, or it cannot be read.
 *
 * tsconfig-paths throws on a file that does not parse. Repositories keep such
 * files as test fixtures, and the throw would surface as a parse error on
 * every source file beneath one, removing them from the index. So it is
 * reported once (the caller caches the result per directory) and passed over.
 */
function nestedMatcher(dir: string): MatchPath | null {
  if (!existsSync(join(dir, 'tsconfig.json'))) return null;
  try {
    return buildTsconfigMatcher(dir);
  } catch (err) {
    process.stderr.write(
      `[mast] WARN: ignoring ${join(dir, 'tsconfig.json')} for path aliases: ${String(err)}\n`,
    );
    return null;
  }
}

function isInside(dir: string, root: string): boolean {
  const rel = relative(root, dir);
  return rel !== '' && !rel.startsWith('..');
}

function buildTsconfigMatcher(configDir: string): MatchPath | null {
  const config = loadConfig(configDir);
  if (config.resultType !== 'success') return null;
  if (Object.keys(config.paths).length === 0) return null;
  // Without a `baseUrl`, `paths` are the only aliases: tsconfig-paths would
  // otherwise add a match-all that maps any bare specifier into the tsconfig's
  // own directory.
  return createMatchPath(config.absoluteBaseUrl, config.paths, undefined, config.addMatchAll);
}

// ---------------------------------------------------------------------------
// pnpm workspace map (package name → absolute package dir)
// ---------------------------------------------------------------------------

function buildWorkspaceMap(projectRoot: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  if (workspaceRoot === null) return map;

  const globs = readWorkspaceGlobs(workspaceRoot);
  if (globs.length === 0) return map;

  const dirs = fg.sync(globs, {
    cwd: workspaceRoot,
    onlyDirectories: true,
    absolute: true,
    followSymbolicLinks: false,
  });

  for (const dir of dirs) {
    const name = packageName(dir);
    if (name !== null && !map.has(name)) map.set(name, dir);
  }
  return map;
}

/** Walk up from `start` to the nearest dir containing pnpm-workspace.yaml. */
function findWorkspaceRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Parse the `packages:` glob list from pnpm-workspace.yaml. The file is a flat
 * list of quoted/unquoted globs under a single `packages:` key, so a line scan
 * is sufficient and avoids a YAML dependency.
 */
function readWorkspaceGlobs(workspaceRoot: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf-8');
  } catch {
    return [];
  }
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of text.split('\n')) {
    if (/^packages:\s*$/.test(raw)) { inPackages = true; continue; }
    if (!inPackages) continue;
    const item = raw.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
    if (item?.[1] !== undefined) { globs.push(item[1].trim()); continue; }
    // A non-list, non-blank line at column 0 ends the packages block.
    if (raw.trim() !== '' && !/^\s/.test(raw)) break;
  }
  return globs;
}

// ---------------------------------------------------------------------------
// package.json helpers
// ---------------------------------------------------------------------------

function packageName(dir: string): string | null {
  const pkg = readPackageJson(dir);
  return typeof pkg?.name === 'string' ? pkg.name : null;
}

function packageMain(dir: string): string | null {
  const pkg = readPackageJson(dir);
  return typeof pkg?.main === 'string' ? pkg.main : null;
}

function readPackageJson(dir: string): { name?: unknown; main?: unknown } | null {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as { name?: unknown; main?: unknown };
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * realpath that falls back to the input when the path does not exist.
 *
 * `.native` is load-bearing, not an optimisation. The JS `realpathSync`
 * resolves symlinks but echoes back whatever casing it was handed, whereas the
 * platform `realpath(3)` reports the name as it is spelled on disk. That
 * matters because `statSync` succeeds for a mis-cased path on a
 * case-insensitive filesystem (APFS, NTFS): `./utils/foo` finds `Utils/Foo.ts`
 * and nothing in the return value says the match was inexact. Echoing the
 * specifier's casing then puts a `resolved_path` in the database that disagrees
 * with the walker's `files.path` — fast-glob reports the on-disk name — and
 * every path-range join against `files.path` (`resolveInFileOrReExportChain`,
 * `insertReExportFiles`, `resolveTypeContext`) matches nothing and drops the
 * edge silently. Canonicalising here fixes all three at the source, and never
 * has to guess between two candidates the way a case-folded lookup would: on a
 * case-insensitive filesystem `Foo.ts` and `foo.ts` cannot coexist, and on a
 * case-sensitive one `statSync` already matched the literal name.
 */
function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}
