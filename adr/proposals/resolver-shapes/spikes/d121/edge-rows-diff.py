#!/usr/bin/env python3
"""edge-rows-diff.py <old graph.db> <new graph.db>

Every stored edge of two indexes of one tree, each end named by file, name, kind and
line, so that two declarations of one name in a file are two things (D121). Prints the
count of each side and every edge only one side has.
"""
import sqlite3, sys
from collections import Counter

Q = """
SELECT e.edge_type, COALESCE(e.resolution, ''), COALESCE(e.call_line, ''),
       ff.path || ':' || fs.name || '(' || fs.kind || '@' || fs.line || ')',
       tf.path || ':' || ts.name || '(' || ts.kind || '@' || ts.line || ')'
FROM edges e
JOIN symbols fs ON fs.id = e.from_id JOIN files ff ON ff.id = fs.file_id
JOIN symbols ts ON ts.id = e.to_id   JOIN files tf ON tf.id = ts.file_id
"""

def rows(path):
    db = sqlite3.connect(path)
    try:
        return Counter(db.execute(Q).fetchall())
    finally:
        db.close()

old, new = rows(sys.argv[1]), rows(sys.argv[2])
print(f"old: {sum(old.values())} edge rows, new: {sum(new.values())} edge rows")
gone, added = old - new, new - old
print(f"only in old: {sum(gone.values())}, only in new: {sum(added.values())}")
print("only in old, by type:", dict(Counter(k[0] for k in gone.elements())))
print("only in new, by type:", dict(Counter(k[0] for k in added.elements())))
for label, side in (("-", gone), ("+", added)):
    for k in sorted(side.elements()):
        print(label, k[0], f"[{k[1]}]" if k[1] else "", f"line {k[2]}" if k[2] != "" else "", k[3], "->", k[4])
