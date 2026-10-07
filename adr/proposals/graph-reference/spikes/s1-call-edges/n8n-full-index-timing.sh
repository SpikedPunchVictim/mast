#!/bin/sh
# old, new, old, new: full index of the n8n copy, wall time each
cd /Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/n8n-ref
for v in old new old new; do
  rm -rf /Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/timing/state-$v
  uptime
  /usr/bin/time -p node /Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/timing/$v/dist/cli/index.js index --state-dir /Users/spikedpunchvictim/.claude/jobs/ce306a60/tmp/timing/state-$v 2>&1 | grep -E "files:|^real|^user|^sys" | sed "s/^/$v /"
done
