import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer';

// ---------------------------------------------------------------------------
// Token counting (@anthropic-ai/tokenizer — claude-2 era, approximate)
// ---------------------------------------------------------------------------

/**
 * The honest tokenizer label, reported verbatim by `mast_efficiency`
 * (`tokenizer` field) and the `mast metrics` footer.
 *
 * Single source of truth — every consumer reads this constant so the wording
 * cannot drift. `@anthropic-ai/tokenizer@0.0.4` implements the Claude 2-era
 * vocabulary and Anthropic never published Claude 3+ vocabularies, so absolute
 * counts drift for every model that consumes MAST output today. The savings
 * *ratio* mostly cancels the per-count error, which is why the mechanism stays
 * and only the labeling is corrected (§14.5). An exact mode via the API's
 * `count_tokens` endpoint is a documented future seam, not implemented here.
 */
export const TOKENIZER_LABEL =
  '@anthropic-ai/tokenizer (claude-2 era, approximate for current models)';

/**
 * Count tokens in `text` using `@anthropic-ai/tokenizer`.
 *
 * Used for `ToolStats.tokens_returned` and `tokens_full_file_upper_bound`.
 * Counts are approximate for current models — see {@link TOKENIZER_LABEL}.
 * The tokenizer loads its vocab table on first call and caches it in memory;
 * subsequent calls are fast (microseconds).
 */
export function countTokens(text: string): number {
  return anthropicCountTokens(text);
}

/**
 * Filesystem access needed by {@link estimateFullFileBound}, injected so
 * tests can observe cache-hit / cache-miss behaviour deterministically
 * (§4.4 — depend on an interface, not a `node:fs` module mock).
 */
export interface FullFileReader {
  /** Reads a file's full UTF-8 contents. Callers catch failures. */
  readonly readFile: (absolutePath: string) => string;
  /**
   * Returns the file's mtime in unix epoch seconds — matching the `files`
   * table convention (see `staleness.ts`). Callers catch failures.
   */
  readonly statMtime: (absolutePath: string) => number;
}

const defaultFullFileReader: FullFileReader = {
  readFile: (absolutePath) => readFileSync(absolutePath, 'utf8'),
  statMtime: (absolutePath) => statSync(absolutePath).mtimeMs / 1_000,
};

interface FullFileCacheEntry {
  readonly mtime: number;
  readonly tokens: number;
}

/**
 * Upper bound on the full-file token cache. Tokenizing whole files is the
 * expensive part of every read-tool call (§14.2), so repeated hits on the
 * same unchanged file must not re-tokenize — but an unbounded cache would
 * grow without limit across a long-running `mast serve` process. A few
 * hundred entries comfortably covers one working session's file set.
 */
export const FULL_FILE_BOUND_CACHE_LIMIT = 200;

// Module-level so the cache survives across tool calls within one `mast
// serve` process. Map iteration order is insertion order, so the first key
// is always the least-recently-used one — cheap LRU-ish eviction with no
// extra dependency (re-inserting a key on cache hit moves it to the tail).
const fullFileCache = new Map<string, FullFileCacheEntry>();

function cacheTouch(absolutePath: string, entry: FullFileCacheEntry): void {
  fullFileCache.delete(absolutePath);
  fullFileCache.set(absolutePath, entry);
  if (fullFileCache.size > FULL_FILE_BOUND_CACHE_LIMIT) {
    const oldestKey = fullFileCache.keys().next().value;
    if (oldestKey !== undefined) fullFileCache.delete(oldestKey);
  }
}

/**
 * Estimate the full-file token upper bound for a set of file paths (§14.2).
 *
 * For each unique path, reads the full file under `projectRoot` and sums
 * `countTokens` over its contents — the "what would a naive Read of every
 * result file have cost?" counterfactual used to compute `efficiency_ratio`.
 *
 * Missing or unreadable files contribute 0 and never throw: the metrics path
 * must never break a tool response over a stale or deleted file reference.
 * Repeated calls referencing the same file at the same mtime reuse the
 * cached token count instead of re-reading and re-tokenizing.
 */
export function estimateFullFileBound(
  filePaths: readonly string[],
  projectRoot: string,
  reader: FullFileReader = defaultFullFileReader,
): number {
  const uniquePaths = new Set(filePaths);
  let total = 0;

  for (const relPath of uniquePaths) {
    const absPath = join(projectRoot, relPath);

    let mtime: number;
    try {
      mtime = reader.statMtime(absPath);
    } catch {
      continue; // file missing/unreadable — contributes 0
    }

    const cached = fullFileCache.get(absPath);
    if (cached !== undefined && cached.mtime === mtime) {
      total += cached.tokens;
      // Refresh recency even on a hit so a hot file survives eviction.
      cacheTouch(absPath, cached);
      continue;
    }

    try {
      const content = reader.readFile(absPath);
      const tokens = countTokens(content);
      cacheTouch(absPath, { mtime, tokens });
      total += tokens;
    } catch {
      continue; // unreadable despite a successful stat — contributes 0
    }
  }

  return total;
}
