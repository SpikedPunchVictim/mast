#!/bin/zsh
# D124: how many `export { a as b }` of a file's own declaration an index holds, and how
# many edges were on the alias row `b`.   usage: local-alias-census.sh <graph.db>
# An alias row is a row that shares its file, line and kind with a row of another name,
# neither a member (`X.m`) nor a marker. Reads the database only.
db=$1
q() { sqlite3 "file:$db?mode=ro" "$1" }
PAIRS="from symbols b join symbols a on a.file_id=b.file_id and a.line=b.line and a.kind=b.kind and a.name<>b.name and a.id<>b.id where b.is_exported=1 and a.is_exported=0 and b.kind<>'export' and b.name not like '%.%' and a.name not like '%.%'"
echo "alias rows (exported row sharing file, line and kind with an unexported row of another name): $(q "select count(*) $PAIRS")"
echo "edges into those alias rows: $(q "select count(*) from edges e where e.to_id in (select b.id $PAIRS)")"
echo "rows in reexport_aliases: $(q "select count(*) from reexport_aliases")"
q "select '  '||f.path||': '||a.name||' as '||b.name $PAIRS join files f on f.id=b.file_id order by 1 limit 12" 2>/dev/null || q "select '  '||(select path from files where id=b.file_id)||': '||a.name||' as '||b.name $PAIRS limit 12"
