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
