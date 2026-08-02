#!/bin/sh
# Code search. Usage: search.sh --query "<text>" [--limit 10]
MAST_AB_ARM="$(cat /Users/spikedpunchvictim/.cache/mast-eval/ab-runs/T07-A1/arm)" \
MAST_AB_LOG=/Users/spikedpunchvictim/.cache/mast-eval/ab-runs/search-log.jsonl \
MAST_AB_RUN=T07-A1 \
MAST_AB_TASK=T07 \
MAST_AB_STATE=/Users/spikedpunchvictim/.cache/mast-eval/ab-state \
node /Users/spikedpunchvictim/projects/kluster/packages/mast/eval/ab-search.mjs "$@" --exclude-file packages/workbench/foldv2/.archived/FABLE_UPGRADES.md
