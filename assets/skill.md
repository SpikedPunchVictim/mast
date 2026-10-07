# Using MAST

You have MAST tools for navigating this codebase. MAST parses **TypeScript, JavaScript,
and Markdown** into an AST-level index and answers structural questions from a symbol
graph, so prefer it over reading files or grepping.

## Rules

- Call `mast_status` at the start of a session to confirm the index is fresh. Read
  **`stale_breakdown.unindexed`**: any non-zero value means files exist that MAST has never
  seen, and no amount of querying will find them. Read that field rather than
  `freshness_cause`, which reports a single ranked cause and shows `"phase1_stale"` ahead of
  `"unindexed_files"` whenever both are non-zero.
- **Search before opening any file.** No file path without a MAST result behind it.
- **Use code tokens in queries** — function names, type names, column names.
  `createTable uuid primaryKey` beats `migration pattern`. An exact symbol name in the
  query anchors its declaration to the top.
- When a query returns nothing, **change vocabulary — do not repeat it**.
- **Call `mast_reindex` after creating or renaming files**, before any query that depends
  on what you just wrote. Editing the *body* of a file MAST already knows is handled for
  you; a **new** file is not, and is invisible until an index pass runs.

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

An empty result is not proof of absence. MAST indexes TypeScript, JavaScript, and Markdown
only, so a symbol in any other language is absent from the index, not from the repository.
The same holds for a dot directory (`.github`, `.storybook`) the project has not listed in
`include_dot_dirs`.
Check `index_empty` and `unindexed_files` on the response before concluding "it isn't
there", and never delete or rewrite code on an empty result alone. `mast docs signals`
prints the full signal reference.
