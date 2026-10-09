#!/bin/zsh
# import-diff.sh <before graph.db> <after graph.db>: import rows whose resolved path differs.
# Reads both; writes nothing.
sqlite3 "$2" "ATTACH '$1' AS b;
CREATE TEMP TABLE a1 AS SELECT f.path p, i.module m, i.symbols s, ifnull(i.resolved_path,'NULL') r FROM main.imports i JOIN main.files f ON f.id=i.file_id;
CREATE TEMP TABLE b1 AS SELECT f.path p, i.module m, i.symbols s, ifnull(i.resolved_path,'NULL') r FROM b.imports i JOIN b.files f ON f.id=i.file_id;
SELECT 'import rows before', count(*) FROM b1; SELECT 'import rows after', count(*) FROM a1;
SELECT 'rows only before', count(*) FROM (SELECT * FROM b1 EXCEPT SELECT * FROM a1);
SELECT 'rows only after', count(*) FROM (SELECT * FROM a1 EXCEPT SELECT * FROM b1);
SELECT 'after: ' || p || ' -> ' || m || ' = ' || r FROM (SELECT * FROM a1 EXCEPT SELECT * FROM b1) ORDER BY 1;
SELECT 'before: ' || p || ' -> ' || m || ' = ' || r FROM (SELECT * FROM b1 EXCEPT SELECT * FROM a1) ORDER BY 1;"
