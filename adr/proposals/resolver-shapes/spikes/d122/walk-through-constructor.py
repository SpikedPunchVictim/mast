#!/usr/bin/env python3
"""D122: how many transitive-caller answers change when the walk passes through
a class's constructor, and what the walk costs.

usage: walk-through-constructor.py <graph.db>

Runs the transitive walk of queryVerifiedCallers (src/graph/queries.ts) both
ways, as SQL copied from it, for every symbol that a class declaring a
constructor calls from its own row (a field initializer), since those are the
only starts whose answer can differ at the first class. Reads the database only.
"""
import sqlite3, sys, time
from collections import Counter

db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
CTOR = "member.name = owner.name || '.constructor'"

OLD = """
WITH RECURSIVE callers(id) AS (
  SELECT from_id FROM edges WHERE to_id IN ({ids}) AND edge_type = 'POTENTIAL_CALL'
  UNION
  SELECT e.from_id FROM edges e JOIN callers ON callers.id = e.to_id WHERE e.edge_type = 'POTENTIAL_CALL'
) SELECT DISTINCT id FROM callers"""
NEW = f"""
WITH RECURSIVE callers(id, is_caller) AS (
  SELECT from_id, 1 FROM edges WHERE to_id IN ({{ids}}) AND edge_type = 'POTENTIAL_CALL'
  UNION
  SELECT e.from_id, 1 FROM edges e JOIN callers ON callers.id = e.to_id WHERE e.edge_type = 'POTENTIAL_CALL'
  UNION
  SELECT member.id, 0 FROM edges p JOIN callers ON callers.id = p.from_id
    JOIN symbols owner ON owner.id = p.from_id JOIN symbols member ON member.id = p.to_id
    WHERE p.edge_type = 'PARENT_OF' AND {CTOR}
) SELECT DISTINCT id FROM callers WHERE is_caller = 1"""

def ctors_of(sid):
    return [r[0] for r in db.execute(
        f"SELECT member.id FROM edges p JOIN symbols owner ON owner.id = p.from_id "
        f"JOIN symbols member ON member.id = p.to_id "
        f"WHERE p.from_id = ? AND p.edge_type = 'PARENT_OF' AND {CTOR}", (sid,))]

classes_with_ctor = [r[0] for r in db.execute(
    f"SELECT DISTINCT owner.id FROM edges p JOIN symbols owner ON owner.id = p.from_id "
    f"JOIN symbols member ON member.id = p.to_id WHERE p.edge_type = 'PARENT_OF' AND {CTOR}")]
print("classes that declare a constructor:", len(classes_with_ctor))
marks = ",".join(map(str, classes_with_ctor)) or "NULL"
calling = db.execute(
    f"SELECT COUNT(DISTINCT from_id), COUNT(*) FROM edges WHERE edge_type = 'POTENTIAL_CALL' AND from_id IN ({marks})").fetchone()
print("of those, with a call stored from the class row:", calling[0], "classes,", calling[1], "edges")
starts = [r[0] for r in db.execute(
    f"SELECT DISTINCT to_id FROM edges WHERE edge_type = 'POTENTIAL_CALL' AND from_id IN ({marks})")]
print("symbols such a class calls (starts measured):", len(starts))

changed, added_total, removed_total, t_old, t_new = 0, 0, 0, 0.0, 0.0
biggest = Counter()
for sid in starts:
    ids = ",".join(map(str, [sid] + ctors_of(sid)))
    t = time.perf_counter(); old = {r[0] for r in db.execute(OLD.format(ids=ids))}; t_old += time.perf_counter() - t
    t = time.perf_counter(); new = {r[0] for r in db.execute(NEW.format(ids=ids))}; t_new += time.perf_counter() - t
    removed_total += len(old - new)
    if new != old:
        changed += 1; added_total += len(new - old); biggest[sid] = len(new - old)
print("starts whose transitive answer changes:", changed)
print("callers added over those starts:", added_total, " callers removed:", removed_total)
print(f"walk time over all starts: old {t_old*1000:.0f} ms, new {t_new*1000:.0f} ms")
for sid, n in biggest.most_common(5):
    name, path = db.execute("SELECT s.name, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?", (sid,)).fetchone()
    print(f"  +{n}  {path}:{name}")
