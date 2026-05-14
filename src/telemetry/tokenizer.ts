import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer';

// ---------------------------------------------------------------------------
// Token counting (Anthropic CL100k tokenizer)
// ---------------------------------------------------------------------------

/**
 * Count tokens in `text` using the Anthropic CL100k tokenizer.
 *
 * Used for `ToolStats.tokens_returned` and `tokens_full_file_upper_bound`.
 * The tokenizer loads its vocab table on first call and caches it in memory;
 * subsequent calls are fast (microseconds).
 */
export function countTokens(text: string): number {
  return anthropicCountTokens(text);
}

/**
 * Estimate the full-file token upper bound for a set of file paths.
 *
 * Reads each file's content (from `chunks.lance`) and sums token counts.
 * This is the "what would it have cost to read the whole file?" baseline
 * used to compute `efficiency_ratio`.
 *
 * Stage 6 implementation — returns 0 until lance reads are wired up.
 */
export function estimateFullFileBound(_filePaths: readonly string[]): number {
  // Stage 6 implementation.
  return 0;
}
