# IMPLEMENTATION_PLAN.md — ROUTING STUB

**This file is no longer the plan.** On 2026-08-19 the 11,459-line remediation plan was
split into twelve verbatim shards under `adr/proposals/*/PLAN-EXCERPT.md`, and the
decisions it recorded were written up as ADRs under `adr/`. See **[ADR 001](adr/001-2026-08-19-adr-system.md)**
for why, and `adr/README.md` for the index.

**The file was not deleted, and this stub was not put here for tidiness.** 663 citations
across 163 files — most of them TSDoc in `src/` — point at `IMPLEMENTATION_PLAN.md`, and
nearly all cite it by *section name* rather than by line. Deleting or moving the path would
have broken every one of them. This table is how those citations still resolve: find the
section you were sent to, follow it to its shard.

Nothing was edited in the split. The shards reassemble to the original byte-for-byte
(813,230 bytes); the check is `docs/provenance/verify-plan-shards.mjs`, runnable at commit
`69a587e`, which is the last commit where this file was still the full document.

## Where the plan went

| kind | now lives in |
|---|---|
| the decisions, in ~200 lines each | `adr/NNN-YYYY-MM-DD-<feature>.md` |
| the full append-only record | `adr/proposals/<feature>/PLAN-EXCERPT.md` |
| which eval scripts + result artifacts belong to a decision | `adr/proposals/<feature>/EVAL.md` |
| every settled claim, refuted hypothesis, and unread measurement | `FINDINGS.md` (unchanged) |
| defects, with shapes | `docs/defects/` (unchanged) |

**New work does not append here.** It appends to the relevant ADR, or opens a new one.

## Section index — every heading in the original, and where to find it

Line numbers are the ORIGINAL line numbers, preserved so that a citation carrying one
(`IMPLEMENTATION_PLAN.md:31`) can still be located. Within a shard, use the heading text.

