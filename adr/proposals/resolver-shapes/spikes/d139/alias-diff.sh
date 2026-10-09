#!/bin/zsh
# alias-diff.sh <before graph.db> <after graph.db>: import rows whose symbols or aliases differ,
# and symbol and reexport_aliases names that hold a quote. Reads both; writes nothing.
sqlite3 "$2" "ATTACH '$1' AS b;
CREATE TEMP TABLE a1 AS SELECT f.path p, i.module m, i.symbols s, ifnull(i.aliases,'NULL') a FROM main.imports i JOIN main.files f ON f.id=i.file_id;
CREATE TEMP TABLE b1 AS SELECT f.path p, i.module m, i.symbols s, ifnull(i.aliases,'NULL') a FROM b.imports i JOIN b.files f ON f.id=i.file_id;
SELECT 'import rows before', count(*) FROM b1; SELECT 'import rows after', count(*) FROM a1;
SELECT 'rows only before', count(*) FROM (SELECT * FROM b1 EXCEPT SELECT * FROM a1);
SELECT 'rows only after', count(*) FROM (SELECT * FROM a1 EXCEPT SELECT * FROM b1);
SELECT 'symbol names holding a quote, before', count(*) FROM b.symbols WHERE name LIKE '%\"%' OR name LIKE '%''%';
SELECT 'symbol names holding a quote, after', count(*) FROM main.symbols WHERE name LIKE '%\"%' OR name LIKE '%''%';
SELECT 'import rows whose symbols hold an escaped quote, before', count(*) FROM b1 WHERE s LIKE '%\\\"%';
SELECT 'import rows whose symbols hold an escaped quote, after', count(*) FROM a1 WHERE s LIKE '%\\\"%';
SELECT 'after: ' || p || ' <- ' || m || ' symbols=' || s || ' aliases=' || a FROM (SELECT * FROM a1 EXCEPT SELECT * FROM b1) ORDER BY 1;"
