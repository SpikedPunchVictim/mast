# ADR 007 — Call-graph resolution, and what an unresolved call may claim

- **Status:** Accepted and shipped (Stage 3, 2026-08-09; extended by Stage 4.7, 2026-08-19)
- **Decided:** 2026-08-09
- **Recorded:** 2026-08-19, backfilled from `IMPLEMENTATION_PLAN.md`
- **Evidence:** [`PLAN-EXCERPT.md`](proposals/call-graph-resolution/PLAN-EXCERPT.md) · the `POTENTIAL_CALL` correction lives physically in [`edges-knee/PLAN-EXCERPT.md`](proposals/edges-knee/PLAN-EXCERPT.md) · `docs/defects/LEDGER.md` D023

## Context

`mast_callers` was returning **confidently-empty** answers — the worst failure mode a code-search
tool has, because an empty result is indistinguishable from "this symbol has no callers" and an
agent will act on it.

Four causes, all shipped fixed:

| | | |
|---|---|---|
| F3 | `parseCallee` never unwrapped `await_expression` | one line |
| F4 | `this.` / `super.` resolution was **documented in the spec and never built** | |
| F5 | the potential set for methods was constructed wrong | design change |
| F10 | `potential_truncated` was silently capped at 50 when the real count was 71 | |

F5's fix is the interesting one. The obvious repair — pass the unqualified leaf name — widens
the potential set ambiguously across every class that happens to declare that method name. The
chosen fix indexes **qualified** names into `identifier_fts` instead: a schema bump and a
reindex, which cost nothing under never-shipped.

F3 and F4 both **ride the existing receiver-binding machinery** (`LocalTypeEnvironment`'s typed-receiver
path) rather than adding a second resolution mechanism. Two mechanisms resolving the same thing
drift, and the drift shows up as inconsistent answers rather than as a crash.

## Decision

**A call the resolver cannot pin must be visibly unpinned. A truncated set must say it was
truncated. Resolution has one mechanism, and it operates on qualified names.**

### Stage 4.7 — fix at the source, not per site

`FINDINGS.md` §2.3 carried a named residual since the D004 fix: on a case-insensitive
filesystem a mis-cased import resolves, `statSync` cannot report the match was inexact, and the
resolver returns the *specifier's* casing while the walker records the *on-disk* casing. The
registered plan was a case-folded lookup on the resolution-miss path. **It was not built**, for
two reasons found while building it:

1. **The site count was wrong — twice.** The risk was written as if one join consumed
   `resolvedPath`. Four sites do. Three join against `files.path` and match nothing when casing
   disagrees; the fourth (`queryDependencies`, backing `mast_dependencies`) does not join at
   all — it hands `resolved_path` straight back, so a mis-cased import emitted a path matching
   no indexed file: **wrong output rather than absent output**. Two of the four run at *query*
   time with no populate-side file map, so the registered mechanism could not have covered them.
2. **A cheaper mechanism exists, and it cannot guess.** `realpathSync.native` calls the platform
   `realpath(3)`, which reports the name as spelled on disk; the JS `realpathSync` echoes the
   casing it was handed. `safeRealpath` already sat on every resolution path and already had to
   resolve symlinks — switching its implementation corrects the casing *before*
   `imports.resolved_path` is written, so all four consumers are right by construction.

A case-folded map must choose when `Foo.ts` and `foo.ts` both exist. That is a guess, and it is
D004 exactly. Asking the OS never chooses. **A per-site guard is only ever as complete as the
site list, and this site list was wrong twice** — which is the argument for fixing at the source.

### `POTENTIAL_CALL` means the opposite of what the record said

Recorded 2026-08-18, appended rather than edited. The claim as written — "`POTENTIAL_CALL` is
what the resolver emits when it *cannot* pin a call" — is **inverted**. A stored `POTENTIAL_CALL`
row is a **successfully resolved** call: `populate.ts:728-736` takes `to_id` from `callToMap` and
returns `[]` when it is undefined, so an unresolved call produces **no row at all**. The edge
type names the *class of call requiring file-evidence resolution*, not a failure to resolve.

So the rising 0.259 → 0.370 rows/chunk means a growing fraction of call sites **succeed** — the
sensible direction, since a larger corpus contains more of its own targets.

Two things worth keeping from how that was found. A `to_id IS NULL` count was briefly taken as
evidence; `edges.to_id` is declared `INTEGER NOT NULL`, so zero nulls is **vacuous** — and the
vacuous check *agreed with the right answer*, which is the most dangerous kind of wrong evidence.
And `potential_call_count` is still not a work counter, now for a sharper reason: it counts
successes and omits every failed resolution attempt, each of which costs real time and leaves no
trace.

## Consequences

- `mast_callers` returns real call sites for methods, with truncation surfaced.
- `imports.resolved_path` carries on-disk casing by construction; no consumer needs a guard.
- E1-SCAN's H3 refutation is **unaffected** — it died on a measured slope (1.1051 against a
  registered [1.15, 1.55] band). Only the explanatory sentence attached to it was wrong.

## What this does not claim

Stage 3 completion does **not** claim the corpus edge-count criterion (1,038 → toward 1,124
`this.` + 20 `super.`). That is E2's registered measurement and is tracked there.
