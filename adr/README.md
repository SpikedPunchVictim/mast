# Architecture decision records

One file per decision theme. `NNN-YYYY-MM-DD-<feature>.md`, where **the number orders and the
date documents** — the date is when the *decision* was taken, not when the file was written.
ADRs 002–013 were backfilled on 2026-08-19 from `IMPLEMENTATION_PLAN.md` and each says so.

Supporting material lives in `proposals/<feature>/`:

| file | what it is |
|---|---|
| `PLAN-EXCERPT.md` | the verbatim append-only record the ADR was drawn from |
| `EVAL.md` | which eval scripts and result artifacts are this decision's instruments |
| `HANDOFF.md` | operational state, where one was written |

**Precedence.** Where an ADR and its `PLAN-EXCERPT.md` disagree, the excerpt and the scored
artifacts win. `FINDINGS.md` remains the single consolidated index of settled claims, dead
hypotheses, and unread measurements — and the only one of these files edited in place.

## The records

| # | date | decision |
|---|---|---|
| [001](001-2026-08-19-adr-system.md) | 2026-08-19 | Adopt an ADR system; retire the monolithic plan |
| [002](002-2026-08-02-retrieval-q1.md) | 2026-08-02 | Retrieval: hybrid search was never justified over lexical |
| [003](003-2026-08-04-vector-store-deletion.md) | 2026-08-04 | Delete the vector store (M2, arm D) |
| [004](004-2026-08-06-ranker-d.md) | 2026-08-06 | Ship ranker D; identifier fusion stays out |
| [005](005-2026-08-07-staleness-contract.md) | 2026-08-07 | Staleness is a contract, not a best effort |
| [006](006-2026-08-07-chunk-store-sqlite.md) | 2026-08-07 | Move chunk storage from Lance to SQLite |
| [007](007-2026-08-09-call-graph-resolution.md) | 2026-08-09 | Call-graph resolution, and what an unresolved call may claim |
| [008](008-2026-08-09-honest-surfaces.md) | 2026-08-09 | Honest surfaces: a tool reports what it does not know |
| [009](009-2026-08-10-measurement-harness.md) | 2026-08-10 | Determinism and the measurement harness |
| [010](010-2026-08-11-empirical-method.md) | 2026-08-11 | The empirical method: pre-registration, appended results, a derived index |
| [011](011-2026-08-17-indexing-scale.md) | 2026-08-17 | Indexing scale: the target, the ladder, and where the exponent lives |
| [012](012-2026-08-18-edges-knee.md) | 2026-08-18 | The edges knee, closed; and the incremental delete behind it |
| [013](013-2026-08-19-declined-scope.md) | rolling | Deliberately not doing |
| [014](014-2026-08-19-packaging-and-first-run.md) | 2026-08-19 | Packaging and the first-run experience |
| [015](015-2026-08-19-integration-harness.md) | 2026-08-19 | An integration harness, and the mutation axis it exists for |
| [016](016-2026-09-03-discovery-freshness.md) | 2026-09-03 | Discovery freshness: the gap JIT was never able to close |

## Reading order — which is not the numbering

The numbers run by decision date, so the method that governs every experiment lands after the
experiments. Read instead:

1. **[010](010-2026-08-11-empirical-method.md)** — the empirical method. Nothing else is legible
   without it, and it explains why the bars, the confidence classes, and `FINDINGS.md` §3 exist.
2. **[009](009-2026-08-10-measurement-harness.md)** — the harness those experiments ran on.
3. **[002](002-2026-08-02-retrieval-q1.md) → [003](003-2026-08-04-vector-store-deletion.md) →
   [004](004-2026-08-06-ranker-d.md)** — the retrieval arc, in dependency order: the evidence,
   the decision it fed, and the thing that shipped in place of vectors.
4. **[011](011-2026-08-17-indexing-scale.md) → [012](012-2026-08-18-edges-knee.md)** — the
   scaling arc. 012 depends on 011 and corrects a gap it left.
5. **[005](005-2026-08-07-staleness-contract.md) — [008](008-2026-08-09-honest-surfaces.md)** —
   the correctness stages. Independent of each other; read as needed.
6. **[014](014-2026-08-19-packaging-and-first-run.md) →
   [015](015-2026-08-19-integration-harness.md)** — how the package ships, installs, and
   upgrades, and the harness that will verify it does. 014 is the first ADR written under this
   system rather than backfilled into it; 015 is a design, not yet a thing that exists.
7. **[016](016-2026-09-03-discovery-freshness.md)** — reads as a continuation of 005: what
   the staleness contract covers, what it structurally cannot, and what now reports the
   difference.
8. **[013](013-2026-08-19-declined-scope.md)** — what is out of scope, and why. Read before
   proposing anything.

## Writing a new one

Take the next number and today's date. State the decision, the options you actually weighed, and
the consequences — then write **what it does not claim**, which is the section that keeps an ADR
honest as it ages. If the decision is empirical, ADR 010 governs: read `FINDINGS.md` §1 and §3
first and say in the registration what you checked and found.

Superseding an ADR does not edit it. Write the new one and set the old one's status to
`Superseded by NNN`.
