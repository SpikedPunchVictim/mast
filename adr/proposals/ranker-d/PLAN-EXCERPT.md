### Q1/IDFUSE — the identifier_fts fusion lever: PRE-REGISTRATION (written 2026-08-03, BEFORE any measurement)

**Nothing below may be edited after the first scored measurement.** Amendments are appended
with timestamp, reason, and the direction the error runs.

#### Why this experiment

Q1/SCALE confirmed the scale caveat: lexical degrades with corpus growth on exact-identifier
queries (+6.7 pp [1.3, 11.3] extra in-window loss vs hybrid at 138k) — and its results review
verified in code that the shipped `hybridSearch` ranks via trigram `chunk_fts` only:
`identifier_fts` (unicode61, exact-identifier semantics) exists but is never consulted in
ranking. Exact names therefore have no exact-token lexical anchor, which is a candidate
non-vector explanation for the entire measured vector advantage. This is the registered
cheapest attack on M2's blocked state (HANDOFF §4 line (a)): if a lexical ranker closes the
scale gap, the delete arm re-opens; if the gap survives, vectors have earned a defensible
niche. Either outcome moves M2. F15 precedent: one lexical line more than halved the measured
value of vectors.

#### What this measures — and does not

- Retrieval only, same scope limits as Q1/SCALE (target-rank level; not outcomes; TSDoc-hot
  mechanical queries; one corpus, one host).
- It gates the M2 delete-arm question; it does NOT by itself decide shipping F17 (the product
  change wiring identifier_fts into search) — that is a separate decision informed by both
  branches.

#### Arms

All arms run through the SAME validated eval reconstruction pipeline (Gate-2 precedent:
reconstruction reproduces shipped `hybridSearch` output exactly, 80/80 at limit 200), on the
SAME frozen tier states (T1–T4) and the SAME frozen query set (`eval/scale-queries.json`,
400 scored + 10 probes). No product code changes.

| arm | rankers in RRF (k = 60) |
|---|---|
| L  | chunk_fts BM25 (shipped lexical) — **RE-RUN in full** alongside the new arms (AMENDMENT 1, F3: no row reuse from 8868404) |
| H  | chunk_fts + vectors (shipped hybrid) — **RE-RUN in full** (F3) |
| L+I | chunk_fts + **identifier_fts** (lexical-only, two rankers) — NEW |
| H+I | chunk_fts + vectors + identifier_fts — NEW, **DESCRIPTIVE ONLY** (arm-V precedent: answers "should the keep-branch also wire identifier_fts?"; barred from bearing the close/survive verdict) |

**Pool per ranker, corrected to describe shipped behavior (AMENDMENT 1, F8):** the arms above
are not uniformly "4×limit per ranker." `hybridSearch` passes `candidateLimit = limit*4`
(`hybrid.ts:59`) into `searchFts`, which applies its OWN further `.limit(options.limit * 2)`
(`fts.ts:92`) — so `chunk_fts`'s realized pool is `limit*4*2` = **effectively 8×limit**.
`searchVectors` and the new ranker I both take `candidateLimit` directly with no further
multiplication — **4×limit each**, matching each other. Negligible for the measured top-10
window; corrected here because the original text was wrong about what ships.

A fifth, descriptive-only sensitivity variant, **L+Isym**, is also run — see the F7 caveat
under Ranker I mechanics below.

#### Ranker I — mechanics (mechanical, committed before measurement; verified against `src/search/fts.ts` and `src/graph/db.ts`)

**Schema.** `identifier_fts` (`src/graph/db.ts:287-292`) is an FTS5 virtual table with a
single indexed column `identifiers` (`chunk_id`, `file_path` UNINDEXED) and
`tokenize = "unicode61 separators '.-_/()[]{}<>:;,=+*&|!?'"` — this is what "unicode61,
exact-identifier semantics" means concretely: identifier-shaped separators split tokens, but
there is no trigram sub-word matching the way `chunk_fts` has. **Population** is one row per
chunk (`src/graph/populate.ts:187-214`, same transaction as `symbols`/`imports`): `identifiers`
is the deduplicated, space-joined set of `\b[A-Za-z_$][A-Za-z0-9_$]*\b` tokens extracted from
the chunk's raw content by `extractIdentifiers` (`src/ast/extractors/typescript.ts:1430-1438`);
markdown chunks get no row (`identifierRows: []`, `src/ast/extractors/markdown.ts:59`).

