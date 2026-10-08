# S3: compare the call edges of two index states of one corpus.
# Usage: python3 arms.py <a/graph.db> <b/graph.db> [walk-log.jsonl]   (a WAL database with no -shm file cannot be opened read-only, so this opens it normally and only selects)
import sqlite3, sys, collections, json
def edges(p):
    db = sqlite3.connect(p)
    q = """select e.edge_type, coalesce(e.resolution,''), ff.path, fs.name, tf.path, ts.name
           from edges e join symbols fs on fs.id=e.from_id join files ff on ff.id=fs.file_id
           join symbols ts on ts.id=e.to_id join files tf on tf.id=ts.file_id"""
    return set(db.execute(q))
a, b = edges(sys.argv[1]), edges(sys.argv[2])
out = {"a_edges": len(a), "b_edges": len(b), "only_a": len(a - b), "only_b": len(b - a),
       "only_b_by_type_and_resolution": dict(collections.Counter(f"{e[0]}/{e[1]}" for e in b - a)),
       "only_a_by_type_and_resolution": dict(collections.Counter(f"{e[0]}/{e[1]}" for e in a - b))}
if len(sys.argv) > 3:
    c = collections.Counter(); linked = collections.Counter()
    for l in open(sys.argv[3]):
        r = json.loads(l); c[r["outcome"]] += 1
        if r["outcome"] == "linked": linked[f'{r["resolution"]} depth {r["depth"]}'] += 1
    out["walks_by_outcome"] = dict(c); out["linked_by_resolution_and_depth"] = dict(sorted(linked.items()))
print(json.dumps(out, indent=1))
