#!/bin/sh
# Spike s16: index one corpus with the build of HEAD and with the build that has
# `patch.diff` applied, and print what each stored.
#
#   index-both.sh <base build dir> <patched build dir> <corpus> <state dir prefix>
#
# One after the other, so the two wall times can be compared. Writes
# <prefix>-base and <prefix>-patch.
set -eu
BASE=$1; PATCHED=$2; CORPUS=$3; PREFIX=$4
for arm in base patch; do
  build=$BASE; [ "$arm" = patch ] && build=$PATCHED
  rm -rf "$PREFIX-$arm"
  start=$(date +%s)
  node "$build/dist/cli/index.js" index "$CORPUS" --state-dir "$PREFIX-$arm" --phase-timing | tail -2
  echo "$arm wall_s $(( $(date +%s) - start ))"
  db="$PREFIX-$arm/graph.db"
  echo "$arm db_bytes $(stat -f %z "$db")"
  sqlite3 "$db" "select '$arm symbols', kind, count(*) from symbols group by kind" \
    "select '$arm chunks', count(*) from chunks" \
    "select '$arm edges', edge_type, coalesce(resolution,''), count(*) from edges group by 1,2,3" \
    "select '$arm interface methods', count(*) from symbols m join symbols i on i.file_id = m.file_id and i.kind = 'interface' and m.kind = 'method' and m.name like i.name || '.%'" \
    "select '$arm call edges to an interface method', coalesce(e.resolution,''), count(*) from edges e join symbols m on m.id = e.to_id join symbols i on i.file_id = m.file_id and i.kind = 'interface' and m.kind = 'method' and m.name like i.name || '.%' where e.edge_type = 'POTENTIAL_CALL' group by 2"
done
