#!/usr/bin/env bash
# Spike S12, follow-up — is `export * as ns from` treated as a plain `export *` (D096)?
#
# Usage: ns-star-repro.sh <mast-dist-dir> <empty-scratch-dir>
#
# Builds four files. TypeScript resolves `import { fn } from './barrel.js'` to b.ts: a.ts is
# reachable only as `ns.fn`. Prints the edges and star rows mast stores.
set -euo pipefail
dist=$1; dir=$2
mkdir -p "$dir/src"; cd "$dir"
printf 'export function fn(): number { return 1; }\n' > src/a.ts
printf 'export function fn(): number { return 2; }\n' > src/b.ts
printf "export * as ns from './a.js';\nexport * from './b.js';\n" > src/barrel.ts
printf "import { fn } from './barrel.js';\nexport function use(): number { return fn(); }\n" > src/zc.ts
node "$dist/cli/index.js" init > /dev/null 2>&1
sqlite3 .mast/graph.db "
  select e.edge_type, sf.path || ':' || s1.name, tf.path || ':' || s2.name
    from edges e join symbols s1 on s1.id = e.from_id join symbols s2 on s2.id = e.to_id
    join files sf on sf.id = s1.file_id join files tf on tf.id = s2.file_id;
  select 'star', f1.path, f2.path from re_export_files r
    join files f1 on f1.id = r.from_file_id join files f2 on f2.id = r.to_file_id;"
