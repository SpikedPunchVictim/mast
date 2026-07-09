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
 * `*`  — matches any sequence not containing `/`
 * `**` — matches any sequence including `/`
 * `?`  — matches a single non-`/` character
 *
 * Lives in the walker (file-discovery domain) because both watch mode and the
 * MCP tools' `file_pattern` filters need the same glob semantics.
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const rx = escaped
    .replace(/\*\*\//g, '(.+/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${rx}$`);
}

/**
 * Walk the project and return all indexable files.
 *
 * Applies `file_extensions` allowlist and `exclude_patterns` denylist from
 * config. Results are in an arbitrary order — callers must not depend on
 * ordering for correctness.
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
