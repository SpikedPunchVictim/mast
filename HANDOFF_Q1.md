# HANDOFF — Q1 / M2 track, as of 2026-08-02 (commit `ca768e2`)

You are taking over an evidence-first investigation in `packages/mast`. Branch `ui`, tree
clean, suite green. Read this file first, then `IMPLEMENTATION_PLAN.md`.

---

## 1. The question, and why it is still open

**Q1: is MAST's vector store justified at all, or does lexical BM25 suffice?** It gates
**M2** — Lance+IVF-PQ vs sqlite-vec, or deleting the vector store entirely, which drops a
91 MB dependency, a ~7 h embed, and 470 MB RAM at the 153k-chunk scale target.

**Q1 is AMBIGUOUS. M2 is BLOCKED.** Exactly one open line of attack remains (§4).

Do **not** skip to M2's A-vs-C backend benchmark. That is the expensive step this entire
investigation exists to gate.

---

## 2. The state of the argument — three independent lines now converge

This is the single most important thing to inherit. Each was pre-registered before running.

1. **Q1/OUTCOME (the task-outcome A/B).** 30 runs, 12 tasks × 2 arms + 6 noise-floor.
   Hybrid vs lexical produced **byte-identical `(file, symbol)` answers on 12/12 tasks**,
   including every failure. b = 0, c = 0, McNemar p = 1.000. Effort non-significant on both
   metrics. Six queries were issued verbatim by both arms; **all six returned different
   ten-result windows (overlap 3–9 of 10) and every one led to the same answer.**
2. **Arm V (equalised).** The vector ranker *alone* is statistically indistinguishable from
   the shipped fusion on all three gold sets (V−H: |t| < 0.8 everywhere). The lexical half
   contributes nothing detectable on prose queries.
3. **Q4 (win-class labelling).** Hybrid's advantage is *flat* — no nameable query class
   carries it (short +0.125 vs long +0.130). And **only 2 of 59 gold queries across all
   three sets are identifier-bearing**: 97% of the ranking evidence base is prose.

**Joint conclusion: ranking metrics on prose gold sets cannot settle Q1.** Items (3) and (4)
of the old order are retired as sources of a verdict. Do not re-open them hoping for one.

**The load-bearing mechanism, measured:** agents never search using the question's wording —
**0 of 147** logged searches did. They rewrite into code-token shorthand first. A reader who
can rephrase their own query is largely insulated from ranking quality. That is why rank
moved and outcomes did not.

---

## 3. Settled — do NOT re-run these

- **F15 (shipped):** FTS OR-join in `toFtsMatch` (`search/fts.ts`). Fixing one line more than
  halved the measured value of vectors. Lexical levers move these numbers a lot.
- **F16 is CLOSED. `rrf_k` stays 60.** Both hypotheses falsified under full embeds. Arm V's
  raw means briefly suggested reopening it; the paired CIs said no (|t| < 0.8). Do not
  reopen on a point estimate.
- **Identifier-decomposition Design Reserve: DISCHARGED.** Both registered constructions
  tested, both rejected on measured grounds. RESERVE-1 harmful (−0.1661, Recall 1.000→0.727,
  RRF vote-dilution); RESERVE-2 a measured null.
- **The shipped trigram tokenizer is doing real work.** W−L significantly *negative* on both
  kluster sets. **Do not "modernise" `chunk_fts` to unicode61.**
- **Authoritative ranking baseline** (`q1-final.mjs`, full embeds, paired CIs):
  kluster-normal H−L = 0.1669 [0.028, 0.306] SIG; kluster-anti 0.1313 [0.068, 0.195] SIG but
  **one-directional** (may kill vectors, never justify them); nest-external 0.1003
  [−0.058, 0.259] NOT SIG.
- **Counter-evidence to carry forward:** under a leave-one-out-selected lexical baseline,
  kluster-normal *loses* significance (t = 2.206 vs crit 2.228). The defensible claim is
  "the home-field result is not robust to the choice of lexical baseline," **not** "vectors
  are dead."

---

## 4. YOUR NEXT ACTION — item (5), the 153k scale-out

**This is the only remaining attack on the one caveat that blocks M2.**

The gap: every benefit measurement is at **~14.5k chunks**; the cost (91 MB / ~7 h / 470 MB)
is priced at **153k**. BM25 over OR'd trigrams plausibly degrades as the corpus grows (more
distractors sharing trigrams) in a way vectors may not. **A SUPPORTED verdict at 14.5k does
not license deletion at 153k** — this is registered as verdict-blocking, and it is the
honest reason Q1 is still open despite three converging lines.

**Do this, and only this, first:** scale out **Gate 4's rank-delta pre-check** (`eval/ab-rank-check.mjs`)
onto a ~153k-chunk corpus. It needs **no agent runs and no gold set** — it measures, per
query, the rank of a known target under hybrid vs lexical. Cheap in tokens; the cost is a
~7 h embed. Suggested corpus: vscode (the 153k figure came from it).

Pre-register before running, per §6. In particular pre-state:
- What result would show lexical *degrading* with scale (the pro-vector outcome), and what
  would show the 14.5k picture holding.
