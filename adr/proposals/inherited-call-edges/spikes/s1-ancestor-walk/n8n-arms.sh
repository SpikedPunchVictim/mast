#!/bin/sh
# Three arms of the prototype on the n8n copy: walk off, walk on (structural edges first), walk on (one stage).
cd /Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/n8n-ref
BIN=/Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/proto/dist/cli/index.js
for arm in off walk single; do
  rm -rf /Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/s3/n8n-$arm /Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/s3/n8n-$arm.jsonl
  uptime
  case $arm in
    off) export MAST_SPIKE_WALK=off; unset MAST_SPIKE_ORDER MAST_SPIKE_LOG;;
    walk) unset MAST_SPIKE_WALK MAST_SPIKE_ORDER; export MAST_SPIKE_LOG=/Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/s3/n8n-walk.jsonl;;
    single) unset MAST_SPIKE_WALK; export MAST_SPIKE_ORDER=single MAST_SPIKE_LOG=/Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/s3/n8n-single.jsonl;;
  esac
  /usr/bin/time -p node $BIN index --state-dir /Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/s3/n8n-$arm 2>&1 | grep -E "files:|^real|^user|^sys" | sed "s/^/$arm /"
done
