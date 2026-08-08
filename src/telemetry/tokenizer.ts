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
 *
 * `mtimeSeconds` and `sizeBytes` are returned from one `stat` method, not two
 * — `fs.statSync` already yields both from a single syscall, and the budget
 * path (F8) needs the size for every cache miss, so splitting them into
 * `statMtime` + a hypothetical `statSize` would double the stat cost for no
 * benefit.
 */
export interface FullFileReader {
  /** Reads a file's full UTF-8 contents. Callers catch failures. */
  readonly readFile: (absolutePath: string) => string;
  /**
   * Returns the file's mtime (unix epoch seconds, matching the `files` table
   * convention — see `staleness.ts`) and size in bytes. Callers catch
   * failures.
   */
  readonly stat: (absolutePath: string) => { readonly mtimeSeconds: number; readonly sizeBytes: number };
}

const defaultFullFileReader: FullFileReader = {
  readFile: (absolutePath) => readFileSync(absolutePath, 'utf8'),
  stat: (absolutePath) => {
    const s = statSync(absolutePath);
    return { mtimeSeconds: s.mtimeMs / 1_000, sizeBytes: s.size };
  },
};

interface FullFileCacheEntry {
  readonly mtime: number;
  readonly tokens: number;
}

/**
 * Upper bound on the full-file token cache. Tokenizing whole files is the
 * expensive part of every read-tool call (§14.2), so repeated hits on the
 * same unchanged file must not re-tokenize — but an unbounded cache would
 * grow without limit across a long-running `mast serve` process.
 *
 * F8 (eval/GITNEXUS_COMPARISON.md §13.7): 200 was tuned for "one working
 * session's file set", before `mast_project_skeleton` — which references
 * EVERY project file — existed as a caller. Entries are a path string plus
 * two numbers, a few hundred bytes each, so 8192 entries is ~2-3 MB worst
 * case: comfortably covers the ~10k-file corpora at the 150k-chunk scale
 * target (plan Stage 4.5), so repeated calls against a monorepo-sized
 * project CONVERGE to all-exact counts (via the per-call tokenization
 * budget below) instead of thrashing forever.
 */
export const FULL_FILE_BOUND_CACHE_LIMIT = 8192;

/**
 * Maximum number of cache-miss paths {@link estimateFullFileBound} will
 * exactly read and tokenize in one call. Paths beyond this budget are
 * size-estimated instead (see {@link BYTES_PER_TOKEN_ESTIMATE}).
 *
 * F8: measured ~24ms/file to read+tokenize a full file, so 32 files is
 * ~0.8s worst-case telemetry overhead per call — versus the ~28s/call this
 * function cost when it tokenized all 1,334 files in a monorepo-sized
 * project on every `mast_project_skeleton` call. §14.1 sets telemetry's
 * "negligible overhead" goal; whatever the exact bound, instrumentation must
 * never cost more than the query it instruments, and this budget converts an
 * unbounded, thrashing cost into a bounded, converging one.
 */
export const FULL_FILE_TOKENIZE_BUDGET_PER_CALL = 32;

/**
 * Bytes-per-token heuristic used to estimate the token count of a cache-miss
 * path once {@link FULL_FILE_TOKENIZE_BUDGET_PER_CALL} is exhausted for a
 * call. This is the standard ~4-bytes/token rule of thumb for source text —
 * defensible here because `tokens_full_file_upper_bound` is already an
 * explicitly approximate, upper-bound methodology number (the tokenizer
 * itself is a claude-2-era vocabulary, §14.5 / {@link TOKENIZER_LABEL}), not
 * a billing figure.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 4;

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
 * Test-only seam: seeds the full-file cache via the real `cacheTouch` insert
 * + evict path, without paying for real tokenization.
 *
 * F8 raised {@link FULL_FILE_BOUND_CACHE_LIMIT} to 8192. Profiling showed
 * `countTokens` costs ~22ms/call *regardless of content length* (a fixed
 * per-invocation floor, not an I/O or content-size cost), so proving
 * eviction still fires once the raised bound is exceeded — by driving 8192+
 * real reads through {@link estimateFullFileBound} — would cost minutes and
 * dwarf the very call this change speeds up. Seeding through `cacheTouch`
 * exercises the exact same insert-and-evict-oldest branch production code
 * uses; only the (irrelevant, for this purpose) cost of real tokenization is
 * skipped. Not used by any non-test code.
 */
export function __seedFullFileCacheForTests(absolutePath: string, mtime: number, tokens: number): void {
  cacheTouch(absolutePath, { mtime, tokens });
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
 *
 * F8 — "cap the work, not the cache" (eval/GITNEXUS_COMPARISON.md §13.7):
 * a cache miss is only exactly tokenized while
 * {@link FULL_FILE_TOKENIZE_BUDGET_PER_CALL} allows it, in the caller's path
 * order (after dedup) so results are deterministic. Cache hits are free and
 * never consume budget. Once the budget is exhausted for a call, further
 * cache misses are size-estimated (`sizeBytes / BYTES_PER_TOKEN_ESTIMATE`)
 * rather than read — and NOT cached, since an estimate must never masquerade
 * as an exact cached count. Successive calls over the same path set
 * progressively convert estimates to exact, cached counts.
 */
export function estimateFullFileBound(
  filePaths: readonly string[],
  projectRoot: string,
  reader: FullFileReader = defaultFullFileReader,
): number {
  const uniquePaths = new Set(filePaths);
  let total = 0;
  let tokenizeBudgetRemaining = FULL_FILE_TOKENIZE_BUDGET_PER_CALL;

  for (const relPath of uniquePaths) {
    const absPath = join(projectRoot, relPath);

    let mtimeSeconds: number;
    let sizeBytes: number;
    try {
      ({ mtimeSeconds, sizeBytes } = reader.stat(absPath));
    } catch {
      continue; // file missing/unreadable — contributes 0, consumes no budget
    }

    const cached = fullFileCache.get(absPath);
    if (cached !== undefined && cached.mtime === mtimeSeconds) {
      total += cached.tokens;
      // Refresh recency even on a hit so a hot file survives eviction.
      cacheTouch(absPath, cached);
      continue;
    }

    if (tokenizeBudgetRemaining <= 0) {
      // Beyond the per-call budget: estimate from size instead of paying for
      // an exact read+tokenize. Deliberately not cached (see doc comment).
      total += Math.ceil(sizeBytes / BYTES_PER_TOKEN_ESTIMATE);
      continue;
    }

    // A failed read below still spends this slot rather than freeing it for
    // the next path — the simplest honest rule, and consistent with the
    // fact that the stat() that granted the slot already succeeded.
    tokenizeBudgetRemaining--;
    try {
      const content = reader.readFile(absPath);
      const tokens = countTokens(content);
      cacheTouch(absPath, { mtime: mtimeSeconds, tokens });
      total += tokens;
    } catch {
      continue; // unreadable despite a successful stat — contributes 0
    }
  }

  return total;
}
