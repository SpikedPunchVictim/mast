# HANDOFF — Q1 / M2 track, as of 2026-08-03 (post Q1/IDFUSE RESULT, evidence `3f8e9f3`)

You are taking over an evidence-first investigation in `packages/mast`. Branch `ui`, tree
clean, suite green. Read this file first, then `IMPLEMENTATION_PLAN.md`.

---

## 1. The question, and why it is still open

**Q1: is MAST's vector store justified at all, or does lexical BM25 suffice?** It gates
**M2** — Lance+IVF-PQ vs sqlite-vec, or deleting the vector store entirely, which drops a
91 MB dependency, a ~7 h embed, and 470 MB RAM at the 153k-chunk scale target.

**Q1 is still OPEN. M2 is still BLOCKED.** What changed this session: the cheapest attack on
the scale caveat — folding `identifier_fts` into RRF fusion (Q1/IDFUSE) — **ran and was
REJECTED**. The lexical-only lever (L+I) is inert at T4 on the decision-bearing S-ident stratum
(efficacy CI [−0.67, +4.67] pp, not knife-edge) AND degrades MORE than hybrid on the
closure-deciding contrast (Δ′ θ̂ = +7.33 pp, CI [+2.0, +12.67], p = 0.0127) — **INERT-LEVER**,
base row 3 of the pre-registered 2×2. It is also independently disqualified on harm grounds:
significant off-stratum degradation (−7 to −12 pp) at **every** tier of both non-identifier
strata, invisible to every registered statistic. F17-as-constructed is dead. The lever landscape
moved, but the verdict has not: vectors' scale niche survives its first lexical challenger,
**with the caveat that the challenger failed for reasons that indicate a better one is
available** (see §2 line 5). Commits: Q1/SCALE registration `3e497da` → AMENDMENT 1 `3d17220`
→ instrument `c15f684` → gates + scored evidence `f40f2bf` → Q1/IDFUSE registration `9ecceca`
→ AMENDMENT 1 `bed7d48` → instrument `c726e6f` → gates + scored evidence `3f8e9f3` → this
session's RESULT + AMENDMENT 2 write-up (see `IMPLEMENTATION_PLAN.md`, "Q1/IDFUSE RESULT" and
the results review at `eval/results/q1-idfuse-results-review.md`).

Do **not** skip to M2's A-vs-C backend benchmark. That is the expensive step this entire
investigation exists to gate.

---

## 2. The state of the argument — four independent lines now converge

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
4. **Q1/SCALE (the 153k rank scale-out, this session).** On the identifier-bearing stratum
   ONLY, lexical's `in_window@10` degrades more than hybrid's as the corpus grows 15k → 138k:
   direction confirmed at retrieval level, **+6.7 pp [+1.3, +11.3] CI**, hit-rule-sensitive
   between CONFIRMED (p=0.021) and AMBIGUOUS (p=0.096) depending on whether the AMENDMENT-1
   dedup-counterpart hit rule is applied. State the weight honestly: this is a marginal,
   identifier-stratum-specific, sub-materiality retrieval effect, not an established
   outcome-relevant one — S-approx (split-identifier queries) and S-prose show **no**
   significant scale differential. Mechanism verified in code: `hybridSearch`'s lexical path
   (`src/search/hybrid.ts`) ranks only via trigram `chunk_fts`; `identifier_fts` exists
   (`src/search/fts.ts`) but is consulted only for zero-result suggestions, never for ranking
   — exact identifiers get no exact-token lexical anchor and dilute with scale, while the
   vector arm anchors on the declaration embedding regardless of corpus size.
5. **Q1/IDFUSE (the identifier_fts fusion lever, this session).** Folding `identifier_fts`
   into RRF as an OR-bag ranker was the cheapest attack on item (4)'s mechanism finding — it
   **REJECTED as constructed**: INERT-LEVER (efficacy CI [−0.67, +4.67] pp; Δ′ significant the
   WRONG way, θ̂ = +7.33 pp, CI [+2.0, +12.67]) and independently harmful off-stratum (−7 to
   −12 pp, every tier, both non-identifier strata). **Weight it honestly**: this is one
   lexical construction failing, not lexical-in-general failing — the review's mechanism
   analysis projects a **declaration-exact** counterfactual (query token == the chunk's own
   `symbol_name`) at T4 S-ident **.98–.99** with **zero** off-stratum harm, against this run's
   L+I of .86 and H's .93. That projection is **post-hoc and unregistered** — selection risk
   applies, it is not evidence yet, only a reason the vector niche should not be treated as
   settled. Vectors' scale advantage survived its first lexical challenger; whether it survives
   a better one is untested.

