# ADR 003 — Delete the vector store (M2, arm D)

- **Status:** Accepted and executed (Stage 7, `1522ef1`). **Closed — do not reopen** without new evidence and an explicit statement of what changed (`FINDINGS.md` §4).
- **Decided:** 2026-08-04 (memo) · executed 2026-08-06
- **Recorded:** 2026-08-19, backfilled from `IMPLEMENTATION_PLAN.md`
- **Evidence:** [`PLAN-EXCERPT.md`](proposals/vector-store-deletion/PLAN-EXCERPT.md) · [`EVAL.md`](proposals/vector-store-deletion/EVAL.md) · `eval/results/m2-memo-review.md`

## Context

M2 asked which chunk-storage backend MAST should stand on. ADR 006 framed four arms, two of
which had no evidence behind them at all. ADR 002 then spent a month asking whether the vector
half of the hybrid path was earning its place.

By 2026-08-04 the benefit side had been given **four independent pre-registered chances** to
show a value that reaches the user, or to find a niche lexical cannot serve. The one niche that
survived three of them — the identifier stratum at scale — turned out to be closable by a
one-line lexical rule, shipped as ranker D at **+14.67 pp efficacy [+9.33, +20.0]** with a
seed-invariant decision-contrast upper bound of **exactly 0**.

## Options considered

Arm D was chosen over a genuinely considered middle option (keep the vector path but stop
maintaining it), which was **rejected** — an unmaintained dependency with a 7.2 h build-time
embed and a model-weights Docker layer is not a cheaper version of keeping it, it is the same
cost with none of the accountability.

The memo's distinguishing feature is that it **confronted five gaps on the record** rather than
around them, and shipped anyway with the gaps named:

| gap | status at decision |
|---|---|
| 1 | the S-prose T4 LEVEL gap vs H, and the kluster-normal H−L baseline |
| 2 | harm on identifier-free / mixed-case-prose queries — **UNTESTED** |
| 3 | outcome-at-scale — still Reserve, **unmeasured** |
| 4 | counterpart-credit composition and generalization limit |
| 5 | doc-chunk retrieval — a surface the handoff list did not name |

## Decision

**Delete the vector store entirely. Ship ranker D without the escape variant.**

Deletion is **total at code level** — this repo has never shipped to a customer, so there are
no migrations and no back-compat: `@lancedb/lancedb`, `vectors.lance`,
`embedder.ts`/`background-embedder.ts`, `vectors.lock`, the embed cache, the model-weights
Docker layer, seed Phase 2, the `mode` discriminator, and cold-start ladder Step 4's embed
half. AST, graph, and FTS tools are untouched — pure tree-sitter and SQLite.

Six conditions were attached as **constitutive, not advisory**:

1. **F18 scope** — ranker D exactly as measured, *without* the escape variant (measured
   harmful as constructed). Any escape-like extension needs a fresh pre-registration.
2. **Regression suite** — Gate B's fixtures become permanent tests, not throwaway checks.
3. **Kill-switch** — D ships behind a default-on config flag, with D-fire telemetry to the
   `metrics` table. Without the telemetry, neither the kill-switch nor re-entry criterion 1
   has an input signal.
4. **Deletion is total** (above).
5. **The organic harvest remains the standing instrument.** Archived embedded assets are kept
   off-repo (`eval/ASSETS.md`) so re-entry never re-pays the 7.4 h embed to rebuild the H
   baseline. A dated review fires at harvest n ≥ 67 or 90 days, whichever comes first — and
   **n = 0 at that review is itself a finding**, forcing a re-decision of the monitoring plan.
6. **Plan consequences** — Q4 and the ANN lever become moot; the A-vs-C benchmark is
   **cancelled, not deferred**.

### Re-entry criteria

Written in advance, so that reversing this is an evidence question rather than an argument:

- harvested agent-authored queries showing window-membership degradation against the archived
  H baseline;
- a product shift making prose-first retrieval load-bearing (Gap 5's trigger);
- sustained D-fire displacement telemetry showing D demoting in-window targets materially
  above the single instance observed in this program.

Re-entry runs through the A-vs-C benchmark **at that time, on the then-current corpus** — not
by resurrecting this program's arms.

## Consequences

- Post-deletion search is **L + D** — FTS BM25 plus ranker D under RRF — exactly the arm that
  was measured. No ranking change was introduced by the deletion itself (ADR 004 shipped D
  into the existing fusion first, deliberately).
- `mode: "hybrid"` and the cold-start ladder's embed half disappear from the honest surface
  (ADR 008).
- The dependency, the Docker layer, and the 7.2 h embed leave the build.

## What this does not claim

The 470 MB / 169 ms cost figures price the **brute-force configuration only** — arm A with
IVF-PQ was never measured. The 7.2 h embed is a build-time cached cost, not a per-query one.
This decision rests on the *benefit* side failing to materialise, not on those cost numbers
being tight.

Gap 2 (harm on identifier-free / mixed-case-prose queries) was **untested at decision time and
is still untested**. It is the reason condition 3 exists.
