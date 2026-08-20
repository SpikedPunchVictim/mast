# Using MAST

You have MAST tools for navigating this codebase. MAST parses **TypeScript, JavaScript,
and Markdown** into an AST-level index and answers structural questions from a symbol
graph, so prefer it over reading files or grepping.

## Rules

- Call `mast_status` at the start of a session to confirm the index is fresh.
- **Search before opening any file.** No file path without a MAST result behind it.
- **Use code tokens in queries** — function names, type names, column names.
  `createTable uuid primaryKey` beats `migration pattern`. An exact symbol name in the
  query anchors its declaration to the top.
- When a query returns nothing, **change vocabulary — do not repeat it**.
- Call `mast_reindex` after writing files, to keep the index current.

## Picking the right tool

| tool | use it for |
|---|---|
| `mast_search` | lexical BM25 + declaration-exact discovery |
| `mast_signature` | a symbol's declaration and resolved parameter types |
| `mast_callers` | who calls a function — run before any refactor |
| `mast_implementors` | which classes implement an interface |
| `mast_exports` | a module's public API, without reading the file |
| `mast_dependencies` | what a file imports, and what it re-exports |
| `mast_project_skeleton` | a directory map of all exported symbols |
| `mast_rename_impact` | rename checklist: verified callers, review sites, barrel exports |
| `mast_efficiency` | token accounting for the session |
| `mast_status` | index freshness and health |
| `mast_reindex` | refresh the index after edits |

## Reading the answers honestly

MAST reports what it does not know, and those signals are load-bearing:

- A result carrying **`file_busy_returning_stale_cache`** or a staleness flag means the
  answer may predate the file on disk. Do not treat it as current.
- A **`truncated`** or **`potential_truncated`** flag means the set was capped. The real
  count is larger than what you were shown.
- An **empty result is not proof of absence.** MAST indexes TypeScript, JavaScript, and
  Markdown only — a symbol defined in Python, Go, Java, or any other language is absent
  from the index, not absent from the repository. Check the flags before concluding
  "it isn't there", and never delete or rewrite code on the strength of an empty result
  alone.
