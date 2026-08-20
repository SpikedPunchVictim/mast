# ADR 013 — Deliberately not doing

- **Status:** Rolling. Amend as things are declined; do not rewrite history.
- **Decided:** ongoing (consolidated 2026-08-19)
- **Recorded:** 2026-08-19, backfilled from `IMPLEMENTATION_PLAN.md`, `FINDINGS.md` §4, and `docs/defects/LEDGER.md`
- **Evidence:** [`PLAN-EXCERPT.md`](proposals/declined-scope/PLAN-EXCERPT.md) · `FINDINGS.md` §4 · `docs/defects/LEDGER.md`

## Context

A decision not to build something decays faster than any other kind: the reason evaporates, the
option looks fresh again, and someone spends a week rediscovering why it was declined. This is
the standing register.

**How this list was built, because a register that is secretly a *sample* is worse than none.**
It is the union of four enumerations, not a reading of the plan's own "Deliberately not doing"
section — that section holds five entries, and the real count is well over twenty:

1. every entry under the plan's `## Deliberately not doing`;
2. `FINDINGS.md` §4 (settled questions);
3. every `PLAN-EXCERPT.md` line matching *cancelled / retired / declined / withdrawn / moot /
   superseded / out of scope / deliberately NOT*;
4. every `docs/defects/LEDGER.md` row whose disposition is not a fix.

Section 4 below — **withdrawn claims** — came entirely from (3) and would have been missed by
reading the plan's own list.

## 1. Declined outright

| | why |
|---|---|
| **GitNexus adoption** | PolyForm Noncommercial — unusable commercially. `impact` / `trace` / `rename` remain a **design study only** |
| **F6** — batch Lance writes + version pruning | superseded by ADR 006; batching a store being removed is wasted work |
| **E3** — Phase 2 embed manifest check | already answered: the embed path already batches |
| **M5** — `edges` PK dedup | **withdrawn** — specified and tested intent (`verified-callers.test.ts:413–444`), not a defect |
| **Per-chunk quarantine on write failure** | the decision was **loud failure**: a bad chunk fails its file loudly rather than being partially recovered |
| **The A-vs-C backend benchmark** | **cancelled, not deferred** (ADR 003, condition 6). Re-entry runs it on the then-current corpus |
| **Ranker D's escape variant** | measured **harmful as constructed** (ADR 004). Any escape-like extension needs a fresh pre-registration |
| **Identifier fusion (IDFUSE)** | **INERT-LEVER** — fails as a scale rescue *and* harms off-stratum (ADR 004) |
| **E1-EDGES** | **retired before measurement** — E1-AB had already answered it, on the same corpus, with a 2× stronger arm (ADR 012) |
| **VS Code (or any editor GUI) in a container, to verify MCP registration** | driving an Electron GUI tests the editor, not mast. The mast-side contract — `mast serve` speaks MCP over stdio and completes a handshake — is assertable directly, and ADR 015's harness does exactly that |
| **Re-tuning `rrf_k`** | both hypotheses falsified; the finding is that **`rrf_k = 60` should not be changed** (ADR 002) |
| **Q6 mechanism isolation on the pre-F11 system** | isolating a mechanism that no longer reproduces, on a build whose topology has since changed, is **archaeology**. The useful form of the question is the HEAD-topology probe, measured forward |
| **Q6 as "the smaller alternative to E1"** | no longer available — not because it is closed, but because what remains of it can only be answered inside E1's ladder |
| **E1's 5-corpus panel as a decision axis** | out of scope **as registered**; recorded `panel_supporting_only`, and **no claim is made about it**. `n8n` is no longer a panel rung |

### Declined *fixes* — where not fixing is the discipline

| | why |
|---|---|
| **D014** — the scorer's post-hoc power formula | **OPEN and deliberately unfixed.** Editing an analysis instrument after seeing its output is exactly what pre-registration exists to prevent. The correction is recorded in the RESULT instead |
| **E1-HOIST's scorer** | **deliberately NOT patched**, same reasoning — a claim that survives on a number the scorer did not compute is recorded as such, not rescued by changing the scorer |
| **`parseMebibytes`' `Number()` looseness** | accurate nit, left unfixed: `0x10` and `1e3` pass the whole-number gate, but no arm uses either form and tightening it is a product change with no bearing on the experiment |
| **`--cache-size-mib 0`** | yields `PRAGMA cache_size = -0`; an untested edge no arm uses |
| **A second full-pipeline test for `super_method`** | deliberately not added; the extractor-level coverage is the layer where it belongs (ADR 010 / §5.5) |

## 2. Closed — do not reopen without new evidence *and* a statement of what changed

