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
  you (see below); a **new** file is not, and is invisible until an index pass runs.

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

## How MAST handles a file that changed since it was indexed

Two mechanisms, and which one you get depends on the tool. Neither can see a file that
was never indexed at all.

- **Re-parsed for you, before the answer** — `mast_signature`, `mast_callers`,
  `mast_exports`, `mast_dependencies`, `mast_rename_impact`. If the re-parse loses a
  race with a writer, the result carries `file_busy_returning_stale_cache`.
- **Flagged, not re-parsed** — `mast_search`, `mast_implementors`. Affected results
  carry `stale: true`. The code and line numbers shown may be out of date; call one of
  the tools above, or `mast_reindex`, to get the current version.

Both only cover files already in the index. That is why creating a file needs an
explicit `mast_reindex`.

## Reading the answers honestly

MAST reports what it does not know. These signals are load-bearing. All but the last are
**omitted entirely when they do not apply** — so their absence is meaningful, and their
presence is never `false`. `truncated` is the exception: it is always present on a
`type_context` entry, so check its value rather than its presence.

| signal | on | means |
|---|---|---|
| `stale` | per result of `mast_search`, `mast_implementors` | this result's file changed since indexing; line numbers may be wrong |
| `file_busy_returning_stale_cache` | the five re-parsing tools | a refresh was attempted and lost to a writer; retry shortly |
| `index_empty` | the empty answer of any of the eight tools that return a result set | **nothing is indexed at all.** This is not "no match" — run `mast_reindex`, or check that `mast_status` names the tree you meant |
| `unindexed_files` | `mast_search` | that many files on disk are not in the index. Your results were ranked over an incomplete corpus |
| `results_truncated` | `mast_signature`, `mast_implementors` | you got the first page, not the answer. The field carries the real total; raise `limit` or narrow the query |
| `exports_truncated` | `mast_exports` | the same, for a module's export list |
| `potential_truncated` | `mast_callers`, `mast_rename_impact` | the unresolved-candidate set was capped; the real count is larger |
| `truncated` | a type in `mast_signature`'s `type_context` | that declaration was clipped at 50 lines |

Two more things that are not flags:

- In `mast_callers` and `mast_rename_impact`, **`verified_callers` and
  `potential_matches` are not the same claim.** A verified caller carries a `resolution`
  and is safe to act on. A potential match carries a `reason` and is a name match with
  no proven edge — review it before editing it.
- An **empty result is not proof of absence.** MAST indexes TypeScript, JavaScript, and
  Markdown only — a symbol defined in Python, Go, Java, or any other language is absent
  from the index, not absent from the repository. Check `index_empty` and
  `unindexed_files` before concluding "it isn't there", and **never delete or rewrite
  code on the strength of an empty result alone.**
