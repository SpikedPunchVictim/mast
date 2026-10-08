#!/bin/sh
# Two defects the checker comparison on n8n packages/cli showed in the build of 563ecaf,
# cut down to five files. Usage: sh reproduce.sh <mast dist/cli/index.js> <empty work dir>
set -e
MAST=$1; W=$2; mkdir -p "$W/src" "$W/lib"; cd "$W"
cat > lib/helpers.ts <<'TS'
export function fail(): string { return 'imported'; }
TS
cat > src/shadow.ts <<'TS'
import { fail } from '../lib/helpers';

export function run(flag: boolean): string {
  const fail = () => 'local';
  return flag ? fail() : 'ok';
}

export function other(): string {
  return fail();
}
TS
cat > lib/column.ts <<'TS'
export class Column {
  constructor(private name: string) {}
  build(): string { return this.name; }
}
TS
cat > lib/index.ts <<'TS'
export { Column as DslColumn } from './column';
TS
cat > src/alias.ts <<'TS'
import { DslColumn } from '../lib';

export function make(): DslColumn { return new DslColumn('a'); }
export function use(c: DslColumn): string { return c.build(); }
TS
node "$MAST" index --state-dir "$W/state" . > /dev/null
sqlite3 "$W/state/graph.db" "select ff.path||':'||fs.name, e.resolution, tf.path||':'||ts.name||' ('||ts.kind||')', e.call_line from edges e join symbols fs on fs.id=e.from_id join files ff on ff.id=fs.file_id join symbols ts on ts.id=e.to_id join files tf on tf.id=ts.file_id where e.edge_type='POTENTIAL_CALL' order by 1"