Per `FINDINGS.md` §4: **Q4**, **harvest-as-verdict-source**, **Q1/SCALE**, **IDFUSE**,
**DECLEX**, and **the vector deletion**.

**Q4** gets its own line, because negative results are the ones that get re-proposed. Verdict:
*the win has no nameable class, and the class that matters is absent.* Its original Stage 5
framing — wire embedder completion, or stop reporting `mode: "hybrid"` — was then made **moot**
by ADR 003, which deleted both the embedder and the `mode` surface.

## 3. Open, not declined — with the reason each is still open

These carry no verdict and are evidence of nothing.

| | state |
|---|---|
| **Q2** | should generated/minified files be chunked at all? (a 451 KB single-line file became 232 `block` chunks) |
| **Q3** | `populateFile` FTS insert cost grows with index size — partly addressed by ADR 011/012, **not re-measured as Q3** |
| **Q5** | result diversification in `mast_search` — no per-file dedup. Held at P2 because the evidence was n = 1 and confounded by lexical-only mode. **Unblocked** now that Q1 is answered and Q4 moot |
| **Q6** | WAL auto-checkpoint stall — **RESCOPED 2026-08-11.** Round-1's signature is measured *absent* on the pre-F11 build, but that null is itself pre-F11; HEAD's reader/writer topology is **unmeasured** and round 1's own suspect is alive. The scale row and a HEAD-topology probe moved to E1 |
| **`wal_autocheckpoint` tuning** | **untried, deliberately.** Verified: `graph/db.ts` sets `journal_mode`, `foreign_keys`, and `busy_timeout` and **never** overrides it. Q6's original suggestion is to be evaluated against E1's numbers, not speculatively |
| **E5** | `mast index --checker` — untested. Does it convert enough truncated potentials into verified edges to justify the complexity? |
| **E6** | cross-language: are non-TS files dropped **silently**, making `mast_project_skeleton` present a partial map as complete? Same false-green class as F5 (ADR 007) |
| **Incremental re-index at 150k chunks** | **unmeasured.** No eval harness measures it, and ADR 012 did not change that |
| **`ρ_D(T9) = 0.8486`** | from E1-AB, **unexplained**. The exponent is gone; that correlation was never the same question |

## 4. Withdrawn claims — recorded so they cannot recirculate

The most easily lost category: things this repo asserted, then retracted. Each was written down
somewhere confident, and each would otherwise be re-derived by the next reader of that text.

- **The live-WAL "deferred checkpoint" datum.** A `graph.db-wal` 2.6× over the autocheckpoint
  threshold was read as evidence that passive checkpoints were being deferred. **Withdrawn, and
  the withdrawal is measured, not argued**: a passive checkpoint never shrinks the `-wal` (it
  resets and reuses at the high-water mark — 11.66 MB before *and* after; only `TRUNCATE`
  shrinks it), and a single 2,600-page transaction produced an 11.66 MB WAL **with no reader
  ever existing and nothing deferred**. The asserted mechanism is false as stated: better-sqlite3
  holds no snapshot between statements, so a completed `.get()` in autocommit leaves the next
  passive checkpoint fully unobstructed. A 2.6×-over-threshold file is evidence of a past large
  transaction and nothing more.
- **A10 — a review claim rejected after verification.** A review stated that `stdout_tail` would
  drop the `files:` line once `pragmas:` printed. **False**: `e1-common.mjs:329` takes
  `slice(-3)` and a phase-timed run emits exactly three lines, so all three are retained —
  confirmed empirically against the real `dist` binary. Recorded explicitly *so it cannot
  recirculate*, which is the only reason a rejected review nit is worth writing down.
- **Stage 4.5's forward-looking scale analysis.** Substantially **superseded** — written before
  E1 and before the vector deletion. Its vector paragraph is **moot, not falsified**; the
  distinction is kept because "we deleted the thing" and "the claim was wrong" are different
  statements and only one of them is evidence.
- **`POTENTIAL_CALL` as a resolution *failure*.** Inverted at both sites that asserted it — see
  ADR 007.
- **"379 ms for one file at any corpus size."** The magnitude is plausible; the **invariance**
  was the error, and it was the load-bearing half — see ADR 012 and `FINDINGS.md` §3.

## What this does not claim

**Q6 is the one to read carefully.** A measured-absent signature on a superseded build is not
evidence that the stall is gone on HEAD — that is `SHAPES.md` **S-07, absence read as evidence**.
Nothing here should be read as "measured and found harmless" unless it says so.

Sections 1 and 4 are enumerated from the sources named above and are complete **as of the
2026-08-19 shard split**. Section 3 is a status list, not a backlog: nothing in it is scheduled.
