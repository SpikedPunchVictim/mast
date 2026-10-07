#!/bin/zsh
# Exploratory timing: wall time and phase breakdown of `mast index --incremental`
# on the n8n scratch copy, by number of files whose content changed.
S=${0:a:h}; M=/Users/spikedpunchvictim/projects/mast/dist/cli/index.js; D=$S/n8n; DB=$D/.mast/graph.db
echo "load: $(sysctl -n vm.loadavg)"
off=0
for N in 0 1 5 20 100; do
  for rep in 1 2 3; do
    if [ $N -gt 0 ]; then
      sqlite3 $DB "select path from files where language='typescript' order by (id*2654435761)%1000003 limit $N offset $off" > $S/pick.txt
      off=$((off+N)); i=0
      while read -r p; do i=$((i+1)); printf '\nexport const zzT_%s_%s_%s = 1;\n' $N $rep $i >> "$D/$p"; done < $S/pick.txt
    fi
    t0=$(python3 -c 'import time;print(time.time())')
    out=$(node $M index --incremental --phase-timing $D 2>&1)
    t1=$(python3 -c 'import time;print(time.time())')
    printf 'N=%s rep=%s wall=%.0fms | %s\n' $N $rep $(( (t1-t0)*1000 )) "$(echo $out | tr '\n' ' ')"
  done
done
echo "load: $(sysctl -n vm.loadavg)"
