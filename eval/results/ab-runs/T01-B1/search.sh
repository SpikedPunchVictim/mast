#!/bin/sh
# Code search. Usage: search.sh --query "<text>" [--limit 10]
MAST_AB_ARM="$(cat /Users/spikedpunchvictim/.cache/mast-eval/ab-runs/T01-B1/arm)" \
MAST_AB_LOG=/Users/spikedpunchvictim/.cache/mast-eval/ab-runs/search-log.jsonl \
MAST_AB_RUN=T01-B1 \
MAST_AB_TASK=T01 \
MAST_AB_STATE=/Users/spikedpunchvictim/.cache/mast-eval/ab-state \
node /Users/spikedpunchvictim/projects/kluster/packages/mast/eval/ab-search.mjs "$@" --exclude-file packages/workbench/fold/ledger/IMPLEMENTATION_PLAN.md
