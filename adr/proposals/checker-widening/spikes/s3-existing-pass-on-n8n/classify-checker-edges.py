#!/usr/bin/env python3
"""classify-checker-edges.py <dir of scorecards> <graph.db the pass wrote to> <out.json>

The `checker` edges of an index, by how the scorecard judged them, and for the ones it has
as wrong or unjudged, what the target is and what the compiler has for the same caller.
"""
import json, sqlite3, sys, glob, os, collections
cards, dbpath, out = sys.argv[1:4]
db = sqlite3.connect(dbpath)
kind = {}
for path, name, k in db.execute("select f.path, s.name, s.kind from symbols s join files f on f.id=s.file_id where s.kind!='export'"):
    kind.setdefault(f'{path}:{name}', k)
bucket_of = {}; reference = set()
for card in sorted(glob.glob(os.path.join(cards, '*.json'))):
    c = json.load(open(card))
    item = c['items'].get('edge: POTENTIAL_CALL', {})
    reference |= set(item.get('agree', [])) | set(item.get('lacks', []))
    for b in ('agree', 'wrong', 'unjudged'):
        for key in c['breakdowns'].get('call edge, stored as checker', {}).get(b, []): bucket_of.setdefault(key, b)
by_from = collections.defaultdict(set)
for key in reference: by_from[key.split(' > ')[0]].add(key.split(' > ')[1])
out_counts = collections.Counter(); samples = collections.defaultdict(list)
for key, bucket in sorted(bucket_of.items()):
    left, right = key.split(' > ')
    target_kind = kind.get(right.split('@')[0], 'unknown')
    name = right.split(':', 1)[1].split('@')[0]
    same_name_elsewhere = [t for t in by_from.get(left, ()) if t.split(':', 1)[1].split('@')[0].split('.')[-1] == name.split('.')[-1] and t != right]
    if bucket == 'agree': what = 'agree'
    elif f'{right}.constructor' in by_from.get(left, ()): what = f'{bucket}: the class, and the compiler has its constructor from this caller'
    elif same_name_elsewhere: what = f'{bucket}: the compiler has a {name.split(".")[-1]} of another declaration from this caller'
    elif by_from.get(left): what = f'{bucket}: the compiler has calls from this caller, none to this name ({target_kind})'
    else: what = f'{bucket}: the compiler has no call from this caller ({target_kind})'
    out_counts[what] += 1
    if len(samples[what]) < 6: samples[what].append(key + ('' if not same_name_elsewhere else '   | compiler: ' + sorted(same_name_elsewhere)[0]))
result = {'checker_edges_scored': len(bucket_of), 'counts': dict(sorted(out_counts.items())), 'samples': samples}
json.dump(result, open(out, 'w'), indent=1); print(json.dumps(result, indent=1))
