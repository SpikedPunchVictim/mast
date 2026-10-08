#!/bin/zsh
# Reproductions for the ledger rows filed from the review of 2026-10-08 (D115 on).
# usage: repro.sh <empty work dir>      (uses the dist/ of this checkout: run `pnpm build` first)
# Prints to stdout; OUTPUT.txt beside this file is one run of it, with the commit it ran on.
HERE=${0:A:h}; REPO=${HERE:h:h:h:h}; M=$REPO/dist/cli/index.js
W=${1:?work dir}; mkdir -p $W; W=${W:A}
mast() { node $M "$@" }
q() { sqlite3 "$1/graph.db" "$2" }
proj() { mkdir -p $W/$1/src; (cd $W/$1 && git init -q 2>/dev/null); print -r -- $W/$1 }
PAD=${(pl:30::\n:):-}   # 30 newlines: further than a chunk's context lines
echo "commit $(git -C $REPO rev-parse --short HEAD)  node $(node -v)"

echo; echo "## A. tool answers on the shapes corpus (stored edges are right, the answer is not)"
export MAST_STATE_DIR=$W/st-shapes
(cd $REPO/eval-suite/fixtures/resolver-shapes && mast index >/dev/null 2>&1
 echo "edges into Emitter rows:"; q $MAST_STATE_DIR "select f.name||' -> '||t.name||' ('||t.kind||' l'||t.line||') '||e.edge_type from edges e join symbols f on f.id=e.from_id join symbols t on t.id=e.to_id join files tf on tf.id=t.file_id where tf.path like '%merged-class%' and e.edge_type='POTENTIAL_CALL'"
 echo "edges out of local-shadow/src/use.ts (Repo there is a local value, not the import):"; q $MAST_STATE_DIR "select '  '||f.name||' -> '||t.name||' ['||e.resolution||']' from edges e join symbols f on f.id=e.from_id join symbols t on t.id=e.to_id join files ff on ff.id=f.file_id where ff.path like '%local-shadow/src/use.ts' and e.edge_type='POTENTIAL_CALL'"
 echo "mast_callers Emitter:"; mast query --json mast_callers '{"symbol":"Emitter"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("  verified_callers "+JSON.stringify(r.verified_callers)+"  potential_matches "+r.potential_matches.length)})'
 echo "mast_callers target, direct:"; mast query --json mast_callers '{"symbol":"target"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("  "+JSON.stringify(JSON.parse(s).verified_callers.map(c=>c.caller_symbol))))'
 echo "mast_callers target, transitive:"; mast query --json mast_callers '{"symbol":"target","transitive":true}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("  "+JSON.stringify(JSON.parse(s).verified_callers.map(c=>c.caller_symbol))))')

echo; echo "## B. the wipe for another schema version (D113's fix)"
p=$(proj wipe); print 'export function one(): number { return 1; }' > $p/src/a.ts
export MAST_STATE_DIR=$W/st-wipe
(cd $p && mast index >/dev/null 2>&1
 sed -i '' 's/"1.4.0"/"1.3.0"/' $MAST_STATE_DIR/index.json
 echo "B2 --incremental on another version:"; out=$(mast index --incremental 2>&1); ec=$?; print -r -- "$out" | tail -2; echo "   exit=$ec"
 sed -i '' 's/"1.4.0"/"9.9.0"/' $MAST_STATE_DIR/index.json
 echo "B3 index stamped 9.9.0 (newer):"; mast index 2>&1 | tail -3; echo "   stamp now $(grep -o '"schema_version": *"[^"]*"' $MAST_STATE_DIR/index.json)"
 sed -i '' 's/"1.4.0"/"1.3.0"/' $MAST_STATE_DIR/index.json; : > $MAST_STATE_DIR/structure.lock
 node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}));setTimeout(()=>{},8000)' $MAST_STATE_DIR/structure.lock &
 holder=$!; sleep 1
 echo "B4 search --reindex while another process holds structure.lock:"; out=$(mast search --reindex one 2>&1); ec=$?; print -r -- "$out" | cut -c1-200; echo "   exit=$ec  files in graph.db: $(q $MAST_STATE_DIR 'select count(*) from files' 2>&1)"
 kill $holder 2>/dev/null; wait $holder 2>/dev/null; rm -f $MAST_STATE_DIR/structure.lock
 mast index >/dev/null 2>&1
 : > $MAST_STATE_DIR/index.json
 echo "B5 empty index.json:"; out=$(mast index 2>&1); ec=$?; print -r -- "$out" | grep -v '^ *at ' | grep . | cut -c1-200; echo "   exit=$ec")
