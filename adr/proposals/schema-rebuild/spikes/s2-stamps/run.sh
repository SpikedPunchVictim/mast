#!/bin/sh
# Each row of the stamp table (PROPOSAL.md, design 3) through the built CLI.
# usage: run.sh <mast checkout, built> <empty work directory>
set -u
MAST="$1/dist/cli/index.js"
W="$2"
mast() { node "$MAST" "$@"; }
stamp() { sed -i.bak "s/\"schema_version\": \"[^\"]*\"/\"schema_version\": \"$1\"/" .mast/index.json && rm .mast/index.json.bak; }

mkdir -p "$W/src" && cd "$W" || exit 2
printf 'export function fn(): number { return 1; }\n' > src/a.ts
printf "import { fn } from './a.js';\nexport function use(): number { return fn(); }\n" > src/b.ts

echo "--- 1. no index.json, empty database: mast index"
mast index; echo "exit $?"
echo "--- 2. this version: mast index --incremental"
mast index --incremental; echo "exit $?"
echo "--- 3. older (1.3.0): mast index --incremental"
stamp 1.3.0; mast index --incremental; echo "exit $?"; grep schema_version .mast/index.json
echo "--- 4. newer (9.9.0): mast index --incremental"
stamp 9.9.0; mast index --incremental; echo "exit $?"; grep schema_version .mast/index.json
echo "--- 5. newer (9.9.0): mast index"
mast index; echo "exit $?"
echo "--- 6. newer (9.9.0): mast serve"
mast serve --no-watch </dev/null; echo "exit $?"
sqlite3 .mast/graph.db 'select count(*) from files' | sed 's/^/file rows after the three refusals: /'
echo "--- 7. empty index.json: mast status, then mast index --incremental"
: > .mast/index.json
mast status >/dev/null; echo "status exit $?"
mast index --incremental; echo "exit $?"; grep schema_version .mast/index.json
echo "--- 8. no index.json, database has file rows and no edges: mast index --incremental"
rm .mast/index.json .mast/file_manifest.json
sqlite3 .mast/graph.db 'delete from edges'
mast index --incremental; echo "exit $?"
sqlite3 .mast/graph.db 'select count(*) from edges' | sed 's/^/edge rows: /'
