#!/bin/zsh
# D148 (and D130): how common a default export is, by the form that makes it, and how
# many named re-exports of one an index holds with and without an edge.
# usage: default-census.sh <source root> <graph.db> [path prefix inside the index]
# Greps .ts/.tsx/.mts/.cts outside node_modules and dist (not .d.ts); reads the database only.
root=$1; db=$2
src() { grep -rEh --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' --exclude='*.d.ts' --exclude-dir=node_modules --exclude-dir=dist "$1" $root 2>/dev/null | wc -l | tr -d ' ' }
q() { sqlite3 "file:$db?mode=ro" "$1" }
echo "source lines, by form:"
echo "  export default function|class|interface <Name>:  $(src '^export default (async )?(abstract )?(function\*?|class|interface) +[A-Za-z_$]')"
echo "  export default function|class with no name:      $(src '^export default (async )?(abstract )?(function\*?|class) *[\(\{<]')"
echo "  export default <identifier>;:                    $(src '^export default [A-Za-z_$][A-Za-z0-9_$]*;? *$')"
echo "  export default <anything else>:                  $(src '^export default ([^A-Za-z_$]|new |await |[A-Za-z_$][A-Za-z0-9_$.]*[\(\[<.])')"
echo "  export { x as default } (no from):               $(src '^export \{[^}]* as default[ ,}][^}]*\}?;? *$')"
echo "  export { default [as x] } from:                  $(src '^export \{[^}]*\bdefault\b[^}]*\} from ')"
echo "  import X from '.…' (relative default import):    $(src "^import (type )?[A-Za-z_$][A-Za-z0-9_$]*(, *\{[^}]*\})? from ['\"]\.")"
echo "  import { default as X } from '.…':               $(src "^import (type )?\{[^}]*\bdefault as [^}]*\} from ['\"]\.")"
echo "index:"
echo "  markers whose source name is default (reexport_aliases + markers named default): $(q "select (select count(*) from reexport_aliases where source_name='default') + (select count(*) from symbols where kind='export' and name='default')")"
echo "  of the aliased ones, with a RE_EXPORTS edge: $(q "select count(*) from reexport_aliases ra join symbols m on m.file_id=ra.file_id and m.name=ra.exported_name and m.kind='export' where ra.source_name='default' and exists (select 1 from edges e where e.from_id=m.id and e.edge_type='RE_EXPORTS')")"
echo "  symbols named default (any kind): $(q "select kind||' '||count(*) from symbols where name='default' group by kind")"
echo "  rows flagged as a default export, by kind: $(q "select group_concat(k, ', ') from (select kind||' '||count(*) k from symbols where is_default_export=1 group by kind)" 2>/dev/null || echo "no such column")"
echo "  of those, rows with an edge into them: $(q "select count(distinct e.to_id) from edges e join symbols s on s.id=e.to_id where s.is_default_export=1" 2>/dev/null || echo "no such column")"
