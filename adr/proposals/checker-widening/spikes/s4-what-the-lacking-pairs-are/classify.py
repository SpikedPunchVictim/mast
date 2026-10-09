#!/usr/bin/env python3
"""classify.py <dir of scorecards> <graph.db> <out.json>

For every call pair the compiler has and the stored graph lacks, what the calling file's
import rows say about the callee. Reads the cards `s1-cost-yield/run.mjs` leaves in its work
dir and the index they were scored against. A pair is `from path:name > to path:name`.

  imported_by_name_from_that_file   an import row of the caller resolves to the callee's file
                                    and lists the callee's first name
  imported_by_name_from_another     an import row lists the name and resolves to another
                                    indexed file (a re-export on the way)
  imported_by_name_unresolved       an import row lists the name and has no resolved path
  namespace_or_default_import_of_that_file
                                    a row resolves to the callee's file and does not list the name
  file_not_imported                 no import row of the caller resolves to the callee's file
                                    or lists the name: the callee came through a value
  same_file                         caller and callee are in one file
"""
import json, sqlite3, sys, glob, os, collections
cards, dbpath, out = sys.argv[1:4]
db = sqlite3.connect(dbpath)
imports = collections.defaultdict(list)
for path, module, symbols, aliases, resolved in db.execute(
    "select f.path, i.module, i.symbols, i.aliases, i.resolved_path from imports i join files f on f.id=i.file_id"):
    names = set(json.loads(symbols or '[]'))
    names |= set((json.loads(aliases) if aliases else {}).values())
    imports[path].append((module, names, resolved))
agree, lacks = set(), set()
for card in sorted(glob.glob(os.path.join(cards, '*.json'))):
    item = json.load(open(card))['items'].get('edge: POTENTIAL_CALL', {})
    agree |= set(item.get('agree', [])); lacks |= set(item.get('lacks', []))
lacks -= agree
def end(key):
    path, _, name = key.partition(':')
    return path, name.split('@')[0]
kinds = collections.Counter(); by_member = collections.Counter(); samples = collections.defaultdict(list)
unresolved_modules = collections.Counter()
for pair in sorted(lacks):
    left, right = pair.split(' > ')
    (fpath, _), (tpath, tname) = end(left), end(right)
    first = tname.split('.')[0]
    member = 'member' if '.' in tname else 'top-level'
    if fpath == tpath: kind = 'same_file'
    else:
        rows = imports.get(fpath, [])
        named = [r for r in rows if first in r[1]]
        if any(r[2] == tpath for r in named): kind = 'imported_by_name_from_that_file'
        elif any(r[2] for r in named): kind = 'imported_by_name_from_another'
        elif named:
            kind = 'imported_by_name_unresolved'
            for r in named: unresolved_modules[r[0]] += 1
        elif any(r[2] == tpath for r in rows): kind = 'namespace_or_default_import_of_that_file'
        else: kind = 'file_not_imported'
    kinds[kind] += 1; by_member[f'{kind}, {member}'] += 1
    if len(samples[f'{kind}, {member}']) < 8: samples[f'{kind}, {member}'].append(pair)
result = {'lacking_pairs': len(lacks), 'by_kind': dict(kinds.most_common()), 'by_kind_and_callee': dict(sorted(by_member.items())),
          'modules_of_unresolved_named_imports_top_25': unresolved_modules.most_common(25), 'samples': samples}
json.dump(result, open(out, 'w'), indent=1)
print(json.dumps({k: v for k, v in result.items() if k != 'samples'}, indent=1))
