#!/bin/zsh
# Exploratory re-run of the edge-loss reviewer's scenarios, written from its
# descriptions (not from its files). Each: build, full index, edit, incremental, full.
S=${0:a:h}; M=/Users/spikedpunchvictim/projects/mast/dist/cli/index.js
dump() { sqlite3 "$1/.mast/graph.db" "select '   '||f1.path||':'||s1.name||' -'||e.edge_type||'-> '||f2.path||':'||s2.name||'('||s2.kind||')' from edges e join symbols s1 on s1.id=e.from_id join symbols s2 on s2.id=e.to_id join files f1 on f1.id=s1.file_id join files f2 on f2.id=s2.file_id where e.edge_type<>'PARENT_OF' order by 1; select '   R '||f1.path||' => '||f2.path from re_export_files r join files f1 on f1.id=r.from_file_id join files f2 on f2.id=r.to_file_id order by 1"; }
scen() { # name ; functions setup_$1 and edit_$1 run inside the project dir
  P=$S/$1; rm -rf $P; mkdir -p $P/src; (cd $P && setup_$1); node $M init $P >/dev/null 2>&1
  echo "== $1 BEFORE"; dump $P; sleep 1.1; (cd $P && edit_$1)
  echo "== $1 INCREMENTAL: $(node $M index --incremental $P 2>&1 | tail -1 | cut -c1-40) $(node $M status $P | grep stale_files | tr -s ' ')"; dump $P
  node $M index $P >/dev/null 2>&1; echo "== $1 FULL"; dump $P
}
CALL="import { fn } from './x.js';\nexport function use(): number { return fn(); }\n"
setup_n2() { print 'export function old(): number { return 1; }' > src/x.ts; print "import { fresh } from './x.js';\nexport function use(): number { return fresh(); }" > src/zc.ts; }
edit_n2() { print 'export function fresh(): number { return 2; }' >> src/x.ts; }
setup_n1() { print "$CALL" > src/zc.ts; }
edit_n1() { print 'export function fn(): number { return 1; }' > src/x.ts; }
setup_s4b() { print 'export function fn(): number { return 1; }' > src/x.ts; print "$CALL" > src/zc.ts; }
edit_s4b() { print 'export function renamed(): number { return 1; }' > src/x.ts; }
setup_s4e() { print 'export function fn(): number { return 1; }' > src/x.ts; print 'export function fn(): number { return 2; }' > src/y.ts; print "export * from './x.js';" > src/barrel.ts; print "import { fn } from './barrel.js';\nexport function use(): number { return fn(); }" > src/zc.ts; }
edit_s4e() { print "export * from './y.js';" > src/barrel.ts; }
setup_m1() { print 'export function fn(): number { return 1; }' > src/impl.ts; print "export { fn } from './impl.js';" > src/x.ts; print "$CALL" > src/zc.ts; }
edit_m1() { print 'export function fn(): number { return 9; }' > src/x.ts; }
setup_s3k() { print 'export type Opts = { a: number };' > src/x.ts; print "import { Opts } from './x.js';\nexport class Impl implements Opts { a = 1; }" > src/zc.ts; }
edit_s3k() { print 'export interface Opts { a: number }' > src/x.ts; }
setup_r1() { print 'export function fn(): number { return 1; }' > src/x.ts; print "export * from './x.js';" > src/barrel.ts; }
edit_r1() { print 'export function fn(): number { return 2; }' > src/x.ts; }
if [ $# -eq 0 ]; then set -- n2 n1 s4b s4e m1 s3k r1; fi; for s in "$@"; do scen $s; done