| section | orig. line | shard |
|---|---|---|
| Stage 1: Staleness correctness (the P0) | 22 | [005 staleness-contract](adr/proposals/staleness-contract/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F12 — 🔴 F1 inverted the stamp/content ordering (silent stale, no flag) | 56 | [005 staleness-contract](adr/proposals/staleness-contract/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F14 result (2026-08-07) — empty-result busy flag shipped | 116 | [005 staleness-contract](adr/proposals/staleness-contract/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F7 result (2026-08-07) — stat-and-flag staleness shipped | 133 | [005 staleness-contract](adr/proposals/staleness-contract/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F11 result (2026-08-07) — narrow-role locking shipped | 201 | [005 staleness-contract](adr/proposals/staleness-contract/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;🔴 HARD CONSTRAINT ON F11 — `busy_timeout` IS the process-freeze window | 380 | [005 staleness-contract](adr/proposals/staleness-contract/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F13 — 🔴 `SQLITE_BUSY_SNAPSHOT` bypasses F2's stale flag (found by E7-r2) | 415 | [005 staleness-contract](adr/proposals/staleness-contract/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F11 — E7 falsified per-batch advisory locking (`eval/e7-concurrency.json`) | 470 | [005 staleness-contract](adr/proposals/staleness-contract/PLAN-EXCERPT.md) |
| Stage 2: Chunk store migration (Lance → SQLite) | 588 | [006 chunk-store-sqlite](adr/proposals/chunk-store-sqlite/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;M1 result (`eval/m1-migration.json`) | 610 | [006 chunk-store-sqlite](adr/proposals/chunk-store-sqlite/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;M2 framing (2026-08-01) — the option set is four arms, and two have no evidence | 664 | [006 chunk-store-sqlite](adr/proposals/chunk-store-sqlite/PLAN-EXCERPT.md) |
| Stage 3: Call-graph correctness | 708 | [007 call-graph-resolution](adr/proposals/call-graph-resolution/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F3+F4 result (2026-08-09) — await unwrap + this/super resolution | 734 | [007 call-graph-resolution](adr/proposals/call-graph-resolution/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F5 result (2026-08-09) — qualified identifiers indexed | 889 | [007 call-graph-resolution](adr/proposals/call-graph-resolution/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F10 result (2026-08-09) — potential_truncated shipped | 1071 | [007 call-graph-resolution](adr/proposals/call-graph-resolution/PLAN-EXCERPT.md) |
| Stage 3.5: Tool defects and honest surfaces | 1173 | [008 honest-surfaces](adr/proposals/honest-surfaces/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F8 result (2026-08-07) — telemetry work cap shipped | 1190 | [008 honest-surfaces](adr/proposals/honest-surfaces/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F9 result (2026-08-08) — init flags honoured, persisted config read | 1278 | [008 honest-surfaces](adr/proposals/honest-surfaces/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;M6 result (2026-08-09) — empty-state honesty shipped | 1387 | [008 honest-surfaces](adr/proposals/honest-surfaces/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;C1 result (2026-08-09) — confidence signals unified | 1492 | [008 honest-surfaces](adr/proposals/honest-surfaces/PLAN-EXCERPT.md) |
| Stage 4: Determinism, hygiene, and the measurement harness | 1603 | [009 measurement-harness](adr/proposals/measurement-harness/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;D1 result (2026-08-10) — deterministic walk order shipped | 1631 | [009 measurement-harness](adr/proposals/measurement-harness/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;D4 result (2026-08-10) — shape-only-assertion sweep + `unknown[]` ban shipped | 1727 | [009 measurement-harness](adr/proposals/measurement-harness/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;D3 result (2026-08-10) — audit found the claims already fixed; one live config-example drift caught red | 1827 | [009 measurement-harness](adr/proposals/measurement-harness/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;D7 result (2026-08-10) — diagnostics seam + self-oracle corpus test + call-shape matrix shipped; one real extractor defect found and fixed | 1937 | [009 measurement-harness](adr/proposals/measurement-harness/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;D5 result (2026-08-10) — numbered archive convention adopted | 2108 | [009 measurement-harness](adr/proposals/measurement-harness/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;D8 result (2026-08-11) — the shipped sweep was not the running tool; build added to the verification baseline | 2124 | [009 measurement-harness](adr/proposals/measurement-harness/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;D0 — CLI query surface (raised P2 → P1 by the R3 review, §14.8 item 3) | 2269 | [009 measurement-harness](adr/proposals/measurement-harness/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;D6 — the metric set (capture a baseline BEFORE each fix) | 2355 | [009 measurement-harness](adr/proposals/measurement-harness/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;D6 RESCOPE (2026-08-10) — the metric table re-decided post-deletion, post-remediation | 2376 | [009 measurement-harness](adr/proposals/measurement-harness/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;D6 result (2026-08-10) — latency percentiles, lock summarizer, config invariant test shipped | 2414 | [009 measurement-harness](adr/proposals/measurement-harness/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;E1/E2 — the scaling ladder and call-graph denominators: PRE-REGISTRATION (written 2026-08-11, BEFORE any measurement) | 2509 | [011 indexing-scale](adr/proposals/indexing-scale/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;AMENDMENT 4 (2026-08-12) — round-3 review, before any scored run | 3391 | [011 indexing-scale](adr/proposals/indexing-scale/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;E1-PHASE PRE-REGISTRATION (2026-08-12) — which phase carries E1's exponent | 3674 | [011 indexing-scale](adr/proposals/indexing-scale/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;E1-AB PRE-REGISTRATION (2026-08-13) — is the page cache the mechanism behind write's super-linearity? | 4168 | [011 indexing-scale](adr/proposals/indexing-scale/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;E1-EDGES PRE-REGISTRATION — 2026-08-17, written BEFORE any measurement | 5635 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Stage 4.5: Scale — the actual target | 5842 | [011 indexing-scale](adr/proposals/indexing-scale/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;~~What breaks at that scale — and what doesn't~~ — **SUPERSEDED, see the CORRECTION block** | 5978 | [011 indexing-scale](adr/proposals/indexing-scale/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;~~🔴 The 7.2 h figure is an implementation artifact, not a model cost~~ — **FALSIFIED for batching (2026-08-01)** | 6004 | [011 indexing-scale](adr/proposals/indexing-scale/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;~~[R6] M2 recommendation RETRACTED — pending this / now un-blocked, must be re-decided~~ — **DECIDED 2026-08-06 (Stage 7): vectors deleted** | 6053 | [011 indexing-scale](adr/proposals/indexing-scale/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Scaling levers that are NOT vectors, by leverage — **3 of 7 since falsified or moot, see CORRECTION §6** | 6069 | [011 indexing-scale](adr/proposals/indexing-scale/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;STAGE 4.5 CORRECTION — 2026-08-17, appended | 6098 | [011 indexing-scale](adr/proposals/indexing-scale/PLAN-EXCERPT.md) |
| Stage 5: Open questions — decide before building | 6242 | [013 declined-scope](adr/proposals/declined-scope/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q6 RESCOPE (2026-08-11) — round-1's signature is measured absent on the pre-F11 build; HEAD's topology is unmeasured | 6260 | [013 declined-scope](adr/proposals/declined-scope/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q1 — pre-registered experiment design (written 2026-08-01, BEFORE any arm was run) | 6423 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F15 — FTS OR-join (SHIPPED 2026-08-01) + Q1 re-run on both corpora | 6779 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;F16 — RRF fusion: `rrf_k` hypothesis FALSIFIED, and a confound found in the harness | 6838 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;🔴 Adversarial review (Fable, 2026-08-01) — verdict withdrawn, Q1 is AMBIGUOUS | 6890 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q1/F16 FULL-EMBED RE-RUN (2026-08-01) — the corrected numbers | 6978 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q1/RESERVE — identifier-decomposition arm: PRE-REGISTRATION (written 2026-08-02, BEFORE any arm was scored) | 7034 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q1/RESERVE-2 — second-COLUMN construction: PRE-REGISTRATION (written 2026-08-02, BEFORE scoring) | 7310 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q1-v2 REAL-QUERY HARVEST (2026-08-02) — instrument ready, data absent, and Q1 cannot close from this source yet | 7484 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;🔴 Q1 REFRAME (2026-08-02, empirical-planning audit) — the metric, not the sample size, is the blocker | 7552 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q1/OUTCOME — hybrid vs lexical **task-outcome** A/B: PRE-REGISTRATION (written 2026-08-02, BEFORE any run) | 7591 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q1/SCALE — 153k scale-out of the Gate-4 rank-delta pre-check: PRE-REGISTRATION (written 2026-08-02, BEFORE any measurement) | 8106 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q1/IDFUSE — the identifier_fts fusion lever: PRE-REGISTRATION (written 2026-08-03, BEFORE any measurement) | 8612 | [004 ranker-d](adr/proposals/ranker-d/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q1/DECLEX — the declaration-exact ranker: PRE-REGISTRATION (written 2026-08-03, BEFORE any measurement) | 9076 | [004 ranker-d](adr/proposals/ranker-d/PLAN-EXCERPT.md) |
| M2 DECISION MEMO (2026-08-04) — arm D (delete) recommended; the scoped-out gaps confronted on the record | 9516 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;The option set (unchanged from the M2 framing, Stage 2) | 9525 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;The decision rule this memo applies | 9534 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;The ledger | 9548 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Gap 1 — the S-prose T4 LEVEL gap vs H, and the kluster-normal H−L baseline | 9582 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Gap 2 — harm on identifier-free / mixed-case-prose queries: UNTESTED | 9602 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Gap 3 — outcome-at-scale: still Reserve, unmeasured | 9627 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Gap 4 — counterpart-credit composition and generalization limit | 9639 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Gap 5 — a surface the handoff list does not name: doc-chunk retrieval | 9656 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;The bet, in one place | 9668 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;The middle option, considered and rejected | 9682 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;DECISION: arm D — delete the vector store; ship F18 (ranker D, WITHOUT escape) | 9692 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Conditions attached to the delete (constitutive, not advisory) | 9710 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Re-entry criteria — what evidence would reverse this decision | 9740 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Adversarial review of this memo (Fable agent, 2026-08-04) | 9754 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| Stage 6: F18 productization — ranker D in shipped `hybridSearch` (2026-08-06, per M2 memo conditions 1–3) | 9763 | [004 ranker-d](adr/proposals/ranker-d/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Stage 6.1: Port ranker D + regression suite | 9806 | [004 ranker-d](adr/proposals/ranker-d/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Stage 6.2: Fusion + kill-switch | 9817 | [004 ranker-d](adr/proposals/ranker-d/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Stage 6.3: D-fire telemetry | 9844 | [004 ranker-d](adr/proposals/ranker-d/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Stage 6.4: Verify + document | 9862 | [004 ranker-d](adr/proposals/ranker-d/PLAN-EXCERPT.md) |
| Stage 7: Vector-store deletion (2026-08-06, per M2 memo condition 4) | 9881 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Stage 7.1: Excise the vector subsystem (pure removal, surface frozen) | 9920 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Stage 7.2: Honest surfaces | 9947 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Stage 7.3: Repo sweep + docs + verify | 9963 | [003 vector-store-deletion](adr/proposals/vector-store-deletion/PLAN-EXCERPT.md) |
| HANDOFF — operational state for the Q1/M2 track (2026-08-01) | 9993 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Off-repo state (none of it is in git) | 9998 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Env vars | 10012 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Script inventory (`eval/`) — `eval/README.md` is STALE and documents only the old N1 bake-off | 10019 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Reproduce the authoritative result | 10032 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;⚠️ Uncommitted work — the real handoff risk | 10039 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Next action (do not skip to A-vs-C) | 10049 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| Deliberately not doing | 10072 | [013 declined-scope](adr/proposals/declined-scope/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q4 RESULT (2026-08-02) — the win has no nameable class, and the class that matters is absent | 10086 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Q1-v2 HARVEST — re-checked 2026-08-02, still n=0 | 10122 | [002 retrieval-q1](adr/proposals/retrieval-q1/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;E1-SCAN — does removing the `files` full scan remove the edges knee? PRE-REGISTRATION (written 2026-08-17, BEFORE any measurement) | 10142 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;E1-SCAN RESULT (2026-08-17) — H1 FIRES, H2 FIRES, H3 IS REFUTED | 10338 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| E1-LADDER PRE-REGISTRATION (2026-08-17) — does a residual survive the range fix? | 10488 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Why this exists | 10493 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Mandatory pre-registration reading (`.claude/CLAUDE.md`, `FINDINGS.md` §6) | 10504 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Design | 10544 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;The estimator, fixed in advance | 10563 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Hypotheses | 10577 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Gates | 10605 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Scoreable | 10622 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Also computed, explicitly descriptive and adjudicating nothing | 10626 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Direction of error, declared | 10643 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;E1-LADDER RESULT (2026-08-17) — H1 FIRES, H2 FIRES, H3 IS REFUTED BY ITS OWN NOISE | 10653 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;CORRECTION (2026-08-18) — `POTENTIAL_CALL` was described backwards, in §1.1 and in E1-SCAN's RESULT | 10827 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| What `FINDINGS.md` said before this was written | 10872 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| The effect size, measured first | 10907 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Why T9 only, and what is deliberately not run | 10936 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Design | 10985 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Hypotheses | 11010 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Gates | 11029 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| What would make this experiment worthless | 11050 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Verdict | 11075 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| GATE C — the result that outranks the timing | 11101 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Two post-hoc analyses, labelled as post-hoc | 11118 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Where the extra 2.5× came from — INFERRED, not measured | 11139 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Three defects in this experiment's own instruments | 11155 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Realised noise, against what was assumed | 11183 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Scope | 11196 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| What was closed | 11220 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| The counting failure this exposed, in two stages | 11242 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Scope, stated | 11274 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Stage 4.6 — the incremental FTS delete, closed by a rowid block (2026-08-18) | 11284 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;What was wrong | 11290 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;The measurement that was missing (§2.4's own gap) | 11298 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;The mechanism, and a design that was wrong before it was right | 11317 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;RESULT — both arms through the same code path | 11359 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| &nbsp;&nbsp;Tests | 11383 | [012 edges-knee](adr/proposals/edges-knee/PLAN-EXCERPT.md) |
| Stage 4.7 — the mis-cased import, closed at the resolver (2026-08-19) | 11397 | [007 call-graph-resolution](adr/proposals/call-graph-resolution/PLAN-EXCERPT.md) |