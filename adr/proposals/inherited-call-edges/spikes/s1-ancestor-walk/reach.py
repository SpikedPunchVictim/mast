# S3 repair reach: for each file that declares a class something extends, which
# files lie below it in the stored EXTENDS edges, and how many of those the
# present repair (files holding an edge into the file) already reaches.
# Usage: python3 reach.py <graph.db>   (only selects)
import sqlite3, sys, collections, json, statistics
db = sqlite3.connect(sys.argv[1])
sym_file = dict(db.execute("select id, file_id from symbols"))
path = dict(db.execute("select id, path from files"))
ext = db.execute("select from_id, to_id from edges where edge_type='EXTENDS'").fetchall()
parents = collections.defaultdict(list); children = collections.defaultdict(list)
for f, t in ext: parents[f].append(t); children[t].append(f)
multi = sum(1 for v in parents.values() if len(v) > 1)
# depth of each class with a parent edge: steps to the top of its stored chain
def depth(c, seen=()):
    if c in seen: return None
    ps = parents.get(c)
    if not ps: return 0
    d = depth(ps[0], seen + (c,))
    return None if d is None else d + 1
depths = collections.Counter(depth(c) for c in parents)
holders = collections.defaultdict(set)
for ff, tf in db.execute("""select distinct fs.file_id, ts.file_id from edges e
  join symbols fs on fs.id=e.from_id join symbols ts on ts.id=e.to_id where fs.file_id != ts.file_id"""):
    holders[tf].add(ff)
# descendant files of each file
by_file = collections.defaultdict(set)
for t in children: by_file[sym_file[t]].add(t)
rows = []
for fid, classes in by_file.items():
    seen = set(); stack = list(classes)
    while stack:
        c = stack.pop()
        for k in children.get(c, []):
            if k not in seen: seen.add(k); stack.append(k)
    below = {sym_file[c] for c in seen} - {fid}
    # files holding an edge into any file below (they may name a subclass as a receiver type)
    users = set()
    for b in below: users |= holders[b]
    users -= {fid}
    rows.append((path[fid], len(holders[fid]), len(below), len(below - holders[fid]), len((below | users) - holders[fid])))
def dist(xs):
    xs = sorted(xs); n = len(xs)
    return {"n": n, "median": xs[n // 2], "p90": xs[int(n * .9)], "p99": xs[int(n * .99)], "max": xs[-1], "sum": sum(xs), "nonzero": sum(1 for x in xs if x)}
out = {
  "extends_edges": len(ext), "classes_with_a_parent_edge": len(parents), "classes_with_two_parent_edges": multi,
  "chain_length_of_classes_with_a_parent_edge": {str(k): v for k, v in sorted(depths.items(), key=lambda kv: (kv[0] is None, kv[0]))},
  "files_declaring_an_extended_class": len(rows), "files_indexed": len(path),
  "holders_now": dist([r[1] for r in rows]),
  "files_below": dist([r[2] for r in rows]),
  "files_below_not_held_now": dist([r[3] for r in rows]),
  "files_below_or_using_a_class_below_not_held_now": dist([r[4] for r in rows]),
  "largest": [dict(zip(["file", "holders_now", "below", "below_not_held", "below_or_users_not_held"], r)) for r in sorted(rows, key=lambda r: -r[4])[:8]],
}
print(json.dumps(out, indent=1))
