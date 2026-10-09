#!/usr/bin/env python3
"""same-name-census.py <graph.db>

How often one file declares one name more than once, and what the rows are (D121).
Prints: the count of declaration rows (re-export markers left out), the groups of rows
that share a file and a name by the kinds in them, every group with the edges each row
holds, and the call edges whose target row is a type.
"""
import sqlite3, sys
from collections import Counter

db = sqlite3.connect(sys.argv[1])
rows = db.execute("""
  SELECT s.id, f.path, s.name, s.kind, s.line, COALESCE(s.is_static, 0),
         (SELECT COUNT(*) FROM edges e WHERE e.from_id = s.id AND e.edge_type = 'POTENTIAL_CALL'),
         (SELECT COUNT(*) FROM edges e WHERE e.to_id = s.id AND e.edge_type = 'POTENTIAL_CALL'),
         (SELECT COUNT(*) FROM edges e WHERE e.to_id = s.id AND e.edge_type = 'PARENT_OF')
  FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.kind != 'export'
  ORDER BY f.path, s.name, s.line, s.id""").fetchall()
groups = {}
for r in rows:
    groups.setdefault((r[1], r[2]), []).append(r)
shared = {k: v for k, v in groups.items() if len(v) > 1}
print(f"declaration rows: {len(rows)}")
print(f"groups of rows sharing a file and a name: {len(shared)}")
combos = Counter("+".join(sorted(f"{r[3]}{'(static)' if r[5] else ''}" for r in v)) for v in shared.values())
for combo, n in combos.most_common():
    print(f"  {n:4d}  {combo}")
print("\neach group: kind@line  calls-out calls-in parent-edges-in")
for (path, name), v in sorted(shared.items()):
    print(f"{path}:{name}")
    for r in v:
        print(f"    {r[3]}{'(static)' if r[5] else ''}@{r[4]}  out={r[6]} in={r[7]} parent={r[8]}")
typed = db.execute("""
  SELECT ff.path || ':' || fs.name, e.call_line, COALESCE(e.resolution, ''), tf.path || ':' || ts.name || '(' || ts.kind || '@' || ts.line || ')'
  FROM edges e JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
  JOIN symbols ts ON ts.id = e.to_id JOIN files tf ON tf.id = ts.file_id
  WHERE e.edge_type = 'POTENTIAL_CALL' AND ts.kind IN ('interface', 'type') ORDER BY 1, 2""").fetchall()
print(f"\ncall edges whose target row is an interface or a type: {len(typed)}")
for t in typed:
    print(f"  {t[0]} line {t[1]} [{t[2]}] -> {t[3]}")
