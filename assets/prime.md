# Using mast

mast indexes this repository's TypeScript, JavaScript and Markdown at the AST level.

- To find code (a symbol, its callers, a module's exports), call mast before grep, glob or
  reading whole files. It returns ranked declarations, not line matches.
- Put code tokens in the query: function, type and column names. An exact symbol name
  anchors its declaration to the top. If a query returns nothing, change the vocabulary.
- `mast_search`: discover code by name or token.
- `mast_signature`: a symbol's declaration and resolved parameter types.
- `mast_callers`: who calls a function. Run it before any refactor.
- `mast_exports`: a module's public API, without reading the file.
- `mast_rename_impact`: the checklist for a rename.
- Use grep for other languages, non-code files, or an exact regex over text.
- An empty result is not proof of absence. Check `index_empty`, `unindexed_files` and
  `stale` on the response before concluding something does not exist.
- Call `mast_reindex` after creating or renaming files. A new file is invisible to every
  read tool until an index pass runs.
