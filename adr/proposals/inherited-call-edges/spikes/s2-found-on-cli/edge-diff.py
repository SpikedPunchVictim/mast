# Edges of two n8n indexes, compared. Usage: python3 d104-diff.py <old state dir> <new state dir> <out.json>
import sqlite3, sys, json, collections
Q = """select ff.path, fs.name, e.edge_type, coalesce(e.resolution,''), tf.path, ts.name, ts.kind, coalesce(e.call_line,0), coalesce(e.context,'')
from edges e join symbols fs on fs.id=e.from_id join files ff on ff.id=fs.file_id
join symbols ts on ts.id=e.to_id join files tf on tf.id=ts.file_id"""
def load(d):
    c = sqlite3.connect(d + '/graph.db')  # a WAL db without -shm cannot be opened mode=ro
    rows = {}
    for r in c.execute(Q):
        rows[(r[0], r[1], r[2], r[4], r[5])] = r
    return rows
a, b = load(sys.argv[1]), load(sys.argv[2])
gone = [a[k] for k in sorted(a.keys() - b.keys())]
new = [b[k] for k in sorted(b.keys() - a.keys())]
out = {'old_edges': len(a), 'new_edges': len(b), 'gone': gone, 'added': new,
       'gone_by_resolution': collections.Counter(r[3] for r in gone),
       'added_by_resolution': collections.Counter(r[3] for r in new)}
json.dump(out, open(sys.argv[3], 'w'), indent=1)
print({k: v for k, v in out.items() if k not in ('gone', 'added')})
