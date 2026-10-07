#!/bin/zsh
# Spike S11 — what recording an empty FTS block saves when markdown files are re-indexed (D082).
#
# Usage: time-md.sh <mast-dist-dir> <project-root>
#
# <project-root> must be a scratch copy: this appends a line to markdown files in
# it. Its index must have been written by a build from before the fix, so that
# markdown files still hold a NULL identifier block. The first re-write of such
# a file takes the old path (a scan of identifier_fts by path) and records the
# empty block; every later re-write takes the new path. So for one set of files
# the first run is "before" and the following runs are "after", on the same
# machine minutes apart.
M=$1/cli/index.js; D=$2; DB=$D/.mast/graph.db
node $M index --incremental $D >/dev/null 2>&1
echo "load: $(sysctl -n vm.loadavg)"
echo "markdown files: $(sqlite3 $DB "select count(*) from files where language='markdown'"), with a NULL identifier block: $(sqlite3 $DB "select count(*) from files where language='markdown' and ident_fts_lo is null")"
echo "identifier_fts rows: $(sqlite3 $DB 'select count(*) from identifier_fts'), chunk_fts rows: $(sqlite3 $DB 'select count(*) from chunk_fts')"
run() { # label, N, offset, rep
  sqlite3 $DB "select path from files where language='markdown' order by path limit $2 offset $3" > /tmp/s11-pick.$$
  nulls=$(sqlite3 $DB "select count(*) from (select ident_fts_lo l from files where language='markdown' order by path limit $2 offset $3) where l is null")
  while read -r p; do printf '\ns11 %s %s\n' $1 $4 >> "$D/$p"; done < /tmp/s11-pick.$$
  out=$(node $M index --incremental --phase-timing $D 2>&1 | tr '\n' ' ')
  echo "$1 N=$2 run=$4 null_blocks_before=$nulls | $(echo $out | sed -E 's/.*(files: [0-9]+ indexed).*duration: ([0-9]+ms).*"write":([0-9]+).*"fts_del":([0-9]+).*/\1 dur=\2 write=\3 fts_del=\4/')"
  rm -f /tmp/s11-pick.$$
}
for set in 0 1 2; do for rep in 1 2 3 4; do run twenty 20 $((set*20)) $rep; done; done
for set in 0 1 2 3 4; do for rep in 1 2 3; do run one 1 $((100+set)) $rep; done; done
echo "load: $(sysctl -n vm.loadavg)"
echo "markdown files with a NULL identifier block now: $(sqlite3 $DB "select count(*) from files where language='markdown' and ident_fts_lo is null")"
