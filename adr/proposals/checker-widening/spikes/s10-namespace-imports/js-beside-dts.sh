#!/bin/sh
# Spike s10, second question: the six vscode edges the scorecard counts as wrong after the
# namespace change all end in `marked.js`, which has a `marked.d.ts` beside it. Is that the
# namespace rule, or what any import of such a module gets?
#
#   sh js-beside-dts.sh <work dir> <mast repo with dist/ of the build before> <mast repo with dist/ after>
#
# One module as `lib.js` with `lib.d.ts`, called through a named import, through a namespace
# import, and as a tagged template. Indexed and scored by each build.
set -eu
F="$1"; BEFORE="$2"; AFTER="$3"
REPO="$(cd "$(dirname "$0")/../../../../.." && pwd)"
rm -rf "$F" && mkdir -p "$F/src" && cd "$F"
cat > tsconfig.json <<'J'
{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext", "target": "ES2022", "strict": true, "noEmit": true }, "include": ["src"] }
J
printf '{"name":"dts-fixture","type":"module"}\n' > package.json
printf 'export function parse(s) { return s; }\nexport class Lexer { constructor() {} }\n' > src/lib.js
printf 'export declare function parse(s: string): string;\nexport declare class Lexer { constructor(); }\n' > src/lib.d.ts
printf "import { parse, Lexer } from './lib.js';\nexport function named(): unknown { return [parse('a'), new Lexer()]; }\n" > src/named.ts
printf "import * as lib from './lib.js';\nexport function viaNamespace(): unknown { return [lib.parse('a'), new lib.Lexer()]; }\nexport function tagged(): unknown { return lib.parse\`x\`; }\n" > src/ns.ts
printf "import { parse } from './lib.js';\nexport function taggedBare(): unknown { return parse\`x\` as unknown; }\n" > src/tag.ts
for pair in "before:$BEFORE" "after:$AFTER"; do
  name="${pair%%:*}"; dir="${pair#*:}"
  rm -rf "$F/.state-$name"
  MAST_STATE_DIR="$F/.state-$name" node "$dir/dist/cli/index.js" index > /dev/null
  node "$REPO/eval-suite/graph-scorecard.mjs" run --root "$F" --tsconfig tsconfig.json --db "$F/.state-$name/graph.db" --label "$name" --out "$F/card-$name.json" > /dev/null 2>&1
  echo "== $name"
  node -e "const d=JSON.parse(require('fs').readFileSync('$F/card-$name.json','utf8')).items['edge: POTENTIAL_CALL'];for(const[k,v]of Object.entries(d))for(const x of v)console.log('  '+k+'  '+x)"
done