p=$(proj serve); print 'export function one(): number { return 1; }' > $p/src/a.ts
export MAST_STATE_DIR=$W/st-serve; (cd $p && mast index >/dev/null 2>&1)
echo "B6 the wipe inside a running server:"; node $HERE/serve-wipe.mjs $REPO $p $MAST_STATE_DIR 2>/dev/null

echo; echo "## C. mast_signature type context left to the by-name guess"
p=$(proj sig)
print 'export interface Shape { decoy: true }\nexport class Circle { decoy = true }\nexport interface Sh { decoy: true }' > $p/src/a-decoy.ts
print 'export default interface Shape { real: true }' > $p/src/shape.ts
print 'export default class Circle { r = 1 }' > $p/src/circle.ts
print "import Shape from './shape.js';\nimport Circle from './circle.js';\nimport { default as Sh } from './shape.js';\nimport * as ns from './shape.js';\nexport function use(a: Shape, b: Circle, c: Sh): void {}" > $p/src/user.ts
print 'export interface Decl { real: true }' > $p/src/types.d.ts
print "import type { Decl } from './types.js';\nexport function viaJs(a: Decl): void {}" > $p/src/user2.ts
print "import type { Decl } from './types';\nexport function bare(a: Decl): void {}" > $p/src/user3.ts
export MAST_STATE_DIR=$W/st-sig
(cd $p && mast index >/dev/null 2>&1
 for s in use viaJs bare; do mast query --json mast_signature "{\"symbol\":\"$s\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const x of JSON.parse(s).results)console.log("  "+x.signature.replace(/\s+/g," ")+"  =>  "+(x.type_context.map(t=>t.name+" -> "+t.file_path+":"+t.line).join(", ")||"(type_context empty)"))})'; done
 echo "  import rows:"; q $MAST_STATE_DIR "select '   '||f.path||' '||i.module||' resolved='||ifnull(i.resolved_path,'NULL')||' symbols='||i.symbols||' aliases='||ifnull(i.aliases,'NULL') from imports i join files f on f.id=i.file_id order by 1")

echo; echo "## D. incremental run against full rebuild"
p=$(proj inc); print "function foo(): number { return 1; }\n${PAD}\nexport { foo };" > $p/src/x.ts
export MAST_STATE_DIR=$W/st-inc
(cd $p && mast index >/dev/null 2>&1
 echo "D1 before: symbols $(q $MAST_STATE_DIR "select name||'|'||is_exported from symbols where name='foo'")  chunks $(q $MAST_STATE_DIR "select count(*) from chunks where is_exported=1" 2>&1)"
 print "function foo(): number { return 1; }\n${PAD}\n" > src/x.ts
 mast index --incremental 2>&1 | tail -1
 echo "D1 incremental: symbols $(q $MAST_STATE_DIR "select name||'|'||is_exported from symbols where name='foo'")"
 echo "D1 mast_exports src/x.ts:"; mast query --json mast_exports '{"file_path":"src/x.ts"}' | cut -c1-300
 echo "D1 mast status:"; mast status 2>&1 | grep -i -E 'fresh|stale|behind' | head -2
 MAST_STATE_DIR=$W/st-inc-full mast index >/dev/null 2>&1
 echo "D1 full rebuild: symbols $(q $W/st-inc-full "select name||'|'||is_exported from symbols where name='foo'")")
p=$(proj star); print "export * from './missing';\n${PAD}export function own(): void {}" > $p/src/b.ts
export MAST_STATE_DIR=$W/st-star
(cd $p && mast index >/dev/null 2>&1
 echo "D2 before: star_reexport_unresolved rows $(q $MAST_STATE_DIR 'select count(*) from star_reexport_unresolved')"
 print "\n${PAD}export function own(): void {}" > src/b.ts; mast index --incremental 2>&1 | tail -1
 echo "D2 incremental after removing the export *: $(q $MAST_STATE_DIR 'select count(*) from star_reexport_unresolved')"
 MAST_STATE_DIR=$W/st-star-full mast index >/dev/null 2>&1
 echo "D2 full rebuild: $(q $W/st-star-full 'select count(*) from star_reexport_unresolved')")
