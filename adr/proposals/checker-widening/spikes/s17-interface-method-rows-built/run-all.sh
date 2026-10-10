#!/bin/sh
# s17: index and score every corpus with the build that stores a row for each method of an
# interface. Writes to a scratch directory only.
#
#   run-all.sh <mast repo> <scratch dir> <n8n copy> <nest copy> <vscode copy>
#
# The build is the repo's `dist/` (run `pnpm build` first, and do not rebuild while this runs).
set -u
R=$1; T=$2; N8N=$3; NEST=$4; VSCODE=$5
M="node $R/dist/cli/index.js"
SC="node $R/eval-suite/graph-scorecard.mjs"
LABEL="interface methods"
cd "$R" || exit 2
rm -f "$T/done"
rm -rf "$T/mast" "$T/shapes" "$T/n8n" "$T/nest" "$T/vscode" "$T/work-n8n"

$M index "$R/eval-suite/fixtures/resolver-shapes" --state-dir "$T/shapes" > "$T/shapes.log" 2>&1
$SC run --root eval-suite/fixtures/resolver-shapes --tsconfig tsconfig.json --workspace-src --db "$T/shapes/graph.db" --label "$LABEL" --out "$T/shapes.json" >> "$T/shapes.log" 2>&1

$M index "$R" --state-dir "$T/mast" > "$T/mast.log" 2>&1
$SC run --root . --tsconfig tsconfig.json --db "$T/mast/graph.db" --label "$LABEL" --out "$T/mast.json" >> "$T/mast.log" 2>&1

$M index "$N8N" --state-dir "$T/n8n" --phase-timing > "$T/n8n.log" 2>&1
$SC run --root "$N8N" --tsconfig packages/core/tsconfig.json --prefix packages/core/ --workspace-src --db "$T/n8n/graph.db" --label "$LABEL" --out "$T/n8n-core.json" >> "$T/n8n.log" 2>&1
$SC run --root "$N8N" --tsconfig packages/cli/tsconfig.json --prefix packages/cli/ --workspace-src --db "$T/n8n/graph.db" --label "$LABEL" --out "$T/n8n-cli.json" >> "$T/n8n.log" 2>&1
node adr/proposals/checker-widening/spikes/s1-cost-yield/run.mjs "$N8N" "$T/n8n/graph.db" "$T/work-n8n" "$T/n8n-80.json" --workspace-src --skip . > "$T/n8n-80.log" 2>&1

$M index "$NEST" --state-dir "$T/nest" > "$T/nest.log" 2>&1
$SC run --root "$NEST" --tsconfig tsconfig.json --db "$T/nest/graph.db" --label "$LABEL" --out "$T/nest.json" >> "$T/nest.log" 2>&1

$M index "$VSCODE" --state-dir "$T/vscode" > "$T/vscode.log" 2>&1
node --max-old-space-size=14000 "$R/eval-suite/graph-scorecard.mjs" run --root "$VSCODE" --tsconfig src/tsconfig.json --db "$T/vscode/graph.db" --label "$LABEL" --out "$T/vscode.json.gz" >> "$T/vscode.log" 2>&1
echo ok > "$T/done"
