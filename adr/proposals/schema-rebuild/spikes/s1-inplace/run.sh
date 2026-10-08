#!/bin/zsh
# Runs the small cases of the spike. usage: run.sh <empty work dir> [<checkout of an older mast, built>]
# `pnpm build` first. Nothing is written outside the work dir.
HERE=${0:A:h}; REPO=$(git -C $HERE rev-parse --show-toplevel); W=${1:?work dir}; OLD=$2
FIX=$REPO/eval-suite/fixtures/resolver-shapes
echo "mast $(git -C $REPO rev-parse --short HEAD), tree dirty: $([ -n "$(git -C $REPO status --porcelain --untracked-files=no)" ] && echo yes || echo no)"

echo "\n== two connections (Q1, Q2, Q5) =="
mkdir -p $W/two-state
(cd $FIX && MAST_STATE_DIR=$W/two-state node $REPO/dist/cli/index.js index >/dev/null 2>&1)
node $HERE/two-connections.mjs $W/two-state/graph.db

echo "\n== a running mast serve of this version (Q3, Q4) =="
for arm in remove clear; do
  cp -R $FIX $W/proj-$arm; mkdir -p $W/serve-state-$arm
  node $HERE/serve.mjs $REPO $W/proj-$arm $W/serve-state-$arm $arm
done

if [ -n "$OLD" ]; then
  echo "\n== a running mast serve of schema $(grep -o "CURRENT_SCHEMA_VERSION = '[^']*'" $OLD/src/store/config.ts), commit $(git -C $OLD rev-parse --short HEAD) (Q7) =="
  for arm in remove clear; do
    cp -R $FIX $W/mixproj-$arm; mkdir -p $W/mix-state-$arm
    node $HERE/mixed.mjs $REPO $OLD $W/mixproj-$arm $W/mix-state-$arm $arm | cut -c1-330
  done
fi
