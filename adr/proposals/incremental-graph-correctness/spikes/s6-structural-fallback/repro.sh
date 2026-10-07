#!/bin/sh
# S6 — the two resolver gaps the spike found, as scratch projects (D086, D087).
# Usage: repro.sh <mast-dist-dir> <empty-work-dir>
set -eu
DIST=$(cd "$1" && pwd); WORK=$2
mast() { node "$DIST/cli/index.js" "$@"; }
Q="select e.edge_type||' '||ff.path||':'||fs.name||' -> '||tf.path||':'||ts.name from edges e join symbols fs on fs.id=e.from_id join files ff on ff.id=fs.file_id join symbols ts on ts.id=e.to_id join files tf on tf.id=ts.file_id order by 1"
callers() { mast query mast_callers '{"symbol":"fn","include_potential":false}' . | tr -d ' \n' | grep -o '"verified_count":[0-9]*'; }

echo "== D086: a name re-exported by name, behind an export *"
rm -rf "$WORK/d086"; mkdir -p "$WORK/d086/src"; cd "$WORK/d086"
printf 'export function fn(): number {\n  return 1;\n}\nexport class Base {}\n' > src/a.ts
printf "export { fn, Base } from './a.js';\n" > src/mid.ts
printf "export * from './mid.js';\n" > src/barrel.ts
printf "import { fn, Base } from './barrel.js';\nexport class Impl extends Base {}\nexport function use(): number {\n  return fn();\n}\n" > src/zc.ts
mast init . >/dev/null; mast index . >/dev/null
sqlite3 .mast/graph.db "$Q"; echo "mast_callers fn: $(callers)"

echo "== D087: a path alias declared in a package's own tsconfig"
rm -rf "$WORK/d087"; mkdir -p "$WORK/d087/packages/app/src/lib"; cd "$WORK/d087"
printf '{ "files": [], "references": [{ "path": "packages/app" }] }\n' > tsconfig.json
printf '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }\n' > packages/app/tsconfig.json
printf 'export function fn(): number {\n  return 1;\n}\n' > packages/app/src/lib/a.ts
printf "import { fn } from '@/lib/a';\nexport function use(): number {\n  return fn();\n}\n" > packages/app/src/zc.ts
mast init . >/dev/null
sqlite3 .mast/graph.db "select 'import '||module||' is_external='||is_external||' resolved_path='||coalesce(resolved_path,'NULL') from imports; select 'edges '||count(*) from edges"
echo "mast_callers fn: $(callers)"
echo "-- the same alias moved to the root tsconfig"
printf '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./packages/app/src/*"] } } }\n' > tsconfig.json
mast index . >/dev/null
sqlite3 .mast/graph.db "select 'import '||module||' is_external='||is_external||' resolved_path='||coalesce(resolved_path,'NULL') from imports; select 'edges '||count(*) from edges"
