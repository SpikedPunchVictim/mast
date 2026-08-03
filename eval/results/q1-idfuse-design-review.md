# Q1/IDFUSE adversarial design review (Fable, 2026-08-03, pre-measurement) — verbatim
Reviewed: IMPLEMENTATION_PLAN.md:2975-3138 at commit 9ecceca. CI arithmetic uses the normal
approximation as a proxy for the seeded BCa (parent's realized BCa widths matched to ±0.1pp).

## F1 (HIGH) — Ranker I's term derivation from the query string is unregistered; the three natural choices produce three different experiments.
The registration commits the match-expression builder (trim/filter, phrase-quote, OR-join;
fts.ts:145-147) but not how the raw query becomes input terms. The only production caller
feeds splitIdentifierTerms(query) (hybrid.ts:287,295), which camelCase-splits and lowercases
(fts.ts:170-184) — but the indexed token is the UNSPLIT case-folded whole
(extractIdentifiers regex, typescript.ts:1430-1438; unicode61 does not split case,
db.ts:286-292). FTS5 unicode61 has no subword matching, so split terms (scan, code, chord)
can never match indexed scancodechord: the natural code-reuse path builds a ranker
STRUCTURALLY INERT on exactly the S-ident anchor. Whitespace-split instead breaks the
36/150 dotted method targets (phrase "Scrollable.getFutureScrollPosition" = adjacent-token
phrase over the dedup bag; Scrollable typically absent from the method chunk) — 24% of the
decision stratum loses its anchor. Only a toFtsMatch-style token split ([A-Za-z0-9_$]+, no
case-splitting) anchors all 150. Direction: most natural path runs toward false
INERT-LEVER / false GAP SURVIVES. Fix: register the derivation explicitly; extend Gate B
with dotted-method + camelCase known-answer cases.

## F2 (HIGH) — Efficacy-fail + closure-criteria-met is a reachable cell with two contradictory registered outputs.
Efficacy (L+I vs L at T4, CI excluding 0) needs >= ~4-5 net rescues (k=3 -> CI lo -0.24pp
FAIL; k=4 knife-edge; k=5 PASS). If the true residual gap is small (parent CI allows
2-3pp), I rescuing 3 queries yields INERT-LEVER while Delta' simultaneously satisfies GAP
CLOSED. Direction: toward false GAP SURVIVES. Fix: map the cell to AMBIGUOUS with both
contrasts reported (or demote efficacy to a mechanism-label diagnostic).

## F3 (MEDIUM-HIGH) — Reuse of f40f2bf L/H rows is false economy guarded by a weak sample.
(a) raw rows carry only per-target ranks (no 200-lists) so Gate D is per-target;
(b) 20 queries: drift at f=2% missed 67% of the time, f=5% 36%;
(c) the paired Delta' subtracts a 2026-08-02 H row from a 2026-08-03 L+I row — run-level
environment drift lands INSIDE the decision statistic. Full L/H re-run is 3,200 searches
(minutes, zero embeds); reuse saves ~the cost of the drift gate itself. Direction:
unknowable. Fix: re-run L and H in full alongside L+I/H+I; keep Gate D as a cross-run
reproducibility report (if reuse kept: >=50 queries + detection-curve logged).

## F4 (MEDIUM) — GAP SURVIVES has no magnitude gate (parent's F-R2 lesson unapplied).
theta=+3pp CI [+0.5,+5.0] p=0.03 -> SURVIVES; same theta CI [-1,+5] ns -> CLOSED. A
significant sub-floor residual gets dignified as a "defensible niche." Direction: toward
false GAP SURVIVES. Fix: verdict language carries realized theta/CI vs the 5pp floor;
significant + CI upper <= 5pp = "SURVIVES (marginal, sub-precision-floor)".

## F5 (MEDIUM) — Two reachable cells unmapped or mapped perversely.
(a) Reverse-significant (L+I degrading LESS than H) falls to AMBIGUOUS though the parent
had an a-fortiori discharge row for the analogous cell. (b) Degenerate Wilcoxon (all 150
Delta'=0 — perfect closure) has no defined row; parent's "degenerate counts as not
significant" clause was not restated. Direction: routes ideal closure to AMBIGUOUS. Fix:
add both rows (reverse-significant -> CLOSED a fortiori, descriptive; degenerate -> not
significant for row 1).

## F6 (MEDIUM) — The 5pp bound's reachability corridor is tighter than stated.
At n=150, balanced outcomes pass only up to (7,7) (upper 4.89pp); (8,8) fails (5.23pp);
any net +2 imbalance with >=~11 non-zeros fails. If I equalizes means but perturbs pairs
(RESERVE-1 vote-dilution precedent), p_nz stays ~0.107 and a TRUE-ZERO residual reaches
CLOSED with only ~1/3 probability. Escalation ("adding queries") has no pre-registered n
or rule. Direction: toward perpetual AMBIGUOUS (pro-incumbent). Fix: pre-register
escalation now — committed generator, pre-named seed, target n=300 (floor ~3.7pp).

## F7 (MEDIUM-LOW) — "Exact-identifier semantics" overstated; a TSDoc-prose double-count channel exists (partial).
extractIdentifiers sweeps ALL word tokens of context-expanded content (context_lines=3,
config.ts:38, includes lines above the declaration); the generator reads TSDoc from lines
above start_line — so the last ~2 TSDoc prose lines land in the identifier bag; rare query
words from there get an exact-token I match that double-counts chunk_fts evidence — a
channel real agent queries (0/147 reused question wording) do not get. Ranker I is a mixed
identifier + partial-prose ranker; efficacy/closure can partly ride the prose half while
the write-up attributes everything to identifier anchoring. Direction: toward false GAP
CLOSED + mechanism misattribution. Fix: registered caveat + per-query diagnostic logging
which query terms matched the target's identifier row (symbol vs rare-word), and/or a
symbol-term-only I variant as descriptive sensitivity.

## Circularity adjudication (attack 2c): the exact-name anchoring is NOT circular — it is
the production-relevant question (harvest: real queries identifier-bearing; parent: the
entire vector advantage lives in S-ident; S-approx trigger guards the split case, where
RESERVE-1 says I may even be harmful). Registration owes one sentence: GAP CLOSED
generalizes only to exactly-spelled identifier-bearing queries (no subword matching; and no
vector help either on S-approx). The circular residue is F7's prose channel, not the anchor.

## F8 (LOW) — "Pool 4x limit per ranker" misdescribes shipped arms: chunk_fts is
effectively 8x (hybrid.ts:59 candidateLimit=limit*4; fts.ts:92 limit*2 -> 1,600 rows);
vectors 4x. Ranker I at 4x matches searchVectors. Negligible for top-10; correct the text.

## F9 (LOW) — Bootstrap on reused-vs-new pairing: moot if F3's full re-run is adopted.

## SOUND: unordered-function catch correct (both call sites order-insensitive);
identifier_fts absent from RRF body; commit ordering verified; all file:line anchors check;
triggers genuinely symmetric and trigger 1 live (RESERVE-1 precedent); bag-BM25 = coherent
IDF-weighted set-overlap ranker (right semantics for exact-token RRF input); 5pp floor and
cost arithmetic reproduce; H+I verdict-barred everywhere; direction-of-error statement
honest; INERT-LEVER concept sound; gates reuse validated machinery; per-call capture
preserves F-R1-style sensitivity re-runs.

## WITHDRAWN: rare-word flooding (rare by construction; kept only as F7 double-count);
bag-BM25 meaninglessness; markdown-unreachability distortion (property of the product
change, not artifact); bm25 tie-order nondeterminism (deterministic within one db file;
environment drift folded into F3); lowercased-query-vs-camelCase mismatch (unicode61
case-folds; verified sample).

## JUDGMENT: Fit to run ONLY with amendments A1-A6 (term derivation + Gate B cases;
collision cell -> AMBIGUOUS; full L/H re-run; SURVIVES magnitude caveat; two added rows;
pre-registered escalation n=300) plus the F7 diagnostic and F8 correction. The core is
strong; as committed it under-specifies the two things that decide the verdict: what
ranker I does to a query string, and what happens when its two registered tests disagree.