**Joint conclusion: ranking metrics on prose gold sets cannot settle Q1, and the scale-out
does not settle it either — it narrows the caveat instead of discharging it.** Items (3) and
(4) of the old order [Q4, the harvest] are retired as sources of a verdict; the scale-out
(item 5 of the old order) is now measured and is ALSO retired as a further verdict source —
see §3. Do not re-open any of them hoping for one.

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
- **The 153k scale-out (Q1/SCALE, this session).** Pre-registered `3e497da`, adversarial
  design review `3d17220`, instrument `c15f684`, gates + scored evidence `f40f2bf`. Verdict:
  row 1, SCALE CAVEAT CONFIRMED (marginal — see §1, §2). **Do not re-run this hoping for a
  cleaner verdict.** The registered escalation path on an AMBIGUOUS-adjacent result is
  "increase n," never "reinterpret" or "re-score" — and this result is not AMBIGUOUS, it is a
  hit-rule-sensitive CONFIRMED with an honestly marginal magnitude. The marginal result is
  what it is; treat a request to re-run it as a sign the reader wants a different answer, not
  a more accurate one.
- **IDFUSE-as-constructed (Q1/IDFUSE, this session).** Pre-registered `9ecceca`, AMENDMENT 1
  `bed7d48`, instrument `c726e6f`, gates + scored evidence `3f8e9f3`. The OR-bag
  `identifier_fts` ranker folded into RRF is **REJECTED on measured grounds**: INERT-LEVER on
  the decision-bearing contrast, AND −7 to −12 pp harm at every tier of both non-identifier
  strata. **Do not re-propose the bag construction** (whole-identifier-bag OR-join, unicode61,
  no field boost) — it is a tested and rejected mechanism, not an unexplored one. The
  mechanism analysis behind the rejection is what motivates the **declaration-exact** variant
  in §4 — that variant is a different construction (field-boosted to the chunk's own
  `symbol_name`), not a re-run of this one.

---

## 4. YOUR NEXT ACTION — two live lines, in this order

**Item (5) of the old order (the 153k scale-out) is DONE — see §3. The identifier_fts fusion
lever (former item (a)) is ALSO DONE and REJECTED — see §3.** Two lines remain live.

### (a) The declaration-exact ranker experiment — freshly pre-register, do this first

Q1/IDFUSE's mechanism finding (§2, item 5): the OR-bag construction fails because non-same-
name bag matches outrank the target ~26:1 inside ranker I's own ordering, and off-stratum harm
comes from the same bag matching common words. The **declaration-exact** counterfactual —
a query token counts only when it equals the chunk's own `symbol_name` exactly, OR-ed with a
whole-query-token escape so all-lowercase identifiers aren't lost to a shape gate — projects
T4 S-ident **.98–.99** with **zero** measured harm on s_approx/s_prose (post-hoc, same-data,
unregistered — this is why it must be freshly registered, not assumed). Pre-register a new
experiment: same frozen T1–T4 tier states (zero new embed cost), same frozen query set. **The
registration must include off-stratum LEVEL contrasts (L+I-vs-L per stratum, not only the
Δ′-scale one)** — Q1/IDFUSE's AMENDMENT 2 row 1 finding was that omitting this let real harm
hide from every registered statistic; do not repeat that gap. The Reserve entry's own
promotion condition ("if bag-BM25 ranking of declarations proves weak") is met — see
`IMPLEMENTATION_PLAN.md`'s Q1/IDFUSE RESULT.

### (b) The outcome test at scale — Reserve, expensive, only if (a) fails or is challenged

The scale-out measures **retrieval**, not outcomes (registered scope limit, unchanged by the
result). Q1/OUTCOME already showed rank movement does not imply outcome movement at 14.5k;
whether that holds at 138k is untested. This is the expensive follow-up — an outcome A/B at
scale, same shape as Q1/OUTCOME — and it is only warranted if (a) fails to neutralize the
scale caveat, or if (a)'s result is itself challenged on review.

