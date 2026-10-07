# MAST signal reference

The fields MAST puts on an answer to say what it does not know, and how it treats a file that
changed after it was indexed. `mast skill` carries the short rules; this is the detail behind them.

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
| `unindexed_files` | `mast_search`, `mast_callers`, `mast_implementors`, `mast_rename_impact`, `mast_project_skeleton` (always); `mast_signature`, `mast_exports`, `mast_dependencies` (on an empty answer only) | that many files on disk are not in the index, so this answer was computed over an incomplete corpus. **An empty result carrying this is not evidence of absence.** The set-returning tools report it even with hits — a short list of callers reads exactly like a complete one |
| `results_truncated` | `mast_signature`, `mast_implementors` | you got the first page, not the answer. The field carries the real total; raise `limit` or narrow the query |
| `exports_truncated` | `mast_exports` | the same, for a module's export list |
| `potential_truncated` | `mast_callers`, `mast_rename_impact` | the unresolved-candidate set was capped; the real count is larger |
| `truncated` | a type in `mast_signature`'s `type_context` | that declaration was clipped at 50 lines |

Two more things that are not flags:

- In `mast_callers` and `mast_rename_impact`, **`verified_callers` and
  `potential_matches` are not the same claim.** A verified caller carries a `resolution`
  and is safe to act on. A potential match carries a `reason` and is a name match with
  no proven edge — review it before editing it.
- An **empty result is not proof of absence.** MAST skips dot directories (`.github`,
  `.storybook`) unless the project's `include_dot_dirs` names them, and it indexes TypeScript, JavaScript, and
  Markdown only — a symbol defined in Python, Go, Java, or any other language is absent
  from the index, not absent from the repository. Check `index_empty` and
  `unindexed_files` before concluding "it isn't there", and **never delete or rewrite
  code on the strength of an empty result alone.** Every result-set tool carries
  `unindexed_files` now, not just `mast_search` — so an empty `mast_callers` answer that
  carries it is not a green light to delete the function.
