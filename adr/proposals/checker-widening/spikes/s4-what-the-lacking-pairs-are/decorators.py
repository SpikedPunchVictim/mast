#!/usr/bin/env python3
"""decorators.py <dir of scorecards> <graph.db> <corpus root> <out.json>

Of the lacking call pairs whose callee is a top-level name, how many have the callee's name
written as a decorator (`@name`) in the calling file, and what kind of symbol the caller is.
A text match over the calling file, not a parse: it says the file uses the name as a
decorator, not that this pair is that decorator.
"""
import json, sqlite3, sys, glob, os, re, collections
cards, dbpath, root, out = sys.argv[1:5]
db = sqlite3.connect(dbpath)
kind_of = {}
for path, name, kind in db.execute("select f.path, s.name, s.kind from symbols s join files f on f.id=s.file_id where s.kind!='export'"):
    kind_of.setdefault((path, name), kind)
agree, lacks = set(), set()
for card in sorted(glob.glob(os.path.join(cards, '*.json'))):
    item = json.load(open(card))['items'].get('edge: POTENTIAL_CALL', {})
    agree |= set(item.get('agree', [])); lacks |= set(item.get('lacks', []))
lacks -= agree
text = {}
def source(path):
    if path not in text:
        try: text[path] = open(os.path.join(root, path), encoding='utf8', errors='replace').read()
        except OSError: text[path] = ''
    return text[path]
counts = collections.Counter(); by_caller_kind = collections.Counter(); names = collections.Counter(); rest = []
top_level = 0
for pair in sorted(lacks):
    left, right = pair.split(' > ')
    fpath, _, fname = left.partition(':'); tpath, _, tname = right.partition(':')
    fname = fname.split('@')[0]; tname = tname.split('@')[0]
    if '.' in tname: continue
    top_level += 1
    used = re.search(r'@' + re.escape(tname) + r'\b', source(fpath)) is not None
    counts['name written as a decorator in the calling file' if used else 'not written as a decorator there'] += 1
    by_caller_kind[f"{'decorator' if used else 'no decorator'}, caller is a {kind_of.get((fpath, fname), 'unknown')}"] += 1
    if used: names[tname] += 1
    elif len(rest) < 40: rest.append(pair)
result = {'lacking_pairs': len(lacks), 'with_a_top_level_callee': top_level, 'counts': dict(counts), 'by_caller_kind': dict(sorted(by_caller_kind.items())),
          'decorator_names_top_20': names.most_common(20), 'first_40_without_a_decorator': rest}
json.dump(result, open(out, 'w'), indent=1)
print(json.dumps(result, indent=1))
