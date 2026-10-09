#!/bin/zsh
# repro.sh <work dir>: how long a `checker` edge lives. Uses the built dist/ of this checkout.
#   A  a third file changes what a call resolves to; `index --incremental` keeps the old edge,
#      and `index --incremental --checker` then stores the new one beside it (D150)
#   B  a full `mast index` without `--checker` removes every checker edge (D151)
#   C  a method called on an expression is never a candidate of the pass
set -u
R=${0:A:h}/../../../../..; M=$R/dist/cli/index.js; W=${1:?work dir}
Q="select f.name||' > '||tf.path||':'||t.name||' ['||coalesce(e.resolution,'')||']' from edges e join symbols f on f.id=e.from_id join symbols t on t.id=e.to_id join files tf on tf.id=t.file_id where e.edge_type='POTENTIAL_CALL' order by 1"
edges() { echo "-- $1"; sqlite3 .mast/graph.db "$Q"; echo "-- ($(sqlite3 .mast/graph.db "select count(*) from edges where edge_type='POTENTIAL_CALL'") call edges)"; }
TS='{"compilerOptions":{"strict":true,"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","noEmit":true},"include":["src"]}'
compiler() { node -e "
const ts=require('$R/node_modules/typescript');const p=ts.createProgram(['src/a.ts'],{module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext});const c=p.getTypeChecker();
(function v(n){if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)){const d=c.getResolvedSignature(n).declaration;console.log('-- the compiler: '+n.getText()+' is declared in '+d.getSourceFile().fileName.replace(process.cwd()+'/',''))}ts.forEachChild(n,v)})(p.getSourceFile('src/a.ts'))"; }

echo "=== A and B: a function reached through a namespace import and a re-export"
rm -rf $W/ab; mkdir -p $W/ab/src; cd $W/ab; git init -q; echo $TS > tsconfig.json
echo 'export function persist(): void {}' > src/b.ts
echo 'export function persist(): void {}' > src/d.ts
echo "export { persist } from './b.js';" > src/c.ts
printf "import * as store from './c.js';\nexport function run(): void {\n  store.persist();\n}\n" > src/a.ts
node $M index 2>&1 | tail -1; edges "index"
node $M index --checker 2>&1 | grep upgraded; edges "index --checker"; compiler
node $M index 2>&1 | tail -1; edges "B: index again, nothing changed"
node $M index --checker 2>&1 | grep upgraded; edges "index --checker"
sleep 1; echo "export { persist } from './d.js';" > src/c.ts; echo "... src/c.ts now re-exports ./d.js"; compiler
node $M index --incremental 2>&1 | tail -1; edges "A: index --incremental"
node $M index --incremental --checker 2>&1 | grep upgraded; edges "A: index --incremental --checker"

echo; echo "=== C: a method called on what a function returns"
rm -rf $W/c; mkdir -p $W/c/src; cd $W/c; git init -q; echo $TS > tsconfig.json
echo 'export class Bravo { persist(): void {} }' > src/b.ts
printf "import { Bravo } from './b.js';\nexport function make(): Bravo { return new Bravo(); }\n" > src/c.ts
printf "import { make } from './c.js';\nexport function run(): void {\n  make().persist();\n}\n" > src/a.ts
node $M index 2>&1 | tail -1; node $M index --checker 2>&1 | grep upgraded; edges "index --checker"; compiler
echo "-- verdict rows, by the file of the candidate:"; sqlite3 .mast/graph.db "select s.name||' in '||f.path||': '||cv.verdict from checker_verdicts cv join files f on f.id=cv.call_site_file_id join symbols s on s.id=cv.queried_symbol_id order by 1" 2>&1
