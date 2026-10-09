# Classes that declare a field whose name is a method of a class above them.
# Usage: python3 field-shadows.py <state dir>
import sqlite3, sys, json
c = sqlite3.connect(sys.argv[1] + '/graph.db')
rows = c.execute("select s.id, s.name, f.path, s.fields from symbols s join files f on f.id=s.file_id where s.fields is not null").fetchall()
parents = {}
for a, b in c.execute("select from_id, to_id from edges where edge_type='EXTENDS'"):
    parents.setdefault(a, []).append(b)
sym = {r[0]: (r[1], r[2]) for r in c.execute("select id, name, file_id from symbols")}
members = {(r[0], r[1]) for r in c.execute("select file_id, name from symbols where kind != 'export'")}
with_fields = len(rows); field_count = 0; hits = []
for sid, name, path, fields in rows:
    f = json.loads(fields)
    for side in ('instance', 'static'):
        for field in f[side]:
            field_count += 1
            cur, passed = sid, set()
            while cur in parents and len(parents[cur]) == 1 and cur not in passed:
                passed.add(cur)
                cur = parents[cur][0]
                pname, pfile = sym[cur]
                if (pfile, pname + '.' + field) in members:
                    hits.append((path, name, side, field, pname))
                    break
print(json.dumps({'classes_with_fields': with_fields, 'fields': field_count, 'fields_over_a_method_above': len(hits)}))
for h in hits: print('  ', *h)
