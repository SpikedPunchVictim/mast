# ADR 010 — The empirical method: pre-registration, appended results, a derived index

- **Status:** Accepted, and binding on all empirical work in this repo
- **Decided:** 2026-08-11 (first full pre-registration; the practice hardened through 2026-08-19)
- **Recorded:** 2026-08-19, backfilled from `IMPLEMENTATION_PLAN.md`, `FINDINGS.md`, and `docs/defects/`
- **Evidence:** every `PRE-REGISTRATION` / `RESULT` pair under `adr/proposals/*/PLAN-EXCERPT.md` · `FINDINGS.md` §3 and §6 · `docs/defects/LEDGER.md`, `docs/defects/SHAPES.md` · `eval/results/*-review.md`

## Context

This ADR has no single decision block in the plan, which is exactly why it is worth writing.
The method emerged as convention across sixteen experiments and is the thing every other ADR
depends on — yet it existed only as boilerplate repeated in each registration, plus rules in
`CLAUDE.md`, plus `FINDINGS.md` §6. A convention that lives only in its own instances is one
careless session away from not existing.

It was also *earned*. Three retrieval gold sets each encoded their own answer before anyone
noticed (ADR 002). A verdict was called and then withdrawn by an adversarial review. A bar was
registered on a statistic too noisy to resolve it. Each of those cost real time, and each
produced a rule.

## Decision

### 1. Pre-registration, before any measurement

Hypotheses, gates, the **estimator**, the scoreable outputs, and the direction of error are
written down and committed *before* the first run. The super-linear bar was **b ≥ 1.35**, fixed
before any measurement and **never moved** — which is the only reason `SUPER_LINEAR` at
b = 1.7529 means anything.

Naming the estimator is not ceremony. "Median per rung, OLS over nine points on log-log" is a
claim someone can check; "the exponent" is not. Where a registration also computes descriptive
statistics, they are labelled **explicitly descriptive and adjudicating nothing**.

### 2. Mandatory reading before writing a registration

`FINDINGS.md` **§1 (unread data)** and **§3 (dead hypotheses)**, with what was checked and found
stated *in* the registration. This rule exists because E1-EDGES was registered and retired the
same day, before any measurement, once it emerged that E1-AB had already answered the question
on the same corpus with a stronger arm — and its data had been sitting committed and unread for
four days.

### 3. Results are appended, never edited

`IMPLEMENTATION_PLAN.md` (now the `PLAN-EXCERPT.md` shards) is append-only. A correction is a
new block that names what it corrects — the `POTENTIAL_CALL` correction (ADR 007) sits after
the RESULT it overturns, not inside it. **`FINDINGS.md` is the sole exception**: it is a derived
index and is edited in place. When the two disagree, the shards and the scored artifacts win.

A RESULT block landing means `FINDINGS.md` updates **in the same commit** — headline verdict to
§2, any refuted hypothesis to §3 with the number that killed it. §3 is the section that pays for
itself: an unrecorded refutation gets re-proposed.

### 4. Confidence classes stay separate

**Measured**, **inferred from code/spec**, and **unmeasured** are labelled and never blurred
inside one sentence. §2.4 is the model: the scan mechanism is measured, the fix's *shape* is
measured on a synthetic corpus, the constant on a real repository is **inferred**, and
incremental cost at 150k chunks is **unmeasured** — four sentences, four labels, one topic.

### 5. Adversarial review at both ends

A design review before running, a results review after. Both are committed under
`eval/results/*-review.md`. The Fable review that withdrew Q1's verdict is the case for it: an
author is the worst available checker of their own work, because they check the parts they
thought about.

### 6. Two rules earned by getting it wrong

**Do not register a bar finer than its statistic can resolve.** E1-LADDER's H3 put a 1.30 bar on
the maximum of eight adjacent-rung local slopes. Neighbouring rungs differ by ~1.4× in chunks, so
`ln` of that ratio is ~0.34 and a 20% error in one rung's median moves the slope by ~0.5;
recomputed across rep pairings, the widths reach **1.560**. The bar was unresolvable, and the
noise was computable in advance from data already committed — nine journal rows and five minutes.
The registered form is refuted and **recorded as refuted**; the question it meant to ask was
answered post-hoc, labelled post-hoc, and adjudicates nothing.

**Compute the noise of the decision RULE, not of the statistic.** A closed form that sizes a
mean does not size the primary you actually registered.

### 7. The defect ledger, with a severity zero derived for this package

> **`mast` returns an answer that is silently incomplete or wrong, and is indistinguishable from
> a correct one — so a caller concludes "it isn't there" and edits or deletes code that is in
> fact referenced.**

Derived, not copied: `mast` never writes to user source, so the irreversible damage is
downstream, in a consumer told to search before opening any file. **D001** is exactly this,
already shipped and already fixed — a whale file blew the SQLite parameter ceiling, rolled back
its own transaction, vanished from the index, and the run **exited 0**.

A defect row is filed **while the reproduction is still in front of you**, never batched, and a
fix does not land without its row. Recurring shapes are promoted to `docs/defects/SHAPES.md` —
S-01 damage that leaves the exit code alone, S-05 two producers of one value drifting apart,
S-07 absence read as evidence, S-10 the check you ran is not the check that governs.

### 8. Two standing hazards, each of which has already cost a run

- **Never** open `graph.db` with `?mode=ro&immutable=1` — it is WAL-blind and will silently
  report an empty table.
- **Run every eval script from the repository root**, never from a subdirectory.

## Consequences

- Verdicts are quotable because the bar predates the number.
- Discarded runs are kept, with the reason, under `eval/results/discarded-*/README.md`.
- The cost is real and is meant to be. It is spent on artifacts that will be trusted without
  re-derivation, and *not* spending it is stated plainly rather than left silent.

## What this does not claim

The method does not make results correct. It makes them **checkable**, and it makes a wrong
result expensive to keep believing. Every entry in `FINDINGS.md` §3 is a hypothesis this process
let someone hold confidently for a while.
