#!/bin/zsh
# The whole-n8n counts the spike results quote, from one full index by the built CLI of this checkout.
# usage: counts.sh <n8n checkout> <empty state dir>     (`pnpm build` first; nothing is written to the checkout)
HERE=${0:A:h}; REPO=$(git -C $HERE rev-parse --show-toplevel)
N=${1:?n8n checkout}; S=${2:?state dir}
export MAST_STATE_DIR=$S
line=$(cd $N && node $REPO/dist/cli/index.js index 2>&1 | grep '^files:')
q() { sqlite3 $S/graph.db "$1" }
cat <<JSON
{
  "mast_commit": "$(git -C $REPO rev-parse --short HEAD)",
  "mast_tree_dirty": $([ -n "$(git -C $REPO status --porcelain --untracked-files=no)" ] && echo true || echo false),
  "n8n_commit": "$(git -C $N rev-parse --short HEAD)",
  "n8n_tree_dirty": $([ -n "$(git -C $N status --porcelain)" ] && echo true || echo false),
  "index_line": "$line",
  "files": $(q 'select count(*) from files'),
  "edge_rows": $(q 'select count(*) from edges'),
  "distinct_edges_of_every_type": $(q "select count(*) from (select distinct e.edge_type, ff.path, f.name, tf.path, t.name from edges e join symbols f on f.id=e.from_id join files ff on ff.id=f.file_id join symbols t on t.id=e.to_id join files tf on tf.id=t.file_id)"),
  "re_export_files_rows": $(q 'select count(*) from re_export_files'),
  "import_rows": $(q 'select count(*) from imports'),
  "import_rows_with_an_alias": $(q 'select count(*) from imports where aliases is not null'),
  "files_with_an_aliased_import": $(q 'select count(distinct file_id) from imports where aliases is not null'),
  "reexport_aliases_rows": $(q 'select count(*) from reexport_aliases'),
  "star_reexport_unresolved_rows": $(q 'select count(*) from star_reexport_unresolved')
}
JSON
