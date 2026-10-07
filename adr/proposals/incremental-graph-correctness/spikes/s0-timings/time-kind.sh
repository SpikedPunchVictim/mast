#!/bin/zsh
# Exploratory: cost of one incremental run by KIND of changed file.
# kinds: block  = typescript file with a recorded FTS block
#        nochunk= typescript file with no chunks (no block recorded)
#        md     = markdown file (no identifier_fts block recorded)
S=${0:a:h}; M=/Users/spikedpunchvictim/projects/mast/dist/cli/index.js; D=$S/n8n; DB=$D/.mast/graph.db
echo "load: $(sysctl -n vm.loadavg)"
run() { # label, sql-where, N, rep, appended text
  sqlite3 $DB "select path from files where $2 order by (id*2654435761)%1000003 limit $3 offset $(( ($4-1)*$3 + ${6:-0} ))" > $S/pick.txt
  i=0; while read -r p; do i=$((i+1)); printf "$5" $1 $4 $i >> "$D/$p"; done < $S/pick.txt
  out=$(node $M index --incremental --phase-timing $D 2>&1 | tr '\n' ' ')
  echo "$1 N=$3 rep=$4 | $(echo $out | sed -E 's/.*(files: [0-9]+ indexed).*duration: ([0-9]+ms).*"parse":([0-9]+),"write":([0-9]+),"edges":([0-9]+).*"fts_del":([0-9]+).*/\1 dur=\2 parse=\3 write=\4 edges=\5 fts_del=\6/')"
}
node $M index --incremental $D >/dev/null 2>&1
for rep in 1 2 3; do
  run block   "language='typescript' and chunk_fts_lo is not null" 1 $rep '\n// zzK %s %s %s\nexport const zzK_%s = 1;\n' 3000
  run nochunk "language='typescript' and chunk_fts_lo is null" 1 $rep '\n// zzK %s %s %s\n'
  run md      "language='markdown'" 1 $rep '\nzzK %s %s %s\n'
done
for rep in 1 2 3; do
  run block20 "language='typescript' and chunk_fts_lo is not null" 20 $rep '\nexport const zzB_%s_%s_%s = 1;\n' 4000
  run block100 "language='typescript' and chunk_fts_lo is not null" 100 $rep '\nexport const zzC_%s_%s_%s = 1;\n' 6000
done
echo "load: $(sysctl -n vm.loadavg)"
