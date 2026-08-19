# ADR 009 — Determinism and the measurement harness

- **Status:** Accepted and shipped (Stage 4, D0–D8, 2026-08-10/11)
- **Decided:** 2026-08-10
- **Recorded:** 2026-08-19, backfilled from `IMPLEMENTATION_PLAN.md`
- **Evidence:** [`PLAN-EXCERPT.md`](proposals/measurement-harness/PLAN-EXCERPT.md) · [`EVAL.md`](proposals/measurement-harness/EVAL.md)

## Context

Every experiment recorded in ADRs 002–004 and 011–012 depends on the harness being trustworthy.
This stage is what made it so, and it exists because measurements were already being read that
the harness could not actually support.

## Decision

**Two identical index runs produce identical output; every claim in the spec is either tested
or quarantined as prose; and the thing being measured is the thing that ships.**

| | | |
|---|---|---|
| **D0** | CLI query surface at parity with the MCP read tools (`mast query <tool> <json>`) | sequenced **before** Stage 3 — a force multiplier for every verification task, not a convenience |
| D1 | sort `walkProject` output | killed ±4/3,940 edge nondeterminism |
| D2 | repair `eval/` as a regression harness — `paths.mjs` pointed at a dead session; pin the corpus | |
| D3 | spec conformance: quarantine mechanism prose, add `spec-conformance.test.ts` with `// MAST_SPEC.md:NNN` citations | |
| D4 | test-assertion rule: **no `unknown[]`** in response type annotations; every returned array gets a content assertion | |
| D5 | numbered archive convention | see below |
| D6 | the metric set — **rescoped** 2026-08-10 | see below |
| D7 | self-oracle invariant tests over a real corpus + property-based call-shape generation | |
| D8 | deploy freshness — `build` added to the verification baseline | see below |

### D4 is the one that pays repeatedly

A test annotating a response as `unknown[]` and asserting only its length is a test that passes
when the contents are wrong. Banning the annotation is what makes the rest of the suite's green
mean something.

### D6 was rescoped rather than delivered as written

Five of ten registered rows were **retired or already served** by instruments that had shipped
in the meantime, and three moved to E1/E2. What remained: latency percentiles, a lock
summarizer, and a config invariant test. Recording the retirement mattered more than the
delivery — a metric table half-built and reported as built is how a harness starts lying.

### D8 — the shipped sweep was not the running tool

Found by verifying the baseline, **not by a test**. `which mast` resolved through a symlink into
this repo's own `dist/`, built 2026-08-07 13:53 and carrying `CURRENT_SCHEMA_VERSION = '1.2.0'`
while `src/store/config.ts` was at `1.3.0`. The binary that MCP — and therefore every agent
session, *including the one that found this* — actually executed predated the entire
2026-08-08…08-10 sweep: F5, F3/F4, F10, M6, C1, F9, and D6's new columns were all in source and
absent from the tool.

`build` is now part of the verification baseline. The class of error is general: a green suite
proves `src/` is correct, and says nothing about what is installed.

### D5 — the convention this repo's ADRs inherit

`.history/`'s mixed naming (`MM.DD.YY` directories beside ISO-stamped files, which breaks
lexicographic ordering across year boundaries) was replaced by flat, zero-padded
`NNN-YYYY-MM-DD-slug.md` records, with a `README.md` documenting that **number orders, date
documents; append-only; records are historical, never normative, never conformance-tested**.

Citations in code and result blocks to the old names were **deliberately not rewritten** —
they are history — and remain resolvable through an original-name index. ADR 001 reaches the
same conclusion about `IMPLEMENTATION_PLAN.md`'s 663 citations, by the same reasoning.

## Consequences

- The `adr/NNN-YYYY-MM-DD-<feature>.md` scheme in ADR 001 is D5's convention applied to live
  decisions rather than to archived ones.
- `MAST_SPEC.md` prose that asserts a mechanism is either cited by a conformance test or
  explicitly quarantined.

## What this does not claim

D1 removes *walk-order* nondeterminism. It does not make the whole pipeline deterministic; the
scaling experiments still run 3 reps per rung and quote medians for that reason.
