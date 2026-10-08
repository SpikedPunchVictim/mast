#!/bin/zsh
# Q6: a full index of n8n into an empty state directory, then into the same
# database after the in-place clear, one after the other on one machine.
# usage: n8n-rebuild.sh <n8n checkout> <empty work dir>      (`pnpm build` first)
HERE=${0:A:h}; REPO=$(git -C $HERE rev-parse --show-toplevel); N=${1:?n8n checkout}; W=${2:?work dir}
S=$W/state; mkdir -p $S
counts() { sqlite3 $S/graph.db "select 'files ' || (select count(*) from files) || ', edge rows ' || (select count(*) from edges) || ', import rows ' || (select count(*) from imports) || ', chunks ' || (select count(*) from chunks) || ', pages ' || (select page_count from pragma_page_count) || ', free ' || (select freelist_count from pragma_freelist_count)" }
echo "mast $(git -C $REPO rev-parse --short HEAD), n8n $(git -C $N rev-parse --short HEAD)"
for arm in "empty directory" "after the clear" "after a second clear"; do
  if [ "$arm" != "empty directory" ]; then node $HERE/cost.mjs $S/graph.db; rm -f $S/file_manifest.json; fi
  echo "$arm: $(cd $N && MAST_STATE_DIR=$S node $REPO/dist/cli/index.js index 2>&1 | grep '^files:')"
  echo "  $(counts), bytes $(stat -f %z $S/graph.db)"
done