**Term derivation from the raw query — registered explicitly (AMENDMENT 1, F1).** The
original drafting left this unregistered; three different natural choices for turning the
query STRING into match-expression TERMS produce three different experiments, and picking
wrong makes ranker I structurally inert on the exact stratum it exists to test. The
registered choice: input terms = a token split of the RAW query by `/[A-Za-z0-9_$]+/` (the
same character class `extractIdentifiers` indexes against, `$` included — a toFtsMatch-style
split, `fts.ts:214-218`), with **NO camelCase splitting and NO lowercasing** — `identifier_fts`'s
`unicode61` tokenizer case-folds AT MATCH TIME (`db.ts:286-292`), so an unlowercased query
token still matches a lowercased indexed token, and the indexed token is never sub-split
(`extractIdentifiers`' regex captures whole identifiers, `typescript.ts:1430-1438`). Each
surviving token — empty-filtered, NO length floor (unlike `chunk_fts`'s trigram minimum,
`identifier_fts` has no such floor to respect) — is phrase-quoted
(`"${term.replace(/"/g, '""')}"`) and OR-joined: the same builder reused verbatim from
`searchIdentifierNearMiss` (`fts.ts:140-154`). An empty term list short-circuits to no query
issued, contributing nothing to RRF for that query.

**Why not the two other natural candidates (F1):**
- **`splitIdentifierTerms`** — the ONLY production caller of the near-miss builder
  (`hybrid.ts:287,295`) — camelCase-splits and lowercases (`fts.ts:170-184`): e.g.
  `scanCodeChord` → `scan`, `code`, `chord`. The indexed token for that declaration is the
  UNSPLIT whole `scancodechord` (case-folded, never sub-split — `unicode61` has no subword
  matching). Split terms can therefore NEVER match the unsplit indexed token: feeding ranker I
  through this path — the path a reader would reach for first, since it is the only path
  already wired to `identifier_fts` in production — builds a ranker that is STRUCTURALLY
  INERT on exactly the S-ident anchor it exists to test. This is the single highest-leverage
  drafting gap in the original text: left unregistered, the natural path runs toward a false
  INERT-LEVER and a false GAP SURVIVES.
- **Whitespace-split** (`query.split(/\s+/)`) breaks dotted `Class.method` targets: phrase-
  quoting `"Scrollable.getFutureScrollPosition"` as one adjacent-token phrase requires
  `Scrollable` and `getFutureScrollPosition` to co-occur in the SAME identifier bag, but the
  class name is typically absent from the method chunk's own bag — 36/150 S-ident targets
  (24% of the decision stratum) use a dotted method-qualified form and lose their anchor.

Only the `/[A-Za-z0-9_$]+/` split anchors all 150 S-ident targets: `Class.method` splits into
two independently-phrase-matchable OR terms (either alone suffices), and camelCase identifiers
are left whole, matching the unsplit indexed token under case-folding.

**Ranking — the correction already present in the pre-amendment draft, restated.** Neither
shipped identifier_fts function ranks by relevance: `searchIdentifierNearMiss` and its exact-
match sibling `searchIdentifiers` (`fts.ts:111-127`) both issue `.limit(n).execute()` with NO
`ORDER BY` / `bm25()` — row order is FTS5's default (effectively rowid/insertion order). This
is safe at both of their production call sites because order doesn't matter there:
`searchIdentifiers` feeds `mast_callers`'s unordered `potential_matches` set
(`src/search/potential-matches.ts:68`); `searchIdentifierNearMiss` feeds `hybridSearch`'s
zero-result "identifier near-miss" advisory suggestions (`hybrid.ts:295`, inside
`gatherSuggestions`, `hybrid.ts:259-301`) — unranked "did you mean" hints, never fused into an
RRF score. `identifier_fts` is referenced nowhere in `hybridSearch`'s RRF-fusion body
(`hybrid.ts:61-119`, which builds only `ftsMap` from `searchFts`/`chunk_fts` and `vecMap` from
`searchVectors`) — confirming it is absent from ranking today.

Ranker I therefore adds one new, explicitly-ordered query: the term-derivation and match-
expression-building step above, with an explicit `.orderBy(sql\`bm25(identifier_fts)\`, 'asc')`
appended — the same pattern `searchFts` already uses for `chunk_fts` (`fts.ts:90-93`). No new
tokenizer, no schema change: the `identifiers` column and its unicode61 separator set are
untouched; the only addition is the BM25 ORDER BY that neither shipped identifier_fts function
currently has. Pool 4×limit, matching `searchVectors` (F8 above); ties and empty matches
handled identically to the other rankers. The exact term-derivation + match-expression +
ORDER BY code ships in the committed instrument; any further deviation from this description
is a logged amendment.

**Gate B extended (F1):** the fixture-db known-answer tests must include, beyond the existing
exact-identifier / OR-semantics / empty-match cases, a dotted `Class.method` target (proving
the OR-split anchors on the method term alone) and a camelCase target (proving the whole-token
match against the unsplit indexed token, not a sub-split).

**Mechanism caveat: a TSDoc-prose double-count channel (AMENDMENT 1, F7).**
`extractIdentifiers` sweeps ALL word tokens of the CONTEXT-EXPANDED chunk content —
`context_lines: 3` (`src/store/config.ts:38`) prepends lines above the declaration, so the
last ~2 lines of a leading TSDoc block land in the same text `extractIdentifiers` runs
against, and their rare prose words end up in the `identifiers` bag alongside the
declaration's own symbol tokens. A query that reuses one of those rare prose words gets an
exact-token ranker-I match through a channel that is NOT identifier anchoring — it is a
second, independent path to evidence `chunk_fts` (which indexes the whole chunk, TSDoc
included) already contributes, i.e. a double-count. This is a channel real agent queries do
not get: 0/147 of the harvested question-wording queries reused TSDoc prose verbatim. Ranker
I is therefore a mixed identifier + partial-prose ranker, not a pure identifier-exact ranker
as its name suggests; efficacy and closure can partly ride the prose half while a write-up
that attributes everything to identifier anchoring would misattribute the mechanism.

**Mandatory diagnostic (F7):** per scored query, log which query terms matched the target's
`identifier_fts` row, classified symbol-token (from the declaration line's own tokens) vs
TSDoc-rare-word (from the context-expansion lines only). Reported alongside the headline
result; not gating.

**Descriptive-only sensitivity arm L+Isym (F7):** ranker I fed ONLY the symbol-shaped tokens
of the query — a token qualifies if it contains an uppercase letter, an underscore, a dollar
sign, a dot, or a digit adjacent to a letter (mechanical definition, applied after the same
`/[A-Za-z0-9_$]+/` split used for the primary ranker I). Run and reported alongside L+I and
H+I; **never verdict-bearing**, same status as H+I.

**Generalization caveat (one sentence):** GAP CLOSED, if reached, generalizes only to
exactly-spelled, identifier-bearing queries — there is no subword matching, so a closed
verdict says nothing about queries that paraphrase or split the identifier (S-approx gets no
benefit from ranker I, and no vector help either, per Q1/SCALE).

**No row reuse (AMENDMENT 1, F3).** L and H are RE-RUN IN FULL alongside L+I and H+I — same
pipeline, same frozen tier states, same frozen query set — rather than reusing 8868404's raw
rows, for three registered reasons: (a) the 8868404 rows carry only per-target ranks, not full
200-row lists, so any drift check against them is necessarily per-target, never a full
reconstruction comparison; (b) a 20-query drift sample (the gate as originally drafted) misses
real drift often — at a true drift rate of 2% it has only a 33% chance of catching it, at 5%
only 64%; (c) most importantly, pairing a 2026-08-02 H row against a 2026-08-03 L+I row for
the decision-bearing Δ′ would let run-level environment drift land INSIDE the decision
statistic itself — undetectable after the fact by any drift-gate sample size. A full re-run
is cheap (3,200 additional searches, minutes, zero embeds) — cheaper than the case for
trusting a drift gate that costs the same order of searches to run credibly. Gate D (below)
is retained but demoted from a gate that licenses reuse to a cross-run reproducibility REPORT.

#### Metrics

Identical to Q1/SCALE: dedup-aware hit rule (target chunk or shell↔method counterpart at
survivor rank), in_window@10, D_loss = in_window@10(T1) − in_window@10(T4) per query,
censoring at 201, per-call mode recording, suppression logging. DEPTH = 200, WINDOW = 10.

#### Decision rules — exactly one decision-bearing contrast, symmetric triggers, collision cell mapped

**Decision-bearing:** S-ident stratum, Δ′ = D_loss_{L+I} − D_loss_H (paired by query).
Exact Wilcoxon (zeros dropped) two-sided α = 0.05 + all-n seeded BCa 95% CI (10,000
resamples) on the paired proportion difference — same machinery, same seeds policy as
Q1/SCALE.

**Efficacy precondition (sanity, evaluated first) — all four reachable cells mapped, no
undefined collision (AMENDMENT 1, F2).** Ranker I must actually do something — L+I vs L at
T4 on S-ident must show improvement with its all-n BCa CI excluding 0. Crossed against
whether Δ′ independently meets the GAP CLOSED criteria below, the full 2×2 is:

| | Δ′ meets GAP CLOSED criteria | Δ′ does not |
|---|---|---|
| **efficacy PASSES** (CI excludes 0) | GAP CLOSED (verdict table below) | GAP SURVIVES / AMBIGUOUS (verdict table below) |
| **efficacy FAILS** (CI includes 0) | **AMBIGUOUS** — both contrasts reported in full | **INERT-LEVER** |

The originally-drafted design left the efficacy-fail + closure-criteria-met cell unmapped,
and it is reachable: e.g. ranker I nets ~3 rescued queries — under the ≈4–5 needed for the
efficacy CI to exclude 0 — while that same small effect is enough for Δ′ to independently
satisfy the closed-criteria non-significance + CI-upper-≤5pp test. Routing that cell to
INERT-LEVER, as originally drafted, would report a false GAP SURVIVES by relabelling a real
(if marginal) closure as a failed lever. It is mapped to AMBIGUOUS instead, with both the
efficacy contrast and the Δ′ contrast reported in full. **Efficacy is verdict-relevant ONLY
as this gate** — it never independently produces GAP CLOSED or GAP SURVIVES on its own;
INERT-LEVER is emitted only in the one cell where efficacy fails AND Δ′ also fails to meet
the closed criteria (the gap trivially "survives," but the substantive finding is that the
candidate mechanism failed — the delete arm stays blocked and F17 is dead as a rescue).

**Verdict table (given efficacy passes, per the gate above):**

| observed | verdict |
|---|---|
| Δ′ Wilcoxon **not** significant — including the degenerate all-zero / non-runnable case, which counts as "not significant" for this row (AMENDMENT 1, F5b) — AND BCa CI upper bound ≤ **5 pp** | **GAP CLOSED.** The vector scale advantage is reproduced by a lexical ranker; the non-vector explanation stands. The M2 delete arm RE-OPENS (subject to the standing outcome-level caveats), with F17 as the enabling product change. |
| Δ′ significant, L+I degrading **LESS** than H (reverse-significant) | **GAP CLOSED, a fortiori (descriptive fusion finding — AMENDMENT 1, F5a).** identifier_fts fusion doesn't merely match H's scale protection, it exceeds it — the parent Q1/SCALE precedent's wording for the analogous discharge-branch cell applies here. Still subject to the symmetric consistency triggers below. |
| Δ′ significant, L+I degrading more, BCa CI upper bound > 5 pp | **GAP SURVIVES.** identifier_fts does not substitute for vectors at scale; vectors have earned a defensible retrieval niche on this query class. M2 proceeds as a keep-decision (Lance IVF-PQ vs sqlite-vec). |
| Δ′ significant, L+I degrading more, BCa CI upper bound ≤ 5 pp | **GAP SURVIVES (marginal, sub-precision-floor) — AMENDMENT 1, F4.** The residual is statistically real but sits at or below the instrument's own 5 pp precision floor — the same floor that discriminates a "closed" verdict. Deletion stays blocked (significance is significance), but the verdict language must carry the realized θ̂/CI against the floor rather than being dignified as an unqualified "defensible niche." |
| anything else | **AMBIGUOUS.** Report; escalate per the pre-registered rule below (F6), never by reinterpreting. |

The 5 pp bound: at Q1/SCALE's realized non-zero rate (p_nz ≈ 0.107, n = 150) a true-zero
contrast yields a CI of ≈ ±5.2 pp — so 5 pp is the instrument's own precision floor, and a
"closed" verdict requires the residual gap to be indistinguishable from zero at the precision
that detected the original +6.7 pp.

**Escalation, pre-registered now (AMENDMENT 1, F6).** The reachability corridor at n=150 is
narrower than the ± figure alone suggests: balanced Wilcoxon outcomes pass the ≤5pp bound only
up to (7,7) non-zero pairs (upper 4.89pp); (8,8) already fails (5.23pp); any net imbalance of
≥2 with ≥~11 non-zero pairs fails regardless of direction. A true-zero population effect that
nonetheless perturbs individual pairs (the RESERVE-1 vote-dilution pattern — I equalizes
aggregate means but reshuffles which queries win or lose) can land in AMBIGUOUS with only
roughly 1-in-3 probability even when the population effect is genuinely zero: a structural
bias toward perpetual AMBIGUOUS (pro-incumbent) that "escalate by adding queries," as
originally drafted with no n or rule, left exploitable. The escalation, pre-registered: if
AMBIGUOUS lands via CI-width unreachability at this corridor (not a data-quality failure),
extend the frozen S-ident set to **n = 300** using the committed generator
(`eval/scale-build-queries.mjs` derivation rules), **pre-named seed 154** (distinct from the
tier/query-construction seed 153, so the escalation draw is independently auditable), targets
drawn from the same T1 TSDoc-rich pool EXCLUDING the S-ident/S-approx/S-prose/probe targets
already used. At n = 300 the precision floor recalculates to ≈ **3.7 pp** at the same realized
p_nz ≈ 0.107. If triggered, the escalation is logged as an amendment with the same
direction-of-error discipline as this one.

**Symmetric consistency triggers (the Q1/SCALE F-R3 lesson — both branches guarded):**
1. GAP CLOSED additionally requires no supporting cell (S-approx, S-prose, Δlog2 co-metric)
   showing L+I significantly worse than H (all-n BCa CI excluding 0 in the worse direction);
   any such cell → AMBIGUOUS.
2. GAP SURVIVES additionally requires no supporting cell showing L+I significantly better
   than H; any such cell → AMBIGUOUS.
3. Monotonicity: tier means outside the [T1,T4] envelope by more than a 95% CI are flagged
   and discussed; endpoints carry the decision (unchanged from Q1/SCALE as amended).

**Direction-of-error statement:** after Q1/SCALE, the investigator holds no clean prior —
the deletion prior argues for GAP CLOSED; the just-confirmed scale result argues for GAP
SURVIVES. Both branches therefore carry the same evidentiary bar (the symmetry above is the
structural version of that), and the results review is instructed to attack whichever branch
the numbers land on.

#### Gates before any scored measurement

A. **Instrument self-check** — with ranker I disabled, the pipeline must reproduce shipped
   `hybridSearch` (arms L and H) exactly on the 10 probes × 4 tiers × 2 arms at limit 200,
   0 mismatches (the existing Gate-2 harness, re-run).
B. **Ranker-I unit tests, EXTENDED (AMENDMENT 1, F1)** — known-answer tests on a fixture db:
   exact-identifier query hits the declaring chunk; OR semantics; empty-match contributes
   nothing; PLUS a dotted `Class.method` target (proving the OR-split anchors on the method
   term alone) and a camelCase target (proving the whole-token match against the unsplit
   indexed token, not a sub-split); committed before measurement.
C. **Arm integrity per call** — explicit chunkStore; mode recorded (L/L+I lexical, H/H+I
   hybrid); any violation voids that tier-arm run, void counts reported.
D. **Cross-run reproducibility REPORT — descriptive, not gating (AMENDMENT 1, F3).** Since L
   and H are now re-run in full rather than reused (see "No row reuse" under Ranker I
   mechanics), this gate no longer licenses anything. It compares the freshly-measured L/H
   per-target ranks against the archived 8868404 raw rows and reports agreement/divergence.
   Any divergence is documented as run-level drift — informative context for interpreting Δ′,
   never a reason to discard the fresh rows, which are what the decision statistic uses
   regardless of what this report finds.
E. **Vector coverage** — pending_embeddings == 0 per tier (H arms only).

#### Costs

**6,400 scored searches (AMENDMENT 1, F3): 4 arms × 400 queries × 4 tiers** — L and H are now
RE-RUN in full alongside L+I and H+I rather than reused from 8868404 — **+ 80 probe calls**
(10 probes × 4 tiers × 2 arms, Gate A). Gate D's cross-run comparison (above) reuses the
freshly-collected L/H rows already counted in the 6,400 and adds no further search cost — only
a comparison against the archived 8868404 rows. Still minutes to tens of minutes; zero embeds;
zero agents.

#### Design Reserve (pre-thought, NOT commitments)

Shipping F17 (the product change) with its own regression suite; an exact-phrase (rather
than OR) ranker-I variant; per-query-class analysis of where I helps; re-running Q1/SCALE's
directory-partition sensitivity under L+I; an outcome A/B at scale (unchanged standing
reserve).

**Added from the adversarial design review (AMENDMENT 1) — all reserve-only, none a
commitment, provenance: external LLM proposal evaluated against track evidence:**

- **Declaration-exact ranker** — a degenerate field-boost form of ranker I: a query token
  matches only when it equals the CHUNK'S OWN `symbol_name` exactly, rather than the whole
  identifier bag. Overlaps substantially with the L+Isym sensitivity arm (F7); promoted to a
  live variant only if bag-BM25 ranking of declarations proves weak in the scored data.
- **MinHash/LSH over trigrams** — recorded as answering a question this track has NOT
  registered: fuzzy near-duplicate matching is not the measured failure mode (S-ident is
  exact-identifier retrieval, not near-duplicate detection). Reserve-only; no promotion path
  identified by this registration.
- **Agent-side query-class routing** — the fallback construction if the fusion approach (F17)
  fails: route S-ident-shaped queries to a dedicated exact-match path outside RRF fusion.
  Carries the standing availability≠adoption caveat (a routing option that exists is not one
  agents reliably use) — noted, not resolved, here.

#### AMENDMENT 1 — 2026-08-03, pre-run, post-adversarial-review

Adversarial review commissioned per the standing §6 rule (Fable agent), against this section
as committed at `8db1672`, **before any measurement had occurred**. Per the Q1/SCALE and
Q1/OUTCOME precedent, no data existed, so the registration above was revised in place rather
than appended to; this log is the audit trail. The full review is committed verbatim at
`eval/results/q1-idfuse-design-review.md`.

Stated plainly, because it is the finding that matters most about the process, not just the
instrument: **this time most errors ran toward false GAP SURVIVES / perpetual AMBIGUOUS —
i.e. toward the INCUMBENT (vectors, the keep-decision) — the mirror image of Q1/SCALE's
registration errors, which mostly ran toward false DISCHARGED (deletion, the investigator's
prior at the time).** The two verdict-DECIDING findings were an unregistered implementation
choice (F1 — what a query string becomes before it reaches ranker I) and an unmapped decision
cell (F2 — efficacy-fail colliding with closure-criteria-met). Neither was a defect inherited
from elsewhere; both were gaps this registration's own drafting left open.

| # | Finding | Change | Direction the error ran |
|---|---|---|---|
| 1 | Ranker I's term derivation from the query string was unregistered; the three natural choices (toFtsMatch-style split, `splitIdentifierTerms`, whitespace-split) produce three different experiments, and the only path already wired to `identifier_fts` in production (`splitIdentifierTerms`) camelCase-splits and can never match the unsplit indexed token — structurally inert on the S-ident anchor. Whitespace-split instead breaks 36/150 dotted `Class.method` targets. | Term derivation registered explicitly: `/[A-Za-z0-9_$]+/` token split of the raw query, no camelCase splitting, no lowercasing (unicode61 case-folds at match time); Gate B extended with dotted-method and camelCase known-answer cases. | **Most natural path → false INERT-LEVER / false GAP SURVIVES** — an unregistered implementation choice, the investigator's own drafting gap. |
| 2 | Efficacy-fail + closure-criteria-met is a reachable cell (ranker I rescues ~3 queries — below the efficacy CI's ~4-5 threshold — while that same effect independently satisfies Δ′'s closed criteria) with two contradictory registered outputs (INERT-LEVER vs GAP CLOSED). | Cell mapped to AMBIGUOUS, both contrasts reported in full; efficacy demoted to verdict-relevant ONLY as this gate — INERT-LEVER fires only when efficacy fails AND closure criteria are also not met. | **Toward false GAP SURVIVES** — an unmapped decision cell, the investigator's own drafting gap. |
| 3 | Reuse of 8868404's L/H rows is false economy guarded by a weak sample: raw rows carry only per-target ranks (Gate D is necessarily per-target, not a full reconstruction); 20 queries misses real drift 67% of the time at f=2%, 36% at f=5%; and the paired Δ′ would subtract a 2026-08-02 H row from a 2026-08-03 L+I row, landing run-level environment drift INSIDE the decision statistic. | L and H RE-RUN in full alongside L+I/H+I (6,400 total scored searches, still minutes, zero embeds); Gate D demoted to a cross-run reproducibility REPORT, descriptive, never gating. | **Unknowable** — collision/drift direction can't be signed in advance. |
| 4 | GAP SURVIVES had no magnitude gate (the parent's F-R2 lesson, unapplied here): a significant but sub-5pp residual would be dignified as a "defensible niche" identically to a large one. | Verdict language carries the realized θ̂/CI against the 5pp floor; significant + CI upper ≤ 5pp is recorded as "GAP SURVIVES (marginal, sub-precision-floor)" — still blocking, explicitly weaker language. | **Toward false GAP SURVIVES** (overstated confidence, not a wrong direction but an inflated one). |
| 5 | Two reachable cells were unmapped or mapped perversely: (a) reverse-significant (L+I degrading LESS than H) fell to AMBIGUOUS though the parent had an a-fortiori discharge row for the analogous cell; (b) degenerate Wilcoxon (all-zero Δ′ — perfect closure) had no defined row. | Two rows added: reverse-significant → GAP CLOSED a fortiori (descriptive fusion finding, parent-precedent wording); degenerate/non-runnable Wilcoxon counts as "not significant" for the closure row, never blocks CI-based closure. | **Routed ideal closure to AMBIGUOUS** — away from GAP CLOSED, i.e. toward the incumbent. |
| 6 | The 5pp bound's reachability corridor is tighter than stated: balanced outcomes pass only up to (7,7) non-zero pairs; a true-zero residual that perturbs individual pairs reaches CLOSED with only ~1/3 probability; "escalate by adding queries" had no pre-registered n or rule. | Escalation pre-registered now: committed generator (`eval/scale-build-queries.mjs`), pre-named seed 154, target n=300 S-ident queries from the same T1 pool excluding already-used targets, floor recalculated to ≈3.7pp; logged as an amendment if triggered. | **Toward perpetual AMBIGUOUS (pro-incumbent)** — structural, not a drafting slip. |
| 7 | "Exact-identifier semantics" was overstated: `context_lines=3` puts the last ~2 TSDoc lines into the identifier bag, so rare TSDoc query words get an exact-token ranker-I match through a channel real agent queries (0/147 reused question wording) don't get — a partial double-count with `chunk_fts`. | Registered caveat; mandatory per-query diagnostic logging which query terms matched (symbol-token vs TSDoc-rare-word); descriptive-only sensitivity arm L+Isym (ranker I fed only symbol-shaped tokens); one-sentence generalization caveat (closure generalizes only to exactly-spelled identifier-bearing queries). | **Toward false GAP CLOSED + mechanism misattribution** — the one finding in this track that ran the other way, toward the challenger. |
| 8 | "Pool 4×limit per ranker" misdescribed shipped arms: `chunk_fts` is effectively 8×limit (`hybrid.ts:59` candidateLimit=limit*4, `fts.ts:92` limit*2 → limit*8); vectors and ranker I are each 4×limit. | Text corrected; arms table now describes shipped behavior accurately. Negligible effect at the measured top-10 window. | **No direction — descriptive correction only.** |
| 9 | Bootstrap pairing of reused-vs-new rows was flagged as a concern. | Moot given F3's full re-run — nothing pairs a reused row against a fresh one anymore. | **No direction — moot.** |
| — | Design Reserve: declaration-exact ranker (degenerate field-boost form, overlaps L+Isym); MinHash/LSH over trigrams (answers a currently-unregistered question — fuzzy matching isn't the measured failure mode); agent-side query-class routing (fallback if fusion fails, availability≠adoption caveat noted). | Added to Design Reserve, reserve-only, none a commitment. | No direction — provenance: external LLM proposal evaluated against track evidence. |

The reviewer's SOUND list and WITHDRAWN items are recorded in full in the committed review
file, `eval/results/q1-idfuse-design-review.md`.

#### Q1/IDFUSE RESULT (2026-08-03) — INERT-LEVER: the bag ranker fails as a scale rescue and harms off-stratum; the declaration-exact Reserve variant's promotion condition is met

**Gates — all green.** Gate 1 (full suite): **505/505** tests. Gate E (`pending_embeddings ==
0`, H/H+I arms): **0 × 4** tiers — reused descriptively from the frozen T1–T4 tier states, no
new embed cost, per registration. Gate A (instrument self-check, ranker I disabled, 10 probes
× 4 tiers × 2 arms, limit 200): **80/80, 0 mismatches**. Gate C (arm integrity per call): **0
mode-integrity violations, 0 voided cells** over **8,000** scored searches (5 arms × 400
queries × 4 tiers, F7's L+Isym sensitivity arm included per the corrected costs line, AMENDMENT
2 row 2). Gate D (cross-run reproducibility REPORT, descriptive only per AMENDMENT 1 F3 — L/H
are freshly re-run in full, never reused): **3,200/3,200** per-target ranks identical against
the archived `8868404` blob; the adversarial results review independently verified
byte-provenance of both the fresh and archived files (distinct SHA-256s, as expected for two
runs on the same deterministic pipeline).

**Verdict, mechanically selected: INERT-LEVER.** Efficacy precondition FAILS — L+I vs L @ T4,
S-ident: θ̂ = **+2 pp**, all-n seeded BCa 95% CI **[−0.67, +4.67]** (excludes neither
direction), 145/4/1 (zero/positive/negative pairs), exact Wilcoxon **p = 0.375** — not
knife-edge: net **+3** rescued queries against the **~+5** the CI would need to exclude zero.
**AND** the decision-bearing contrast Δ′ (= D_loss_{L+I} − D_loss_H, S-ident) independently
fails the GAP CLOSED criteria — it is significant in the WRONG direction, L+I degrading MORE
than H: θ̂ = **+7.33 pp**, CI **[+2.0, +12.67]**, exact Wilcoxon **p = 0.0127** (133/14/3
zero/positive/negative). Both conditions together route to **base row 3** of the pre-registered
2×2 (efficacy FAILS ∧ Δ′ does not meet closure) → **INERT-LEVER**: the gap trivially "survives"
but the substantive finding is that ranker I failed as a candidate mechanism, not that vectors
were newly vindicated.

**Headline cells — `in_window@10`, T1 → T4 (of n):**

| stratum | arm | T1 | T4 |
|---|---|---|---|
| S-ident (n=150) | L | .967 | .840 |
| S-ident (n=150) | H | .993 | .933 |
| S-ident (n=150) | L+I | .993 | .860 |
| S-ident (n=150) | H+I | .993 | .953 |
| S-ident (n=150) | L+Isym | .987 | .880 |
| S-approx (n=150) | L | .953 | .840 |
| S-approx (n=150) | L+I | .867 | .767 |
| S-prose (n=100) | L | .940 | .820 |
| S-prose (n=100) | L+I | .850 | .730 |

**The four review-mandated caveats, at full strength — this row's survival is conditioned on
stating them, not on omitting them:**

1. **Off-stratum harm — an independent disqualifier of F17-as-constructed.** L+I vs L is
   significant at **every tier of both non-identifier strata**: s_approx **−8.7 pp** at T1
   (p = 0.00098) through **−7.3 pp** at T4; s_prose **−9 pp** to **−12 pp** (p ≤ 0.0117) at
   every tier. Mechanism-verified: RESERVE-1-style vote dilution — ranker I's OR-bag matches
   ~800 chunks, the pool cap is hit 18/24 times, and the target is either absent from ranker I's
   ordering or ranked 24–792 in it — competitors accumulate fts+I double votes and leapfrog a
   single-vote target. Reproduced 24/24 against the real tier state (not a wiring artifact).
   **Structurally invisible to every registered statistic**: the harm is tier-flat, so it
   cancels inside `D_loss`, and Δ′-scale triggers can never fire on a tier-flat pattern. F17-
   as-constructed would be dead on harm grounds even had efficacy passed.
2. **"Inert" means failed-as-scale-rescue, not does-nothing.** Ranker I anchored **100%** of
   S-ident targets (F7 any-match = 1.000 on the decision stratum) and helped at T1–T3 (T3
   +4.67 pp nominal, p = 0.039; L+I's T1 = .9933, matching H's T1 exactly) — it fails **AT T4
   SPECIFICALLY**, because bag crowding grows with corpus size (ranker I's pools saturate the
   800-candidate cap at T4). The lever degrades with scale for the same reason `chunk_fts`
   does, so it cannot fix a scale problem by construction.
3. Consistency triggers and monotonicity were not evaluated on the INERT-LEVER path —
   registration-conformant (the trigger clauses attach only to GAP CLOSED / GAP SURVIVES) and
   immaterial here (no supporting cell's CI excludes 0; every tier sequence is weakly
   monotone) — stated, not hidden.
4. **M2 consequence:** the delete arm stays blocked and the gap trivially survives — but
   "vectors' defensible niche" must **NOT** be over-read, because of the mechanism finding
   below.

**The mechanism finding (review-verified, decides the next lever).** Among the **21**
S-ident/T4 L+I failures, the target's median rank INSIDE ranker I's own ordering is **28** (only
2/21 in I's top-10), outranked **~26:1** by non-same-name bag matches (call-site/reference
chunks scoring under bag-BM25 doc-length/IDF). Forcing the target to I-rank 1 rescues only
**12/21** — a fusion-dilution cap, not a ranking-quality cap alone. The **declaration-exact
counterfactual** (query token == the chunk's own `symbol_name`, pessimistic worst-case ordering
among same-name matches) rescues **20/21**: T4 S-ident **.9933**. The **symbol-gated** variant
(declaration-exact, OR-ed with whole-query-token symbol_name matches to cover all-lowercase
identifiers) reaches T4 S-ident **.9800** with s_approx/s_prose **EXACTLY = L** — zero
off-stratum harm — T1 S-ident **1.0000**, and D_loss ≈ **2 pp** against H's **6 pp**:
closure-shaped. This is a **post-hoc, same-data projection** — selection risk applies, and it
must be freshly registered before it counts as evidence. The plain declaration-exact shape
loses the 3 all-lowercase-identifier L+Isym regressions, which is why the variant must OR-in
whole-query-token `symbol_name` matches rather than rely on shape alone. **The Reserve entry's
own promotion condition — "if bag-BM25 ranking of declarations proves weak" — is now
empirically met.**

**Descriptive-only arms (never verdict-bearing).** H+I vs H: θ̂ = **−2 pp**, not significant —
the identifier ranker doesn't help hybrid either. L+Isym: the 35.5% any-match rate is the
all-strata aggregate; on s_ident alone L+Isym matches **94%** of targets, and it beats L+I at
T4 by shedding prose-token votes.

**F7 diagnostic aggregates (the registered prose-channel caveat, borne out numerically).**
L+I / H+I: any-match **96.5%**, symbol-token match **84.5%**, TSDoc-rare-word match **68.5%** —
confirming ranker I is a mixed identifier + partial-prose ranker, not a pure identifier-exact
one, exactly as AMENDMENT 1 (F7) predicted before any data existed.

**What this licenses.** Q1 remains **OPEN**; M2's delete arm remains **BLOCKED**;
**F17-as-constructed is REJECTED** — inert on-stratum at scale, harmful off-stratum at every
tier. The registered next candidate is a **freshly pre-registered declaration-exact
experiment** (the Reserve promotion condition is now met). The outcome-test-at-scale Reserve
(HANDOFF_Q1.md §4b) stands unchanged.

#### AMENDMENT 2 — 2026-08-03, POST-scoring, after adversarial review of the results

Unlike Amendment 1 (pre-run), these corrections were found **after** seeing results by a
commissioned adversarial review (committed verbatim at
`eval/results/q1-idfuse-results-review.md`), not by me. **None flips the verdict row** — the
review's overall verdict is "INERT-LEVER survives, with required caveats" (see the RESULT
section above).

| # | Error | Direction it ran |
|---|---|---|
| 1 | Off-stratum harm (L+I vs L, S-approx/S-prose) is invisible to every registered statistic — a structural gap in the registration itself: no L+I-vs-L off-stratum contrast was ever registered. | Made the lever look merely inert when it is also harmful. Caveat carried at full strength in the RESULT section; future fusion registrations must include off-stratum LEVEL contrasts, not only Δ′-scale ones. |
| 2 | The costs line said 6,400 scored searches (4 arms), but the registered F7 sensitivity arm (L+Isym) makes it 5 arms / 8,000 rows. | Drafting slip; corrected here and in the Gates line above. |
| 3 | `idfuse-score.mjs` shipped with no CLI entry point — the parent (Q1/SCALE)'s defect class, **second occurrence**, despite the builder brief requiring working CLIs. The runner authored `eval/idfuse-run-score.mjs` as the working invocation (review: line-level clean, orchestration only, no scoring/verdict logic of its own). | Process defect, cosmetic for validity this run; recurrence logged — fix the class before any third instrument. |
| 4 | `scoreIdfuse` does not wire consistency-trigger-3 (monotonicity) into `evaluateVerdict`. | Moot on the INERT-LEVER path this run (trigger clauses attach only to CLOSED/SURVIVES); latent gap if a future run reaches CLOSED or SURVIVES — fix before reuse. |
| 5 | The W = 27 convention (min rank-sum) initially read as implying \|Δ′\| = 2 for some pairs. | Resolved: all 17 non-zero pairs have \|Δ′\| = 1; p equals the exact sign test. No error in the committed output; recorded here to prevent re-derivation confusion. |

The review's SOUND and WITHDRAWN lists are recorded in full in the committed file,
`eval/results/q1-idfuse-results-review.md`. The review also independently re-executed the
fusion (53 queries reconstructed end-to-end, plus three full-cell counterfactual sweeps) — the
declaration-exact and symbol-gated counterfactual projections in the RESULT section above are
the **review's own**, labelled post-hoc throughout, not the pre-registered instrument's output.

---

### Q1/DECLEX — the declaration-exact ranker: PRE-REGISTRATION (written 2026-08-03, BEFORE any measurement)

**Nothing below may be edited after the first scored measurement.** Amendments appended with
timestamp, reason, direction.

#### Why this experiment, and its provenance risk (stated first)

Q1/IDFUSE's results review (`eval/results/q1-idfuse-results-review.md`, F-R2) diagnosed WHY
the bag ranker failed (declarations outranked ~26:1 by call-site chunks inside
`identifier_fts`; fusion dilution caps any bag fix) and computed a post-hoc counterfactual: a
SYMBOL-GATED DECLARATION-EXACT ranker projects T4 S-ident `in_window@10` ≈ **.9800** (vs H
**.9333**, L **.8400**) with s_approx/s_prose EXACTLY = L (**.8400** / **.8200** respectively —
zero harm). Quoted verbatim from F-R2: "SYMBOL-GATED declaration-exact: T4 s_ident .9800,
s_approx .8400 = L exactly, s_prose .8200 = L exactly (zero harm); T1 s_ident 1.0000; D_loss
~2pp vs H 6pp — closure shape, no off-stratum cost." The Reserve promotion condition for this
variant ("if bag-BM25 ranking of declarations proves weak") is empirically met (Q1/IDFUSE
RESULT, and HANDOFF_Q1.md §4a).

**Provenance risk:** that projection was mined from the same 400 frozen queries
(`eval/scale-queries.json`) the whole Q1/SCALE → Q1/IDFUSE track has scored against.
Therefore the DECISION-BEARING data here is a FRESH query set (below); the original 400 are
re-scored as descriptive comparability only. **Direction-of-error statement:** the projection
is pro-deletion and investigator momentum now favours closure — the CLOSED branch carries the
extra scrutiny (fresh-set primary, mandatory harm gate, results review instructed to attack
CLOSED hardest if it lands there).

**Generalization caveat (restored from Q1/IDFUSE; dropped from the original draft of this
section — AMENDMENT 1, F-2).** GAP CLOSED, if reached, generalizes ONLY to queries literally
containing the declared name as a symbol-shaped token. Ranker D's eligibility gate and match
rule (below) require an exact, case-insensitive token/segment equality against `symbol_name`;
it says nothing about queries that paraphrase, abbreviate, or partially reference a symbol.
Verdict language for this track is fixed accordingly: a CLOSED verdict here **closes the
S-ident scale gap** — it must never be written as "reproduces the vector advantage" without
that qualifier, since the vector advantage (Q1/SCALE) was measured across S-ident's full
generality, not the symbol-shaped-token subset D anchors on.

**Pre-stated prediction (so the result can surprise):** L+D T4 S-ident ≈ .98, Δ′ ≈ −2 to
−4 pp (L+D degrading LESS than H — a-fortiori-closure territory), off-strata level == L.
Mined-from-old-data; fresh-set regression toward L is the live risk.

#### Ranker D — mechanics (mechanical, committed before measurement)

- Query terms: raw-token split `/[A-Za-z0-9_$]+/` (the Q1/IDFUSE registered derivation,
  `deriveRankerITerms`, `eval/idfuse-ranker.mjs:58-60`; no camelCase split, no lowercasing).
- **Eligibility gate (primary arm):** only SYMBOL-SHAPED tokens participate — the F7 predicate
  as actually implemented, `isSymbolShapedTerm` (`eval/idfuse-ranker.mjs:81-89`): a term
  qualifies if it contains an uppercase letter (`/[A-Z]/`), an underscore, a dollar sign, or a
  digit adjacent to a letter (`/[0-9][A-Za-z]|[A-Za-z][0-9]/`) — **minus the dead dot
  criterion**: the implementation also tests `term.includes('.')`, but the upstream split
  character class `/[A-Za-z0-9_$]+/` never includes `.` in any surviving token (`.` is a
  separator, not a class member), so that arm of the predicate can never fire on any
  post-split term. The registered `eval/idfuse-ranker.mjs` JSDoc calls this out explicitly:
  "That criterion is therefore dead code by construction." Ranker D's eligibility gate
  reproduces this predicate but drops the dead clause rather than reimplementing dead code.
- **Match rule:** a chunk is a candidate iff an eligible token equals, case-insensitively, the
  chunk's `symbol_name` OR its final dot-segment. Verified against the chunk schema
  (`MAST_SPEC.md` §6.1, `src/ast/extractors/typescript.ts:280-330`): method chunks carry
  `symbol_name = `${className}.${methodName}`` (`typescript.ts:324`, "qualified as
  `ClassName.methodName`" per `MAST_SPEC.md:174`) — the raw `/[A-Za-z0-9_$]+/` split severs
  the dot (same mechanism that splits `Class.method` queries into two OR terms for ranker I),
  so the method-name segment must match on its own. `class_shell` chunks carry the unqualified
  class name (`symbol_name = className`, `typescript.ts:294`) and match on that directly — no
  segment logic needed for `class_shell`.
- **Ordering (deterministic):** full-name matches before segment-only matches; then fewer
  total same-name candidates first; then ascending chunk_id. Pool cap 4×limit (matching
  `searchVectors`; `chunk_fts` is effectively 8× by shipped code — `hybrid.ts:59`
  `candidateLimit = limit*4` into `searchFts`'s own `fts.ts:92` `limit*2`, per Q1/IDFUSE
  AMENDMENT 1 F8).
- RRF k = 60, fused exactly as the other rankers. Empty term set / no matches → contributes
  nothing.
- **Escape variant (descriptive arm only, D+esc):** lowercase tokens also eligible IFF their
  declaration-match count within the tier is ≤ 20 (a token matching more declarations carries
  no signal and is the measured common-word harm channel). Registered to recover the
  all-lowercase-identifier class (rtrim/splice — the 3 L+Isym regressions, quoted verbatim
  from F-R2: "the plain declaration-exact shape loses the 3 all-lowercase-identifier L+Isym
  regressions... so variant should OR-in whole-query-token matches on symbol_name") without
  reintroducing ungated harm (ungated counterfactual measured s_prose T4 .73, per F-R2). The
  ≤ 20 cap is an unregistered-until-now magic number (AMENDMENT 1, F-8): annotated here as
  **arbitrary, sensitivity-reported** — the scorer publishes the matched-count distribution
  for all lowercase tokens considered under escape, and reports the esc arm's cells at caps
  {5, 20, 50} alongside the primary ≤20 cell, descriptive only, no verdict stakes.

**Registered divergence from the F-R2 projection, and role assignment (AMENDMENT 1, F-4).**
The construction above is not the one F-R2 projected: F-R2's counterfactual matched only
`symbol_name == query term`; segment matching (the final-dot-segment rule, above) is an
ADDITION this registration makes to recover dotted-method targets without relying on the
class-shell counterpart alone. Segment matching adds real candidate mass the projection never
modeled — e.g. a `toJSON`-class query can face on the order of 140 same-segment candidates,
all receiving D votes, a mini dilution channel bounded only by full-name-before-segment
ordering (lowercase segment giants such as `constructor`/`dispose`/`run`/`get` are excluded by
the eligibility gate, not by ordering). Because the registered set of D-eligible matches is
therefore LARGER than the set F-R2's pessimistic-last argument was computed over, F-R2's .9800
floor argument does not carry over automatically in either direction. Role assignment,
registered now: the ORIGINAL-400 D re-score is the DIRECT test of the F-R2 projection (same
construction the projection was mined from, modulo this addition); the FRESH set tests the
construction actually registered here; the RESULT must report the divergence delta between the
two (fresh-set S-ident in_window@10 vs original-400 D re-score, same metric, same tier).

#### Query sets

- **FRESH set (decision-bearing):** generated by NEW code (AMENDMENT 1, F-5 — the committed
  `eval/scale-build-queries.mjs` cannot produce this set as shipped: it hardcodes `SEED=153`,
  has no exclusion-set support, and unconditionally overwrites `./scale-queries.json`).
  Registered mechanics, now mechanical and unambiguous: reuse `scale-build-queries.mjs`'s own
  derivation rules for pool construction and per-stratum selection (pool = T1's TSDoc-rich
  exported chunks with a leading TSDoc block ≥ 80 chars; rare-word selection via T1's own
  `chunk_fts` DF ≤ 50; S-approx via shipped `splitIdentifierTerms`, paired 1:1 to S-ident by
  target, drawing no separate pool cost) — but as new driver code that (1) filters the T1
  pool to EXCLUDE the 260 previously-used targets BEFORE sampling, (2) shuffles the remaining
  pool with `mulberry32(154)` (the pre-registered escalation seed — see below for why its
  reuse here is clean), (3) draws sequential slices per stratum off the shuffled pool (150
  S-ident, 150 paired S-approx, 100 S-prose, 10 probes, in that order), and (4) writes the
  result to the DISTINCT file `eval/declex-queries.json` — the driver never opens or
  overwrites `eval/scale-queries.json`. **Seed 154's reuse here is verified clean:** it is
  the pre-registered escalation seed — Q1/IDFUSE AMENDMENT 1 F6 reserved it for extending
  S-ident to n=300 if that track landed AMBIGUOUS via CI-width; Q1/IDFUSE instead resolved
  directly to INERT-LEVER, base row 3 of its 2×2, without ever reaching the AMBIGUOUS/CI-width
  path — so seed 154 was never drawn. Reused here for a different purpose: DECLEX's own fresh
  primary set, not an escalation. Verified no collision: no `eval/declex-queries.json` or any
  other seed-154/155 artifact exists in the repo yet. — targets drawn from T1's TSDoc-rich
  pool EXCLUDING all 260 previously used targets. The 260 is verified directly from the
  committed `eval/scale-queries.json`: 150 S-ident targets, 150 S-approx targets (identical
  chunk_ids to S-ident, paired 1:1 by array index), 100 S-prose targets, 10 probe targets —
  all pairwise disjoint except the S-ident/S-approx pairing, union = 260 distinct chunk_ids.
  Realized T1 pool = **593**, the `pool_size` field committed in `eval/scale-queries.json`
  (produced by `scale-build-queries.mjs`'s own count of TSDoc≥80-char T1 chunks, independent
  of seed — the seed only orders the sampling draw). 593 − 260 = **333 available** (exact,
  not approximate). n = 150 S-ident + 150 S-approx (paired, same targets) + 100 S-prose + 10
  probes (needs 260 distinct targets against the 333 available — comfortably above the
  registered floor; floor rule carried forward from `scale-build-queries.mjs`: if the
  realized available pool < 260, reduce S-prose first, floor 50, further reduction hits
  S-ident and MUST be logged as an amendment). Committed as `eval/declex-queries.json` BEFORE
  any measurement, with a zero-overlap verification against `eval/scale-queries.json` (Gate
  F, extended below). **Anchor rate published before scoring (AMENDMENT 1, F-2):** Gate F
  also computes and publishes, mechanically and before any search/ranking runs, the fresh
  set's D-anchor rate (the fraction of S-ident targets reachable via full-name or segment
  match) — expected ≈ 96%, stated here in advance so the RESULT cannot present a ~96% anchor
  rate as a discovery. **Seed 155 is reserved now for DECLEX's own escalation** (below) —
  distinct from seed 154's reuse here, so a future escalation draw cannot collide with this
  registration's primary draw.
- **ORIGINAL 400 (descriptive comparability only):** re-scored so DECLEX numbers sit beside
  SCALE/IDFUSE numbers; never verdict-bearing (it is the data the projection was mined from —
  its D re-score is expected to show near-perfect closure BY CONSTRUCTION, being the
  projection's own training data; see F-4's role assignment above). **Narrative firewall
  (AMENDMENT 1, F-9):** the RESULT's verdict paragraph may cite FRESH-set numbers only;
  original-400 numbers appear solely under a separate heading, "projection-provenance data
  (mined-from, non-evidentiary)" — never blended into the verdict prose.

#### Arms (all fresh runs; no row reuse — the IDFUSE F3 lesson)

| arm | rankers | role |
|---|---|---|
| L | chunk_fts | baseline |
| H | chunk_fts + vectors | incumbent |
| L+D | chunk_fts + ranker D (symbol-gated) | **decision arm** |
| H+D | chunk_fts + vectors + ranker D | descriptive only (keep-branch question) |
| L+D+esc | chunk_fts + ranker D with lowercase escape | descriptive sensitivity |

Both query sets × 4 tiers × 5 arms. Fresh set: 400 × 4 × 5 = 8,000 rows (400 = the 150+150+100
scored S-ident/S-approx/S-prose queries; the 10 probes are Gate A self-check only, excluded
from scoring, same convention as `eval/scale-queries.json`'s own probes note and Q1/IDFUSE's
costs line); original set the same; ~16,000 scored rows total, minutes-scale, zero embeds.
Cross-run reproducibility report for L/H vs the IDFUSE run (descriptive).

#### Metrics

Identical machinery to Q1/IDFUSE (dedup-aware hit rule, in_window@10, D_loss endpoints,
censoring 201, per-call mode, suppression, pre-dedup ranks). DEPTH 200, WINDOW 10.
Per-query ranker-D diagnostic: whether D matched the target, via full-name or segment, and
D's candidate count per query. **Mandatory per-stratum fire-rate aggregates (AMENDMENT 1,
F-1):** for every stratum (S-ident, S-approx, S-prose) × tier, the RESULT reports the fraction
of queries on which D produced ≥ 1 candidate — this is the input to the HARM-CLEAN /
HARM-NULL split below, and is reported regardless of which side of that split each stratum
lands on. **Matched-count distribution (AMENDMENT 1, F-8):** for the escape variant, the
scorer additionally reports the distribution of per-token declaration-match counts among
lowercase tokens considered, and the esc arm's cells at caps {5, 20, 50}.

#### Decision structure — one decision-bearing contrast + one mandatory harm gate

**Efficacy 2×2 gate (evaluated FIRST — AMENDMENT 1, F-7(iv): this gate's outcome takes
precedence over every row of the verdict table below, including CLOSED-BUT-HARMFUL; a
verdict-table row is reached only once this gate has passed):** L+D vs L @ T4, fresh
S-ident, all-n BCa CI excluding 0 = pass. Fail + closed-criteria-met → AMBIGUOUS (both
reported). Fail + not-met → INERT-LEVER, UNLESS the failure is a reverse-significant
efficacy result (D hurts L on-stratum), in which case the cell is **HARMFUL-LEVER
(on-stratum)** (AMENDMENT 1, F-7(ii) — renamed from INERT-LEVER, which would mislabel a
lever proven to hurt its own stratum as merely inert). Reverse-significant efficacy (D hurts
L on-stratum) → efficacy FAIL, flagged explicitly.

**HARM-CLEAN / HARM-NULL split (AMENDMENT 1, F-1 — the harm gate's vocabulary, registered
now because the gate is a priori near-vacuous for the primary arm: D fires on 0/150 S-approx
targets and 1/100 S-prose targets on the old 400, both all-lowercase-derived strata, per the
design review).** Per off-stratum (S-approx, S-prose), the stratum is **HARM-CLEAN** only if
D produced ≥ 1 candidate on ≥ 10% of that stratum's queries (a registered, non-trivial
fire-rate floor); otherwise the stratum is **HARM-NULL (unexposed)** — the harm contrast
could not fire and reports no information either way. HARM-CLEAN in the verdict table below
requires this fire-rate floor to be met; "harm-free" language anywhere in the RESULT is
scoped to identifier-free queries actually exercising D (never asserted for a HARM-NULL
stratum). The esc-arm (D+esc) is the only arm with material exposure on the null strata and
is reported descriptively as the harm contrast where the primary arm is HARM-NULL.

**Decision-bearing:** fresh-set S-ident, Δ′ = D_loss_{L+D} − D_loss_H, exact Wilcoxon
(zeros dropped; degenerate = not significant) two-sided α = .05 + all-n seeded BCa 95% CI.
Verdict table (amended-IDFUSE structure; AMENDMENT 1, F-7 cell fixes and precedence applied):
| Δ′ ns AND CI upper ≤ 5 pp AND HARM-CLEAN (≥ 1 off-stratum) | **GAP CLOSED.** Lexical closes the S-ident scale gap (never write "reproduces the vector advantage" unqualified — AMENDMENT 1, F-2); M2 delete arm RE-OPENS (standing outcome-level caveats unchanged), F18 (shipping ranker D) becomes the enabling product change, subject to its own regression suite. This row's "harm-tested" language applies ONLY because at least one off-stratum reached HARM-CLEAN; see the firewall sentence below for what this row does NOT discharge. |
| Δ′ ns AND CI upper ≤ 5 pp AND both off-strata HARM-NULL | **GAP CLOSED** — closure with off-stratum harm **UNTESTED** at the primary construction (D is structurally silent there); esc-arm harm contrast reported descriptively in its place. Same M2/F18 consequence as the row above, minus any harm-tested claim. |
| Δ′ significant, L+D degrading LESS than H, AND HARM-CLEAN (≥ 1 off-stratum) | **CLOSED A FORTIORI** (lexical beats hybrid at scale on this stratum; descriptive fusion finding). |
| Δ′ significant, L+D degrading LESS than H, AND both off-strata HARM-NULL | **CLOSED A FORTIORI** — harm UNTESTED (same caveat as the row above). |
| Δ′ significant, L+D degrading more, CI upper > 5 pp | **GAP SURVIVES.** Two independent lexical constructions have now failed; vectors' niche is earned. M2 proceeds as keep-decision. |
| Δ′ significant, L+D degrading more, CI upper ≤ 5 pp | **SURVIVES (marginal, sub-precision-floor).** |
| closure criteria met (EITHER the GAP CLOSED row OR the CLOSED-A-FORTIORI row above) but the HARM gate independently fails (a HARM-CLEAN stratum shows harm) | **CLOSED-BUT-HARMFUL** (AMENDMENT 1, F-7(i) — a-fortiori closure + harm-fail is explicitly routed here, not left to fall through to AMBIGUOUS). Not shippable as constructed; delete arm stays blocked; escape/ordering variants indicated. Reported, never spun as closure. |
| anything else | **AMBIGUOUS.** Escalate per the pre-registered rule below. |

**CLOSED-row firewall sentence (AMENDMENT 1, F-3 — mandatory, both CLOSED rows above):**
re-opening the delete arm requires M2 to separately confront the S-prose T4 LEVEL gap (H 92
vs L 82 per 100, untested here as a level contrast — this registration tests D_loss scale
only) and the kluster-normal H−L baseline; DECLEX closure discharges the S-ident SCALE
caveat ONLY. A descriptive off-stratum L+D-vs-H level report (scorer-side; S-approx and
S-prose, pooled and per-tier) is produced alongside every RESULT regardless of which row is
hit, so this gap is visible even when not verdict-bearing.

**Mandatory HARM gate (the Q1/IDFUSE AMENDMENT-2 row-1 lesson — off-stratum LEVEL
contrasts, not Δ′-scale only; vocabulary and bootstrap unit fixed by AMENDMENT 1, F-1 and
F-7(v)):** per off-stratum that reaches HARM-CLEAN's fire-rate floor (≥ 10% D fire rate,
above), paired per-query level difference (L+D − L) in_window@10, pooled across tiers, all-n
BCa 95% CI. HARM-CLEAN (the verdict-table sense) = the fire-rate floor is met AND neither CI
excludes 0 in the negative direction. A stratum below the fire-rate floor is HARM-NULL and
reports no CI (there is nothing to bootstrap — D never fired). **Bootstrap unit = per-query
(AMENDMENT 1, F-7(v)):** resampling draws queries, carrying all four of that query's tier
rows together as one unit — never query×tier rows resampled independently, which would treat
four correlated observations as independent and overstate precision by up to 4×. Per-tier
cells reported regardless of the pooled HARM-CLEAN/HARM-NULL outcome. The same contrast is
reported for S-ident (level, not only D_loss).

**Symmetric consistency triggers:** as amended-IDFUSE, both directions, evaluated on every
verdict path INCLUDING inert/harm rows (the IDFUSE F-R5 note made conformant-but-unstated;
here it is stated: triggers are computed and reported on ALL paths, verdict-bearing only on
CLOSED/SURVIVES rows).

**Escalation (pre-registered; arithmetic fixed by AMENDMENT 1, F-6 — the remaining T1 pool
after the fresh draw is only 333 − 260 = 73 targets, so extending to +150 S-ident MUST draw
77 T2-resident targets, not an edge case to be handled post-hoc):** AMBIGUOUS via CI-width →
extend fresh S-ident to n = 300 via the generator under seed 155, remaining T1 pool (73
targets) first. The escalated Δ′ decision statistic is computed on T1-RESIDENT targets ONLY.
The unavoidable T2-resident additions (up to 77) are reported as a SEPARATE cell with
endpoints T2→T4 (not T1→T4 — `in_window@10(T1)` is structurally 0 for a target that isn't in
T1, which would corrupt D_loss if mixed into the decision statistic) — that cell is
descriptive, never inside the decision statistic. If the T1-resident escalation pool of 73 is
itself insufficient to resolve CI-width AMBIGUOUS, that is reported as a hard
AMBIGUOUS-stays-AMBIGUOUS outcome, not a further ad hoc pool expansion.

#### Gates before scoring

A. Self-check: D disabled → reproduce shipped hybridSearch on 10 fresh probes × 4 tiers ×
   2 arms at limit 200, 0 mismatches.
B. Ranker-D known-answer fixtures: dotted Class.method segment match; camelCase full match;
   case-insensitivity; lowercase token correctly EXCLUDED in primary / INCLUDED under escape
   with the ≤20 cap enforced; same-name multiplicity ordering; determinism (two runs
   byte-identical); empty contribution; **high-multiplicity-segment fixture (AMENDMENT 1,
   F-4)** — a `toJSON`-class fixture with ~140 same-segment candidates, asserting full-name
   and class-shell matches order strictly above the segment crowd.
C. Per-call mode + explicit chunkStore, void protocol as before.
E. pending_embeddings == 0 × 4 tiers.
F. Fresh-set integrity, EXTENDED (AMENDMENT 1, F-5 mechanics + F-2 anchor rate): committed
   pre-measurement; zero target overlap with eval/scale-queries.json; generator + seed in the
   JSON; realized pool size reported; **byte-determinism** — two independent runs of the
   fresh-set generator produce byte-identical `eval/declex-queries.json`; **exclusion-set
   verification** — the generator's exclusion set is checked ≡ the committed 260 used
   targets; **prose-skip count** reported (targets skipped during S-prose selection, if any);
   **anchor-rate report** — the fresh set's mechanically-computed D-anchor rate (full-name or
   segment match against S-ident targets) published BEFORE scoring, per F-2 above.
