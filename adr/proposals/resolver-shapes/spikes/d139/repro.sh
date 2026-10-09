#!/bin/zsh
# D139: what the import extractor stores for names a style guide would not allow.
# usage: repro.sh <empty work dir>   (`pnpm build` first). Writes only under the work dir.
HERE=${0:A:h}; REPO=${HERE:h:h:h:h:h}; M=$REPO/dist/cli/index.js
W=${1:?work dir}; mkdir -p $W; W=${W:A}
echo "commit $(git -C $REPO rev-parse --short HEAD)$(git -C $REPO diff --quiet -- src || echo ' + uncommitted src')  node $(node -v)"
p=$W/alias; mkdir -p $p/src; cd $p; git init -q
print 'export interface Shape { real: true }\nconst v = 1;\nexport { v as "string name" };\nexport function run(): void {}\nexport default function dflt(): void {}' > src/lib.ts
print "import { Shape as __proto__ } from './lib.js';\nexport function p(a: __proto__): void {}" > src/u1.ts
print "import { \"string name\" as sn } from './lib.js';\nexport const x = sn;" > src/u2.ts
print "export async function d(): Promise<void> { const { Shape: Q } = await import('./lib.js'); void Q; }" > src/u3.ts
print "import { run as constructor } from './lib.js';\nexport function c(): void { constructor(); }" > src/u4.ts
print "import __proto__ from './lib.js';\nexport function e(): void { __proto__(); }" > src/u5.ts
print "export { run as \"other name\" } from './lib.js';" > src/u6.ts
print "export async function f(): Promise<void> { const { run: go } = await import('./lib.js'); go(); }" > src/u7.ts
export MAST_STATE_DIR=$W/st-alias; node $M index >/dev/null 2>&1
sqlite3 $MAST_STATE_DIR/graph.db "select f.path||'  symbols='||i.symbols||'  aliases='||ifnull(i.aliases,'NULL') from imports i join files f on f.id=i.file_id order by 1"
echo "-- symbols that are not plain names"
sqlite3 $MAST_STATE_DIR/graph.db "select f.path||'  '||s.kind||' '||s.name from symbols s join files f on f.id=s.file_id where s.name like '%\"%' or s.name like '% %' order by 1"
echo "-- reexport_aliases"; sqlite3 $MAST_STATE_DIR/graph.db "select * from reexport_aliases" 2>&1
echo "-- call edges"
sqlite3 $MAST_STATE_DIR/graph.db "select ff.path||':'||a.name||' -> '||tf.path||':'||b.name from edges e join symbols a on a.id=e.from_id join symbols b on b.id=e.to_id join files ff on ff.id=a.file_id join files tf on tf.id=b.file_id where e.edge_type like '%CALL%' order by 1"
node $M query --json mast_signature '{"symbol":"p"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const x of JSON.parse(s).results)console.log(x.signature+"  =>  "+(x.type_context.map(t=>t.name+" -> "+t.file_path).join(", ")||"(type_context empty)"))})'
