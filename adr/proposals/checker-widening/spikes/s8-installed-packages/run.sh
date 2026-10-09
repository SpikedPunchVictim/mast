#!/bin/zsh
# Spike s8 for checker-widening: a corpus with its packages installed.
#
#   zsh run.sh <copy of nest's sample/01-cats-app, after `npm install --ignore-scripts`> <work dir>
#
# Indexes the app with the built `dist/`, then scores the index twice: with `node_modules`
# where it is, and with it moved aside. Prints the call-edge item of each card and the
# stored call edges. The app's decorators are all imported from `@nestjs/common` or
# `class-validator`, except `Roles`, which the app declares as a constant.
here=${0:A:h}; repo=${here:h:h:h:h:h}; app=${1:A}; work=${2:A}
mkdir -p $work; rm -rf $work/state
( cd $app && MAST_STATE_DIR=$work/state node $repo/dist/cli/index.js index | tail -1 )
for mode in with without; do
  [[ $mode == without ]] && mv $app/node_modules $work/node_modules-aside
  ( cd $repo && node eval-suite/graph-scorecard.mjs run --root $app --tsconfig tsconfig.json --db $work/state/graph.db --label "01-cats-app, $mode node_modules" --out $work/card-$mode.json > /dev/null 2>&1 )
  [[ $mode == without ]] && mv $work/node_modules-aside $app/node_modules
  python3 -c "
import json,sys
d=json.load(open('$work/card-$mode.json')); i=d['items']['edge: POTENTIAL_CALL']
print('$mode node_modules: program_source_files', d['meta']['program_source_files'], {k:len(v) for k,v in i.items() if isinstance(v,list)})"
done
echo "stored call edges:"
sqlite3 $work/state/graph.db "select '  '||s.name||' > '||t.name||' ('||e.resolution||')' from edges e join symbols s on s.id=e.from_id join symbols t on t.id=e.to_id where edge_type='POTENTIAL_CALL' order by 1"
echo "decorators in the app's source, by name:"
grep -rhoE "@[A-Z][A-Za-z]*\(?" $app/src | sort | uniq -c | sort -rn | sed 's/^/  /'