G. **CLI gate (new — the twice-recurred defect):** every shipped script's CLI entry point is
   exercised by an automated test (spawn with --help or a fixture invocation, assert exit 0).
   No script ships CLI-less; no runner-authored drivers this time. (Verified recurrence: Q1/SCALE's
   `scale-rank-check.mjs`/`scale-score.mjs` shipped with no CLI entry point — first occurrence,
   HANDOFF_Q1.md §5; `idfuse-score.mjs` recurred the same defect — second occurrence, the
   results review's F-R7. Gate G exists to make a third occurrence structurally impossible,
   not merely caught after the fact.)

#### Costs

~16,000 scored searches + probes, zero embeds, zero agent runs; minutes to ~1 h wall-clock.
Fresh-set generation: seconds.

#### Design Reserve (pre-thought, NOT commitments)

F18 productization (ranker D in shipped hybridSearch + config flag + regression suite);
D-ordering variants (BM25-weighted same-name disambiguation); the outcome A/B at scale
(standing); late-embedding M2 arm (standing); MinHash/LSH (standing, no registered question).

#### AMENDMENT 1 — 2026-08-03, pre-run, post-adversarial-review

Adversarial review commissioned per the standing §6 rule (Fable agent), against this section
as committed at `b90465b`, **before any measurement or query-set generation had occurred** —
`eval/declex-queries.json` does not exist yet. Per the Q1/SCALE, Q1/OUTCOME, and Q1/IDFUSE
precedent, no data existed, so the registration above was revised in place rather than
appended to; this log is the audit trail. The full review is committed verbatim at
`eval/results/q1-declex-design-review.md`.

