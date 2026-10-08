#!/usr/bin/env bash
# D114 — mast_signature's type context does not follow a re-export.
# Usage: d114-repro.sh <mast-dist-dir> <empty-scratch-dir>
# Prints what resolveTypeContext returns for `Shape` in src/user.ts, first with a named
# re-export in the barrel, then with a star. TypeScript resolves both to src/types.ts.
set -euo pipefail
dist=$1; dir=$2
mkdir -p "$dir/src"; cd "$dir"
printf 'export interface Shape { area(): number }\n' > src/types.ts
printf 'export interface Shape { decoy: true }\n' > src/a-decoy.ts
printf "import { Shape } from './index.js';\nexport function draw(s: Shape): void {}\n" > src/user.ts
cat > ask.mjs <<'JS'
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [dist, state] = process.argv.slice(2);
const { openDatabase } = await import(pathToFileURL(join(dist, 'graph/db.js')).href);
const { resolveTypeContext } = await import(pathToFileURL(join(dist, 'graph/queries.js')).href);
const db = openDatabase(state);
console.log(JSON.stringify(await resolveTypeContext(db, ['Shape'], 'src/user.ts')));
await db.destroy();
JS
for barrel in "export { Shape } from './types.js';" "export * from './types.js';"; do
  printf '%s\n' "$barrel" > src/index.ts
  MAST_STATE_DIR="$dir/state" node "$dist/cli/index.js" index > /dev/null 2>&1
  echo "$barrel"; node ask.mjs "$dist" "$dir/state"
done
