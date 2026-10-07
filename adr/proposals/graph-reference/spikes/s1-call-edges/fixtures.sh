#!/bin/sh
# S1 spike — THROWAWAY. Two small projects that isolate the call shapes the n8n run found
# mast has no edge for. Writes them into <work-dir>, indexes each with the built mast CLI,
# and prints the POTENTIAL_CALL edges stored. Kept as a script so the fixture sources do
# not enter this repository's own index.
#
#   sh fixtures.sh <work-dir>          (run from the repository root; needs dist/ built)
set -eu
W=$1
MAST="$(pwd)/dist/cli/index.js"
rm -rf "$W/fx1" "$W/fx1-state" "$W/fx2" "$W/fx2-state"

# ---- fx1: how the receiver's class is reached ------------------------------------------
X=$W/fx1
mkdir -p "$X/src/errors" "$X/src/base"
cat > "$X/tsconfig.json" <<'EOF'
{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, "strict": true } }
EOF
cat > "$X/src/errors/reporter.ts" <<'EOF'
export class Reporter {
  warn(msg: string): void { console.log(msg); }
  static make(): Reporter { return new Reporter(); }
}
EOF
echo "export { Reporter } from './reporter';" > "$X/src/errors/index.ts"
cat > "$X/src/base/parent.ts" <<'EOF'
export class Parent {
  plain(n: number): number { return n; }
  generic<T>(v: T): T { return v; }
  over(n: number): number { return n; }
  overG<T>(v: T): T { return v; }
}
EOF
cat > "$X/src/a-alias-file.ts" <<'EOF'
import { Reporter } from '@/errors/reporter';
export class A { constructor(private readonly r: Reporter) {} run(): void { this.r.warn('a'); } }
EOF
cat > "$X/src/b-alias-barrel.ts" <<'EOF'
import { Reporter } from '@/errors';
export class B { constructor(private readonly r: Reporter) {} run(): void { this.r.warn('b'); } }
EOF
cat > "$X/src/c-relative-barrel.ts" <<'EOF'
import { Reporter } from './errors';
export class C { constructor(private readonly r: Reporter) {} run(): void { this.r.warn('c'); } }
EOF
cat > "$X/src/d-inherit.ts" <<'EOF'
import { Parent } from './base/parent';
export class Child extends Parent {
  callsInheritedPlain(): number { return this.plain(1); }
  callsInheritedGeneric(): number { return this.generic<number>(1); }
  override over(n: number): number { return super.over(n); }
  override overG<T>(v: T): T { return super.overG<T>(v); }
  sameFileGeneric(): number { return this.local<number>(1); }
  local<T>(v: T): T { return v; }
}
EOF
cat > "$X/src/e-static.ts" <<'EOF'
import { Reporter } from './errors/reporter';
export function viaStatic(): Reporter { return Reporter.make(); }
export function viaUnion(r: Reporter | undefined): void { r!.warn('u'); }
export const obj = (r: Reporter) => ({ go(): void { helper(r); } });
function helper(r: Reporter): void { r.warn('h'); }
EOF

# ---- fx2: where in the caller the call sits ---------------------------------------------
X=$W/fx2
mkdir -p "$X/src"
echo '{ "compilerOptions": { "strict": true } }' > "$X/tsconfig.json"
cat > "$X/src/lib.ts" <<'EOF'
export function imported(n: number): number { return n; }
export class Env { record(n: number): number { return n; } }
EOF
cat > "$X/src/shapes.ts" <<'EOF'
import { imported, Env } from './lib';
function local(n: number): number { return n; }
export function s01_direct(): number { return local(1) + imported(1); }
export function s02_nestedArrow(xs: number[]): number[] { return xs.map((x) => local(x) + imported(x)); }
export function s03_nestedFunctionDecl(): number { function inner(): number { return local(1) + imported(1); } return inner(); }
export const s04_objectLiteralMethod = () => ({ go(): number { return local(1) + imported(1); } });
export const s05_exprBodiedArrow = (n: number) => local(n);
export const s06_exprBodiedArrowImported = (n: number) => imported(n);
export function s07_defaultParam(n: number = local(1)): number { return n; }
export function s08_insideTry(): number { try { return local(1); } catch { return 0; } }
export function s09_arrowParamAnnotated(): (e: Env) => number { return (e: Env) => e.record(1); }
export function s10_paramInNestedArrow(e: Env, xs: number[]): number[] { return xs.map((x) => e.record(x)); }
export class K {
  field = local(1);
  constructor(private readonly e: Env) {}
  s11_fieldInNestedArrow(xs: number[]): number[] { return xs.map((x) => this.e.record(x)); }
  s12_thisInNestedArrow(xs: number[]): number[] { return xs.map((x) => this.own(x)); }
  own(n: number): number { return n; }
  get s13_getter(): number { return local(1); }
}
EOF

for fx in fx1 fx2; do
  node "$MAST" index --state-dir "$W/$fx-state" "$W/$fx" > /dev/null
  echo "== $fx"
  sqlite3 "$W/$fx-state/graph.db" "select ff.path||':'||a.name, e.resolution, tf.path||':'||b.name from edges e join symbols a on a.id=e.from_id join files ff on ff.id=a.file_id join symbols b on b.id=e.to_id join files tf on tf.id=b.file_id where e.edge_type='POTENTIAL_CALL' order by 1,3"
done
