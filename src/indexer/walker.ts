import fg from 'fast-glob';
import { statSync } from 'node:fs';
import type { MastConfig } from '../ast/types.js';

export interface FileEntry {
  /** Absolute path to the file. */
  readonly path: string;
  /** Relative path from project root (used as the stored `file_path`). */
  readonly relativePath: string;
  /** File mtime in unix seconds. */
  readonly mtime: number;
}

/**
 * Convert a glob pattern to a RegExp.
 * `**\/` — matches zero or more leading directories
 * `**`   — matches any sequence including `/`
 * `*`    — matches any sequence not containing `/`
 * `?`    — matches a single non-`/` character
 *
 * Lives in the walker (file-discovery domain) because both watch mode and the
 * MCP tools' `file_pattern` filters need the same glob semantics — and because
 * `walkProject` below hands the same patterns to fast-glob, so this function's
 * output has to agree with fast-glob's for the same pattern. It is checked
 * against fast-glob directly by `__tests__/glob-to-regex.test.ts`.
 *
 * Written as a single left-to-right scan rather than a chain of `.replace`
 * calls. The chain was re-entrant: each rule rewrote the output of the ones
 * before it, so `**` → `.*` left a `*` for the `*` rule to turn into
 * `.[^/]*`, and `**\/` → `(.+/)?` left a `?` for the `?` rule to turn into
 * `(.+/)[^/]`. Every shipped default in `exclude_patterns` (`store/config.ts`)
 * contains one of those two sequences, so every one of them compiled to a
 * regex that matched neither the directory it named nor its contents.
 */
export function globToRegex(pattern: string): RegExp {
  let rx = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      // Optional, so `**\/x` matches a bare `x` at the root — fast-glob's
      // reading of the same pattern.
      rx += '(?:.+/)?';
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      rx += '.*';
      i += 2;
    } else if (pattern.startsWith('*', i)) {
      rx += '[^/]*';
      i += 1;
    } else if (pattern.startsWith('?', i)) {
      rx += '[^/]';
      i += 1;
    } else {
      rx += pattern.charAt(i).replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${rx}$`);
}

/**
 * Walk the project and return all indexable files.
 *
 * Applies `file_extensions` allowlist and `exclude_patterns` denylist from
 * config. Results are sorted lexicographically by `relativePath` (D1,
 * IMPLEMENTATION_PLAN.md Stage 4): fast-glob returns filesystem order, which
 * varies between identical runs — and because edge insertion order feeds the
 * bare-name fallback in `insertEdges`' name resolution, two identical index
 * runs produced edge sets differing by ±4/3,940 (§15.5). Sorting here makes
 * every downstream consumer (index order, manifest, edge insertion)
 * deterministic at the source. Callers still must not attach SEMANTIC meaning
 * to the order — the guarantee is reproducibility, not priority.
 */
export async function walkProject(config: MastConfig): Promise<FileEntry[]> {
  const patterns = config.file_extensions.map((ext) => `**/*${ext}`);

  const paths = await fg(patterns, {
    cwd: config.project_root,
    ignore: config.exclude_patterns as string[],
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  const entries: FileEntry[] = [];
  for (const absPath of paths) {
    try {
      const stat = statSync(absPath);
      const relativePath = absPath
        .slice(config.project_root.length)
        .replace(/^\//, '');
      entries.push({
        path: absPath,
        relativePath,
        mtime: stat.mtimeMs / 1_000,
      });
    } catch {
      // File disappeared between glob and stat — skip silently.
    }
  }

  // D1: localeCompare is locale-sensitive and would make "deterministic"
  // depend on the host locale — plain code-unit comparison does not.
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return entries;
}

/**
 * Build a `{ relativePath → mtime }` snapshot map from `walkProject` results.
 * Stored as `file_manifest.json` at the end of each index run.
 */
export function buildManifest(entries: readonly FileEntry[]): Record<string, number> {
  const manifest: Record<string, number> = {};
  for (const entry of entries) {
    manifest[entry.relativePath] = entry.mtime;
  }
  return manifest;
}

/**
 * Compare the current filesystem scan against the previous manifest.
 * Returns sets of paths for changed, new, and deleted files.
 */
export function diffManifest(
  current: readonly FileEntry[],
  previousManifest: Record<string, number>,
): {
  stale: FileEntry[];       // mtime changed
  added: FileEntry[];       // not in previous manifest
  deleted: string[];        // in previous manifest but not in current scan
} {
  const currentPaths = new Set(current.map((e) => e.relativePath));

  const stale: FileEntry[] = [];
  const added: FileEntry[] = [];

  for (const entry of current) {
    const prevMtime = previousManifest[entry.relativePath];
    if (prevMtime === undefined) {
      added.push(entry);
    } else if (entry.mtime > prevMtime) {
      stale.push(entry);
    }
  }

  const deleted = Object.keys(previousManifest).filter(
    (p) => !currentPaths.has(p),
  );

  return { stale, added, deleted };
}
