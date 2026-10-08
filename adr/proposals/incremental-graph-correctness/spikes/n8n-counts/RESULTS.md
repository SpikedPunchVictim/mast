# Whole-n8n counts, derived again

The spike results for D096, schema 1.4.0 and the inherited-call walk quote counts over a full
index of n8n. They were measured when written, but no output or script was committed with
them. `counts.sh` derives the ones that describe the current graph, and `counts.json` is its
output: mast `4922858` with a clean tree, n8n `9d9e9bf9` with a clean tree, 2026-10-08.

| Count | Quoted | Where | Derived here |
|---|---|---|---|
| Distinct edges of every type | 71,091 | `../d096-namespace-star/RESULTS.md`, `../schema-1.4.0/RESULTS.md`, `../s12-two-star-names/RESULTS.md`, `inherited-call-edges/spikes/RESULTS.md` | 71,091 |
| Rows in `re_export_files` | 926 | `../d096-namespace-star/RESULTS.md`, `../s12-two-star-names/RESULTS.md` | 926 |
| Import rows | 51,963 | `../schema-1.4.0/RESULTS.md`, `inherited-call-edges/spikes/RESULTS.md` | 51,963 |
| Import rows holding an alias, and their files | 560 in 448 | `../schema-1.4.0/RESULTS.md` | 560 in 448 |

Also in `counts.json` and quoted nowhere: 13,985 files, 391 rows in `reexport_aliases`, 0 in
`star_reexport_unresolved`.

Not derived again, because each needs a build of an earlier commit: the counts before a change
(1,063 star rows before D096; 70,022 edges and 51,617 import rows before the walk), and the 112
type contexts D114's ledger row counts on the build before its fix. Those stay as quoted, with
no committed source.

The current values agreeing says the changes since have not moved them. It does not check the
"0 gone, 0 new" beside 71,091, which compares two edge sets and not two counts.
