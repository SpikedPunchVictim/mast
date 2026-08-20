# `.agents/`

Working artifacts produced by agent runs against this repository — the raw output of an
investigation, kept because something durable cites it.

## What belongs here

A document earns a place here when a **ledger row, an ADR, or a plan names it as evidence**. The
2026-08-20 full-codebase bug hunt is the founding case: `docs/defects/LEDGER.md` records it as the
discovery instrument for **D031–D037** and, indirectly, for the REVIEW items that became
**D038–D040**. Those rows say "found by a full-codebase bug hunt (all 9 lenses)"; without the
document, that citation resolves to nothing and a reader cannot check what was actually looked at
— including the parts the hunt says it *did not* look at, which is the more useful half.

## What does not

Session transcripts, scratch output, anything nothing cites, and anything that would be duplicated
by the artifact it fed. A finding that made it into the ledger, an ADR, or `FINDINGS.md` lives
there; this directory holds the working document, not a second copy of the conclusion.

## Status of what is here

`research/2026-08-20-bug-hunt-full-codebase.md` is **complete and dispositioned**. Its six BUG
findings were fixed (D031–D037) and its three "Needs Human Review" items were settled on
2026-08-20 — a disposition table at the head of that section records which row each became. Read
it for the reasoning and the refutation log; read the ledger for what is currently true. **Where
the two disagree, the ledger wins**: this file is a snapshot of one session's beliefs and is not
maintained in place.

Its own "What I could not check" section is the most reusable part, and one item from it is still
open: `src/ast/extractors/typescript.ts` (1,637 lines) was never read in full, which the hunt
names as its single largest coverage gap. D040 was resolved by measuring around that gap rather
than closing it.
