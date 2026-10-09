#!/bin/zsh
# Spike s7 for checker-widening: what reading decorators costs a full index.
#
#   zsh run.sh <corpus root> <dist of the build before> <dist of the build after> <work dir> <rounds>
#
# Indexes the corpus from nothing with each build in turn, `rounds` times, so both builds
# meet the same load. One line per run on stdout: build, wall seconds, maximum resident
# bytes, the load average when the run began, and mast's own summary line.
corpus=$1; before=$2; after=$3; work=$4; rounds=$5
for round in $(seq 1 $rounds); do
  for build in before after; do
    dist=${(P)build}
    state=$work/state-$build-$round
    rm -rf $state
    load=$(uptime | sed 's/.*load averages: //' | cut -d' ' -f1)
    ( cd $corpus && MAST_STATE_DIR=$state /usr/bin/time -l node $dist/cli/index.js index > $work/out-$build-$round.txt 2> $work/err-$build-$round.txt )
    real=$(grep -E ' real ' $work/err-$build-$round.txt | awk '{print $1}')
    rss=$(grep 'maximum resident set size' $work/err-$build-$round.txt | awk '{print $1}')
    edges=$(sqlite3 $state/graph.db "select count(*) from edges where edge_type='POTENTIAL_CALL'" 2>/dev/null)
    echo "$build round=$round wall_s=$real max_rss_bytes=$rss load_at_start=$load call_edges=$edges | $(tail -1 $work/out-$build-$round.txt)"
    rm -rf $state
  done
done
