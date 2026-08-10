# .history — numbered archive records (D5)

Append-only archive of completed plans, session logs, reviews, and decision
records for `packages/mast`. Files follow the ADR-style naming convention
adopted by Stage 4's D5 (IMPLEMENTATION_PLAN.md):

```
NNN-YYYY-MM-DD-short-slug.md
```

- **`NNN`** — zero-padded sequence number, strictly increasing, never reused.
  The number orders records; the date documents them. (The previous mixed
  scheme — `MM.DD.YY` directories alongside ISO-stamped files — broke
  lexicographic ordering across year boundaries: `06.02.27` sorts before
  `07.21.26`. See eval/GITNEXUS_COMPARISON.md §14.5's closing note.)
- **`YYYY-MM-DD`** — the date the archived content was finalized (not the
  date it was moved here).
- Records are **historical, not normative**: nothing in this directory is a
  contract, and nothing here is conformance-tested. Current truth lives in
  `MAST_SPEC.md` (spec), `IMPLEMENTATION_PLAN.md` (work), and
  `HANDOFF_Q1.md` (handoff state). When those documents retire a stage or
  plan, the retired document moves here under the next free number.

## Original-name index

Code comments and result blocks cite these documents by their original
filenames; those citations are history and are not rewritten. Map them here:

| Original name | Archived as |
|---|---|
| `2026-05-14T1402.md` (session log) | `001-2026-05-14-session-log-stage-8-verification.md` |
| `IMPLEMENTATION_PLAN.md` (v1, superseded) | `002-2026-05-14-implementation-plan-v1-archived.md` |
| `06.02.26/BUG_FIXES.md` | `003-2026-06-02-bug-fixes.md` |
| `IMPLEMENTATION_PLAN_VEXP.md` | `004-2026-07-21-implementation-plan-vexp-archived.md` |
| `07.21.26/FABLE_FEEDBAK.md` | `005-2026-07-21-fable-feedback.md` |

Next free number: **006**.
