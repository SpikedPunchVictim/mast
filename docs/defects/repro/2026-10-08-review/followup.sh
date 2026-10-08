#!/bin/zsh
# Reproductions for D137 to D139. usage: followup.sh <empty work dir>   (`pnpm build` first)
HERE=${0:A:h}; REPO=${HERE:h:h:h:h}; M=$REPO/dist/cli/index.js
W=${1:?work dir}; mkdir -p $W; W=${W:A}
count() { sqlite3 $1/graph.db "select count(*) from $2" }
echo "commit $(git -C $REPO rev-parse --short HEAD)  node $(node -v)"

echo; echo "## E. a first index killed before it finished, then --incremental (D137). Corpus: this repository"
cd $REPO
MAST_STATE_DIR=$W/full node $M index >/dev/null 2>&1; echo "full index: files=$(count $W/full files) edges=$(count $W/full edges)"
for s in 0.7 1.3 1.8; do export MAST_STATE_DIR=$W/k$s
  node $M index >/dev/null 2>&1 & pid=$!; sleep $s; kill -9 $pid 2>/dev/null; wait $pid 2>/dev/null
  echo "killed at ${s}s: index.json $([ -f $MAST_STATE_DIR/index.json ] && echo present || echo absent)  files=$(count $MAST_STATE_DIR files) edges=$(count $MAST_STATE_DIR edges)"
  sleep 12   # the dead process's lock has to go stale first
  echo "  --incremental: $(node $M index --incremental 2>&1 | grep '^files:')"
  echo "  after: files=$(count $MAST_STATE_DIR files) edges=$(count $MAST_STATE_DIR edges)  $(node $M status 2>&1 | grep -E 'index_fresh|stale_files' | tr -s ' \n' ' ')"
done

echo; echo "## F. readers of an index stamped with another version (D138)"
p=$W/stamp; mkdir -p $p/src; cd $p; git init -q; print 'export function one(): number { return 1; }' > src/a.ts
export MAST_STATE_DIR=$W/st-stamp; node $M index >/dev/null 2>&1; sed -i '' 's/"1.4.0"/"1.2.0"/' $MAST_STATE_DIR/index.json
echo "index.json: $(grep schema_version $MAST_STATE_DIR/index.json | tr -d ' ')"
node $M status 2>&1 | grep -E 'schema_version|index_fresh'
echo "search one: $(node $M search one 2>&1 | head -1)"

echo; echo "## G. the alias column (D139)"
p=$W/alias; mkdir -p $p/src; cd $p; git init -q
print 'export interface Shape { real: true }\nconst v = 1;\nexport { v as "string name" };' > src/lib.ts
print "import { Shape as __proto__ } from './lib.js';\nexport function p(a: __proto__): void {}" > src/u1.ts
print "import { \"string name\" as sn } from './lib.js';\nexport const x = sn;" > src/u2.ts
print "export async function d(): Promise<void> { const { Shape: Q } = await import('./lib.js'); void Q; }" > src/u3.ts
export MAST_STATE_DIR=$W/st-alias; node $M index >/dev/null 2>&1
sqlite3 $MAST_STATE_DIR/graph.db "select f.path||'  symbols='||i.symbols||'  aliases='||ifnull(i.aliases,'NULL') from imports i join files f on f.id=i.file_id order by 1"
node $M query --json mast_signature '{"symbol":"p"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const x of JSON.parse(s).results)console.log(x.signature+"  =>  "+(x.type_context.map(t=>t.name+" -> "+t.file_path).join(", ")||"(type_context empty)"))})'
