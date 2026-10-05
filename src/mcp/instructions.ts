/**
 * The MCP `instructions` string sent in the `initialize` result (ADR 017 §6).
 * One paragraph: a client may place it in the model's context verbatim, so every
 * sentence has to earn its tokens.
 */
export const SERVER_INSTRUCTIONS =
  'mast is an AST-level index of this repository\'s TypeScript, JavaScript and Markdown. ' +
  'To find code — a symbol, its callers, a module\'s exports — call mast_search (or mast_signature, mast_callers, mast_exports) before using grep, glob or reading whole files: it returns ranked declarations, not line matches. ' +
  'Use grep for other languages, non-code files, or an exact regex over text. ' +
  'An empty result is not proof of absence: check index_empty and unindexed_files on the response, and call mast_reindex after creating or renaming files.';
