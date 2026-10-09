#!/bin/sh
# static-members.sh <graph.db>: methods, methods declared static, and names a
# file has both a static and an instance method row for.
sqlite3 "$1" "select 'methods', count(*) from symbols where kind='method';
select 'static methods', count(*) from symbols where is_static=1;
select 'names with a static and an instance row in one file', count(*) from (select file_id, name from symbols where kind='method' group by file_id, name having count(distinct coalesce(is_static,0))=2);"