- That this measures **retrieval**, not outcomes — it cannot by itself resolve Q1 in the
  pro-vector direction without an outcome test at that scale.

**Reserve (pre-thought, NOT commitments):** an outcome A/B at 153k; a `--no-embeddings`
container A/B; shipping D0 (a real `mast search` CLI) so the A/B harness's Bash-surface
caveat disappears.

---

## 5. Known defects — fix before any repeat, do not grade around them

- **Harvester/prompt mismatch (confirmed, `eval/ab-agent-prompt.md`).** The agent prompt asks
  agents to "find the code this describes"; `ab-build-tasks.mjs:88-104` grades against the
  *first uniquely-resolving backticked identifier* — a symbol the line *mentions*, not the
  one it is *about*. This made T01/T04/T06 false failures. Align one to the other and
  pre-register a referent-ambiguity rule. (`b = c = 0` is unaffected — both arms gave
  identical answers, so no regrading can create a discordant pair.)
- **`ab-score.mjs` never implemented Wilcoxon** (registered as co-primary B's primary test);
  it used a sign test on *total* calls instead of calls-to-first-sighting. Both corrected in
  AMENDMENT 3; implement Wilcoxon before reusing the scorer.
- **McNemar:** the registration's worked example is one-sided, the implementation two-sided.
  Moot at b = c = 0; fix the registration text before the next run.
- **`hybrid.ts:55`** defaults `chunkStore` to the RETIRED Lance chunk table. Any new caller
  omitting it gets zero results with no error. Always pass it explicitly.
- **`hybrid.ts:102-104`** swallows embedder failure and silently returns `mode: "lexical"`.
  Any hybrid-arm harness must assert `mode` per call or it can decay mid-experiment.

---

## 6. Methodological rules — non-negotiable, learned the hard way here

- **Pre-register in `IMPLEMENTATION_PLAN.md` and commit the registration BEFORE running**,
  including falsification criteria. Amendments are appended with a timestamp, a reason, and
  **which direction the error ran**.
- **Report confidence intervals, not point estimates.** This has now caught two false leads
  (an "external replication" 9× smaller than its own SE; arm V appearing to beat H).
- **A result that flatters the thing you are testing deserves MORE scrutiny.** Multiple
  verdicts here were harness artifacts, all found by asking "is this too clean?"
- **"Reports success wrongly" is severity zero.** Hunt the whole class, fix together, codify
  an invariant.
- **Check the artifact, not its neighbour.** Four errors in this program came from grading
  against the wrong artifact.
- **Validate any reimplemented pipeline against the shipped one before believing new arms**
  (`q1-reserve2.mjs` self-check, 0 mismatches — reuse it).
- **Commission an adversarial review, of the design AND of the results.** Use a Fable agent
  (`Agent` tool, `model: "fable"`). On the design it caught a fake-null path, broken
  blinding, and a decision rule firing at p ≈ 0.27. On the results it caught five errors,
  **four of which ran in the investigator's own favour**. Verify its claims — it has been
  wrong before, and it withdrew several of its own findings on checking.

---

## 7. Operational

- **Run every script from `packages/mast`**, never the repo root.
- **Off-repo assets: see `eval/ASSETS.md`** — what each contains, which experiment needs it,
  rebuild cost. ~590 MB of embedded state = ~45 min compute. Remove worktrees with
  `git worktree remove`, never `rm -rf`. `~/.cache/mast-eval/ab-wt` (1.5 GB) is disposable.
- **Never** open `graph.db` with `?mode=ro&immutable=1` for metrics reads — WAL-blind,
  reports `metrics` as empty. This cost a session a false conclusion.
- `MAST_EVAL_STATE` required by nearly every script; `MAST_EVAL_R2=1` required by
  `build-corpus.mjs` or you rebuild the void v1 corpus.
- **Evidence is committed** under `eval/results/` — all 30 run outputs, the 147-call search
  log, the sealed arm manifest, every results JSON. `eval/README.md` is STALE.
- Verification baseline: `pnpm -F mast test` → 382 tests / 34 files; `typecheck`; `lint`;
  `pnpm align:check`. **align reports red at +3 baselined debt (324→327) — PRE-EXISTING**,
  identical at `c21a199`, self-reported "provisional". Do not attribute it to your changes.
- Session commits: `ad88009` (registration) → `e61008c` (instrument+gates) → `e26a3ca`
  (outcome) → `f75cdc4` (AMENDMENT 3) → `b99db64` / `ed9eb03` (arm V) → `5c6ef80` (prompt
  record + evidence) → `ca768e2` (Q4 + assets).

---

## 8. Two things I would flag about this handoff

It leads with the **converging-lines** section rather than the next task, because the
biggest risk to you is re-opening Q4 or the harvest hoping for a verdict. They are retired
as verdict sources; only the scale question is live.

It carries the **counter-evidence prominently** — the LOO-baseline significance loss, and
the fact that the reframe's own premise (Recall@10 = 1.000) did *not* generalise to the
outcome task set (target chunk in-window 3/12 for both arms). This program's failures have
all been biases favouring a conclusion someone already held. An inherited summary that
buried those would recreate exactly that, with the sign flipped.
