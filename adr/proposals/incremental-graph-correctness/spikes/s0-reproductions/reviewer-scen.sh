#!/bin/bash
# usage: scen.sh <name> ; expects dir <name>/ prepared with before state and <name>.edit script
S=$(cd "$(dirname "$0")" && pwd); P=$S/$1
rm -rf $P/.mast; $S/m.sh init $P >/dev/null 2>&1
echo "== $1: BEFORE"; $S/e.sh $P | grep -v PARENT_OF
(cd $P && bash $S/$1.edit)
echo "== $1: INCREMENTAL: $($S/m.sh index --incremental $P 2>&1 | tail -1)"; $S/e.sh $P | grep -v PARENT_OF > $P.inc; cat $P.inc
$S/m.sh status $P | grep stale_files
echo "== $1: FULL"; $S/m.sh index $P >/dev/null 2>&1; $S/e.sh $P | grep -v PARENT_OF > $P.full; cat $P.full
