#!/bin/zsh
# names-reached.sh <before graph.db> <after graph.db>: for the import rows that have a resolved
# path only in the second index, the names they import and how many have a symbol row of that
# name in the file the import now resolves to. Reads both; writes nothing.
sqlite3 "$2" "ATTACH '$1' AS b;
CREATE TEMP TABLE gained AS SELECT i.file_id, i.module, i.symbols, i.resolved_path FROM main.imports i JOIN main.files f ON f.id=i.file_id
  WHERE i.resolved_path IS NOT NULL AND EXISTS (SELECT 1 FROM b.imports bi JOIN b.files bf ON bf.id=bi.file_id WHERE bf.path=f.path AND bi.module=i.module AND bi.symbols=i.symbols AND bi.resolved_path IS NULL);
SELECT 'import rows that gained a resolved path', count(*) FROM gained;
SELECT 'rows that import no name (namespace or side effect)', count(*) FROM gained WHERE symbols='[]';
CREATE TEMP TABLE names AS SELECT g.resolved_path p, j.value n FROM gained g, json_each(g.symbols) j;
SELECT 'imported names', count(*) FROM names;
SELECT 'names with a symbol row in the resolved file', count(*) FROM names WHERE EXISTS (SELECT 1 FROM main.symbols s JOIN main.files f ON f.id=s.file_id WHERE f.path=names.p AND s.name=names.n);
SELECT 'the resolved file is in the index', count(*) FROM gained WHERE EXISTS (SELECT 1 FROM main.files f WHERE f.path=gained.resolved_path);"
