# ADR 016 — Discovery freshness: the gap JIT was never able to close

- **Status:** Accepted and shipped (2026-09-03)
- **Decided:** 2026-09-03
- **Evidence:** `docs/defects/LEDGER.md` D054 · commits `e44b0e8`, `4022c8e` ·
  measurements reproduced in this ADR, all taken 2026-09-03

## Context

[ADR 005](005-2026-08-07-staleness-contract.md) settled what happens when an indexed file
*changes*: every read tool either JIT-refreshes it or stat-and-flags it, and no busy signal
is droppable. That contract holds and is not revisited here.

It does not cover a file that was never indexed at all, and the distinction had been
allowed to blur. `jitRefreshFile` reads the `files` row for a path and **returns early when
there is none** — an unindexed file has no stored mtime to compare against, so there is
nothing for the mechanism to act on. `findStaleFiles` only ever stats paths already behind
results, so it cannot see a file that produced no result. Both mechanisms are, by
construction, blind to new files.

With `mast serve --watch` opt-in — which it was until this ADR — that meant the default
configuration had a hole shaped exactly like this package's severity zero: **a file created
during a session was invisible to every read tool for the rest of that session, and
`mast_search` reported the absence with no signal at all.**

Reproduced on a two-file temp project indexed at one file, serving with
`--no-watch --no-startup-reindex`:

```
mast_search{query:'betaTwo'}     -> results=0, no index_empty, no other signal
mast_signature{symbol:'betaTwo'} -> results=0, no index_empty, no other signal
```

A confident empty answer, indistinguishable from a correct one, for a symbol sitting on
disk in the project root. The ledger header's S0, reached through a default rather than a
bug.

Two documents had been asserting the opposite. `README.md`'s summary bullet claimed the
index "never goes stale without the assistant knowing", and its "JIT Staleness Checks"
section claimed every read tool calls `jitRefreshFile`. Both were false, and the second was
found only after the first had been fixed — by grepping the document for its own keyword.
That is D054, and the sub-shape it earned under S-04.

## Decision

**Discovery freshness is a separate problem from staleness, and gets its own mechanisms.
Where a mechanism cannot close the gap, the gap is reported rather than described as
closed.**

1. **`mast serve` watches by default.** `--no-watch` opts out; `--watch` is still accepted
   and selects the default, so existing MCP client configurations are unaffected. This is
   the only mechanism available that closes the window with no per-query cost, and it was
   already safe to default: watcher construction failure (EMFILE, permissions) degrades to
   serving without it, so the default cannot prevent the server from starting.

2. **`mast_search` reports the size of the blind spot** as `unindexed_files`, from a
   TTL-cached probe (`src/mcp/freshness-probe.ts`) rather than a per-request measurement.
   `null` — no measurement yet — is rendered as silence, never as zero.

3. **The CLI gets an explicit `--reindex`** on `mast search` and `mast query`, because it
   has neither of the above: no watcher, and no probe, since a one-shot process has no
   lifetime over which to amortise a TTL.

### Why the probe is cached rather than measured per call

| | measured |
|---|---|
| `fusedSearch` on a small tree | ~4 ms |
| `measureFreshness` walk, 13,985 files | ~183 ms |

Answering on the request path would make a search roughly 45× slower to report a warning
that is almost always absent. The probe returns the last measurement synchronously and
refreshes behind the caller on a 30 s TTL.

**This is amortised, not free, and the distinction is recorded because it is the kind that
gets rounded away.** `walkProject` globs asynchronously but then `statSync`s every hit in a
synchronous loop, so a refresh occupies the event loop for part of its duration and a
search landing mid-refresh can be delayed. One such window per TTL, rather than one walk
per search, is the whole of the improvement.

### Why `--reindex` is opt-in

Measured on this repository (212 indexable files): a no-op incremental run reports **25–34
ms** of index work inside **~0.5 s** of process wall clock; a run that found 11 changed
files reported **424 ms**. It scales with the tree, and `mast search` is used in scripts and
loops.

An earlier draft of the flag's help text asserted "~1 s", carried over from a figure derived
on a different corpus. It was replaced with the measurement above rather than rounded into
agreement — S-03, caught before it shipped.

## Consequences

- The SDD container and the integration harness pass `--no-watch` explicitly. For the
  harness this is load-bearing rather than cosmetic: a chokidar watcher over the 26,321-file
  n8n corpus would reindex underneath a running scenario and make its assertions
  nondeterministic.
- `--reindex` **refreshes, it does not bootstrap.** It runs strictly after `runQuery`'s
  never-indexed guard, so a missing `graph.db` still fails fast with that guard's message
  instead of being created as a side effect of the flag.
- A failed `--reindex` warns and answers from the existing index. `runIndex` takes
  `structure.lock`, and with the watcher now on by default, losing that race is an ordinary
  outcome rather than an exception.
- `unindexed_files` is the name of both a `mast_search` count and a `mast_status`
  `freshness_cause` value. Same population, deliberately the same word; §9.0 records how
  they differ in shape and freshness.

## What this does not claim

- **The warning is on `mast_search` only.** `mast_signature` and the other six
  result-returning tools still answer `results=0` with no `unindexed_files`, as the
  reproduction above shows. `index_empty` covers the all-or-nothing case for all eight; the
  partial case is covered on one. This is a known, measured gap, not an oversight.
- The watcher is a discovery-freshness optimisation, never a correctness mechanism, and it
  does not reopen the §3 no-daemon non-goal — it lives and dies with the serve process.
- No claim is made that the 183 ms walk figure transfers to other trees; it is one
  measurement on one corpus, quoted to justify a cache, not to characterise scaling.
