# S3 repair reach, precise: which files' walks passed through a class of each file.
# Usage: python3 visits.py <graph.db> <walk-log.jsonl>   (only selects)
# The log's `chain` is the symbol ids a walk read an EXTENDS edge from or
# arrived at: the receiver's class and each class above it that was looked in.
import sqlite3, sys, json, collections
db = sqlite3.connect(sys.argv[1])
sym_file = dict(db.execute("select id, file_id from symbols"))
path = dict(db.execute("select id, path from files"))
fid_of = {p: i for i, p in path.items()}
holders = collections.defaultdict(set)
for ff, tf in db.execute("""select distinct fs.file_id, ts.file_id from edges e
  join symbols fs on fs.id=e.from_id join symbols ts on ts.id=e.to_id where fs.file_id != ts.file_id"""):
    holders[tf].add(ff)
visitors = collections.defaultdict(set)   # class file -> files whose walk passed through it
pairs = set(); rows = 0
for l in open(sys.argv[2]):
    r = json.loads(l)
    if "chain" not in r: continue
    rows += 1
    f = fid_of[r["file"]]
    for c in r["chain"]:
        pairs.add((f, c))
        if sym_file[c] != f: visitors[sym_file[c]].add(f)
def dist(xs):
    xs = sorted(xs); n = len(xs)
    return {"n": n, "median": xs[n // 2], "p90": xs[int(n * .9)], "p99": xs[int(n * .99)], "max": xs[-1], "sum": sum(xs), "nonzero": sum(1 for x in xs if x)}
per = [(path[t], len(v), len(v - holders[t])) for t, v in visitors.items()]
print(json.dumps({
  "walks_with_a_chain": rows, "distinct_file_and_class_pairs": len(pairs),
  "files_some_other_files_walk_passed_through": len(per),
  "visiting_files": dist([p[1] for p in per]),
  "visiting_files_not_held_now": dist([p[2] for p in per]),
  "largest": [dict(zip(["file", "visiting_files", "not_held_now"], p)) for p in sorted(per, key=lambda p: -p[2])[:8]],
}, indent=1))