**The organic harvest remains the only instrument for real-query evidence** (unchanged from
before this session) — every stratum in this program, including Q1/SCALE's S-ident/S-approx/
S-prose, is synthetic/TSDoc-derived, not agent-authored.

**Reserve (pre-thought, NOT commitments, carried from before plus Q1/SCALE's own reserve):**
a `--no-embeddings` container A/B; shipping D0 (a real `mast search` CLI) so the A/B harness's
Bash-surface caveat disappears; a fifth tier at ~30k if the dose–response curve needs
resolution between 15k and 50k; the directory-based tier partition as a sensitivity analysis;
multi-seed T1 sensitivity.

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
- **`runSelfCheck` (Q1/SCALE instrument) under-counts its own mismatch tally** — it excludes
  reconstruction failures and mode-integrity failures from the count it reports. Gate 2's
  reported 80/80 relied on a wider criterion computed externally by the runner, not by the
  instrument itself. Fix `runSelfCheck` to count what Gate 2 actually requires before reuse.
- **`scale-rank-check.mjs` and `scale-score.mjs` ship with no working CLI entry points** for
  the scored sweep / self-check / scorer their own header comments document. The working
  invocation is the three runner-authored driver scripts committed at `f40f2bf`
  (`scale-run-selfcheck.mjs`, `scale-run-measure.mjs`, `scale-run-score.mjs`) — use those, not
  the instrument files directly, until CLI entry points are added.
- **`RESULTS_DIR` in `eval/paths.mjs` resolves to `~/.cache/mast-eval/results/`, not the
  repo's `eval/results/`.** `scale-embed-tiers.mjs`'s Gate 0(c)/(d) output writes there by
  default; it was copied into `eval/results/` by hand for the committed record. Any script
  that imports `RESULTS_DIR` from `paths.mjs` needs its output copied in the same way, or the
  gate evidence silently lives outside the repo.
- **`sqliteChunkStore.replaceChunksForFile` (`src/store/sqliteChunkStore.ts:55-70`) issues one
  unbatched multi-row `INSERT`** for all of a file's chunks. At 11 columns/row, SQLite's
  32,766-parameter ceiling caps a single file at ~2,979 chunks; a larger file's insert rolls
  back **entirely** — loud (`write_errors` increments, CLI exit code 1), not silent, but
  **orchestration that gates only on exit code and not on `write_errors` would still silently
  drop the file's chunks.** Found via vscode's two whale fixture files (146,620-line and
  11,190-line). Not fixed in this program — batch the insert before trusting a corpus with
  files anywhere near that size.
- **`idfuse-score.mjs` ships with no CLI entry point** — the `scale-rank-check.mjs`/
  `scale-score.mjs` defect class (above), **second occurrence**, despite the builder brief
  requiring working CLIs. The working invocation is the runner-authored
  `eval/idfuse-run-score.mjs`, not the instrument file directly (line-level clean per the
  results review, orchestration only). **Treat this as a class, not a one-off** — fix it
  before authoring any third scoring instrument.
- **`scoreIdfuse` does not wire consistency-trigger-3 (monotonicity) into `evaluateVerdict`.**
  Moot on the INERT-LEVER path (trigger clauses attach only to CLOSED/SURVIVES); latent gap if
  a future run on this instrument reaches CLOSED or SURVIVES. Fix before reuse.
- **The probes/probe key mismatch the Q1/IDFUSE builder logged**: `scale-queries.json` keys
  the probe stratum as `"probes"` (plural) while every `ResultRow`/CLI-facing label uses the
  singular `"probe"` (`validateResultRow`'s stratum enum). `idfuse-rank-check.mjs` maps this
  explicitly (`jsonKey = stratum === 'probe' ? 'probes' : stratum`) — any new script reading
  `scale-queries.json` by naive key needs the same mapping or it silently resolves an empty
  query list.

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
  rebuild cost. ~590 MB of embedded state (pre-Q1/SCALE assets) = ~45 min compute; the
  Q1/SCALE vscode assets add substantially more — see `ASSETS.md`'s new entries (~7.4 h embed
  measured for the full corpus). Remove worktrees with `git worktree remove`, never `rm -rf`.
  `~/.cache/mast-eval/ab-wt` (1.5 GB) is disposable.
- **Never** open `graph.db` with `?mode=ro&immutable=1` for metrics reads — WAL-blind,
  reports `metrics` as empty. This cost a session a false conclusion.
- `MAST_EVAL_STATE` required by nearly every script; `MAST_EVAL_R2=1` required by
  `build-corpus.mjs` or you rebuild the void v1 corpus.
- **Evidence is committed** under `eval/results/` — all 30 Q1/OUTCOME run outputs, the
  147-call search log, the sealed arm manifest, all Q1/SCALE gate + measure + score JSON, the
  Q1/SCALE results review, and (this session) `idfuse-gateA-selfcheck.json`,
  `idfuse-gateD-reproducibility.json`, `idfuse-measure-raw.json` (8,000 rows),
  `idfuse-score-output.json`, `q1-idfuse-design-review.md`, and
  `q1-idfuse-results-review.md`. `eval/README.md` is STALE.
- Verification baseline: `pnpm -F mast test` → **505 tests / 38 files** (was 455/36 before
  Q1/IDFUSE); `typecheck`; `lint`; `pnpm align:check`. **align reports red at +3 baselined
  debt (324→327) — PRE-EXISTING**, identical at `c21a199`, self-reported "provisional". Do
  not attribute it to your changes.
- Session commits: `ad88009` (registration) → `e61008c` (instrument+gates) → `e26a3ca`
  (outcome) → `f75cdc4` (AMENDMENT 3) → `b99db64` / `ed9eb03` (arm V) → `5c6ef80` (prompt
  record + evidence) → `ca768e2` (Q4 + assets) → `77d4f63` (cold-start handoff) → `3e497da`
  (Q1/SCALE registration) → `3d17220` (Q1/SCALE AMENDMENT 1) → `c15f684` (Q1/SCALE instrument)
  → `f40f2bf` (Q1/SCALE gates + scored evidence) → `9ecceca` (Q1/IDFUSE registration) →
  `bed7d48` (Q1/IDFUSE AMENDMENT 1) → `c726e6f` (Q1/IDFUSE instrument) → `3f8e9f3` (Q1/IDFUSE
  gates + scored evidence) → this session's RESULT + AMENDMENT 2 + handoff update.

---

## 8. Two things I would flag about this handoff

It leads with the **converging-lines** section rather than the next task, because the
biggest risk to you is re-opening Q4, the harvest, the scale-out, or the identifier_fts
OR-bag lever hoping for a cleaner verdict. All four are retired as verdict sources — Q4 and
the harvest structurally, the scale-out because it is now measured and its marginality is the
honest answer, the OR-bag lever because it is now measured and REJECTED on both efficacy and
harm grounds. Only the two lines in §4 are live, and (a) is now a *different* construction
(declaration-exact), not a re-run of the rejected one.

It carries the **counter-evidence prominently** — the LOO-baseline significance loss, the
fact that the reframe's own premise (Recall@10 = 1.000) did *not* generalise to the outcome
task set (target chunk in-window 3/12 for both arms), Q1/SCALE's own four required caveats
(hit-rule sensitivity between CONFIRMED and AMBIGUOUS; magnitude below the registration's own
materiality line; consistency triggers that structurally could not have demoted CONFIRMED;
sign-test-equivalence with two near-twin pairs), and now Q1/IDFUSE's two flags, one on each
side: the **pro-deletion carry-forward** is the declaration-exact projection (post-hoc,
unregistered — T4 S-ident .98–.99 with zero measured off-stratum harm), which is the reason
Q1 stays open rather than tilting decisively pro-vector; the **anti-F17 carry-forward** is the
measured off-stratum harm itself (−7 to −12 pp, every tier, both non-identifier strata,
invisible to every registered statistic) — real, mechanism-verified, and an independent
disqualifier of the OR-bag construction regardless of how the efficacy question had landed.
This program's failures have all been biases favouring a conclusion someone already held. An
inherited summary that buried those would recreate exactly that, with the sign flipped.