The review's central judgment, quoted in full because it is the one sentence that governs
every amendment below: **"closure is close to foreordained (96% constructional anchoring,
vacuous harm gate — D fires 0/150 S-approx, 1/100 S-prose) and the amendments exist to stop a
near-foreordained CLOSED from masquerading as harm-tested, vector-advantage-reproducing
evidence for deletion."** Stated plainly, because it is the finding that matters most about
the process, not just the instrument: **effectively all nine findings run toward over-read
CLOSED / vacuous-pass — toward deletion; the direction momentum favours the investigator's
own prior (closure, M2's delete arm re-opening), not away from it.** None of the nine
findings flips the registered question or its arms; all are registration-text, scorer-
reporting, or generator-mechanics amendments, landing entirely before any measurement.

| # | Finding | Change | Direction |
|---|---|---|---|
| 1 | Harm gate a priori vacuous for the primary arm: D fires 0/150 S-approx, 1/100 S-prose (splitIdentifierTerms and the generator both lowercase off-stratum queries, silencing D's symbol-shaped-token eligibility gate before any measurement runs). HARM-CLEAN was certain and CLOSED-BUT-HARMFUL unreachable, by construction. | Vocabulary split: HARM-CLEAN requires ≥ 1 candidate on ≥ 10% of the stratum's queries; otherwise HARM-NULL (unexposed). CLOSED row's "harm-tested" language gated on ≥ 1 off-stratum reaching HARM-CLEAN; both-HARM-NULL routes to "closure with off-stratum harm UNTESTED... esc-arm harm contrast reported descriptively" instead. Mandatory per-stratum fire-rate aggregates in the RESULT. "Harm-free" language scoped to identifier-free queries. | **Toward vacuous-pass masquerading as harm-tested — pro-deletion.** |
| 2 | On-stratum closure is near-certain by construction (~96% D-anchor rate on the decision stratum; the 800-candidate cap never binds; dilution cannot recur) — legitimate for the registered question, but IDFUSE's generalization caveat was dropped from this draft, and the ~96% anchor figure was positioned to read as a discovery rather than a stated-in-advance construction property. | Generalization caveat restored ("closure generalizes only to queries literally containing the declared name as a symbol-shaped token"); Gate F publishes the fresh set's mechanically-computed anchor rate BEFORE scoring (expected ~96%, stated in advance); verdict language fixed to "closes the S-ident scale gap," never "reproduces the vector advantage" unqualified. | **Toward over-read CLOSED — pro-deletion.** |
| 3 | GAP CLOSED would re-open the delete arm while vectors hold an untested ~10pp LEVEL advantage on S-prose at T4 (H 92/100 vs L 82/100, never tested as a level contrast, plus the kluster-normal H−L significant baseline); D fires 1/100 on S-prose, so L+D forfeits whatever of that advantage is real, and the harm gate (L+D vs L) is structurally incapable of seeing what deletion loses vs H off-stratum. | Descriptive off-stratum L+D-vs-H level report registered (scorer-side); firewall sentence added to both CLOSED rows: re-opening the delete arm requires M2 to separately confront the S-prose level gap and the H−L baseline; DECLEX closure discharges the S-ident scale caveat ONLY. | **Toward false/over-broad CLOSED consequence — pro-deletion.** |
| 4 | Registered D is not the construction F-R2 projected: segment matching (the final-dot-segment rule) is an ADDITION F-R2's counterfactual never modeled, adding real candidate mass (a `toJSON`-class query faces ~140 same-segment candidates) — a mini dilution channel bounded only by ordering. The .9800 floor argument was computed over a smaller candidate set than the one actually registered. | One registered paragraph acknowledging the divergence; role assignment (original-400 D re-score = direct test of the F-R2 projection; fresh set = test of the registered construction; RESULT reports the divergence delta); Gate B gains a high-multiplicity-segment fixture (toJSON-class, ~140 same-segment candidates). | **Unknowable in sign — a provenance-accuracy defect, not a resolved bias.** |
| 5 | The fresh set cannot be generated by the committed generator as shipped: `eval/scale-build-queries.mjs` hardcodes `SEED=153`, has no exclusion-set support, and unconditionally overwrites `./scale-queries.json` — new, unregistered code would otherwise be the one point selection could re-enter after data exists. | Fresh-generator mechanics registered now: filter pool to exclude the 260 used targets → `mulberry32(154)` shuffle → sequential slices per stratum → write `eval/declex-queries.json` (distinct file, never touches `scale-queries.json`); Gate F extended with byte-determinism (two runs identical), exclusion-set ≡ the 260, prose-skip count, anchor-rate report. | **Toward an unregistered re-entry point for selection — pro-deletion if exploited, so closed off pre-emptively.** |
| 6 | Escalation arithmetic is guaranteed to exhaust the T1 pool: +150 S-ident needs 150, but the remaining T1 pool after the fresh draw is only 333 − 260 = 73, so 77 targets MUST be T2-resident, where `in_window@10(T1)` is structurally 0 and D_loss would be corrupted for ~26% of the escalated stratum if left inside the decision statistic. | Escalated Δ′ decided now: computed on T1-resident targets ONLY; T2-resident additions reported as a separate cell with endpoints T2→T4, never inside the decision statistic. | **Toward a corrupted decision statistic under escalation — direction unsigned, but the corruption itself was pro-deletion-by-noise (either direction, uncontrolled).** |
| 7 | Decision-table gaps: (i) a-fortiori + harm-fail fell through to AMBIGUOUS with no exit, though a-fortiori is stronger closure and should route to CLOSED-BUT-HARMFUL; (ii) reverse-significant efficacy (D hurts L on-stratum) landed INERT-LEVER, mislabeling an on-stratum-harmful lever; (iii) degenerate + harm-fail → CLOSED-BUT-HARMFUL was already fine; (iv) efficacy-fail + closure-met + harm-fail had no stated gate precedence; (v) the harm-CI bootstrap unit was unspecified, risking query×tier rows resampled as if independent (up to 4× overstated precision). | (i) mapped to CLOSED-BUT-HARMFUL; (iv) precedence stated explicitly — efficacy 2×2 gate evaluated first, its AMBIGUOUS/HARMFUL-LEVER outcome takes precedence over every verdict-table row; (ii) renamed **HARMFUL-LEVER (on-stratum)**; (v) bootstrap unit fixed to per-query (resample queries, carrying their tier rows together, never query×tier rows independently). | **Mixed: (i)/(iv) toward under-reported harm (pro-deletion); (ii) toward a mislabeled harmful lever (pro-deletion); (v) toward overstated precision on the harm CI (pro-deletion, narrower CIs make HARM-CLEAN easier to satisfy).** |
| 8 | The ≤20 escape cap is an unregistered magic number — confirmed nearly non-binding on the old set (only 2/73 eligible lowercase tokens exceed it), but unregistered thresholds are exactly the kind of post-hoc-adjustable knob a closure-favoring investigator could tune after seeing results. | Cap annotated "arbitrary, sensitivity-reported"; scorer publishes the matched-count distribution and the esc arm's cells at caps {5, 20, 50}. | **Toward an unregistered, post-hoc-tunable knob — pro-deletion if exploited, closed off pre-emptively.** |
| 9 | Comparability trap: the old-400 re-score will show near-perfect closure by construction (it is the projection's own training data); the registration demoted it to "descriptive comparability only" in name but built no narrative firewall preventing the RESULT from citing it as if it were evidence. | Narrative firewall registered: the RESULT's verdict paragraph may cite fresh-set numbers only; original-400 numbers appear solely under a separate heading, "projection-provenance data (mined-from, non-evidentiary)." | **Toward a technically-clean CLOSED whose narrative weight would exceed its evidentiary content — pro-deletion.** |

The review's SOUND and WITHDRAWN lists are recorded in full in the committed review file,
`eval/results/q1-declex-design-review.md`.

#### Q1/DECLEX RESULT (2026-08-03) — GAP CLOSED (harm untested): the declaration-exact ranker holds the identifier stratum flat at full scale; the S-ident scale caveat is DISCHARGED; the M2 delete arm RE-OPENS at registered scope

**Gates — all green.** Gate 1 (full suite): **597/597** tests. Gate E (`pending_embeddings ==
0`, H/H+D arms): **0 × 4** tiers, re-verified live by the adversarial results review (not
merely reused from the frozen state). Gate F (fresh-set integrity, extended per AMENDMENT 1):
byte-determinism PASS, **0/260** target overlap with `eval/scale-queries.json`, exclusion set
≡ the committed 260, and the D-anchor rate — **97.33%** (146/150) — published BEFORE scoring,
matching the measured fire rate exactly. Gate A (instrument self-check, ranker D disabled, 10
probes × 4 tiers × 2 arms): **80/80**, 0 mismatches. Gate C (arm integrity per call): **0
mode-integrity violations, 0 voided cells** over **19,200** scored searches (both query sets ×
4 tiers × 5 arms, plus the escape-cap sweep's supplementary rows). Gate D (cross-run
reproducibility against the Q1/IDFUSE run, L/H arms, descriptive): **3,200/3,200** per-target
ranks identical.

**Verdict, mechanically selected: `DECLEX_GAP_CLOSED_HARM_UNTESTED`.** The efficacy
precondition PASSES — L+D vs L @ T4, fresh S-ident: θ̂ = **+14.67 pp**, all-n seeded BCa 95%
CI **[+9.33, +20.0]**, exact Wilcoxon **p = 4.77e-7** (22 positive / 0 negative / 128 zero
pairs). The decision-bearing contrast Δ′ (= D_loss_{L+D} − D_loss_H, fresh S-ident) is **not
significant** (exact Wilcoxon degenerate below the registered informative-pairs threshold),
with all-n seeded BCa 95% CI **[−5.33 pp, 0]** — upper bound exactly **0**, inside the
registered ≤ 5 pp floor, and seed-invariant (hi = 0.00000 across all 50 alternative seeds).
`in_window@10` holds **flat** T1 → T4 for L+D: **.9867 → .9867** — the SAME 148 queries
in-window at both endpoints (0 exits, 0 entries) — against H's **.9867 → .9733** and L's
**.9400 → .8400**. Both off-strata are **HARM-NULL**: D fires on only **0.67%** (s_approx) and
**0.50%** (s_prose) of queries, both below the registered 10% exposure floor — the harm gate
could not fire at the primary construction.

**The four review-mandated caveats, at full strength — this row's survival is conditioned on
stating them, not on omitting them:**

1. **The esc-arm harm contrast (RF-1).** The registered "reported descriptively in its place"
   esc-arm harm contrast is **missing from the scorer output** (`declex-score.mjs` emits only
   fire rates + match counts) — logged as AMENDMENT 2 finding 1, below. Computed by the review
   with the registered per-query block bootstrap, its content is **adverse at every cell**: cap
   20 s_approx **−4.83 pp [−9.17, −1.0]**, s_prose **−13.5 pp [−19.75, −8.25]**; cap 5 s_prose
   **−10.75 pp [−16.5, −6.5]**; cap 50 s_prose **−13.5 pp [−20.0, −8.0]** — every cell excludes
   0 in the harmful direction. The escape variant is measured **harmful off-stratum** and may
   not ship without a new registration; **F18 is ranker D WITHOUT escape.**
2. **Statistical degeneracy (RF-2).** 146/150 pairs are ties; the four nonzero pairs are
   `[−1, −1, −1, +1]`. The ns leg of the decision-bearing Wilcoxon was **structurally
   incapable of failing** at this degeneracy (minimum achievable two-sided p at n = 4 is
   0.125) — closure is carried entirely by the seed-stable BCa upper bound of 0, not by the ns
   leg. Stated plainly: the experiment contained **~4 informative pairs** on the decision
   contrast.
3. **Counterpart-credit composition (RF-3).** **23/148** of L+D's T4 in-window hits are
   shell-counterpart credits (H: 14/148); 2 of the 3 queries where L+D exceeds H are shell
   credits, not exact-target retrievals. The dedup-aware hit rule is the registered metric,
   applied uniformly — legitimate — but "**.9867 > H**" must not be read as exact-hit
   superiority.
4. **Prediction miss (RF-5) + near-miss trigger (RF-6).** The registered prediction was Δ′ ≈
   **−2 to −4 pp**, a-fortiori territory; observed θ̂ = **−1.33 pp**, plain CLOSED — H barely
   degraded on the fresh draw (D_loss_H = 1.33 pp vs ~6 pp on the old 400). Deflationary
   surprise, stated. The s_approx supporting Δ′ trended **L+D-worse** (θ̂ = **+5.33 pp**, CI
   **[−0.67, +10.67]**), one step from the closure-direction consistency trigger. Off-stratum
   LEVEL deficits vs H, seed-robust: s_approx **−7.67 pp [−13.0, −3.17]**, s_prose **−7.25 pp
   [−13.5, −2.75]**.

**The mechanism finding (review-verified, decides what "flat T4" actually means).** D-fired ⇒
in-window at T4 in **290/290** cases across both query sets (full-name/shell ordering puts the
anchor at D-rank ~1; RRF lands it every time); D-silent ⇒ the L+D row is identical to L. The
segment channel is live and adds the predicted crowd (candidate counts up to **139**, ≈ the
~140 `toJSON`-class prediction) but **0 of 70 segment-only reaches fell out of window** — the
crowd sits below full-name matches by ordering and never displaced a membership. Verified by
**48/48** end-to-end reconstructions, exact on rank, hit_case, pre-dedup rank, mode, and every
d_diagnostic field. RF-7's single window-invisible harm micro-instance (original s_prose_4,
T4, D fired at cc=1, demoted the target rank 1→2 — the only off-stratum D effect in 3,200
original row-pairs) is footnoted, not folded into the verdict.

##### Projection-provenance data (mined-from, non-evidentiary)

The original-400 re-score exists solely for comparability against SCALE/IDFUSE and carries no
verdict weight (AMENDMENT 1, F-9). T4 s_ident_L+D = **.9800** exactly, matching the F-R2
projection with a divergence delta of exactly **0** on all five dimensions the review checked.
Confirmed **mechanism-explained, not a same-code-path artifact** (RF-4): the scorer compares
measured rates against hardcoded `F_R2_PROJECTION` constants with no shared code path, and the
zero delta is reproduced from raw per-row data.

**What this licenses, at full registered scope.** The **S-ident SCALE caveat is DISCHARGED**:
for queries literally containing the declared name as a symbol-shaped token, lexical +
declaration-exact (F18, WITHOUT the escape variant, now measured harmful off-stratum) holds
`in_window@10` flat T1→T4 on a fresh, never-scored 150-query set, with efficacy over plain
lexical of +14.67 pp [+9.33, +20.0] — so the **M2 delete arm RE-OPENS**, F18 the enabling
product change, subject to its own regression suite. It licenses **nothing else**: harm on
identifier-free queries remains **UNTESTED** at the primary construction (the realistic
shipped-D harm surface — mixed-case prose mentioning non-target identifiers — lies outside
every stratum); the S-prose T4 LEVEL gap (H 92/100 vs L 82/100) and the kluster-normal H−L
baseline remain **unconfronted** (fresh-set descriptives point the same way, L+D
−7.7/−7.25 pp below H off-stratum, seed-robust); closure generalizes only to
symbol-shaped-token queries from the same TSDoc-rich exported-declaration population on this
one corpus; **15.5%** of L+D's window hits are shell-counterpart credits; and the
outcome-at-scale question retains its **Reserve** standing — nothing here measures agent task
outcomes. Deleting the vector store on this evidence is a bet that these scoped-out gaps don't
matter; **M2 must confront each explicitly before that bet is placed.**

#### AMENDMENT 2 — 2026-08-03, POST-scoring, after adversarial review of the results

Unlike Amendment 1 (pre-run), these corrections were found **after** seeing results by a
commissioned adversarial review (committed verbatim at
`eval/results/q1-declex-results-review.md`), not by me. **None flips the verdict row** — the
review's overall verdict is "`DECLEX_GAP_CLOSED_HARM_UNTESTED` survives, with required
caveats" (see the RESULT section above).

| # | Error | Direction it ran |
|---|---|---|
| 1 | The registered esc-arm harm contrast was omitted from the scorer output (`declex-score.mjs` emits only fire rates + match counts). | Pro-deletion (under-reported harm story — the direction ALL nine design-review findings ran). Computed by the review with the registered block bootstrap; numbers carried in the RESULT; scorer gap to fix before reuse. |
| 2 | The escape-cap sweep required 3,200 supplementary measured rows beyond the registered 16,000 (the scorer only reports caps it is given). | Volume deviation, logged by the runner at commit time; no contamination (review: exact union, 0 dup keys, esc parts isolated to the esc arm). |
| 3 | Registered prediction missed (−2..−4 pp a-fortiori vs observed −1.33 pp plain CLOSED). | Deflationary; recorded per the pre-stated-prediction discipline. |
| 4 | Determinism-gate hash vs pretty-printed file hash differ (compact-JSON hashing) + `git_head_at_generation` stamps the regeneration HEAD. | Cosmetic provenance nits, pre-explained to prevent false "tampering" discoveries. |

The review committed verbatim is the verification basis: its **48/48** end-to-end
reconstruction and **50-seed** CI sweep are what the RESULT section's numbers rest on.
Pre-run prediction scorecard: **6 HIT / 1 MISS**.

---

## Stage 6: F18 productization — ranker D in shipped `hybridSearch` (2026-08-06, per M2 memo conditions 1–3)

**Goal**: the declaration-exact ranker ships in the product exactly as measured, behind a
default-on kill-switch, with D-fire telemetry and the Gate B fixtures as a permanent
regression suite. The vector-store deletion (memo condition 4) is a SEPARATE later stage —
this stage adds D to the existing fusion (the measured H+D arm), so post-deletion search
becomes L+D with no further ranking change.

**Design decisions (recorded before implementation):**

1. **Module**: `src/search/declex.ts` — TypeScript port of `eval/declex-ranker.mjs`,
   PRIMARY arm only. The escape variant is NOT ported (memo condition 1: measured harmful,
   requires fresh registration; the instrument file remains the escape record). Function
   names are preserved (`deriveRankerDTerms`, `isEligiblePrimaryTerm`, `searchRankerD`) so
   "exactly as measured" is auditable line-against-line with the instrument.
2. **Fusion**: third RRF map in `hybridSearch`, byte-matching
   `reconstructWithRankerD` (`eval/declex-rank-check.mjs:161-208`): D queried at
   `candidateLimit` (= limit × 4), rows ranked 1..n by the registered ordering,
   `rrfScore(dRank, rrf_k)` added to the sum, same downstream pipeline (top-pool →
   `getChunksByIds` → RRF sort → shell/method dedup → backfill).
3. **Kill-switch** (memo condition 3): `MastConfig.declaration_exact_ranker: boolean`,
   default `true`, resolved through the existing config chain and threaded via
   `HybridSearchConfig`. Flag off ⇒ `hybridSearch` behaves byte-identically to pre-F18.
4. **Telemetry** (memo condition 3): when D fired, `hybridSearch` computes the fusion
   twice — with and without D's map (pure in-memory arithmetic over already-fetched
   lists; no extra IO) — and reports per-result window effects. Persisted as a new
   additive `metrics.declex_json` column (`ALTER TABLE` precedent: `args_json`/
   `results_json`, no `CURRENT_SCHEMA_VERSION` bump):
   `{fired, top_match_channel, candidate_count, window_effects: [{chunk_id, symbol_name,
   rank_with_d, rank_without_d}], _truncated?}` — window_effects lists final-window
   entries whose rank differs between the two fusions plus entries pushed OUT of the
   window (rank_with_d: null), capped at 10 entries with the stated-honestly cap rule.
   NULL for queries where D did not fire and for all other tools.
5. **Regression suite** (memo condition 2): Gate B primary-arm fixtures ported to
   `src/search/__tests__/declex.test.ts` against the product module (dotted
   `Class.method` segment match, camelCase full match, case-insensitivity, underscore-
   literal LIKE escaping, same-name multiplicity ordering, chunk_id tie-break, the
   140-candidate `toJSON` high-multiplicity fixture, empty/no-eligible-term firing rules,
   OR semantics, pool cap, two-run determinism). Escape fixtures stay in `eval/`.
6. **Docs**: MAST_SPEC.md — §4.1 (config key), §7.3 (fusion gains the declaration-exact
   list + flag semantics), §14.3 (`declex_json` column). `eval/README.md` remains stale
   (pre-existing, out of scope).

### Stage 6.1: Port ranker D + regression suite
**Success criteria**: `src/search/declex.ts` ships `searchRankerD` (primary arm only);
ported Gate B fixtures pass against it; instrument file untouched.
**Tests**: `src/search/__tests__/declex.test.ts` (ported fixtures, red first against the
empty module).
**Status**: Complete (2026-08-06) — 25 fixtures red-first then green; full suite 622/622
(+25 over the 597 baseline); tsc + lint clean. Port verified line-against-line vs the
instrument; 4 strict-TS accommodations, all behavior-neutral (type-guard for the SQL
`IS NOT NULL`, annotated ternary over a cast, unreachable `?? 0` map fallbacks,
`candidates[0]` bound before branching).

### Stage 6.2: Fusion + kill-switch
**Success criteria**: D fused as third RRF list behind `declaration_exact_ranker`
(default on); flag off ⇒ pre-F18 behavior; D-silent ⇒ result set identical to flag-off
(the measured invariant); D-fired ⇒ anchor participates in RRF exactly per the
reconstruction.
**Tests**: `hybrid` test additions — flag off/on equivalence when D silent; anchor
in-window when D fires; dedup/backfill interplay unchanged.
**Status**: Complete (2026-08-06) — 8 new tests red-first then green (fusion invariants +
config default/override); full suite 630/44 (+8 over 622); tsc + lint clean. Fusion diff
verified against `reconstructWithRankerD` line-for-line. Logged deviations: config tests
went to a NEW `src/store/__tests__/config.test.ts` (none existed); dedup-interplay fixture
uses `Foo.Bar` (capitalized segment) because a bare lowercase `bar` never passes D's own
eligibility gate. `pnpm align:check`: 2 pre-existing repo-level REDs outside
`packages/mast` (ui root-layout cycle, api fold-build-record repo) — untouched by this
stage, consistent with the handoff's pre-existing-debt note; 6.4 re-checks for NEW debt.
**Design note (recorded before implementation):** `HybridSearchConfig.declaration_exact_ranker`
is OPTIONAL with absent ⇒ OFF, gated `=== true`. Rationale: the eval instruments
(`declex-rank-check.mjs:304`, idfuse equivalents) call the shipped `hybridSearch` to
reconstruct measured arms — a function-level default-on would silently turn every future
instrument H-arm reproduction into H+D, breaking Gate D reproducibility without an error.
The memo's "default on" lives in `MastConfig` DEFAULTS (the product config chain), which
is the layer a kill-switch belongs to. D applies no `file_pattern`/`language` pre-filter —
same as the vector list (pre-existing shipped semantics; the measured construction had no
filter either); `chunk_type`/`only_exported` post-filters apply downstream unchanged. D
never affects the `mode` discriminator (matches the reconstruction: mode comes from the
vector path only).

### Stage 6.3: D-fire telemetry
**Success criteria**: dual-fusion diff computed only when D fired; `declex_json` written
via `recordToolCall` for `mast_search`; caps honest; metrics failures still swallowed.
**Tests**: unit tests for the window-diff builder; integration test asserting the
persisted row shape.
**Status**: Complete (2026-08-06) — 14 new tests red-first then green; full suite 644/44
(+14 over 630); tsc + lint clean; align unchanged vs pre-existing repo debt (verified via
stash). Dual-fusion diff verified: D-only ids EXCLUDED from the without-D reconstruction
(not zero-scored), identical RRF arithmetic, union-of-top-`limit`-windows effect set,
deterministic ordering, `fired: true` rows persisted even with zero window effects
(exposure data). Design refinements vs decision 4's sketch, recorded: (i) window_effects
report the ACTUAL fused rank wherever the id is still in a list — null only on true
absence (D-only ⇒ `rank_without_d: null`); (ii) truncation is a top-level
`_truncated: <dropped>` field (the `buildArgsJson` convention, not `buildResultsJson`'s
appended sentinel — a sentinel inside `window_effects` would be indistinguishable from a
malformed effect); (iii) `DeclexTelemetry`/`DeclexWindowEffect` live in `hybrid.ts`, not
`declex.ts` — window effects are a property of the fusion, not the ranker.

### Stage 6.4: Verify + document
**Success criteria**: full suite green (597 baseline + new), `tsc --noEmit` clean, lint
clean, `pnpm align:check` no new debt vs the 327 baseline; MAST_SPEC.md updated;
this stage table updated; handoff updated.
**Status**: Complete (2026-08-06) — suite **644/44** green; `tsc --noEmit` clean; lint
clean; `pnpm align:check` red at the EXACT pre-existing baseline (324→327 +3,
"provisional", identical pre-Stage-6 — no new debt). MAST_SPEC.md updated: §4.1
(`declaration_exact_ranker` key + rationale), §7.3 (ranker D as third RRF input — match
rule, eligibility gate, ordering, filter/mode semantics, escape-variant exclusion),
§14.3 (`declex_json` column + dual-fusion diff contract). `mast_reindex` run (10 files,
0 parse errors). HANDOFF_Q1.md updated with the 2026-08-06 addendum.

**Stage 6 exit state**: F18 is productized per M2 memo conditions 1–3. NOT yet done
(deliberately out of scope): memo condition 4 — the vector-store deletion — which is the
next stage of work; and the memo condition 5 review clock (harvest n ≥ 67 or 90 days)
starts at DELETION ship, not at F18 ship.

---

