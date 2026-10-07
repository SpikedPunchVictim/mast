#!/usr/bin/env python3
"""Spike S12, follow-up — which kind of `export *` line stands in front of each counted name?

Usage: barrel-lines.py <count.py output json> <project-root>     (reads only)

For each barrel count.py reported, reads the barrel's source and says whether the files that
declare the doubled names are reached by `export * from` or by `export * as ns from`. A name
behind an `as ns` line is not exported under its own name, so it is not a D094 case at all.
Matches lines by regular expression, not by parsing.
"""
import json, re, sys

pairs = json.load(open(sys.argv[1]))["pairs"]
rows, plain_names = [], 0
for barrel, names in pairs.items():
    src = open(f"{sys.argv[2]}/{barrel}").read()
    plain = {p.rsplit("/", 1)[-1] for p in re.findall(r"^export \*\s+from\s+'([^']+)'", src, re.M)}
    spaced = {p.rsplit("/", 1)[-1] for p in re.findall(r"^export \* as [\w$]+ from\s+'([^']+)'", src, re.M)}
    behind_plain = 0
    for name, files in names.items():
        stems = {f.rsplit("/", 1)[-1].rsplit(".", 1)[0] for f in files}
        if len(stems & plain) >= 2:
            behind_plain += 1
    plain_names += behind_plain
    rows.append({"barrel": barrel, "plain_star_lines": len(plain), "namespace_star_lines": len(spaced),
                 "names_counted": len(names), "names_declared_in_two_files_behind_plain_stars": behind_plain})
print(json.dumps({"barrels": len(rows), "names_counted": sum(r["names_counted"] for r in rows),
                  "names_declared_in_two_files_behind_plain_stars": plain_names, "rows": rows}, indent=2))
