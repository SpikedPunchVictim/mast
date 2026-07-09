import { existsSync, statSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import fg from 'fast-glob';
import { loadConfig, createMatchPath, type MatchPath } from 'tsconfig-paths';

// Module/import path resolution (§13.7).
//
// Turns an import specifier into a project-relative path that matches an
// indexed `files.path` (extension included), or marks it external. Handles:
//   1. relative imports (`./x`, `../y`) — probed for the real file on disk;
//   2. tsconfig `paths` aliases (`@api/types`) — via tsconfig-paths;
//   3. pnpm workspace package names (`@kluster/shared`) — via the workspace map;
//   4. everything else — external (node_modules / built-ins).
// `realpathSync` collapses pnpm symlinks so resolved paths point at real files.

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

export interface ResolvedImport {
  /** Project-relative path (with extension) of the resolved file, or null. */
  readonly resolvedPath: string | null;
  /** True for node_modules / built-in modules (no intra-repo target). */
  readonly isExternal: boolean;
}

export interface ImportResolver {
  resolve(moduleSpecifier: string, fromFileRel: string): ResolvedImport;
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

function buildResolver(projectRoot: string): ImportResolver {
  const matchPath = buildTsconfigMatcher(projectRoot);
  const workspace = buildWorkspaceMap(projectRoot);

  // Relativise against the realpath of the root as well, so a symlinked root
  // (e.g. macOS /tmp → /private/tmp) cancels out and the result matches the
  // walker's `files.path`. realpathSync also collapses pnpm package symlinks.
  const realRoot = safeRealpath(projectRoot);

  const toRel = (abs: string): string => {
    return relative(realRoot, safeRealpath(abs)).split('\\').join('/');
  };

  /** Resolve a base path (possibly without extension) to a real indexed file. */
  const probe = (base: string): string | null => {
    // NodeNext source-first precedence: when the specifier carries a compiled
    // JS extension (`./x.js`), prefer the TypeScript source (`x.ts`) that would
    // emit it, ahead of any literal `x.js` on disk (see JS_TO_TS_EXTS).
    for (const [jsExt, tsExts] of JS_TO_TS_EXTS) {
      if (base.endsWith(jsExt)) {
        const stem = base.slice(0, -jsExt.length);
        for (const tsExt of tsExts) {
          if (isFile(stem + tsExt)) return toRel(stem + tsExt);
        }
        break; // a base ends in at most one of these extensions
      }
    }
    if (isFile(base)) return toRel(base);
    for (const ext of CANDIDATE_EXTS) {
      if (isFile(base + ext)) return toRel(base + ext);
    }
    for (const ext of CANDIDATE_EXTS) {
      const idx = join(base, `index${ext}`);
      if (isFile(idx)) return toRel(idx);
    }
    return null;
  };

  return {
    resolve(spec, fromFileRel) {
      // 1. Relative / absolute imports.
      if (spec.startsWith('.')) {
        const fromDir = dirname(join(projectRoot, fromFileRel));
        return { resolvedPath: probe(resolve(fromDir, spec)), isExternal: false };
      }
      if (spec.startsWith('/')) {
        return { resolvedPath: probe(spec), isExternal: false };
      }

      // 2. tsconfig path alias.
      if (matchPath !== null) {
        const aliasBase = matchPath(spec, undefined, undefined, [...CANDIDATE_EXTS]);
        if (aliasBase !== undefined) {
          const rel = probe(aliasBase);
          if (rel !== null) return { resolvedPath: rel, isExternal: false };
        }
      }

      // 3. pnpm workspace package.
      const ws = resolveWorkspace(spec, workspace, probe);
      if (ws !== null) return { resolvedPath: ws, isExternal: false };

      // 4. External.
      return { resolvedPath: null, isExternal: true };
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

function buildTsconfigMatcher(projectRoot: string): MatchPath | null {
  const config = loadConfig(projectRoot);
  if (config.resultType !== 'success') return null;
  if (Object.keys(config.paths).length === 0) return null;
  return createMatchPath(config.absoluteBaseUrl, config.paths);
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

/** realpathSync that falls back to the input when the path does not exist. */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
