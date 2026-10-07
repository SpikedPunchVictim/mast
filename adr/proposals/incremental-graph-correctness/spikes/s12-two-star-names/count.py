#!/usr/bin/env python3
"""Spike S12 — how often is a name declared in two files behind one barrel's `export *` lines (D094)?

Usage: count.py <graph.db>     (reads only)

For every file with a star re-export, collects the exported top-level names declared in the files
it reaches through stars, and keeps the names declared in two or more of them that the barrel
does not itself declare or re-export by name. Then counts the import rows that resolve to such a
barrel and name such a name: those are the imports whose edge D094's ordering decides.

A name is matched by spelling alone, so a type and a value of the same name in two files count;
that makes the figures an upper bound.
"""
import collections, json, sqlite3, sys

db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
path = {i: p for i, p in db.execute("select id, path from files")}
pid = {p: i for i, p in path.items()}
stars = collections.defaultdict(set)
for f, t in db.execute("select from_file_id, to_file_id from re_export_files"):
    stars[f].add(t)
names, markers = collections.defaultdict(set), collections.defaultdict(set)
for f, n, k in db.execute("select file_id, name, kind from symbols where name not like '%.%' and is_exported = 1"):
    (markers if k == "export" else names)[f].add(n)

def reach(start):
    seen, queue = {start}, [start]
    while queue:
        for nxt in stars.get(queue.pop(), ()):
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    return seen

ambiguous = {}
for barrel in stars:
    where = collections.defaultdict(set)
    for f in reach(barrel) - {barrel}:
        for n in names[f]:
            where[n].add(f)
    own = names[barrel] | markers[barrel]
    found = {n: fs for n, fs in where.items() if len(fs) >= 2 and n not in own}
    if found:
        ambiguous[barrel] = found

hits, files = 0, set()
for fid, symbols, resolved in db.execute("select file_id, symbols, resolved_path from imports where resolved_path is not null"):
    barrel = pid.get(resolved)
    if barrel in ambiguous:
        for n in json.loads(symbols):
            if n in ambiguous[barrel]:
                hits += 1
                files.add(fid)

print(json.dumps({
    "files": len(path),
    "files_with_a_star_re_export": len(stars),
    "barrels_with_a_name_declared_in_two_files_behind_their_stars": len(ambiguous),
    "barrel_name_pairs": sum(len(d) for d in ambiguous.values()),
    "import_rows": db.execute("select count(*) from imports").fetchone()[0],
    "imported_names_that_are_such_a_pair": hits,
    "files_importing_one": len(files),
    "pairs": {path[b]: {n: sorted(path[f] for f in fs) for n, fs in d.items()} for b, d in ambiguous.items()},
}, indent=2))
