#!/bin/zsh
# run.sh <n8n copy> <state dir of an index of it> <out dir>: the shipped `mast index --checker` on n8n.
# The state dir is copied first and the copy is what the pass writes to.
set -u
R=${0:A:h}/../../../../..; N=${1:?corpus}; ST=${2:?state dir}; O=${3:?out dir}
rm -rf $O/state && mkdir -p $O && cp -R $ST $O/state
cd $N && /usr/bin/time -l env MAST_STATE_DIR=$O/state node $R/dist/cli/index.js index --incremental --checker > $O/pass.out 2> $O/pass.err
echo "exit=$?" >> $O/pass.out
sqlite3 $O/state/graph.db "select 'checker edges: '||count(*) from edges where resolution='checker'; select 'verdict rows: '||count(*) from checker_verdicts; select 'verdicts '||verdict||': '||count(*) from checker_verdicts group by verdict" >> $O/pass.out
