#!/bin/sh
# S0-R — the scenarios first run by hand on 2026-10-06, as a script.
# Usage: hand-scenarios.sh <mast-dist-dir> <empty-work-dir>
# Prints `edges | re_export_files | imports` row counts after each step.
set -eu
DIST=$(cd "$1" && pwd); WORK=$2
mast() { node "$DIST/cli/index.js" "$@"; }
counts() { sqlite3 "$1/.mast/graph.db" "select (select count(*) from edges)||'|'||(select count(*) from re_export_files)||'|'||(select count(*) from imports)"; }
say() { printf '%-58s %s\n' "$1" "$2"; }
fresh() { rm -rf "$WORK/$1"; mkdir -p "$WORK/$1/src"; cd "$WORK/$1"; }
# The manifest stamps whole seconds; an edit in the same second as the index is not seen.
tick() { sleep 1.1; }

echo "== D081, two files, incremental run"
fresh d081
printf 'export function alpha(): number {\n  return 1;\n}\n' > src/a.ts
printf "import { alpha } from './a.js';\nexport function beta(): number {\n  return alpha();\n}\n" > src/b.ts
mast init . >/dev/null
say "after init" "$(counts .)"
tick; printf 'export function alpha(): number {\n  return 2;\n}\n' > src/a.ts
say "incremental: $(mast index --incremental . | tail -1)" "$(counts .)"
say "status: $(mast status . | grep stale_files)" ""
mast index . >/dev/null; say "after full index" "$(counts .)"

echo "== D081, two files, query-time re-parse"
fresh d081q
printf 'export function alpha(): number {\n  return 1;\n}\n' > src/a.ts
printf "import { alpha } from './a.js';\nexport function beta(): number {\n  return alpha();\n}\n" > src/b.ts
mast init . >/dev/null
say "after init" "$(counts .)"
tick; printf 'export function alpha(): number {\n  return 2;\n}\n' > src/a.ts
mast query mast_exports '{"file_path":"src/a.ts"}' . >/dev/null
say "after mast_exports on the edited file" "$(counts .)"
say "incremental: $(mast index --incremental . | tail -1)" "$(counts .)"
say "status: $(mast status . | grep stale_files)" ""
mast index . >/dev/null; say "after full index" "$(counts .)"

echo "== D080, query-time re-parse of a file with its own edge and star re-export"
fresh d080
printf 'export function alpha(): number {\n  return 1;\n}\n' > src/a.ts
printf "export const other = 1;\n" > src/o.ts
printf "import { alpha } from './a.js';\nexport * from './o.js';\nexport function beta(): number {\n  return alpha();\n}\n" > src/b.ts
mast init . >/dev/null
say "after init" "$(counts .)"
tick; printf "import { alpha } from './a.js';\nexport * from './o.js';\nexport function beta(): number {\n  return alpha() + 1;\n}\n" > src/b.ts
mast query mast_exports '{"file_path":"src/b.ts"}' . >/dev/null
say "after mast_exports on the edited file" "$(counts .)"
say "mast_callers alpha: $(mast query mast_callers '{"symbol":"alpha","include_potential":false}' . | tr -d ' \n' | grep -o '"verified_count":[0-9]*')" ""
say "incremental: $(mast index --incremental . | tail -1)" "$(counts .)"
say "status: $(mast status . | grep stale_files)" ""
mast index . >/dev/null; say "after full index" "$(counts .)"

echo "== D080, query-time re-parse of a file with its own edge and no star re-export"
fresh d080b
printf 'export function alpha(): number {\n  return 1;\n}\n' > src/a.ts
printf "import { alpha } from './a.js';\nexport function beta(): number {\n  return alpha();\n}\n" > src/b.ts
mast init . >/dev/null
say "after init" "$(counts .)"
tick; printf "import { alpha } from './a.js';\nexport function beta(): number {\n  return alpha() + 1;\n}\n" > src/b.ts
mast query mast_exports '{"file_path":"src/b.ts"}' . >/dev/null
say "after mast_exports on the edited file" "$(counts .)"
say "mast_callers alpha: $(mast query mast_callers '{"symbol":"alpha","include_potential":false}' . | tr -d ' \n' | tr -d ' \n' | grep -o '"verified_count":[0-9]*')" ""
say "incremental: $(mast index --incremental . | tail -1)" "$(counts .)"
say "status: $(mast status . | grep stale_files)" ""
mast index . >/dev/null; say "after full index" "$(counts .)"
