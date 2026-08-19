# ADR 005 — Staleness is a contract, not a best effort

- **Status:** Accepted and shipped (Stage 1, all eight items, 2026-08-07)
- **Decided:** 2026-08-07
- **Recorded:** 2026-08-19, backfilled from `IMPLEMENTATION_PLAN.md`
- **Evidence:** [`PLAN-EXCERPT.md`](proposals/staleness-contract/PLAN-EXCERPT.md) · `eval/f1-lock-scope.json`, `eval/e7-concurrency.json`, `eval/baseline-locks.json`

## Context

The P0 for a code-search tool is not being slow. It is **returning line coordinates that are
confidently wrong**, because an agent acting on stale coordinates edits the wrong lines and has
no signal that anything went amiss.

Two defects in this class were found, and both are worth preserving as shapes:

**F12 — the stamp/content inversion.** `runIndex` parsed *unlocked*, then stat'd the file
*after* the parse, inside the write lock. Content read at `T_parse`, stamped with an mtime read
at `T_stat > T_parse`. Any edit landing in that window — seconds wide, under the FTS growth
that ADR 012 later fixed — stored **pre-edit content with a post-edit mtime**. Every subsequent
staleness check (`diskMtime <= storedMtime` → fresh) is then **permanently disarmed**. Not a
stale read: a stale read that can never again be detected.

**F13 — `SQLITE_BUSY_SNAPSHOT` bypassed F2's stale flag.** A busy signal that can be dropped is
not a busy signal.

**And F11, which is the methodological one.** E7 tested whether per-batch advisory locking was
adequate and all three pre-committed criteria fired: JIT failure with **zero reindex running** at
**35% (N=2), 70% (N=4), 88.5% (N=8)** — pure reader-versus-reader, separate `mast serve`
processes on one state dir. Root cause was not the lock's *scope* but its *granularity and
semantics*: `markerPath(stateDir, type)` takes no file component, so `structure.lock` is **one
global lock per state dir**, and a JIT re-parse of file A blocks a JIT re-parse of file B across
disjoint rows — combined with fail-fast retry (3 × 100 ms, no queue), concurrent readers starve
each other.

The plan then **corrected its own framing on the record**: each criterion had been written as
"if this fires, F1's per-batch locking made contention worse." Arm A ran no reindex at all, so
F1 played no part. Reader-vs-reader contention was **pre-existing**. F1 is *insufficient, not
harmful*, and its 25× hold reduction stands. The criterion fired; the causal clause attached to
it was unverified. That is a distinct error class from a wrong measurement, and it recurs.

## Decision

**Every read tool either JIT-refreshes or stat-and-flags. No busy signal is droppable. The
reader-vs-reader contention class is dissolved by construction, not mitigated.**

- **F1** — bound lock hold to per-batch: max hold **11,078 ms**, down 25× from **280,782 ms**;
  p50 28 ms.
- **F7** — stat-and-flag staleness on every read path.
- **F2/F13/F14** — the busy flag is undroppable, including on empty results. An empty result
  that is empty *because the index was busy* must say so; silence there reads as "no matches".
- **F11** — narrow-role locking. Option (d)'s overlay half was deferred per E7-r2.
- **F12** — stamp after content, never before.

### The hard constraint, recorded because it is counter-intuitive

**`busy_timeout` IS the process-freeze window.** Raising it to make failures rarer lengthens
the freeze proportionally. It is not a tuning knob with a free direction.

## Consequences

- Stage 2 shrank the stale window as a side effect (245 s → tens of seconds). That is
  **mitigation, not a fix**, and does not retire F1.
- A JIT refresh can still fail during a *full* reindex of an already-large corpus if it lands
  inside one of that run's multi-second batches. F1 bounds the blast radius to one batch; it
  does not eliminate per-batch cost growth. That growth was ADR 011/012's problem, and is now
  fixed there.

## What this does not claim

F1's 25× reduction is a **hold-time** measurement, not a failure-rate one. E7 showed the
failure rate was governed by lock granularity, which F1 never touched — which is exactly why
the plan's original attribution had to be corrected.
