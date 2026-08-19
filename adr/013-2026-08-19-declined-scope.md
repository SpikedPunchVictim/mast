# ADR 013 — Deliberately not doing

- **Status:** Rolling. Amend as things are declined; do not rewrite history.
- **Decided:** ongoing (this record consolidated 2026-08-19)
- **Recorded:** 2026-08-19, backfilled from `IMPLEMENTATION_PLAN.md`
- **Evidence:** [`PLAN-EXCERPT.md`](proposals/declined-scope/PLAN-EXCERPT.md) · `FINDINGS.md` §4

## Context

A decision not to build something is a decision, and it decays faster than any other kind: the
reason evaporates, the option looks fresh again, and someone spends a week rediscovering why it
was declined. This ADR is the standing register.

## Declined outright

| | why |
|---|---|
| **GitNexus adoption** | PolyForm Noncommercial — unusable commercially. `impact` / `trace` / `rename` remain a **design study only**, per the licence bar |
| **F6** — batch Lance writes + version pruning | superseded by ADR 006; batching a store being removed is wasted work |
| **E3** — Phase 2 embed manifest check | already answered: the embed path already batches |
| **The A-vs-C backend benchmark** | **cancelled, not deferred** (ADR 003, condition 6). Re-entry runs it on the then-current corpus, not on this program's arms |
| **Ranker D's escape variant** | measured **harmful as constructed** (ADR 004). Any escape-like extension needs a fresh pre-registration |
| **Identifier fusion (IDFUSE)** | **INERT-LEVER** — fails as a scale rescue and harms off-stratum (ADR 004) |
| **E1-EDGES** | retired before measurement; E1-AB had already answered it with a stronger arm (ADR 012) |
| **Re-tuning `rrf_k`** | both hypotheses falsified; the finding is that **`rrf_k = 60` should not be changed** (ADR 002) |

## Closed — do not reopen without new evidence *and* a statement of what changed

Per `FINDINGS.md` §4: **Q4**, **harvest-as-verdict-source**, **Q1/SCALE**, **IDFUSE**,
**DECLEX**, and **the vector deletion**.

**Q4** deserves its own line, because it is a negative result and negative results get
re-proposed. Verdict: *the win has no nameable class, and the class that matters is absent.*
Its original Stage 5 framing (wire embedder completion, or stop reporting `mode: "hybrid"`) was
then made **moot** by ADR 003, which deleted both the embedder and the `mode` surface.

## Open, not declined — with the reason they are still open

These carry no verdict and are not evidence of anything:

| | state |
|---|---|
| **Q2** | should generated/minified files be chunked at all? (a 451 KB single-line file became 232 `block` chunks) |
| **Q3** | `populateFile` FTS insert cost grows with index size — partly addressed by ADR 011/012, not re-measured as Q3 |
| **Q5** | result diversification in `mast_search` — no per-file dedup. Held at P2 because the evidence was n = 1 and confounded by lexical-only mode. **Unblocked** now that Q1 is answered and Q4 moot |
| **Q6** | WAL auto-checkpoint stall — **RESCOPED 2026-08-11.** Round-1's signature is measured *absent* on the pre-F11 build, but that null is itself pre-F11; HEAD's reader/writer topology is **unmeasured** and round 1's own suspect is alive |
| **E5** | `mast index --checker` — untested. Does it convert enough truncated potentials into verified edges to justify the complexity? |
| **E6** | cross-language: are non-TS files dropped **silently**, making `mast_project_skeleton` present a partial map as complete? Same false-green class as F5 (ADR 007) |

## What this does not claim

**Q6 is the one to read carefully.** A measured-absent signature on a superseded build is not
evidence that the stall is gone on HEAD — that is `SHAPES.md` S-07, absence read as evidence.
Nothing in this register should be read as "measured and found harmless" unless it says so.
