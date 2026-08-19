<!-- SHARD — do not edit the excerpt below. -->

> **Plan excerpt — ADR 002: Retrieval: hybrid was never justified over lexical.**
> Verbatim from `IMPLEMENTATION_PLAN.md` at commit `69a587e`, lines 6423–8611, 9993–10071, 10086–10141 (concatenated in that order).
> This is the append-only record the ADR was written from; the ADR is the summary, this is the evidence.
> Nothing here has been edited — see `docs/provenance/verify-plan-shards.mjs` for the losslessness proof.

---

### Q1 — pre-registered experiment design (written 2026-08-01, BEFORE any arm was run)

Pre-registration is the point. E7's value came from three falsification criteria
committed before measurement; this follows that precedent. **Nothing below may be
edited after the first scored run** — amendments get appended with a timestamp and a
reason, per §15.4's "the instrument was amended mid-experiment" finding.

#### The questions (named first)

1. On **lexically-normal** queries, does hybrid beat lexical-only on NDCG@10, and by
   how much?
2. On the existing 28 **anti-lexical** queries, does hybrid beat lexical? (Per §14.3
   this arm can only *kill* vectors, never justify them — reported, not decisive.)
3. What fraction of queries does lexical alone answer adequately (a gold target in
   the top 10)?
4. Where hybrid wins, is the win concentrated in a nameable query class?
5. Cost side: what does the subsystem actually buy per unit of the 7.2 h / 470 MB /
   169 ms it costs at the 153k target?

#### Arms

| arm | construction |
|---|---|
| **L** — lexical-only | `hybridSearch(db, null, …)` — falls to lexical at `hybrid.ts:72`. §14.3: adding it is a single argument; call site `score-only.mjs:52`. |
| **H** — hybrid | shipped RRF, rank-based vector inclusion (§7.3) |
| **V** — pure vector | raw cosine; isolates the model. Already in the harness. |

#### D2 prerequisite — corpus pinning (decision + rationale)

§14.2 recommended switching to `nest` as an external, pinnable corpus. **Rejected for
Q1**, with reason: the 28-query / 43-target gold set is authored against *kluster's own*
chunks, so switching corpora discards all of it. Instead: **pin kluster at a fixed git
SHA via `git worktree`** and index that. This fixes §14.2's actual defect — `chunk_id`
is `sha256(file_path + ":" + start_line)`, so ids break on *line drift*, and a pinned
tree has none — while preserving the sunk authoring cost. `nest` is retained as the
**n ≥ 2 external replication**, run only if Q1 lands in the ambiguous band below.

Also required: `eval/paths.mjs` `SCRATCH` points at dead session
`c4f25db4-…`; `corpus-subset.json` is **empty (0 bytes)** despite the README
describing it as "frozen 3,006 chunk-ids". Both must be repaired and the state moved
out of the session scratchpad before any arm runs.

#### The new lexically-normal queries — provenance protocol

The trap is symmetrical: E4's 28 queries were *"deliberately worded to minimize lexical
overlap"*, and me hand-authoring 15 replacements would just bias the other way.
Two sources were considered and one rejected:

- **Rejected — `metrics.args_json` (real agent queries).** Verified working on
  2026-08-01 (a `mast_search` call landed one row with `args_json` populated exactly
  per §14.3 — the previously-empty table was "nothing instrumented had run against
  this state dir", **not** a defect). But n=1 today, so it cannot source 15 queries.
  **Promoted to the reserve as the v2 source**: harvest real queries over the coming
  weeks and re-run Q1 against them.
- **Adopted — this repo's own pre-existing task descriptions.** `IMPLEMENTATION_PLAN.md`
  task rows and `GITNEXUS_COMPARISON.md` findings are natural-language descriptions of
  code locations that **cite their own ground truth** (e.g. "`parseCallee`: unwrap
  `await_expression` (`typescript.ts:1360`)"). They were written by a human, for a
  purpose unrelated to this experiment, before it was designed. That is materially
  better provenance than anything authored now.

Protocol: sample 15 such rows with a seeded RNG, use the description verbatim as the
query (identifiers included — that is what makes them *normal*), and the cited
`file:line` as the target. Freeze into `gold-set-normal.json` and gate with
`verify-gold.mjs` **before** any arm is scored.

#### Pre-committed decision rule (limit=10, NDCG@10 on the normal set)

| outcome | verdict |
|---|---|
| hybrid − lexical **< 0.05** *and* lexical Recall@10 ≥ 0.80 × hybrid's | **Vectors die.** M2 resolves to arm D: delete `vectors.lance`, drop `@lancedb/lancedb` (−91 MB), retire the forked embedder and the `mode` discriminator. |
| hybrid − lexical **≥ 0.15** | **Vectors justified.** Proceed to the A-vs-C benchmark at 153k (vscode). |
| **0.05 – 0.15** (ambiguous) | Escalate: run the `nest` external replication (n ≥ 2), **and** promote the reserve arm below. |

#### Design Reserve (pre-thought, NOT a build commitment)

- **Identifier decomposition** (Stage 4.5 lever #2) — index `checkAuthToken` also as
  `check auth token` in a second FTS column, making conceptual queries hit
  *lexically*. Promoted **only** if Q1 lands in the ambiguous band or justifies
  vectors: if this closes the gap at zero query cost, vectors still die and the
  capability is kept. Do not build it to find out — measure L vs H first.
- **`metrics.args_json` harvest** — the real-query re-run described above.

#### D2 result (2026-08-01) — harness repaired, gate green

**Two M1-induced rot sites found, both reading the retired Lance chunk table:**

| site | symptom | severity |
|---|---|---|
| `build-corpus.mjs:38–39` | `LanceStore.chunkCount()` → reported `TOTAL CHUNKS = 0` **as success** | **false-green** — would have frozen an empty corpus and scored against it |
| `verify-gold.mjs:11–12` | `LanceStore.getAllChunks()` → empty set, so all 43 targets read `(file not in corpus)` | false-red — a confident, wholly artifactual "GOLD SET INVALID" verdict |

The second failed *closed* (exit 1), so nothing was scored against bad data. The first
did not — it printed a zero-chunk corpus as a successful build. Both now route through
`SqliteChunkStore`, and **both gained an explicit zero-chunk guard** so this class
cannot recur silently in either direction.

**Corpus pinned and rebuilt:**
- `git worktree add --detach ~/.cache/mast-eval/corpus-kluster 07d705b…`
- `paths.mjs` moved off the dead session scratchpad to `~/.cache/mast-eval`, and now
  exports `CORPUS_SHA` for stamping into results.
- Build: **1,322 files / 10,997 chunks / 0 parse errors in 27.2 s** — against the
  README's pre-M1 budget of ~7 min, an incidental reconfirmation of M1's win.

**Gold set survived the pin:** after the read-path fix, 42 of 43 targets resolved
unchanged. The single casualty (q19 → `packages/IMPLEMENTATION_PLAN.md` L1620) targets
a file deleted before `07d705b`; it was **dropped, not substituted** (see
`gold-set.json > amendments`), and the repair was made before any arm was scored.
Gate now prints `queries: 28  targets: 42  missing: 0  → gold set OK`.

**A third and fourth Lance rot site were found while wiring the arms:**

- `make-subset.mjs:20–21` — `LanceStore.getAllChunks()`. Would have frozen a subset
  containing **zero gold needles**, silently crippling every vector-using arm while
  reporting "subset frozen: 3000 chunks".
- `search/hybrid.ts:55` — `chunkStore: ChunkStore = lance`. The **shipped** default
  parameter still points at the retired Lance chunk table. Shipped call sites all pass
  it explicitly so production is unaffected, but any new caller that omits it gets zero
  results with no error. Left in place (out of M2's scope) but flagged: this is a
  loaded gun in a public signature. Candidate for Stage 3.5/C1.

**Instrument built (2026-08-01):**

| artifact | what it is |
|---|---|
| `gold-set-normal.json` | 15 lexically-normal queries, **15 distinct targets**, mechanically selected (seed 20260801) from the pinned tree's own task rows. 3 amendments logged, all pre-scoring, plus an explicit stopping rule. |
| `build-normal-set.mjs` | the harvester; sentence/table-row units, dedup by target chunk |
| `corpus-subset.json` | re-frozen: 3,000 chunks = **54 gold needles (from 57 targets across both sets, 0 unresolved)** + 2,946 distractors |
| `q1-vector-value.mjs` | the three-arm scorer (L/H/V) with the pre-committed decision rule inlined |

One amendment is worth calling out because it cuts against the incumbent: the harvest
unit was changed from *line* to *sentence* because line-splitting produced grammatical
debris that keeps rare identifiers but loses conceptual content — which would have
biased the experiment **toward killing vectors**. The correction favours the subsystem
under test, which is the direction an author with a thesis would not choose.

#### 🔴 Q1 run of 2026-08-01 is VOID — corpus leakage in the query protocol

The run completed and printed `VERDICT: VECTORS JUSTIFIED`. **That verdict must not be
used.** Raw numbers kept on the record (`~/.cache/mast-eval/results/q1-vector-value.json`):

| set | arm L (lexical) | arm H (hybrid) | arm V (pure vector) |
|---|---|---|---|
| normal (15) | **0.0000** | 0.4386 | 0.5046 |
| anti-lexical (28) | **0.0000** | 0.5109 | 0.5193 |

**What tipped it off:** arm L scored *exactly* 0.0000 on NDCG, Recall and MRR across
all 43 queries. A BM25 index containing the literal tokens `parseCallee` and
`walkProject` cannot score zero on queries containing those words — and standalone,
`hybridSearch(db, lance, null, …)` on `"walkProject"` returns 10 results with the
correct target at rank 1. So the arm works; the *queries* are broken.

**Root cause — confirmed, not theorised.** Every normal query returned **exactly one**
result, and for all 15 that sole hit is the query's **own source document**:

```
n01 provenance: eval/GITNEXUS_COMPARISON.md  → L-arm sole hit: eval/GITNEXUS_COMPARISON.md (doc)
n02 provenance: IMPLEMENTATION_PLAN.md       → L-arm sole hit: IMPLEMENTATION_PLAN.md (doc)
```

The protocol harvested queries **verbatim from documents that are themselves in the
corpus** (`.md` is in `file_extensions`). A 200-character verbatim sentence is a
near-perfect trigram match for exactly one chunk — the paragraph it was copied from —
so FTS returns that and nothing else. Arm L therefore scores 0 **by construction**, not
by measurement.

**The bias runs toward the incumbent.** The leak cripples the lexical arm specifically,
manufacturing the "vectors justified" verdict. Had I taken the number at face value,
M2 would have proceeded to an A-vs-C benchmark on the strength of an artifact.

**Two distinct defects, only one of which I anticipated:**

1. **Corpus leakage** — the source docs are in the corpus. Fixable by excluding
   `packages/mast/IMPLEMENTATION_PLAN.md`, `eval/GITNEXUS_COMPARISON.md`, and
   `packages/mast/.history/**` (q19's target lives in `workbench/fold/`, so it survives).
2. **Query realism** — a 200-char verbatim sentence is not how anything searches. MAST's
   own §12 prompt tells agents to use *code tokens*. Even leak-free, these queries do not
   represent the workload. This defect I did not foresee, and it is the more serious of
   the two.

**Not a bug:** the anti-lexical set's `L = 0` is expected. That set is anti-lexical by
design (§14.3) — it exists to defeat trigram FTS. Only the normal set is affected.

**Why this is not being quietly re-run.** `gold-set-normal.json` carries a declared
stopping rule, and I have now seen which direction the error ran. Amending an instrument
after seeing its results is exactly the §15.4 failure ("the instrument was amended
mid-experiment"). The redesign needs an explicit, recorded decision and a re-registration
**before** the next run — not a fourth silent amendment.

**Status: Q1 unresolved. M2 remains blocked.**

#### Q1-r2 — RE-REGISTERED protocol (written 2026-08-01, BEFORE the re-run)

Approved after the void run. The v1 numbers stay on the record above so this change
is auditable.

**Fix 1 — leakage.** Exclude the query source documents from the corpus:
`packages/mast/IMPLEMENTATION_PLAN.md`, `packages/mast/eval/GITNEXUS_COMPARISON.md`,
`packages/mast/.history/**`. q19's target (`workbench/fold/IMPLEMENTATION_PLAN.md`)
is unaffected. Requires: rebuild corpus → re-run `verify-gold` → re-freeze subset →
re-embed.

**Fix 2 — realism.** Query is derived from the TARGET, not from prose quoting it:
`camelCaseSplit(symbol_name)` + the first sentence of its TSDoc, capped at ~12 words,
code tokens retained. E.g. `walkProject` → *"walk project file discovery exclude
patterns"*.

**⚠ Fix 2 introduces a KNOWN, OPPOSITE bias — stated before the run, not after.**
A chunk's TSDoc is part of its own indexed content, so a TSDoc-derived query hands the
lexical arm tokens that are literally inside the target. The normal set is therefore
**biased FOR lexical**. This is not concealed — it is load-bearing, because it converts
Q1 into a **bracketing** design:

| set | built-in bias | what a win there proves |
|---|---|---|
| anti-lexical (28) | **for vectors** — worded to defeat trigram FTS (§14.3) | **lexical** winning ⇒ vectors die decisively |
| normal (15) | **for lexical** — query tokens sit inside the target | **hybrid** winning ⇒ vectors justified decisively |

**Re-committed decision rule (supersedes v1's single-set rule):**

| outcome | verdict |
|---|---|
| hybrid ≥ lexical on the **normal** set by ≥ 0.10 NDCG@10 | **Vectors justified** — beat a lexically-rigged set. Proceed to A-vs-C. |
| lexical ≥ hybrid on the **anti-lexical** set | **Vectors die** — lost a vector-rigged set. M2 = arm D. |
| each arm wins its own biased set | **Ambiguous by construction.** Do NOT force a call: escalate to the `metrics.args_json` real-query harvest (reserve), and run the `nest` replication. |
| both sets agree on one arm | that arm wins outright; bias direction is irrelevant when it is overcome. |

**Sanity gate — must pass before any score is believed.** The v1 run failed because
nobody asserted a floor on arm behaviour. Before scoring: assert arm L returns **> 1
result for at least 12 of 15** normal queries, and that no arm's sole hit is a `doc`
chunk from a query's own provenance file. A run violating this is void by rule, not by
judgement.

#### Q1-r2 RESULT (2026-08-01) — leak fixed, gate failed on a mis-calibrated clause

Corpus: 1,320 files / 10,943 chunks (source docs excluded). Query set:
`gold-set-normal-r2.json`, 11 TSDoc-derived queries (4 v1 targets dropped — no TSDoc
and too-short identifiers). Subset: 3,000 chunks, 50 gold needles, 0 unresolved.

| set | bias | arm L (lexical) | arm H (hybrid) | arm V (pure vector) |
|---|---|---|---|---|
| **normal** (11) | **FOR lexical** | 0.3319 | **0.7567** | 0.7624 |
| **anti-lexical** (28) | **FOR vectors** | 0.0000 | 0.4894 | 0.5213 |

*(NDCG@10. Normal-set Recall@10: L 0.5455, H **1.0000**, V 0.9091.)*

**The leak is fixed.** Arm L went from 0/15 targets found (v1) to **6/11**, with real
result sets instead of a single self-match. `soleDocHit = 0`.

**The gate failed — on the wrong clause.** It has two clauses:
- `soleDocHit === 0` — the clause written to catch the **v1 pathology**: **PASSED**.
- `>1 result for ≥80% of queries` (8/11, needed 9): **FAILED**.

The failing clause is a **proxy** for "the lexical arm is being exercised", and the
direct evidence contradicts it: arm L scores 0.3319 NDCG / 0.5455 Recall and retrieves
6 targets. A query that legitimately returns one excellent result is not a broken arm.
Per the pre-registration the run is **void by rule**, and it is recorded as such rather
than quietly re-graded.

**Sensitivity check — the conclusion is invariant.** Restricting to only the 8 queries
that *pass* the gate (which **helps** L, since the 3 excluded are ones it failed):

| | L | H | V |
|---|---|---|---|
| normal, gate-passing 8 only | 0.4564 | **0.7741** | 0.7359 |

Delta H−L = **0.3177**, still 3× the 0.10 decisive threshold. On all 11: **0.4248**.

**What the numbers say, pending ratification of a gate fix:** hybrid beat lexical by
0.42 NDCG@10 on a set **deliberately rigged for lexical**, and lexical scored **0.0000**
on the set rigged for vectors. Under the bracketing rule that is the *decisive* branch —
`VECTORS JUSTIFIED` — reached from the direction that is hard to fake. It is **not**
being recorded as the verdict until the gate clause is amended and re-registered,
because the author does not get to grade his own failed gate.

**Secondary finding, unprompted:** arm **V (pure vector) ≈ arm H (hybrid)** on both sets,
and V *beats* H on the normal set (0.7624 vs 0.7567) and on anti-lexical (0.5213 vs
0.4894). The FTS side contributes ~nothing to the fused ranking here and may be diluting
it. That is a live question about **RRF fusion value**, distinct from Q1's
"do vectors earn their keep" — worth its own entry.

**Gate amendment — RATIFIED 2026-08-01 (user-approved).** The multi-result proxy is
replaced by a direct assertion on retrieval: arm L must achieve `NDCG > 0` on ≥ 40% of
normal queries. The `soleDocHit === 0` clause — the one that actually detects the v1
leakage pathology — is unchanged. The original clause and its failure are preserved
above; the amendment was proposed with the failure on the record and approved
separately, not applied by the author unilaterally.

Re-scored under the ratified gate: **arm L retrieves on 6/11 (need ≥ 5), sole-doc-hits
= 0 → PASS.**

> **VERDICT (home-field): VECTORS JUSTIFIED.** Hybrid beat lexical by **0.4248**
> NDCG@10 on a set deliberately rigged *for* lexical, and lexical scored **0.0000** on
> the set rigged *for* vectors. Both branches of the bracketing rule point the same way.

**This is one corpus.** Per the n ≥ 2 rule the result is not generalised until the
external replication below lands.

#### 🔴 nest replication (n≥2) — VOID, and it exposed a shipped FTS defect that confounds Q1

External corpus: `nestjs/nest` @ `f7fffd6`, pinned worktree, 1,332 files / 4,994 chunks
/ 0 parse errors. 20 queries, mechanically selected (seed 20260801: exported,
TSDoc-bearing declarations, one per file), same TSDoc derivation as the kluster set.

| arm | NDCG@10 | Recall@10 | MRR |
|---|---|---|---|
| L (lexical) | 0.2315 | 0.2500 | 0.2250 |
| H (hybrid) | 0.5815 | 0.6500 | 0.5583 |
| **V (pure vector)** | **0.7827** | **0.9000** | 0.7417 |

**Gate: FAIL** — arm L retrieves on 5/20 (need ≥ 8). Void by the ratified rule. The gate
was **not** amended again; a third revision, made after seeing an unwelcome result,
is exactly the trap the pre-registration exists to prevent.

**Why L failed — root cause found, and it is not "BM25 is weak".** 6 of 20 queries
returned **zero** FTS rows on a corpus that plainly contains the target symbol.
`search/fts.ts:202`:

```js
return tokens.map((t) => `"${t}"`).join(' ');   // FTS5: implicit AND
```

Every token is ANDed, so a 12-word conceptual query only matches a chunk containing
**all twelve words**. Confirmed directly against the nest index:

```
query: "precondition failed exception defines an http for type errors"
  AND (shipped) -> 0 rows
  OR            -> 5 rows
```

`identifier_fts` at `fts.ts:147` already uses `.join(' OR ')`. Only `chunk_fts` — the
BM25 path behind `mast_search` — ANDs.

**This confounds Q1 on both corpora.** The "lexical arm" was never plain BM25; it was
BM25 behind a query builder that discards any multi-word conceptual query. Vectors have
been compensating for a **fixable lexical defect**, not demonstrating irreplaceable
semantic value. It also retroactively explains why §9's "zero-result assist"
(`suggestions`, split-term retry) exists at all — that machinery papers over this bug.

**Consequences:**
- **The home-field `VECTORS JUSTIFIED` verdict is downgraded to *confounded*.** It is
  not withdrawn — hybrid did win — but it cannot carry M2 while a known defect
  handicaps the arm it beat.
- **M2 must NOT proceed to the A-vs-C benchmark yet.** Spending a 153k-chunk benchmark
  to pick a backend for a subsystem whose measured value rests on a one-line FTS bug is
  the wrong order.
- **New blocking task (F15): fix `buildMatchExpr`.** OR-join at minimum; better, OR with
  an AND-boost so full-phrase matches still rank first. Then re-run Q1 on both corpora.
- **V ≫ H on nest (0.7827 vs 0.5815).** Pure vector beats the shipped fusion by 0.20.
  Combined with the same sign on kluster, this is now a strong signal that **RRF fusion
  is actively degrading ranking** — plausibly the same root cause, since an AND-matched
  FTS list contributes near-random ranks to the fusion. Re-measure after F15.

---

### F15 — FTS OR-join (SHIPPED 2026-08-01) + Q1 re-run on both corpora

**Fix**: `toFtsMatch` (`search/fts.ts:199`) now `.join(' OR ')` instead of `.join(' ')`,
plus `"`-escaping. TDD: `fts-query.test.ts` gained a red-first test
("matches when only SOME query terms occur in the chunk") and a BM25 ranking-order test.
**Verification**: `pnpm -F mast test` **382 passed / 34 files** (baseline was 380 — the
2 new tests), `tsc --noEmit` clean, `eslint` clean. No structural change, so `align`
is unaffected.

**Q1 re-run, post-F15 — both corpora, no re-index or re-embed needed (query
construction only):**

| corpus | set (bias) | L | H | V | Δ(H−L) | gate |
|---|---|---|---|---|---|---|
| kluster | normal (**for lexical**) | 0.5663 | **0.8140** | 0.7624 | **0.2477** | 11/11 PASS |
| kluster | anti-lexical (**for vectors**) | 0.1908 | 0.4869 | **0.5213** | 0.2961 | — |
| **nest** (external) | normal (**for lexical**) | 0.5119 | **0.6201** | **0.7827** | **0.1082** | 14/20 PASS |

> **⚠️ THIS VERDICT IS WITHDRAWN — see "Adversarial review" below (2026-08-01).**
> ~~VERDICT: VECTORS JUSTIFIED — and REPLICATED on an external corpus. Both gates pass.
> Hybrid beats lexical on a set rigged for lexical, on both a home-field and a foreign
> codebase, and on kluster it also wins the set rigged the other way. Q1 is resolved;
> M2 is unblocked.~~
>
> Kept struck-through rather than deleted: the claim was made, and the record of an
> overclaim is more useful than its absence. **Corrected status: Q1 is AMBIGUOUS** by
> its own pre-registered rule. See below.

**How much F15 changed the picture — this is the honest part:**

| | pre-F15 | post-F15 |
|---|---|---|
| nest arm L NDCG | 0.2315 | **0.5119** (+121%) |
| nest Δ(H−L) | 0.3500 | **0.1082** |
| kluster normal Δ(H−L) | 0.4248 | **0.2477** |
| kluster anti-lexical arm L | **0.0000** | 0.1908 |

Fixing one line of query construction **more than halved** the measured value of the
vector store, and the external margin now clears the pre-committed 0.10 threshold by
**0.0082**. Vectors still win everywhere, but "vectors are worth 0.35 NDCG" was never
true — it was worth ~0.11 on a foreign corpus, and the rest was a bug. Anyone re-reading
this should treat the external margin as *thin*, not comfortable, at n=20.

**🔴 The fusion finding survived F15 and is now the top open question.**
On nest, **pure vector beats the shipped hybrid fusion by 0.1626** (0.7827 vs 0.6201) —
V also beats H on kluster's anti-lexical set (0.5213 vs 0.4869), and only loses on
kluster's normal set (0.7624 vs 0.8140). So RRF-fusing the FTS list *costs* ranking
quality on 2 of 3 measured sets, even with FTS repaired. This is not Q1's question and
must not be folded into it. **New task F16: measure and fix RRF fusion** (candidate
causes: `rrf_k = 60` mis-tuned for a 40-candidate pool; OR-matching now injecting many
weak lexical candidates at high rank). Directly relevant to M2 — if the answer is
"vector-only ranking", the backend choice changes.

**M2 status: UNBLOCKED.** Arm B eliminated on paper; Q1 resolved and replicated; the
A-vs-C benchmark (Lance+IVF-PQ vs `sqlite-vec` at 153k) is now the correct next step —
though F16 should land first, since it may change what the store must support.

---

### F16 — RRF fusion: `rrf_k` hypothesis FALSIFIED, and a confound found in the harness

**Hypothesis (mine, pre-measurement):** `rrf_k = 60` is calibrated for TREC-style pools
of ~1000 but `hybridSearch` fuses `limit * 4 = 40`. At k=60 the constant swamps the
rank — `rrfScore(1,60)=0.01639` vs `rrfScore(40,60)=0.01000`, only 64% apart — while
merely *appearing in both lists* roughly doubles the score. So a weak lexical match that
is also a mediocre vector match should outrank a true target at vector rank 1 that is
absent from the FTS top-40.

**Measured (`eval/f16-rrf-sweep.mjs`, k ∈ {0,1,2,5,10,20,40,60,120}):**

| set | L | V | shipped k=60 | best hybrid | verdict |
|---|---|---|---|---|---|
| kluster-normal (11) | 0.5663 | 0.7624 | 0.8140 | 0.8140 @ k=10–120 (flat) | hybrid wins |
| kluster-anti (28) | 0.1908 | 0.5213 | 0.4869 | 0.5034 @ k=10 | **vector still wins** |
| nest (20) | 0.5119 | 0.7827 | 0.6201 | 0.7012 @ k=2 | **vector still wins** |

**The hypothesis is false.** Tuning k yields marginal gains and never closes the gap:
nest's best (0.7012) still trails pure vector by 0.0815, kluster-anti's best (0.5034) by
0.0179. The optima also *disagree* across corpora (k=10 vs k=2) and kluster-normal is
flat from k=10 to k=120 — so k-tuning would be overfitting to a corpus, not fixing a
defect. **Do not ship a k change on this evidence.**

**🔴 But F16 cannot be concluded yet — the harness confounds it, worse than it confounds Q1.**

Arm V ranks within the **embedded subset** (3,000 chunks); arms L/H rank against
**full-corpus FTS**. Two consequences, the second specific to fusion:

1. *(Q1)* The vector arm faces fewer distractors than the lexical arm — an easier
   problem. kluster embedded **27%** of its corpus and showed Δ(H−L)=0.2477; nest
   embedded **60%** and showed Δ=0.1082. The corpus with the bigger handicap-in-V's-favour
   produced the bigger vector advantage, consistent with inflation.
2. *(F16, worse)* The FTS side contributes candidates that **have no vector at all**, so
   they fuse on lexical evidence alone and pollute the ranking. In production every chunk
   is embedded and both rankers cover the same universe. The shipped fusion has therefore
   never been measured under the conditions it actually runs in.

The eval README justifies the subset for *model-vs-model* comparison, where an
easier-but-identical pool cancels. It does **not** cancel for *arm-vs-arm*. That
justification does not transfer and should not have been carried over.

**Action taken:** `eval/embed-full-corpus.mjs` — embed every chunk in both corpora
(nest 1,994 remaining ≈ 5 min; kluster 7,943 ≈ 22 min). F16 and Q1 both re-measure
against full embeds before any fusion change or any A-vs-C spend.

**Implication for the vscode question:** a vscode run on the 3,000-chunk subset would be
**2% embedded** — a ~50× asymmetry that would flatter vectors enormously. A valid vscode
run needs a full embed (152,969 ÷ 6.15 ch/s ≈ **6.9 h**, matching §4.5's 7.2 h figure).
Cheap-and-invalid is worse than not running it.

---

### 🔴 Adversarial review (Fable, 2026-08-01) — verdict withdrawn, Q1 is AMBIGUOUS

An independent adversarial review was run against the plan, both result JSONs, all three
query sets, the harness, and `hybrid.ts`/`fts.ts`. It found four issues that each
independently threaten the withdrawn verdict. **All four are accepted.**

**1. The external margin is not a measurement.** No inferential statistics were computed
anywhere in this program — every threshold was applied to a point estimate. Recomputed
from the recorded per-query pairs: n=20, mean Δ(H−L)=0.1082, paired SD=0.3281,
SE=0.0734, **95% CI [−0.045, +0.262]**, t(19)=1.47 vs zero. Against the 0.10 threshold,
p≈0.46 — a coin flip. Only 10 of 20 queries differ at all (9 wins, 1 loss), and dropping
any one of **seven** queries pushes the mean under 0.10. Detecting Δ=0.10 at this
variance with 80% power needs **n≈67**; n=20 gives ≈35%. The celebrated "clears by
0.0082" margin is **9× smaller than the standard error**. By contrast the kluster
home-field delta *is* significant (n=11, t=3.70 vs zero, t=2.21 vs threshold) — that is
the real evidence in this record.

**2. The record contradicted itself.** The F15 verdict box said "Q1 resolved, M2
unblocked" while the F16 section below it mandated a full-embed re-measurement of the
same numbers. Now fixed (verdict struck through). The confound is also *worse* than
stated: `make-subset.mjs` and `q1-nest-replication.mjs` **seed every gold needle into the
embed pool first**, so the vector arm is guaranteed its target is embedded while 40%
(nest) / 73% (kluster) of the corpus is invisible to it — the needle can never lose to
an unembedded distractor. The plan's own dose-response (27% embedded → Δ=0.2477; 60% →
Δ=0.1082) predicts further shrinkage at 100%.

**3. The bracketing premise was asserted, never measured — and the data suggest it is
backwards.** Chunk content *includes* the leading TSDoc
(`ast/extractors/typescript.ts:521,563,763`), and that same text is what gets embedded.
So a `symbol + TSDoc-first-sentence` query is a bag-of-words subset of the target's own
embedded text — a self-retrieval task dense encoders ace. The tell: **pure vector scores
its maximum anywhere on the supposedly "lexically rigged" sets** (0.7827 nest, 0.7624
kluster) versus 0.5213 on the set built to favour vectors. A set where the vector arm
peaks is not rigged against vectors. Declaring a bias direction does not make it real,
and the entire "a win on the set rigged against you is decisive" rule rests on it.
Without that premise the result is "each arm won a set favourable to itself" — the
pre-registered **AMBIGUOUS** branch.

**4. The pre-registered reserve arm was skipped exactly when its trigger fired.** The
Design Reserve says identifier decomposition is promoted "**only** if Q1 lands in the
ambiguous band **or justifies vectors**". Q1 was declared to justify vectors; the arm was
never run; the verdict jumped to "proceed to A-vs-C". Violating a pre-registration in the
direction that favours the incumbent subsystem is the exact failure the pre-registration
existed to prevent. F15 is the proof it matters — one line of lexical query construction
halved the measured value of vectors, and the residual gap is only ~0.11.

**Further accepted findings:**

- **Arm V runs a different pipeline.** It calls `lance.searchVectors` directly, bypassing
  `dedupShellMethodCollisions` (`hybrid.ts:139,201-253`), post-filters, and the candidate
  pipeline that L/H go through. Shells carry the same TSDoc + signatures as their methods,
  so on TSDoc-derived queries dedup can **delete the designated target from L/H's list**
  and score the surviving shell as a miss. This contaminates F16's "V beats H" headline —
  part of V's edge may be dedup penalising H, not fusion degradation. nest **x13: L=1.0,
  H=0.0** — hybrid destroyed a rank-1 lexical hit and nobody diagnosed it.
- **The two runs use different relevance definitions** — kluster matches by line
  containment (a shell spanning the line counts), nest by exact symbol (the shell is a
  miss). Comparing 0.2477 to 0.1082 as one replicated quantity is not apples-to-apples.
- **Practical significance was never established.** On kluster normal, **arm L
  Recall@10 = 1.000** — lexical already puts the target in the 10-result window on *every*
  home query, so the entire home delta is intra-window ordering, for a consumer (an LLM
  agent) that reads all 10. On nest the recall gain is 0.70→0.80: **2 queries in 20**.
  Pre-registered questions Q4 (win concentrated in a nameable class?) and Q5 (value per
  unit of 7.2h/470MB/169ms?) were silently dropped.
- **Query-set defects reduce effective n**: nest x17 is generated-file banner text
  (unanswerable by design), x01/x12/x13 are near-duplicate exception boilerplate
  (effective n≈17), and word-cap mangling leaves stop-word debris.
- **F15's comment is wrong even though the fix is right.** `fts.ts:210` claims "bm25()
  already ranks by term coverage" — BM25 has **no coverage term**; high tf of one mid-IDF
  token can outrank full coverage. Tokens ≥3 chars now OR in stop-words ("the", "and"),
  and `searchFts` truncates at `limit*2` **before** fusion (`fts.ts:92`), so a
  full-coverage target can be pushed out of the top-80 by token-stuffed chunks in a way
  AND made impossible. Recall win is measured; precision and latency cost are not.

**CORRECTED STATUS: Q1 is AMBIGUOUS.** The mandated action for that branch is the
real-query harvest + the reserve arm — **not** A-vs-C. Ordered next steps:

1. Full-embed re-run of Q1 + F16 (in flight; nest done at 4,994/4,994).
2. **Promote the identifier-decomposition reserve arm** (pre-registered, overdue).
3. Report **confidence intervals, not point estimates**, on every future arm comparison;
   raise n toward ≈67 or accept that only large effects are detectable.
4. Equalise the arms: run V through `hybridSearch`'s pipeline, and use one relevance
   matcher across corpora.
5. Fix `fts.ts:210`'s incorrect BM25 claim; measure F15's precision/latency cost.
6. **M2 stays BLOCKED.**

---

### Q1/F16 FULL-EMBED RE-RUN (2026-08-01) — the corrected numbers

`eval/q1-final.mjs`. 100% of both corpora embedded, **one** relevance matcher (symbol OR
line containment) across all sets, paired 95% CIs on every comparison.

| set | n | L | H | V | H−L (95% CI) | sig? | V−H (95% CI) | sig? |
|---|---|---|---|---|---|---|---|---|
| kluster-normal | 11 | 0.5663 | **0.7331** | 0.6842 | **0.1669** [0.028, 0.306] | **YES** t=2.68 | −0.049 [−0.223, 0.125] | no |
| kluster-anti | 28 | 0.1908 | 0.3222 | **0.3574** | **0.1313** [0.068, 0.195] | **YES** t=4.34 | 0.035 [−0.102, 0.173] | no |
| nest-external | 20 | 0.5119 | 0.6122 | **0.6889** | 0.1003 [**−0.058**, 0.259] | **NO** t=1.33 | 0.077 [−0.069, 0.222] | no |

**1. The subset confound was real and large — the review's prediction held.** Embedding
the remaining corpus dropped arm V on *every* set: kluster-normal 0.7624→0.6842,
kluster-anti 0.5213→0.3574, nest 0.7827→0.6889. The needle-seeded 3,000-chunk pool had
been inflating the vector arm exactly as the dose-response suggested.

**2. 🔴 F16 IS CLOSED — NO ACTION. My "pure vector beats the shipped fusion" finding was
a harness artifact.** With full embeds, V−H is **not significant on any set** (t = −0.63,
0.54, 1.10) and is *negative* on kluster-normal. The apparent 0.16 gap on nest came from
the FTS side contributing candidates that had no vector, precisely as hypothesised — but
the fix was to the harness, not to `hybrid.ts`. **RRF fusion needs no redesign, and
`rrf_k = 60` should not be changed.** Both F16 hypotheses (k mis-tuning, then fusion
degradation) are now falsified. Good: the shipped design survives.

**3. Q1 remains AMBIGUOUS, but the shape is clearer.** Hybrid beats lexical
**significantly on both kluster sets** — including the one whose queries are drawn from
the targets' own TSDoc, and the one built to defeat trigram FTS (t=4.34, the strongest
result in the record). On the **external** corpus the effect is the right sign and
similar size (+0.1003) but the **CI spans zero** (t=1.33): consistent with a real effect,
not a demonstration of one. Per the review's power analysis, n≈67 would be needed; nest
has 20.

**Honest one-liner:** *vectors measurably help on our own repo; the external evidence
points the same way but does not reach significance.*

**Still outstanding before M2 unblocks** (unchanged by this run):
- identifier-decomposition reserve arm (pre-registered, still not run)
- real-query harvest via `metrics.args_json`
- arm V still bypasses `hybridSearch`'s dedup/post-filters (review finding 5)
- practical significance: kluster arm L **Recall@10 = 1.000** — lexical already puts the
  target in the window on every home query, so the entire home-field gain is intra-window
  reordering for a consumer that reads all 10 results. Until Q4/Q5 are answered, no
  measurement connects Δ-NDCG to agent task outcomes.

#### Known limitations, stated up front

- Single corpus for the primary run (kluster @ pinned SHA); `nest` replication is
  conditional, so a pass in the "vectors die" band is **home-field validated only**.
- 15 normal + 28 anti-lexical queries separates tiers, not near-ties (the existing
  set's own ±30% caveat carries over).
- The live index is 70% unembedded (`pending_embeddings: 10169` / 14,449), so arms H
  and V require a completed embed of the pinned corpus before scoring. That embed
  cost (~30–45 min per §14.3) is Q1's dominant runtime.

---

### Q1/RESERVE — identifier-decomposition arm: PRE-REGISTRATION (written 2026-08-02, BEFORE any arm was scored)

Pre-registered in the Design Reserve; trigger (ambiguous band) fired; skipped once — a
pre-registration violation in the direction favouring the incumbent. Registered properly
here. Adversarially reviewed **before** running (Fable agent, two rounds, transcript
findings folded in below and attributed).

#### Mechanism restatement — the lever is NOT what the Reserve said it was

The Reserve described it as *"index `checkAuthToken` also as `check auth token` … making
conceptual queries hit **lexically**"* — a **recall** claim. Measured against the pinned
corpus before designing anything:

| probe | result |
|---|---|
| `chunk_fts` is **trigram** → already substring-matches | `"project"` matches **1,688** chunks, **including `walkProject`'s own chunk** |
| `identifier_fts` (unicode61) does **not** substring-match | `"project"` → 805 chunks; `"walkProject"` → 5; the former never retrieves the latter |
| `extractIdentifiers` (`typescript.ts:1430`) is a bare `\b[A-Za-z_$][A-Za-z0-9_$]*\b` regex over full content | so `identifier_fts` is already a word-level bag-of-words **including prose**, camelCase unsplit |
| `identifier_fts` coverage | **9,420 / 10,943** chunks — `doc` chunks excluded by design (§10.1) |

**So the recall path already exists.** What decomposition actually adds is **word-boundary
term statistics** (word-level IDF; `project` stops matching `projection`) plus *effective
recall into the candidate window* — `searchFts` truncates at `limit*2 = 80` **after** BM25
ordering (`fts.ts:92`), so a target ranked below 80 among 1,688 trigram matches never
reaches fusion at all. This is a **weaker** premise than the Reserve assumed. Recorded
before the run so it cannot be used post-hoc to explain away a null — and equally, so
"the original recall lever was never testable here" is not available as an excuse either.

#### Pre-run reachability bound (zero-compute, computed BEFORE registering)

Per query: resolve the target chunk, build the decomposed bag the proposed index would
hold, and ask whether the query gains a ≥3-char word match the **prose-inclusive**
undecomposed baseline does not already have. This bounds *movement*, not gap closure.

| set | can move | provably adds nothing | max possible effect |
|---|---|---|---|
| kluster-normal | 7 | 4 | **7/11 (64%)** |
| kluster-anti | 13 | 15 | **13/28 (46%)** |
| nest-external | 14 | 6 | **14/20 (70%)** |

This **falsified** the reviewer's round-1 claim that the anti set is structurally immune to
decomposition (its round-2 challenge to the bound was itself falsified: its spot-checks
read TSDoc from the *source file*, whereas chunks store the declaration plus only
`context_lines: 3` backward — `splitIdentifierTerms`'s chunk is `fts.ts:170-184` and does
**not** contain the prose word "identifier"; the gain is real). Reviewer conceded its
"mechanically cannot inject" phrasing was an overclaim.

**Incidental finding, worth its own follow-up:** because chunk spans start at the
declaration line, a **long** TSDoc is largely *outside* its own chunk. The prior
adversarial review's finding 3 — "a symbol+TSDoc-first-sentence query is a bag-of-words
subset of the target's own embedded text" — therefore holds only for **short**-TSDoc
symbols. This weakens the self-retrieval premise for the vector arm *and* the decomp arm.
Measured and reported as `tsdoc_in_chunk_pct` in this run.

#### Arms — five, all through ONE pipeline

| arm | rankers fused |
|---|---|
| L | `chunk_fts` BM25 (shipped lexical) |
| D | `decomp_fts` BM25 alone (diagnostic) |
| **L+D** | RRF(`chunk_fts`, `decomp_fts`) — the reserve arm |
| H | RRF(`chunk_fts`, vectors) — shipped hybrid |
| **H+D** | RRF(`chunk_fts`, `decomp_fts`, vectors) |

`decomp_fts` is built from `chunks.content` (all chunks incl. `doc`), **not** from
`identifier_fts` — inheriting that table's doc exclusion would silently shrink a *search*
arm's corpus by 1,523 chunks for a *call-graph* reason. Built into a separate database
file; the authoritative state dirs are never opened for writing.

**Knobs pinned before the run** (each is otherwise a post-hoc tuning knob): decomp pool =
80 (mirrors `searchFts`'s `limit*2` at `candidateLimit=40`, `fts.ts:92`); vector pool = 40
(`hybrid.ts:59`); ranker enumeration order (fts, decomp, vec) with stable sort;
`chunkStore` passed explicitly at every call site (`hybrid.ts:55`'s default is the retired
Lance table — the v1 `0.0000` pathology's cousin).

**Equalisation** (fixes review finding 5, where arm V bypassed the pipeline and
contaminated F16): every arm runs the same candidate → RRF → fetch → post-filter →
`dedupShellMethodCollisions` path.

**Self-check, mandatory before any new arm is believed:** the reimplemented pipeline must
reproduce `q1-final.mjs`'s L and H **exactly** on all three sets. A failure is diagnosed to
root cause, and the ONLY permitted harness change is enumeration-order / embed-path
alignment (`embed([queryAsChunk])` vs `embedRawUncached`). Anything else is tuning.

#### Pre-committed decision rule

**Primary contrast: (H+D) − (L+D)** — vectors' marginal value holding the lexical machinery
constant. `H − (L+D)` is secondary; it confounds *adding vectors* with *removing
decomposition*.

**Co-primary metric: ΔRecall@10**, not NDCG alone. kluster arm L already has
Recall@10 = 1.000, so home-field NDCG deltas are intra-window reordering for a consumer
(an LLM agent) that reads all 10 results. Recall is the metric a 91 MB / 7 h / 470 MB cost
argument can attach to.

| branch | decisive cell | verdict |
|---|---|---|
| **Vectors retain marginal value** | (H+D)−(L+D) CI excludes zero AND mean ≥ 0.10 on **kluster-normal or nest** | Decomposition does not close the gap. Reserve arm answers NO. Q1 still not *resolved* — see authority limit below. |
| **Vectors die** | equivalence: CI **upper** < 0.10 for **both** (H+D)−(L+D) **and** H−(L+D), on **both** kluster sets, **and** ΔRecall@10 CI upper < 0.10 | **Committed consequence: the A-vs-C 153k benchmark is cancelled outright**, and deletion of `vectors.lance` + `@lancedb/lancedb` is scheduled, contingent only on the real-query harvest not reversing it. |
| Significant but mean < 0.10 | — | "Statistically real, practically below threshold." Bound to this cell only; not a free narrative slot. |
| **(L+D) < L significantly on any set** | — | Decomposition is **harmful**. Stop, do not tune. Primary contrast collapses back to H−L and the arm reports "decomposition dead, Q1 unchanged." |

**Anti-lexical set is one-directional** (§14.3, restored): it may *kill* vectors, never
*justify* them. It cannot contribute to the "retain value" branch.

**Deletion requires BOTH contrasts to fail the bar.** Reviewer's vote-dilution argument,
accepted: in H vectors hold 1 of 2 votes; in H+D they hold 1 of 3 against a *correlated*
two-ranker lexical bloc, so `H+D < H` is plausible and `(H+D)−(L+D) ≈ 0` could coexist with
`H−(L+D) > 0`. Reading that as "vectors add nothing" would be false.

**Threshold provenance, stated rather than laundered.** 0.10 was registered for `H−L` on
the shipped configuration. `(H+D)−(L+D)` is structurally *smaller* (D absorbs part of the
deficit vectors compensated for; vectors' vote share drops 1/2 → 1/3). Reusing 0.10 is
therefore **conservative against vectors** in the keep direction and **permissive** in the
delete direction. Not re-derived post-hoc — that would be tuning. Weight rests on the
Recall@10 co-primary instead.

**Authority limit, committed in advance and asymmetric on purpose:** this arm **can never
justify** the vector store — only the real-query harvest can. It **can** trigger the delete
branch. No verdict stronger than "pending harvest" may issue from any synthetic-set run.

#### Anti-degeneracy gate (from the run where arm L scored exactly 0.0000)

1. `decomp_fts` rows == chunk count per corpus. **[PASS pre-run: 10,943/10,943 and 4,994/4,994]**
2. Arm D returns ≥1 result for ≥90% of queries on every set.
3. No arm scores exactly 0.0000 across an entire set.
4. Spot-check: a known camelCase target retrieved by its decomposed words. **[PASS pre-run: `walkProject`'s chunk is returned for `"walk" OR "project"`]**
5. Doc-magnet check: arm D's top-10 `doc`-chunk share vs arm L's (assertion, not a knob —
   de-duplicating the bag flattens BM25 tf to 1, so prose chunks citing many rare
   identifiers become short, dense documents).
6. **Self-retrieval canary:** normal + nest re-scored with the symbol-derived tokens
   stripped (TSDoc sentence only). `gold-set-normal-r2.json`'s own `meta.derivation` is
   `camelCaseSplit(symbol_name) + first TSDoc sentence` — which *is* the index-construction
   function, so a gain there may be echo, not measurement. If D's gain vanishes under the
   canary, those sets cannot support a verdict.

Violation of 1–4 → **void by rule**, stop and prove the mechanism.

**Known instrument limit:** the query-side half of the lever is **dead on this instrument**
— camelCase tokens appear in 0/11 normal, 0/20 nest, 2/28 anti queries. The normal/nest
queries were pre-split by the derivation protocol. So this run tests the *index-side* half
only, and a shipped `decomp_fts` would carry query-side behaviour no experiment here
exercised.

#### Reviewer's pre-run predictions, recorded before the numbers exist (Fable, round 2)

Self-check fails first attempt on embed-path or tie-break, passes after permitted
alignment. Arm D alone: normal 0.45–0.60, anti 0.15–0.25, nest 0.40–0.55. L+D over L:
normal +0.05–0.12, anti +0.00–0.05, nest +0.03–0.08. **(H+D)−(L+D): kluster-anti stays
significant, ≈0.08–0.13, t≈3**; normal ≈+0.03–0.10 CI spanning zero; nest ≈+0.03–0.08 CI
spanning zero. ΔRecall@10 (H+D vs L+D): normal ≈0, **anti +0.10–0.20**, nest +0.05–0.10.
Predicted branch: mixed/diagnostic — neither branch fires; Q1 stays open pending harvest.
Confidence ~70%; ~20% a delete-leaning surprise; ~10% void on first scored attempt.

**Round-3 revisions (after the reviewer conceded the bound), superseding the above where
they differ:** anti-set L+D gain revised **up** to +0.02–0.07 ("the bound proved my model of
D's reach was too pessimistic once already"); split moves to **65% mixed / 25%
delete-leaning surprise / 10% void**. New attributed prediction: `tsdoc_in_chunk` will be
absent/truncated for **30–50%** of normal+nest queries, concentrated in well-documented
symbols, and D's realized gains will correlate with the **symbol echo**, not TSDoc presence.

**Pre-committed addition, requested by the reviewer because it cuts TOWARD the incumbent**
(hence committed before the number exists, not discovered post-hoc): stratify the
**existing** per-query H and V results by `tsdoc_in_chunk`. The prior review's finding 3
("the normal sets are a self-retrieval task for embeddings, so their declared FOR-lexical
bias is backwards") rests on the TSDoc being *inside* the embedded chunk. If H's
kluster-normal win (the significant 0.1669) **holds on the queries whose TSDoc is not in
the chunk**, that win is more genuine than the current AMBIGUOUS ruling credits, and the
record must be ready to say so.

#### Q1/RESERVE RESULT (2026-08-02) — the stop rule fired: decomposition is HARMFUL, not neutral

`eval/q1-reserve-decomp.mjs` → `~/.cache/mast-eval/results/q1-reserve-decomp.json`.
Runtime ~4 min, no re-index and no re-embed (index-side build is 15 s for both corpora).

| set | n | L | D | **L+D** | H | H+D |
|---|---|---|---|---|---|---|
| kluster-normal | 11 | 0.5663 | 0.3230 | **0.4001** | 0.7331 | 0.5984 |
| kluster-anti | 28 | 0.1908 | 0.1681 | **0.2042** | 0.3222 | 0.2822 |
| nest-external | 20 | 0.5119 | 0.4323 | **0.4385** | 0.6122 | 0.5521 |

**Harness validated first: `self_check_mismatches = 0` on all three sets.** The
reimplemented N-ranker pipeline reproduces shipped `hybridSearch` result-for-result on
both overlapping configurations, and its `H−L` reference reproduces `q1-final.mjs`'s
recorded **0.1669 / 0.1313 / 0.1003** to the digit. Anti-degeneracy gate: arm D returned
≥1 result on **every** query of every set (0 empty), no arm scored 0.0000. Gate PASS.

**🔴 The pre-registered stop rule fired.** *"(L+D) < L significantly on any set →
decomposition is harmful. Stop, do not tune."*

| set | (L+D) − L | 95% CI | t | |
|---|---|---|---|---|
| **kluster-normal** | **−0.1661** | **[−0.3247, −0.0075]** | **−2.333** | **significantly NEGATIVE** |
| kluster-anti | +0.0133 | [−0.0835, +0.1102] | 0.288 | n.s. |
| nest-external | −0.0734 | [−0.2517, +0.1049] | −0.862 | n.s. |

Arm D alone loses to arm L on **all three** sets. Worse, the harm lands on the metric that
matters: **kluster-normal Recall@10 falls from L's 1.0000 to L+D's 0.7273** — decomposition
*removes* targets from the ten-result window the agent reads in full. The reachability
bound was right that decomposition can *move* these queries; it moved them the wrong way.

**Mechanism (stated, not assumed):** fusing a strictly weaker, highly *correlated* ranker
into RRF dilutes the stronger one — the same vote-splitting the reviewer identified for
H+D, here applied to the lexical side. Where L is strong (normal, Recall 1.000) and D is
weak (0.6364), fusion drags the pair toward D.

**Answer to the Design Reserve's question: the cheapest remaining lexical lever does not
exist.** Decomposition does not close the gap at zero query cost; it opens it. F15 remains
the only lexical fix that moved these numbers, and it moved them by *repairing a defect*,
not by adding signal.

##### 🔴 Construction deviation from the pre-registration — logged, and it runs TOWARD the incumbent

The Design Reserve specified *"index `checkAuthToken` also as `check auth token` in a
**second FTS column**"*. I built a second FTS **table**, fused by RRF. These are not the
same instrument: a second *column* is scored jointly by one `bm25()` call over one
document; a second *table* is a separate ranker whose votes must be fused — and RRF
vote-dilution is precisely the mechanism that produced the harm above. The column
construction cannot dilute this way.

**Direction of the error: it favours the incumbent** (harm to the lexical arm ⇒ vectors
look better). That is the exact direction in which this program has already failed twice.
The result above therefore answers *"is decomposition-as-a-fused-ranker a lever?"* — **no,
it is a regression** — and does **not** answer the Reserve's actual question. **RESERVE-2
(second-column construction) is registered as owed work, not optional**, for the same
reason the original arm was owed.

##### Auxiliary findings

- **Doc-magnet prediction FALSIFIED, inverted.** Predicted arm D would over-return `doc`
  chunks. Measured share of returned slots that are `doc`: kluster-anti **D 26.1% vs L
  45.7%** (128/280 slots); nest D 4% vs L 2%. The shipped **trigram** arm is the bigger doc
  magnet; decomposition *reduces* prose pollution.
- **Canary did not execute on kluster-normal (n=0).** Its targets are line-addressed
  (`symbol: null`), so the symbol-stripping step had nothing to strip. **Moot rather than
  missing**: the canary exists to test whether D's *gain* is symbol echo, and on that set
  there is no gain to attribute — D lost, significantly. Ran fine on anti (n=27,
  (L+D)−L = +0.0322) and nest (n=18, +0.0046), both null. Fix owed for RESERVE-2 (resolve
  the symbol from the chunk at the cited line).
- **`query_in_chunk` stratification is unanswerable on kluster-normal: 11/11 queries have
  ≥50% of their terms inside the target chunk** (nest 18/20; anti only 6/28, as expected
  for a set built to avoid lexical overlap). So the reviewer's round-3 prediction that
  30–50% of TSDoc-derived queries would fall *outside* their chunk is **falsified**, and
  the pre-committed test — "does H's normal-set win survive on queries whose TSDoc is not
  in the chunk?" — has **zero eligible queries** and cannot be run on this instrument. The
  prior review's self-retrieval premise for the normal set therefore **stands**: those
  queries are inside their targets' own indexed text, for the lexical *and* vector arms
  alike.

##### What this does and does not change for Q1

**Does not change:** Q1 stays **AMBIGUOUS** and M2 stays **BLOCKED**. Under the registered
authority limit this arm *can never justify vectors* — only the real-query harvest can.
Nothing here is evidence *for* the vector store; it is evidence *against a proposed
alternative to it*.

**Does change:** the primary contrast now reads on the *shipped* configuration, because
L+D is not a configuration anyone would ship. `(H+D)−(L+D)` was significant on
kluster-normal (**0.1982**, CI [0.061, 0.336], t=3.219) and on kluster-anti (0.0781, CI
[0.021, 0.135], t=2.862 — **one-directional, cannot count toward keeping vectors**), and
**not** significant on nest (0.1136, CI [−0.009, 0.236], t=1.936). That is the same shape
as `H−L`: significant at home, not significant externally. **The external CI still spans
zero. Nothing has replicated.**

##### Reviewer's pre-run predictions, scored

Recorded before the numbers existed, so they can be graded. **Right:** kluster-anti
`(H+D)−(L+D)` ≈0.08–0.13 at t≈3 (actual 0.0781, t=2.862); ΔRecall@10 anti +0.10–0.20
(actual 0.1607); nest CI spanning zero; arm D anti 0.15–0.25 (0.1681) and nest 0.40–0.55
(0.4323). **Wrong:** the self-check would fail on first attempt (0 mismatches); arm D on
normal 0.45–0.60 (actual 0.3230); kluster-normal `(H+D)−(L+D)` CI spanning zero (actual
significant); `tsdoc_in_chunk` absent for 30–50% (actual ~0%); the doc-magnet direction.
**Missed by both of us:** that decomposition would come out *significantly negative* —
neither the reviewer's range (+0.02–0.07 on anti, +0.05–0.12 on normal) nor mine allowed
for harm on the normal set.

### Q1/RESERVE-2 — second-COLUMN construction: PRE-REGISTRATION (written 2026-08-02, BEFORE scoring)

Owed work, not optional: RESERVE-1 deviated from the Reserve's specified construction (a
second FTS *column*, one joint `bm25()`) by building a second *table* fused via RRF — and
that fusion is what caused the harm. The deviation ran toward the incumbent.

**Hard constraint (verified):** FTS5's `tokenize=` is **table-level, not column-level**, so
a second column cannot keep trigram on `content` while word-tokenizing `decomposed`.
Per-column `bm25(tbl, w0, w1)` weights *are* supported. This forces the tokenizer and the
decomposition to be varied together — so the design varies them **factorially** instead.

| arm | table | isolates |
|---|---|---|
| L | shipped `chunk_fts` (trigram, content) | baseline |
| **T+D** | trigram, (content, decomposed) | decomposition under **shipped** tokenization — the literal Reserve reading |
| **W** | unicode61, (content) | the **tokenizer** change alone |
| **W+D** | unicode61, (content, decomposed) | decomposition **on top of** word tokenization |
| H | RRF(`chunk_fts`, vectors) | shipped hybrid, reference |

A complete 2×2, so `(T+D)−L` and `(W+D)−W` are **unconfounded** decomposition effects with
the tokenizer held fixed, `W−L` is the pure tokenizer effect, and the **interaction**
`((W+D)−W) − ((T+D)−L)` — free from the factorial — tests the Reserve's actual mechanistic
claim: that decomposition's value *depends* on word tokenization.

**Pinned before the run.** Identical query expression for every lexical arm (shipped
`toFtsMatch`; **no** query-side splitting anywhere, so every lexical contrast is
index-side-only — costs nothing here, camelCase appears in 0/11, 0/20, 2/28 queries).
`decomposed` column = the split sub-terms **not already present as whole tokens in
content**, i.e. exactly the surface decomposition adds; mirroring the full bag would
duplicate every content token across two columns and penalise the arm for redundancy
rather than test it. `bm25` weights **default (1.0, 1.0)** — a declared choice, not an
absence of one; the decomposed column is a short deduped bag and FTS5's per-column length
normalisation makes matches there disproportionately potent, so if W+D shows harm that is
the named first suspect (a follow-up hypothesis, **not** a knob to tune now).

**Decision rule.**
- **Decomposition LIVES** only if a decomposition contrast is significantly positive on a
  non-one-directional set **AND that arm beats L**, the shipped alternative. *(Reviewer
  catch: without the beats-L clause, `(W+D)−W > 0` could ship a net regression — an arm
  beating its own tokenizer-mate while the whole unicode61 family loses to shipped
  trigram.)*
- **Closure, two tiers** — the original single tier (CI upper < 0.05 on all three sets ×
  both contrasts) is **unreachable at these n**: six equivalence cells with SEs of
  0.05–0.09 pass jointly ≈ never even under a true null, which is the same reachability
  defect caught in round 1. **Strong closure:** CI upper < 0.10 (the inherited margin) on
  both kluster sets, both contrasts. **Weak closure:** no contrast significantly positive
  anywhere and all point estimates < 0.05.
- **Delete-vectors branch** (the authority this arm does hold): `H − lexical[LOO]`
  equivalence CI upper < 0.10 **and** ΔRecall@10 CI upper < 0.10, on **both** kluster sets.
- **Stop rule retained:** any arm significantly below L is reported as harm, not tuned.
- Anti-lexical set stays **one-directional** (§14.3).

**Selection bias — fixed, not just declared.** A per-set max over 4 correlated arms inflates
the winner by ≈0.5–1 SE (0.05–0.09 NDCG — the size of the entire nest H−L effect), so
testing H against it would *manufacture* deletion. A holdout is infeasible at n=11
(select on 5, score on 6). The delete branch therefore uses **leave-one-query-out
selection**: for query *i*, pick the lexical arm on the other n−1, score *i* under that
pick. The raw max is reported **descriptively only**, labelled.

**Pre-run assertions (all PASS before scoring):** each new FTS table's rows == chunk count
(10,943 / 4,994 × 3 tables); `decomposed` column **byte-identical** between T+D and W+D
(0 mismatches both corpora, so the tokenizer contrast is not contaminated by content
drift); arms L and H must still reproduce shipped `hybridSearch` exactly.

**🔴 Instrument dilution, measured pre-run and recorded because it weakens the arm.** The
mechanism spot-check asked whether `walkProject`'s chunk is reachable via "walk project" in
W+D but *not* in W. It **is reachable in W too** — the chunk's own prose supplies both
words. So wherever documentation restates an identifier's constituent words, decomposition
is redundant with prose and `(W+D)−W` is diluted toward null. The residual value of
decomposition should concentrate on **terse or undocumented** chunks. Stated before the
numbers exist.

**Authority limit, unchanged and explicit:** RESERVE-2 may trigger the delete branch; it
can **never** justify vectors. **The harvest gate does not move regardless of this
outcome** — after two reserve runs whose most decisive findings were about *lexical*
machinery, marginal information per synthetic-set run is visibly declining, and the
real-query harvest remains the only instrument that can close Q1.

**Reviewer's pre-run predictions (Fable, round 4), recorded before the numbers exist:**
`(T+D)−L` null everywhere (−0.02 to +0.03, all CIs spanning zero); `W−L` negative on
normal/nest (−0.05 to −0.15), near-zero to slightly positive on anti; **`(W+D)−W` the one
real effect** (+0.05 to +0.15 normal/nest, +0.00 to +0.05 anti); interaction positive; net
W+D vs L a wash; `H − lexical[LOO]` stays significantly positive on both kluster sets
(~0.12–0.17 normal, ~0.09–0.13 anti), nest CI spanning zero; **delete branch does not
fire**. 60% that shape / 20% W+D beats L outright on a non-anti set / 10% T+D surprises
positive / 10% void. Self-scored round-1 record: *"my mechanism reasoning has been good, my
quantitative intuitions about this corpus have been poor"* — vote-dilution was correctly
identified, then not followed to its conclusion that it would dilute **L** in L+D too.

#### Q1/RESERVE-2 RESULT (2026-08-02) — decomposition doesn't live; the shipped TRIGRAM tokenizer is doing real work; and the home-field verdict is NOT robust to the lexical baseline

`eval/q1-reserve2.mjs` → `~/.cache/mast-eval/results/q1-reserve2.json`. Gate: self-check
**0 mismatches** all sets, no empty arms, all pre-run assertions PASS.

| set | n | L | T+D | W | W+D | H |
|---|---|---|---|---|---|---|
| kluster-normal | 11 | 0.5663 | **0.5807** | 0.3710 | 0.4281 | 0.7331 |
| kluster-anti | 28 | 0.1908 | **0.2150** | 0.1322 | 0.1909 | 0.3222 |
| nest-external | 20 | **0.5119** | 0.4774 | 0.4162 | 0.4127 | 0.6122 |

**1. Decomposition does not live — but it is not "closed for good" either.** No
decomposition contrast is significantly positive **anywhere**:

| contrast | kluster-normal | kluster-anti | nest |
|---|---|---|---|
| `(T+D)−L` (trigram) | +0.0144 [−0.030, +0.059] | +0.0242 [−0.001, +0.049] t=2.04 | −0.0345 [−0.086, +0.017] |
| `(W+D)−W` (unicode61) | +0.0570 [−0.032, +0.146] | +0.0587 [−0.002, +0.120] t=2.02 | −0.0035 [−0.066, +0.059] |

The **literal Reserve reading (`T+D`) is a measured null**, as predicted — under trigram the
decomposed column is near-redundant because trigram already substring-matches.
`(W+D)−W` is consistently positive on kluster and consistently non-significant. Per the
registered rule: **strong closure FAILS** ((W+D)−W CI upper 0.146/0.120 > 0.10) and **weak
closure FAILS narrowly** (point estimates 0.057/0.059 > 0.05). Honest status: *decomposition
under word tokenization is a small, consistently-signed, never-significant effect that never
beats the shipped baseline.* Not dead; not worth building.

**Lives branch does not fire:** nothing is significantly positive, and `(W+D)−L` is
significantly **negative** on kluster-normal (−0.1382 [−0.253, −0.023]). The beats-L clause
the review added is what makes this unambiguous — without it, `(W+D)−W = +0.0587` could
have been read as a win while the arm was losing to shipped.

**2. 🔴 The stop rule fired again — on the TOKENIZER this time.** `W − L` is significantly
**negative** on both kluster sets (**−0.1952**, t=−2.77 normal; **−0.0587**, t=−2.492 anti),
with Recall@10 collapsing 1.000 → 0.636 on normal. **Swapping trigram for unicode61 is a
large regression.** The shipped trigram tokenizer is not an incidental default — it is
carrying substantial retrieval value via substring matching, which is exactly what the
RESERVE-1 mechanism check found and what makes the decomposed column redundant under it.
That is a positive finding about the shipped design, arrived at by trying to beat it.

**3. Interaction is positive on all three sets** (+0.043, +0.035, +0.031) and significant on
none. Directionally it confirms the mechanism restatement — decomposition is worth more
under word tokenization than under trigram — but the effect is smaller than the tokenizer
penalty that buying it would cost. The 2×2 says: you cannot have word-level decomposition
without giving up substring matching, and the trade is a net loss.

**4. 🔴 The finding that cuts AGAINST the incumbent — and it is the important one.**
With the LOO-selected lexical baseline (picks: `T+D` on both kluster sets, `L` on nest):

| set | H − lexical[LOO] | 95% CI | t | sig? |
|---|---|---|---|---|
| kluster-normal | **0.1525** | **[−0.0015, +0.3065]** | 2.206 | **NO** (t_crit 2.228) |
| kluster-anti | 0.1072 | [+0.0544, +0.1600] | 4.252 | YES — but **one-directional**, cannot justify vectors |
| nest-external | 0.1003 | [−0.0579, +0.2585] | 1.327 | NO |

**kluster-normal was the only significant, non-one-directional evidence for vectors in the
entire record** (`H−L` = 0.1669, t=2.68). Against a marginally better lexical arm — one
that is *itself* not significantly better than L — **it loses significance** (CI now spans
zero by 0.0015). The flip is fragile in both directions and must not be overread: t=2.206
vs a 2.228 critical value is a coin-flip margin, driven by a non-significant improvement.
The defensible statement is: **the home-field result is not robust to the choice of lexical
baseline.** A result that survives only against one specific baseline is weaker evidence
than the AMBIGUOUS ruling already credited it with.

**Delete branch does not fire** (requires equivalence CI upper < 0.10 on both kluster sets;
normal's upper is 0.3065). **Q1 stays AMBIGUOUS. M2 stays BLOCKED.**

##### Reviewer's round-4 predictions, scored

**Right:** `(T+D)−L` null everywhere; interaction positive on all sets; delete branch does
not fire; `H − lexical[LOO]` on anti (~0.09–0.13, significant → 0.1072, t=4.25); the
overall branch shape. **Wrong:** `(W+D)−W` positive on nest (actual −0.0035); `W−L`
near-zero-to-positive on anti (actual significantly negative); net `W+D` vs `L` "a wash"
(actual significantly negative on normal); `H − lexical[LOO]` significant on kluster-normal
(actual just misses). Its self-assessment held — mechanism reasoning good, corpus numbers
mediocre — but round 4 was its most accurate.

##### What is now owed

The Reserve's lever has been tested in **both** registered constructions (fused table,
second column) across **two** tokenizers. It does not exist at a size worth building.
**The reserve is discharged.** Remaining, in order: the real-query harvest (the only
instrument that can close Q1 — gate unmoved, as registered); equalising arm V through the
now-validated N-ranker pipeline (`rankers: ['vec']`, cheap); Q4/Q5 practical significance.

### Q1-v2 REAL-QUERY HARVEST (2026-08-02) — instrument ready, data absent, and Q1 cannot close from this source yet

`eval/harvest-real-queries.mjs`. Extracts real queries from `metrics.args_json` and derives
**behavioural** relevance labels from `results_json` via the **chain**: a later
`mast_signature`/`mast_exports`/`mast_callers` call in the same session targeting a
file/symbol an earlier `mast_search` returned is the *agent itself* judging that result
relevant — a label with no author's opinion in it. This is what §14.3 wired the columns for.

**Measured today, against the live `.mast`:**

```
rows_with_args=2  searches=2  self_referential=2  organic=0  chain_labelled=0
POWER: have 0 / need ~67 -> INSUFFICIENT
```

| # | when | query | |
|---|---|---|---|
| 1 | 2026-08-01 09:32 | `selectPendingChunks runEmbed vectors` | prior session's write-path verification |
| 2 | 2026-08-02 02:14 | `recordToolCall metrics args_json write path` | this session's re-verification |

**The write path WORKS** — re-verified today, 24 h and two sessions after the first row,
with both `args_json` *and* `results_json` populated exactly per §14.3. But **both rows are
this investigation's own traffic**, so organic n = **0**. Using them as a Q1 gold set would
be a third flavour of the circularity that voided two earlier sets: queries *about the
retrieval system*, scored *against the retrieval system's own code*. The harvester
separates them automatically (`self_referential`) rather than quietly counting them.

**🔴 A read-mode trap that cost this session a false conclusion — recorded so it doesn't
recur.** `graph.db` runs in WAL, and the live `mast serve` holds pages in an 8 MB
`graph.db-wal`. Opening with `?mode=ro&immutable=1` **ignores the WAL** and reports the
`metrics` table as **empty**. That is exactly how I first concluded the write path was
broken and the plan's "n=1" row had been lost — it hadn't; I was reading the wrong
artifact. Same error class as the reviewer's round-2 miss (source file vs indexed chunk)
and as D2's Lance rot sites: *the query was fine, the artifact was wrong.* **Always open
`graph.db` plainly for metrics reads.** Verified the eval corpora are unaffected — both
have no WAL (checkpointed) and both read modes agree (10,943 / 4,994 chunks), so the
RESERVE-1/2 results and the reachability bound stand.

**The one thing measurable at n=2, stated with its n.** Both real queries are
**identifier-bearing** (`selectPendingChunks runEmbed vectors`; `recordToolCall metrics
args_json write path`), median **5 words** — code tokens, exactly as §12's prompt instructs
agents to search. Every gold set that has carried a Q1 verdict is instead **TSDoc-prose
derived**. If the organic workload is identifier-heavy, the lexical arm is *advantaged in
production relative to what every synthetic set measured* — which would push Q1 further
toward arm D, not away. **This is n=2 and both are self-referential; it is a hypothesis the
harvest must test, not a finding.** Recorded because it points against the incumbent and
should not wait for someone to notice it later.

**What actually gates Q1 now — and it is not an engineering task.** Reaching n≈67 organic
chain-labelled queries requires MAST to be *used for real work*, not used to investigate
itself. Two sessions of intensive MAST-on-MAST investigation produced **zero** eligible
queries. So Q1's remaining cost is **elapsed usage**, not compute. Until then:

- **Q1 stays AMBIGUOUS; M2 stays BLOCKED.** No synthetic-set run may issue a verdict
  stronger than "pending harvest" (registered in RESERVE-1, unmoved).
- The A-vs-C 153k benchmark stays cancelled-until-justified.
- Re-run `node eval/harvest-real-queries.mjs .mast` periodically; it prints the power check
  and refuses to imply sufficiency.

**Pre-registered for when n suffices** (written now, before any harvested number exists):
arms and pipeline exactly as `q1-reserve2.mjs` (self-check against shipped `hybridSearch`
mandatory); relevance = chain labels only, never author-assigned; `self_referential` rows
excluded by construction; paired 95% CIs; the anti-lexical set stays one-directional; and
**the harvest may resolve Q1 in either direction** — unlike the reserve arms, it carries no
authority limit, because its provenance predates the experiment.

---

### 🔴 Q1 REFRAME (2026-08-02, empirical-planning audit) — the metric, not the sample size, is the blocker

Five scored Q1 experiments have now run; **three were invalidated by circularity in a query
set someone constructed**, and the sixth (harvest) is gated on organic n=0. Applying the
"what is the biggest thing I am missing?" test to the *strategic bet* rather than the
arms gives an uncomfortable answer, and it is not a defect:

**Every Q1 verdict is denominated in NDCG@10, and the record already contains kluster arm L
Recall@10 = 1.000.** Lexical puts the target inside the ten-result window on *every* home
query, and the consumer is an LLM agent that reads all ten. If that generalises, the entire
home-field delta is **intra-window reordering for a reader who consumes the whole window** —
in which case no n resolves Q1, because the metric is measuring something that cannot change
the consumer's behaviour. Pre-registered questions **Q4/Q5 (practical significance) have now
been deferred four times**; that deferral, not the arm design, is this program's
load-bearing unexamined decision.

**The cheapest test that could make half of this unnecessary — drive the real thing.**
`mode: "lexical"` is already a shipped, supported configuration (§13.11 `--no-embeddings`).
So the decisive experiment needs **no gold set at all**: run the *same real task* twice,
hybrid vs lexical-only, and measure **task outcome** — did the agent find what it needed,
how many tool calls, did it fall back to Read/Grep, did the change land correct. That is
Q1's question in the units the 91 MB / ~7 h / 470 MB is actually spent in.

It also dissolves the harvest blocker rather than waiting it out: organic n is 0 **because
MAST is only ever used to investigate MAST**. Running real tasks under both modes fills
`metrics` with organic rows *and* produces the outcome comparison. One activity, both
payoffs — which is why it should precede any further synthetic-set work.

**Reserve (pre-thought, NOT build commitments):** per-query win-class labelling for Q4;
`--no-embeddings` container A/B at task scale; latency/precision cost of F15's OR-join.
Promote only on evidence.

**Standing correction to this plan's own framing:** "Q1 is blocked on the harvest" is
imprecise and should not be repeated. Q1 is blocked on **never having measured whether
retrieval-rank differences change agent outcomes at all**. The harvest improves the query
sample; it does not fix the metric.

---

### Q1/OUTCOME — hybrid vs lexical **task-outcome** A/B: PRE-REGISTRATION (written 2026-08-02, BEFORE any run)

**Nothing below may be edited after the first scored run.** Amendments are appended with a
timestamp, a reason, and **which direction the error runs**. This registration is committed
before the instrument is built, per the §Q1 precedent.

#### Why this experiment and not more synthetic-set work

Every Q1 verdict to date is denominated in NDCG@10 — an *intra-window reordering* metric —
while the record already holds kluster arm L **Recall@10 = 1.000** for a consumer that reads
the whole window. The reframe above argues that no `n` fixes this. **The reframe is an
argument, not a measurement.** It rests on an unmeasured assumption: that the agent uses all
ten results roughly equally. This experiment is the measurement. It is designed so it can
falsify the reframe, not only confirm it — the failure mode this program has repeatedly
suffered is bias toward the incumbent, and a registration that could only vindicate my own
new framing would reproduce that failure with the sign flipped.

#### The question, in the units the cost is paid in

Does running MAST in `mode: "lexical"` instead of `mode: "hybrid"` change **whether an agent
completes a real task, and at what effort** — where the cost of the hybrid half is 91 MB of
dependency, ~7 h of embed, and 470 MB RAM at the 153k-chunk target?

#### Arms

| arm | construction |
|---|---|
| **H** — hybrid | `hybridSearch(db, lance, embedder, …)` — shipped RRF, rank-based vector inclusion |
| **L** — lexical | `hybridSearch(db, lance, **null**, …)` — the shipped, supported `--no-embeddings` configuration (§13.11); `mode` defaults to lexical at `hybrid.ts:75`, embedder gate at `hybrid.ts:78` |

The switch is one argument. Both arms are shipped code paths; neither is a reimplementation.

#### Mechanism (and its honest limitation)

No `mast search` CLI exists (D0 unshipped) and a subagent cannot be given its own MCP server
config, so the arms are exposed through a thin eval wrapper, `eval/ab-search.mjs`, that
replicates `src/mcp/tools/search.ts`'s call exactly — including passing `chunkStore`
explicitly (the `hybrid.ts:55` loaded-gun default reads the **retired** Lance chunk table).

- **Limitation, stated up front:** agents will search via a Bash command rather than the
  `mast_search` MCP tool. Both arms share that surface, so **internal validity is preserved**;
  what is weakened is external validity — a Bash surface may be reached for less readily than
  an MCP tool. This is a limit on generalising the *absolute* effort numbers, not on the
  H-vs-L contrast.
- **Frozen index.** All runs read one snapshot of `.mast` copied to
  `~/.cache/mast-eval/ab-state` before run 1, so index drift cannot differ between arms.
  `last_indexed`, `chunk_count`, and vector coverage are recorded into the results file.
- **Blinding — and the defect that nearly broke it.** Naively replicating the MCP tool leaks
  the arm into every response: `search.ts:35` serialises `mode`, `_stats` carries it
  (`search.ts:43`), and `similarity_score` is non-null **only** in hybrid
  (`hybrid.ts:153`). Transcripts would therefore have contained the arm, and "graded blind"
  would have been a false claim. The wrapper **redacts `mode`, `_stats`, and
  `similarity_score` from agent-visible output, identically in both arms**; the fidelity gate
  compares the *pre-redaction* payload. Arm comes from an env var the agent never sees;
  transcripts use opaque run-ids; the run-id → arm mapping is not opened until grading is
  committed.
- **Arm-integrity assertion (per call, not per experiment).** `hybrid.ts:102–104` swallows
  any embedder failure — `catch { /* Embedding failure is non-fatal */ }` — and silently
  returns `mode: "lexical"`. A mid-experiment model-load or memory failure would therefore
  turn arm H into arm L and manufacture exactly the null the reframe predicts. The wrapper
  records `mode` on **every** call (pre-redaction, to the results file); any H-arm run
  containing a call that did not return `mode: "hybrid"` is **void and re-run**. Void counts
  are reported.
- **MCP bypass control.** Subagents are instructed not to call any `mcp__mast__*` tool. This
  is enforced by measurement, not by hope: mast's MCP tools are *deferred* in this harness
  (they require an explicit `ToolSearch` to load), and any transcript containing a mast MCP
  call is **void and re-run**. Void counts are reported.

#### Task set — provenance protocol

Tasks must be **real and not about MAST** (organic query n is 0 precisely because MAST is
only ever used to investigate MAST). Sampling frame: pre-existing documents in the *other*
packages — `packages/workbench/{foldv2,sdd,fold,metrics}`, `packages/kluster-bt` — written
for unrelated purposes before this experiment existed, each row citing or implying a concrete
code location that serves as ground truth. Sampled with a seeded RNG; frozen to
`eval/ab-tasks.json` and committed **before** any run.

Two pre-registered strata, 6 tasks each (k = 12 total, 24 runs):

- **S-ident** — task text retains its code identifiers. This is the *production-realistic*
  stratum under the harvest's n=2 hypothesis (real queries are identifier-bearing, median 5
  words).
- **S-concept** — task text paraphrased to contain **no identifier appearing in the target
  code**. This is the anti-lexical construction and is **vector-favourable by design**.

**The weakest link, named — and my first claim about it RETRACTED.** S-concept paraphrases
must be authored, and three earlier query sets in this program were voided by authoring bias.
I originally registered that the bias "runs toward vectors, so a null is conservative."
**That is not established, and the counter-construction is concrete:** the S-concept
constraint bans only identifiers *appearing in the target code*, but the shipped `chunk_fts`
uses the **trigram** tokenizer, which matches prose as readily as identifiers. A paraphraser
working from a doc row that describes the target will naturally reuse rare *prose* tokens
that also occur in the target chunk's comments or TSDoc — producing paraphrases that are
formally identifier-free but **lexically hot**. The net direction of the bias is therefore
**unknown**, not favourable to vectors.

Mitigations: (a) paraphrases written by an agent told only "restate without using any
identifier from the target", never told which arm benefits; (b) frozen and committed pre-run;
(c) **a mandatory automated overlap audit** — for every paraphrase, list tokens ≥ 3 chars
shared with the target chunk's **full indexed content** (not merely its identifiers); any
paraphrase sharing a rare token is rewritten or flagged, and the audit output is committed
alongside `ab-tasks.json`. Because the direction is unknown, the asymmetric reading below
("no hybrid advantage even in S-concept is strong evidence against vectors") is **conditional
on that audit passing**, and is void without it.

**Leakage exclusion — index level AND filesystem level.** Task text is verbatim from an
indexed `.md` file. Excluding it only from *search results* is insufficient: the file is
still on disk, so `grep` over a task-text fragment finds the doc, which cites the ground
truth. Therefore: (a) agents run in a `git worktree` with each task's source document
**removed from the filesystem**; (b) the wrapper additionally excludes `chunk_type: 'doc'`
results in **both** arms — the registered question is whether the agent found the right
*code*, and 187 indexed `.md` files otherwise give a doc-mediated path to the answer that
ceilings both arms. Both exclusions are symmetric and logged; neither favours an arm. The
doc-chunk exclusion is a deviation from production configuration and is stated as a limit on
external validity.

#### Outcomes

Two **co-primary** outcomes. The original registration made success the sole primary while
conceding in the same breath that the secondaries "carry the power the binary lacks" — an
incoherence that would have put the entire verdict on the statistic least able to bear it.

- **Co-primary A — task success (binary).** Did the agent identify the pre-specified
  ground-truth location and answer correctly? Graded against a rubric written before any run,
  **blind to arm**, by an independent Fable agent; disputes adjudicated by reading the
  transcript, every overturn logged.
- **Co-primary B — retrieval effort (paired, continuous).** Search calls issued before the
  first correct sighting of the ground-truth location. Tested by **Wilcoxon signed-rank**
  (sign test as the pre-registered fallback if ties dominate), two-sided, α = 0.05, paired by
  task. This is where the power actually lives, so it gets a real pre-registered statistic
  rather than a round-number override.
- **Secondary:** fallback to `Grep`/`Glob`/`Read` (binary + count); total tool calls;
  wall-clock; void-run count.

#### Pre-committed decision rule

Paired over k = 12 tasks. Let **b** = tasks where H succeeds and L fails; **c** = the reverse.

| outcome | verdict |
|---|---|
| **exact McNemar p ≤ 0.05** (at k = 12: e.g. b = 5, c = 0 → p = 0.031) | **Reframe FALSIFIED.** Retrieval mode changes agent outcomes. Q1 moves toward justifying vectors — but M2 stays blocked until Q4 names the winning query class. |
| **b + c ≤ 1** *and* co-primary B not significant | **Reframe SUPPORTED.** Mode is outcome-neutral *and* effort-neutral at this power. With Recall@10 = 1.000 this is the practical-significance evidence Q4/Q5 have been deferred for four times; Q1 resolves *provisionally* toward arm D, subject to the bounds below, the scale caveat, and Gate 0. |
| **b + c ≤ 1** *but* co-primary B significant | **Outcome-neutral, effort-positive.** L reaches the same answers but costs materially more retrieval. That cost is real and **blocks a clean arm-D resolution**. |
| anything else | **AMBIGUOUS.** Report; do not resolve Q1. Escalate by increasing k, not by reinterpreting. |

**Why the falsification threshold moved (correcting my own arithmetic).** The originally
registered rule was `b − c ≥ 3 and b ≥ 3`. Its `b ≥ 3` clause is **redundant** (`b − c ≥ 3`
with `c ≥ 0` already implies it), and worse, it is not a fixed-significance rule: under H₀,
`b ~ Binomial(b+c, ½)`, so it fires at one-sided p = 0.125 (b=3,c=0), 0.188 (b=4,c=1), 0.227
(b=5,c=2), up to ≈ 0.27 (b=7,c=4). It would have let the **pro-incumbent** branch issue on
near-coin-flip evidence, in a program whose named failure mode is pro-incumbent bias. Exact
McNemar at α = 0.05 replaces it. This makes falsification demanding at k = 12 — that is the
honest exposure of how little k = 12 can falsify, not a defect to be tuned away.

**Per-stratum reporting is mandatory and asymmetric.** S-concept is vector-favourable by
construction, so a hybrid win there is weak evidence *for* vectors, while **no hybrid
advantage even in S-concept is strong evidence against them**. Headline rule applies to the
pooled set; strata are always reported separately.

#### Power — stated before the result, not after

This experiment is powered only for **large** effects. The bound depends on where in the
SUPPORTED region the result lands, and the original registration quoted only the best case —
corrected here, before any data exists:

| observed | 95% upper bound on the outcome-changing rate |
|---|---|
| b + c = 0, k = 12 | exact 1 − 0.05^(1/12) = **22.1%** (rule of three ≈ 25%, conservative) |
| b + c = 1, k = 12 | ≈ **34%** |
| b + c = 0, **S-ident alone** (n = 6) | ≈ **39%** |

That last row matters: if the harvest's n=2 hypothesis holds and production queries are
identifier-bearing, **S-ident is the production-relevant stratum**, and the pooled 25%
headline silently borrows power from the vector-favourable stratum. Any null must be reported
with the S-ident bound alongside the pooled one.

None of this is equivalence and must never be reported as such. The defensible null claim is:
*"mode-driven outcome differences are not large — bounded above at ~22% of tasks pooled,
~39% on the production-relevant stratum — and combined with Recall@10 = 1.000 the burden of
proof shifts to whoever wants to keep the vector store."* No verdict stronger may be issued
from k = 12.

**Discordance ≠ mode effect.** `b + c` also absorbs agent run-to-run stochasticity and
grading noise. With one replicate per cell there is no estimate of that floor: symmetric
noise inflates `b + c` (blocking SUPPORTED → AMBIGUOUS → "escalate k" → the incumbent
survives by default). **Registered noise-floor probe:** 3 tasks are run with 2 replicates
**per arm**; within-arm discordance across replicates estimates the floor. If the
within-arm floor is as large as the between-arm discordance, the experiment is
**uninformative at this k** and must be reported as such rather than resolved.

#### Gates that must pass BEFORE any task run is scored

**Instrument gates** (must pass before the spend gate):

1. **Fidelity self-check.** For 10 fixed probe queries, `ab-search --arm hybrid` must return
   the same `mode` and the same ordered `chunk_id` list as the shipped `mast_search` MCP tool,
   **both reading the same state dir** (otherwise a mismatch is index drift, not infidelity).
   Arm H probes must report `mode: "hybrid"`. **Zero mismatches required** (the
   `q1-reserve2.mjs` precedent).
2. **Switch-liveness check.** The two arms must differ in ranking on **≥ 1** of those 10
   probes, and arm L must report `mode: "lexical"`. **If H and L return identical rankings on
   all 10 probes, STOP: the instrument is broken, not the hypothesis.**
   **Necessary but NOT sufficient, and registered as such:** this proves the switch is alive,
   *not* that it is connected to the outcome. A live switch the agent routes around produces
   the identical fake null. Gate 4 is what closes that.
3. **Vector coverage recorded.** The frozen state's embedded fraction is measured and
   reported; the live `.mast` showed `pending_embeddings: 10 / 14,464` at registration time
   (99.93% embedded), but a degraded hybrid arm would silently manufacture a null.

**Spend gate — the retrieval-level target-rank pre-check (run BEFORE any agent is spawned):**

4. For each of the 12 task queries, compute the **rank of the ground-truth chunk under H and
   under L** through the wrapper. No agents, minutes of compute, zero token cost.
   - If H and L place the ground truth at the **same rank on every task**, the arms cannot
     discriminate on this task set and **the 24 agent runs must not be spent** — the task set
     is replaced, not the hypothesis resolved.
   - If ranks **do** differ, the causal precondition is established, and any subsequent
     outcome concordance is then genuinely informative — it is the reframe's exact prediction
     (rank moves, outcome doesn't) rather than an artifact.
   - The per-task rank deltas are committed with the results and become Q4's raw material.

   This is the cheapest test in the design and it was missing from the original registration.
   It also has standalone value: it is a direct measurement of how often mode changes the
   *retrieval* answer on non-synthetic queries.

**Interpretation gate (applied at analysis):**

5. **Marginals validity.** If pooled success is ~12/12 or ~0/12 in **both** arms, the task set
   is **uninformative** (ceiling or floor) and must be reported as such — never as SUPPORTED.
   A concordant null is only evidence when the tasks were capable of discriminating.

#### What this experiment does NOT measure (scope, stated plainly)

- **🔴 Scale — the benefit and the cost are measured at different corpus sizes.** The costs
  this decision is about (91 MB, ~7 h embed, 470 MB RAM) are priced at the **153k-chunk**
  target; this experiment measures the benefit at **~14.5k chunks**, where lexical
  Recall@10 = 1.000 is *already known*. BM25 over OR'd trigrams plausibly degrades as the
  corpus grows (more distractors sharing trigrams) in a way vectors may not. **A SUPPORTED
  verdict here therefore does NOT license deleting the vector store at 153k** — it licenses
  the claim at the scale measured, and makes scale the next question rather than a resolved
  one. Registered now so it cannot be quietly skipped when the result arrives.
- **Code-change correctness.** Tasks are investigative/read-only so the two arms cannot
  contaminate each other through the filesystem. The causal path from retrieval mode to
  outcome runs through "did the agent find the right code", which is in scope; "did the edit
  land correct" is not. *Deviation from the handoff's wording, logged: the handoff listed "did
  the change land correct" as an outcome.* Code-change tasks under `isolation: "worktree"` go
  to the Reserve.
- **Production MCP-surface effort levels** (see the Bash-surface limitation above).
- **Latency.** Not asserted here (§14.9 stands).

#### Design Reserve (pre-thought, NOT build commitments)

Code-change tasks under worktree isolation; a `--no-embeddings` container A/B at task scale;
per-query win-class labelling (Q4) fed by this run's transcripts; shipping D0 (a real
`mast search` CLI) so the wrapper's external-validity caveat disappears; a scale-out of
Gate 4's rank-delta pre-check onto a 153k-chunk corpus (addresses the scale gap above at
retrieval level, with no agent spend). Promote only on evidence.

#### AMENDMENT 1 — 2026-08-02, pre-run, post-adversarial-review

Adversarial review commissioned per the standing rule (Fable agent). **No run had occurred
and no data existed**, so the instrument was revised in place rather than appended to; this
log is the audit trail. Direction of each error is stated, since three of these ran in the
direction that would have produced a *false* result.

| # | Finding | Change | Direction the error ran |
|---|---|---|---|
| 1 | **Bypass/ceiling fake null (SEV-0).** Source doc excluded from the *index* but still on disk; S-ident task text carries the target's identifiers, so one `grep` resolves the task. Both arms concord for reasons unrelated to the hypothesis. | Filesystem-level source-doc removal via worktree; `chunk_type: 'doc'` excluded in both arms; marginals validity gate (Gate 5). | **Toward a false SUPPORTED → toward deleting the vector store.** Anti-incumbent — i.e. toward my own new framing. |
| 2 | **Missing spend gate.** No check that the arms disagree about anything the tasks depend on, before spending 24 agent runs. | **Gate 4** target-rank pre-check added — the cheapest test in the design, and standalone-informative. | Toward spending compute on an experiment guaranteed to be concordant. |
| 3 | **Blinding was false.** `mode` (`search.ts:35`), `_stats` (`:43`) and `similarity_score` (`hybrid.ts:153`) all leak the arm into agent-visible output *and* into transcripts, so "graded blind" was untrue as written. | Redaction of all three, identically in both arms; fidelity gate compares pre-redaction payload. | Toward unblinded grading — direction unknowable, therefore worst kind. |
| 4 | **Silent arm degradation.** `hybrid.ts:102–104` swallows embedder failure and returns `mode: "lexical"`; gates ran once, so arm H could become arm L mid-experiment. | Per-call `mode` assertion; any H-run with a non-hybrid call is void and re-run. | **Toward a false SUPPORTED.** Anti-incumbent. |
| 5 | **Decision rule not fixed-significance.** `b − c ≥ 3` fires at one-sided p = 0.125–0.27; its `b ≥ 3` clause was redundant. | Exact McNemar p ≤ 0.05. | **Toward a false FALSIFIED → pro-incumbent**, this program's named failure mode. |
| 6 | **Verdict rested on the admittedly-powerless statistic**, with effort demoted to a round-number override. | Retrieval effort promoted to **co-primary B** with a pre-registered Wilcoxon signed-rank test. | Toward under-detecting a real cost of lexical → anti-incumbent. |
| 7 | **Power quoted only the best case** (b+c=0 pooled), while SUPPORTED fires at b+c ≤ 1, and the production-relevant stratum is n=6. | Three bounds tabulated: 22.1% / 34% / 39%. | Toward overstating the strength of a null. |
| 8 | **"Authoring bias runs toward vectors" was unsupported** — trigram FTS matches prose, so identifier-free paraphrases can still be lexically hot. | Claim **retracted**; mandatory token-overlap audit against full chunk content; the asymmetric S-concept reading made conditional on it. | Unknown direction — which is exactly why the original claim was unsafe. |
| 9 | **Scale gap:** cost priced at 153k chunks, benefit measured at 14.5k. | Registered as a scope limit that **blocks** a SUPPORTED verdict from licensing deletion at 153k. | Toward over-generalising a null. |
| 10 | Stale citation `hybrid.ts:72`. | Corrected to `:75` / `:78`. | Cosmetic. |

Findings the reviewer checked and **withdrew** are recorded in its report: the frozen index
does cover the target packages (993 workbench + 200 kluster-bt files), sibling roadmap docs
do **not** duplicate task rows verbatim (zero shared lines > 40 chars on the highest-risk
pair), and rule-of-three *is* the right shape for a paired discordance count.

#### AMENDMENT 2 — 2026-08-02, pre-scoring: grading is mechanical, not Fable-blind

The registration specified a blind Fable grader. Ground truth is a mechanically-resolved
unique symbol, so grading is exact string match on `(answer_file, answer_symbol)` — which
removes the grader as a bias source entirely rather than blinding it. Strictly stronger;
runs in no direction. The SEALED arm manifest was opened only after all 30 `result.json`
files existed.

#### Q1/OUTCOME RESULT (2026-08-02) — outcome-neutral at k=12, and the mechanism is visible

30 runs (24 registered + 6 noise-floor), 0 void, 0 missing, 0 arm-integrity failures.

**Co-primary A — task success: b = 0, c = 0.** Perfect concordance on all 12 tasks, at
symbol level *and* file level. H 8/12, L 8/12. Exact McNemar p = 1.000. Gate 5 marginals
**ok** — 8/12 is neither ceiling nor floor, so the task set did discriminate.

**Co-primary B — retrieval effort: not significant on either metric.** See AMENDMENT 3 —
the first scoring pass used the WRONG statistic. On the **registered** metric (search
calls before first correct sighting): 11/12 ties, one non-tie (T09, H = 4 vs L = 1), sign
test **p = 1.000**. On the substituted metric (total calls) p = 0.219. Neither is
significant, so the branch is unaffected, but the original write-up's flourish — "the
direction runs against hybrid" — was an artifact of the wrong metric and is **withdrawn**.

**The single most informative descriptive fact, which the first write-up buried: H and L
returned byte-identical `(file, symbol)` answers on 12/12 tasks — including all four
failures.** Not merely the same success bits: the same answers. This is why b = c = 0 is
robust to any regrading dispute below. It also means outcome here is heavily determined by
task text plus a near-deterministic agent policy, so the experiment's effective
sensitivity to retrieval mode is *lower* than "12 paired tasks" suggests.

**Noise floor: 0/6 within-arm success discordance** across the 3 seeded replicate tasks —
and replicates returned identical *answers*, not just identical success bits, which is the
stronger stability evidence. But 6 binary cells bound the within-arm flip rate only at
≈39% (rule of three), the same order as the effect bound itself, so the original claim
that this proves "the zero discordance is not noise swamping a real effect" is
**overstated and withdrawn**. It is consistent with stability, not proof of it.

**The mechanism — corrected. It is query authoring, not re-querying.** The original
write-up claimed lexical "recovered by reformulating the query." The logs falsify that:

- **0 of 147** logged queries were the task text. Gate 4's rank deltas were computed on
  queries **no agent ever issued** — a real limit on how much Gate 4's table can carry.
- On T08 and T10, the lexical arm's **first self-authored query already had the target
  file in the window** (`calls_to_sight = 1` for T03-B1, T08-B1, T10-B1). There was no
  recovery to perform.

The stronger evidence was sitting unanalysed in the log. **Six queries were issued
verbatim by both arms. All 6 returned different ten-result windows** (overlap 3–9 of 10)
— **and the outcome was identical in all 6.**

| overlap@10 | query (both arms, verbatim) |
|---|---|
| 3/10 | `reDiscover ReDiscoverFn injected seam` |
| 6/10 | `WorkspaceFs port interface writeFile readFile Promise<void>` |
| 6/10 | `ChainedCapabilityMatcher first non-null lexical embedding` |
| 6/10 | `behavior tree leaf node single LLM call renders prompt` |
| 7/10 | `installToolchain pnpm add retries 3 times provisioning` |
| 9/10 | `AgentLoop multi-turn tool-aware agent loop` |

That is the reframe's claim in its cleanest measurable form: on the queries agents actually
write, the arms surface materially different windows, and it changes nothing about what the
agent concludes. **The window moved; the outcome did not.**

**What this does and does not license — the registered bounds, applied.**

- b + c = 0 at k = 12 → 95% upper bound on the outcome-changing rate = **22.1%** exact
  (25% by rule of three). **This is not equivalence.**
- S-ident alone (n = 6, the production-relevant stratum under the harvest hypothesis) →
  **≈39%**. The pooled bound borrows power from the vector-favourable stratum; both are
  reported, as registered.
- **Scale caveat stands and is verdict-blocking:** measured at ~14.5k chunks; the 91 MB /
  ~7 h / 470 MB is priced at 153k. This result does **not** license deleting the vector
  store at the target scale.
- **"The task set discriminated" is WITHDRAWN.** Gate 5 read `ok` on mechanical grading
  (8/12), but a referent audit of the four failures finds **three are ground-truth
  extraction artifacts**, not agent failures. The harvester takes the first
  uniquely-resolving backticked identifier in a doc line (`ab-build-tasks.mjs:88-104`),
  which yields *a symbol the line mentions*, not *the symbol the line is about*:
  T06 (line is about the shared retry behaviour; both arms answered `retrySpawn`, arguably
  more correct than the recorded truth), T04 (the line's disjunction *is* the classifier
  `isEndpointStallFailure` both arms named), T01 (both answered `GapClosureOptions`, the
  interface declaring the `reDiscover` seam the line describes). Only T03 is a clean
  failure. Regraded, both marginals are 11/12 — **brushing the registered Gate 5 ceiling
  rule**, under which the set would be UNINFORMATIVE rather than SUPPORTED. b = c = 0 is
  unaffected (the arms gave identical answers), but effective discrimination is well below
  nominal k. A referent-ambiguity rule must be pre-registered before any repeat.
- **The S-ident null is weaker than the S-concept null.** Deleting the source document does
  not remove the identifier from the code, so S-ident tasks stay Grep-resolvable in
  principle. The S-concept stratum carries no such shadow.
- External validity limits: Bash surface rather than the MCP tool; `doc` chunks excluded
  in both arms; investigative read-only tasks, so code-change correctness is untested.

**Verdict per the registered rule:** b + c ≤ 1 **and** co-primary B not significant →
**Reframe SUPPORTED**, mechanically. But the honest statement of what was shown is a notch
weaker than that label, and this is the version that should be quoted:

> *Outcome-concordant at k = 12 under mechanical grading — indeed answer-identical on
> 12/12 — with effective discrimination below 8/12 because three of the four failures are
> ground-truth extraction artifacts, an S-ident stratum shadowed by Grep-resolvability,
> and a mechanism that is query authoring rather than re-querying.*

Combined with the 6/6 same-query/different-window evidence, this is still the
practical-significance evidence Q4/Q5 were deferred four times for — it is just not the
clean sweep the first write-up implied.

**Q1 remains AMBIGUOUS and M2 remains BLOCKED**, and that is not timidity. The registered
verdict is bounded at 22%/39% and explicitly does not extend to 153k chunks — the scale
at which the cost is actually paid. What changed is the *burden of proof*: the case for
keeping the vector store can no longer rest on NDCG@10 deltas, because a measured
retrieval advantage did not move a single task outcome.

**Honest counter-evidence, recorded because it cuts against this result.** Gate 4 also
showed the reframe's own premise does not generalise: kluster arm L Recall@10 = 1.000 was
the argument's foundation, but on this task set the target *chunk* was in the window on
**3/12** tasks for both arms. The reframe was right about the conclusion for a reason
partly different from the one it gave — outcomes are rank-insensitive because agents
re-query, not because lexical already retrieves everything.

#### AMENDMENT 3 — 2026-08-02, POST-scoring, after adversarial review of the results

Unlike Amendments 1–2 these corrections were made **after** seeing results, so each states
which direction the error ran. All were found by a commissioned Fable review of the result,
not by me. None flips the registered branch; all were reported as errors rather than
quietly fixed.

| # | Error | Direction it ran |
|---|---|---|
| 1 | **Co-primary B scored on the wrong statistic.** Registered: search calls *before first correct sighting*, Wilcoxon primary / sign fallback. Scored: **total** calls, sign test only; Wilcoxon never implemented (`ab-score.mjs:97-99`). Registered metric gives p = 1.000 (11/12 ties); the reported 0.219 and the "direction runs against hybrid" remark are artifacts of the substitution. | The flourish **flattered the reframe** — my own framing. Corrected and withdrawn above. |
| 2 | **Mechanism mischaracterised** as "re-querying". 0/147 queries were the task text, and lexical's first query already sighted the target on T03/T08/T10. | Overstated the reframe's story. Replaced with the 6/6 same-query/different-window analysis, which is stronger. |
| 3 | **"The task set discriminated" unsupported** — 3 of 4 failures are extraction artifacts; regraded marginals 11/12 brush the Gate 5 ceiling. | Made the null look better-earned than it was. Withdrawn. |
| 4 | **Noise-floor claim overstated** — 6 cells bound the flip rate at ≈39%, not "therefore not noise". | Pro-reframe. Softened. |
| 5 | **McNemar registration/implementation mismatch:** the registered example (b=5,c=0 → p=0.031) is *one-sided*; the implementation is two-sided (0.0625). | Makes FALSIFIED **harder** → pro-reframe. Moot at b=c=0 (p=1 either way), logged for the next run. |
| 6 | **The 12/12 identical-answers fact went unreported** — the strongest datum in the set, omitted in favour of a weaker three-task story. | Omission, not direction. Now headlined. |
| 7 | `ab-score.mjs:40-45` comment says "ground-truth **chunk**"; the code matches **file** prefix. `sighted` is file-level, and would not be 30/30 at chunk level. | Comment/code mismatch; the metric used is file-level and is now labelled as such. |

Reviewer criticisms checked and **withdrawn by the reviewer**: agents did not bypass the
tool (all 147 calls logged, all `arm_intact: true`, every answered file appeared in that
run's own search results); the paraphrase audit's zero-overlap result reproduces
independently; source-doc deletion held in all 12 worktrees with 0 doc chunks reaching any
agent; noise-floor task selection was sealed before the first search; and the commit
ordering (registration `3a26e71` 08:41Z → instrument `6319161` 09:02Z → seal → runs
09:09–09:19Z → scoring 09:19:52Z) confirms nothing was scored before it was registered.

**Unresolved gap, carried forward:** the 30 subagent prompts and model identity are not in
the committed record — only `cards.json`'s question text. Whether agents were asked for
"the symbol this line refers to" versus "the code implementing this" is exactly what
decides the artifact-vs-genuine status of the four failures. **Commit the agent prompt
template with any repeat.**

#### Q1/ARM-V EQUALISATION — PRE-REGISTRATION (written 2026-08-02, BEFORE the arm was scored)

Closes the last open finding from the 2026-08-01 adversarial review (finding 5): arm V
(pure vector) was scored by a *different* harness from L and H, so its numbers were never
comparable to theirs. `runArm` in `q1-reserve2.mjs` already implements `V` — it was simply
absent from `ARMS`. Equalisation is therefore adding one list entry, and V then runs the
identical path as L/H: same candidate pool, same `chunkStore` fetch, same dedup, same
scorer. No new data, no re-embedding.

`LEXICAL = ['L','T+D','W','W+D']` deliberately excludes V, so the leave-one-out lexical
baseline — the only baseline permitted to bear the delete-branch contrast — is untouched.

**Registered authority limit.** Arm V is **DESCRIPTIVE ONLY**. It answers "how much of
hybrid's ranking comes from the vector side alone?" It may **not** be used to justify or
kill the vector store in either direction: V < L would not prove vectors worthless (RRF
fuses a weak-but-decorrelated ranker to real effect — that is the whole premise of hybrid),
and V > L would not prove them necessary (H is what ships, not V). Any verdict language
stronger than description is out of scope by pre-registration.

**Pre-stated expectation, so the result can surprise me:** on the anti-lexical set V should
be strongest relative to L; on kluster-normal and nest V should trail L. If V beats H
anywhere, that is a *fusion* finding — RRF diluting a strong ranker with a weak one — and
it would reopen F16, which is currently CLOSED.

**Falsification of the equalisation itself:** the existing L/H self-check against shipped
`hybridSearch` must remain at **0 mismatches**. If adding V perturbs it, the change is
contaminating the pipeline and must be reverted rather than interpreted.

#### Q1/ARM-V RESULT (2026-08-02) — V ≈ H everywhere; F16 stays CLOSED

Equalisation is clean: **self-check = 0 mismatches** on all three sets, `empty` = 0 for
every arm including V. L/H reproduce shipped `hybridSearch` exactly, so adding V did not
perturb the pipeline.

| set | n | L | H | **V** | V−H (paired 95% CI) | V−L (paired 95% CI) |
|---|---|---|---|---|---|---|
| kluster-normal | 11 | 0.4238 | 0.5907 | 0.5417 | −0.0490 [−0.223, +0.125] t=−0.63 **ns** | +0.1179 [−0.065, +0.301] t=1.43 ns |
| kluster-anti ¹ | 28 | 0.1908 | 0.3222 | 0.3436 | +0.0214 [−0.111, +0.154] t=0.33 **ns** | +0.1527 [+0.013, +0.292] t=2.25 **sig** |
| nest-external | 20 | 0.5119 | 0.6122 | 0.6608 | +0.0486 [−0.083, +0.180] t=0.77 **ns** | +0.1489 [−0.052, +0.349] t=1.56 ns |

¹ one-directional per §14.3 — may kill vectors, never justify them.

**🔴 A near-miss worth recording as a process finding.** On raw means V beat H on two of
three sets (anti 0.3436 vs 0.3222; nest 0.6608 vs 0.6122), and my pre-registration said
exactly that outcome "would reopen F16, which is currently CLOSED." **The paired CIs say
no**: V−H is not significant anywhere, |t| < 0.8 on all three sets. Acting on the point
estimate would have reopened a closed question and re-run the fusion investigation for
nothing. This is the "report confidence intervals, not point estimates" rule earning its
keep for the second time in this program — the first was an "external replication" that
turned out to be 9× smaller than its own standard error. **F16 stays CLOSED. `rrf_k`
remains 60.**

**What V actually shows, within its registered descriptive-only limit.** The vector ranker
*alone* is statistically indistinguishable from the shipped fusion on all three gold sets.
The lexical half of RRF contributes nothing detectable **on these query sets** — which are
TSDoc-prose-derived and therefore the class most favourable to vectors. It is **not**
licence to drop the lexical half: the registration forbids V bearing any
justify-or-kill verdict, RESERVE-2 showed the shipped trigram tokenizer is doing real work
(W−L significantly negative on both kluster sets), and F15 showed a one-line lexical fix
more than halved the measured value of vectors.

**My pre-stated expectation was wrong in direction, and that is recorded rather than
quietly dropped.** I predicted V would trail L on kluster-normal and nest. V led L on both
(+0.118, +0.149), though neither reaches significance. Only the anti set — where V leading
was expected — is significant, and it is the one set whose registration forbids it from
justifying vectors.

**How this sits with Q1/OUTCOME.** On gold-set ranking H ≈ V (lexical half adds nothing
measurable); on task outcomes H ≈ L (vector half changed no outcome). These are different
metrics on different query sets and are not formally contradictory, but jointly they say:
**ranking-metric differences among all three arms are not what determines agent outcomes.**
That is now two independent lines of evidence pointing at the same conclusion, and it is
the strongest argument yet that Q1 cannot be closed from ranking metrics at all.

Q1 remains AMBIGUOUS. M2 remains BLOCKED — the 153k scale caveat is untouched by this.

**Next (registered order unchanged):** (2) equalise arm V via `rankers: ['vec']` in
`q1-reserve2.mjs`; (3) Q4 win-class labelling, now with 30 transcripts and per-task rank
deltas as raw material; (4) the organic harvest — note these 30 runs wrote real
non-self-referential rows into the A/B search log, though not into `metrics`; (5) the
scale-out of Gate 4's rank-delta pre-check onto a 153k corpus, which is the cheapest
attack on the one caveat that blocks M2.

### Q1/SCALE — 153k scale-out of the Gate-4 rank-delta pre-check: PRE-REGISTRATION (written 2026-08-02, BEFORE any measurement)

**Nothing below may be edited after the first scored measurement.** Amendments are appended
with a timestamp, a reason, and which direction the error runs. Registration is committed
before the instrument is built, per the Q1/OUTCOME precedent.

#### Why this experiment

The one verdict-blocking caveat on Q1: every benefit measurement sits at ~14.5k chunks; the
cost (91 MB dep, ~7.2 h embed, 470 MB RAM, 169 ms brute-force scan) is priced at the
153k-chunk target (vscode). Mechanism under test: BM25 over OR'd trigrams plausibly degrades
as the corpus grows (more distractors sharing trigrams; shifting collection statistics) in a
way dense vectors may not. Three converged lines (Q1/OUTCOME, arm V, Q4) already show prose
gold-set ranking cannot settle Q1 — this experiment does not re-litigate them; it attacks
only the scale caveat.

#### Corpus-truth correction, and a product defect found while measuring it

Stage 4.5's vscode figure (152,969 chunks) was the CLI stdout counter, not a ground-truth
count. The true count, read from `graph.db`'s `chunks` table after indexing commit
`5ebbe53282bd1d5d3453405d9e6a34ee2eb7f42d` (full clone, clean tree, 8,653 files indexed, 0
skipped, Phase-1 wall clock 577 s, state dir 737 MB), is **138,440**. The 14,529-chunk gap is
fully accounted for: two files — `extensions/vscode-colorize-perf-tests/test/colorize-fixtures/test-checker.ts`
(a 146,620-line fixture) and `src/vs/workbench/services/search/test/node/fixtures/examples/employee.js`
(an 11,190-line fixture) — had **all** of their chunk writes fail deterministically with
"too many SQL variables."

**Root cause (product defect, logged, NOT fixed in this effort).** `replaceChunksForFile`
(`src/store/sqliteChunkStore.ts`, ~line 66) inserts every chunk for a file in one unbatched
multi-row `INSERT`. At 11 columns/row, SQLite's 32,766-parameter ceiling caps a single file
at ~2,979 chunks; a larger file's insert rolls back **entirely** — loud, not silent
(`write_errors=2`, CLI exit code 1). The gap this leaves: orchestration that gates only on
exit code and does not additionally check `write_errors` would still silently drop the
file's chunks from the index. That gating gap is recorded as a finding here; batching
`replaceChunksForFile`'s insert is out of scope for this registration.

Chunk-type distribution over the true 138,440: method 74,685; block 22,791; function 14,287;
class_shell 11,636; interface 10,776; type 3,239; doc 1,026 (0.74%).

#### What this measures — and does not (scope, stated first)

- This measures **retrieval** (rank of a known target as distractor mass grows), **not
  outcomes**. It cannot by itself resolve Q1 in the pro-vector direction: if lexical
  degrades at scale, the required next step is an outcome test at that scale (Reserve),
  because Q1/OUTCOME showed rank movement does not imply outcome movement.
- In the pro-deletion direction it is the registered discharge instrument for the scale
  caveat: if the 14.5k picture holds at 138k at retrieval level, the caveat is discharged
  at target-rank retrieval level and Q1 may resolve on the strength of the three existing
  lines — residual scale channels (window composition at scale; outcome transfer across
  corpus and scale) are accepted by decision, not evidence (see AMENDMENT 1, F10).
- **External validity (F11).** Measured at 138,440 chunks; the 14,529-chunk fixture tail
  (the corpus's two largest, most repetitive files — see Corpus-truth correction above) is
  absent due to the logged insert defect; the 153k-priced cost basis includes distractor
  mass this measurement does not.

#### Design — nested tiers, fixed queries, one corpus

Single-point measurement at full scale confounds corpus content with corpus scale. Instead:
**nested corpus tiers within one pinned vscode checkout** (commit
`5ebbe53282bd1d5d3453405d9e6a34ee2eb7f42d`).

- **Tiers are seeded RANDOM file-level nested subsets, not directory-based.** Construction:
  seeded shuffle (seed = 153, committed) of the full indexed file list; take file prefixes
  whose cumulative chunk counts land nearest ~15,000 (T1) / ~50,000 (T2) / ~90,000 (T3);
  T4 = all 138,440 chunks (every indexed file). Each tier is a strict superset of the
  smaller by construction — T1 ⊂ T2 ⊂ T3 ⊂ T4.
- **Why random, not directory-based (a reversal from the original framing).** A
  directory-based partition looks natural (grow the corpus one extension folder at a time)
  but confounds scale with *content*: `extensions/copilot` alone is 29,459 chunks of one
  topical flavour, so each increment would differ in kind as well as in size, and a
  rank-delta measured that way cannot distinguish "more distractors" from "different
  distractors." Random file-level nesting makes distractor *mass* the only thing varying in
  expectation across tiers — the actual quantity the scale caveat is about. The
  directory-based partition is not discarded; it moves to the **Design Reserve** as a
  sensitivity analysis, promoted only if the primary result is challenged or ambiguous.
- All (query, target) pairs have their **target in T1** (targets are sampled after tier
  assignment — see Query strata below), so every query is answerable at every tier; the
  only thing that varies across tiers is distractor mass and collection statistics.
  Per-query rank across tiers is a within-query dose–response curve.
- Each tier gets its own state dir (own FTS index → own BM25 stats; own vector table scoped
  to the tier). Embeddings are computed once against T4 (the full-corpus embed — see the
  Deviation below) and shared into the smaller tiers via the content-hash embed cache
  (`<stateDir>/embed_cache/<modelId>__<dtype>__<recipeTag>/<sha256(content)>.json`); each
  tier still needs its own `lance/vectors.lance` populate pass (cache read + write, no model
  call).

#### Arms

| arm | construction |
|---|---|
| H | shipped `hybridSearch(db, lance, embedder, …)` |
| L | shipped `hybridSearch(db, lance, null, …)` — the supported `--no-embeddings` path |

Known-defect mitigations carried forward from Q1/OUTCOME (§5 of HANDOFF_Q1.md) are enforced
as Gates 2–4 below: `chunkStore` passed explicitly, per-call `mode` assertion, vector
coverage checked per tier before scoring.

#### Query strata — sampled AFTER tier assignment, mechanical derivation only

Targets are sampled from **T1's TSDoc-rich exported chunks** (functions/methods/
class_shells/interfaces/types with a leading TSDoc comment ≥ 80 chars) — measured 4,357 such
chunks corpus-wide (of 71,472 exported candidates). Expected TSDoc-rich chunks landing in T1
under the seeded random tier assignment: 4,357 × 15,000/138,440 ≈ **472** (corrected from a
previously unreconstructable 497 — AMENDMENT 1, item 12). Distinct T1 targets needed:
**150 (S-ident) + 100 (S-prose) + 10 (probes) = 260** — S-approx (below) reuses the S-ident
targets and draws no additional pool. 472 comfortably covers 260.

**Floor rule if the realized T1 pool falls short of 260:** reduce S-prose first (floor 50);
any further reduction below that floor hits S-ident and must be logged as an amendment.

S-prose, S-ident, and the probe set are disjoint seeded samples from the T1 pool; S-approx is
a paired derivation from the S-ident sample (draws no separate targets). Target = the sampled
symbol's own declaration chunk, which makes the Q1/OUTCOME referent-ambiguity defect
(harvester grading "a symbol the line mentions, not the one it is about") structurally
impossible: the referent IS the sampled declaration.

- **S-ident** (n = 150, floor 40) — query = symbol name + up to 3 rare content words from its
  TSDoc, mirroring the measured shape of real agent queries (harvest n=2 and the 147-call
  log: identifier-bearing, median 5 words). Production-relevant stratum; **this is the
  decision-bearing stratum**, covering **exact-identifier retrieval** (see below and
  AMENDMENT 1, F6). n_min for the 10 pp discharge bound to be reachable under a true zero
  effect is 154 at p_nz = 0.4 (1.96²·p_nz/0.10²) — n = 150 (not the original 75) is sized to
  that, not to the old 75-query design (AMENDMENT 1, F2).
  - **"Rare" defined mechanically (F7).** Content words = alphabetic tokens ≥ 4 chars from
    the target's TSDoc, excluding a fixed stopword list committed with the generator.
    Rarity = document frequency computed over **T1's index only** — not T4: T4-side rarity
    would exclude exactly the terms that are rare-at-15k/common-at-138k, the terms through
    which the scale mechanism would show. Qualification: T1 DF ≤ 50 documents. Selection: up
    to 3 qualifying words, lowest T1 DF first, ties broken by earliest occurrence in the
    TSDoc. If no word qualifies, the query is the symbol name alone, logged.
- **S-prose** (n = 100, floor 50) — build-normal-set-r2.mjs's **derivation rule**
  (`camelCaseSplit(symbol)` + first TSDoc sentence, ≤ 12 words) applied by a **new committed
  generator** to fresh seeded targets from the T1 pool (F12). Not "verbatim": the original
  script hardcodes kluster targets/paths (lines 26, 77) — only the derivation rule transfers.
  Comparable in class to the existing kluster-normal/nest evidence base (97% prose), because
  that base was built by the same rule. Note plainly: the rule *prepends* the split symbol
  name, so **both S-prose and S-ident are identifier-led** — this is why the comparability
  claim to the existing evidence base survives, not despite it. **Supporting only.**
- **S-approx** (n = 150, supporting) — for each of the 150 S-ident targets: the same query
  with the exact symbol name replaced by its camelCase/snake-split words (the shipped
  `splitIdentifierTerms` rule), keeping the same rare-word suffix. Mirrors guessed/
  partial-identifier search behaviour and directly addresses F6 (exact-name queries are
  near-unique trigram keys that may flatten the dose–response). Paired to the S-ident
  targets, so it draws no additional pool cost. In the consistency set (see Pre-committed
  decision rule below).
- **10 probe queries** — instrument self-check only (Gate 2), excluded from scoring.

**Doc chunks are NOT excluded** — a deliberate contrast with Q1/OUTCOME, which excluded
`chunk_type: 'doc'` results in both arms because task text there was copied verbatim from an
indexed `.md` file, giving a doc-mediated path to the same ground truth. Here queries derive
from TSDoc content that lives *inside* the target chunk itself, not from a separate document
that cites the target — there is no leakage channel of that shape. `.md` distractor chunks
(1,026 of 138,440 corpus-wide, 0.74%) are legitimate production corpus mass; production
`mast_search` does not exclude them, and neither does this measurement.

Honest lexical-hotness note: queries derived from the target's own TSDoc are lexically hot
by construction. This affects the **level** of ranks identically at every tier; the
registered quantity is the **change across tiers**, which hotness does not fabricate. It
does bound external validity: these are not agent-authored queries.

The frozen query set is committed as `eval/scale-queries.json` BEFORE any tier measurement,
with the seed and the generator script.

#### Metrics and censoring

Per query × tier × arm, through the wrapper at `limit = DEPTH = 200`, `WINDOW = 10` (deeper
than the window so "below window" is distinguishable from "unretrievable"; 200 not 100
because censoring risk grows with corpus size):
- **Hit definition, amended for dedup suppression (F4).** `hybridSearch` routes results
  through `dedupShellMethodCollisions` (`hybrid.ts:139, 201–253`), which can suppress the
  target chunk itself in favour of its class shell (or a method over its shell) — the
  survivor's hint still names the target, so production treats this as a hit either way.
  Registered rule: a result counts as the target at rank r if it IS the target chunk, OR it
  is the target's shell↔method counterpart in the same file (a kept `class_shell` whose
  `symbol_name` equals the target method's `parent_symbol`, or a kept `method` whose
  `parent_symbol` equals the target shell's `symbol_name`). The wrapper additionally records
  the **PRE-dedup rank** as a diagnostic (not scored), and suppression events are logged and
  reported per arm × tier.
- chunk-level `rank` of the target's own declaration chunk (post-dedup, per the hit
  definition above); chunk-level `in_window@10` (rank ≤ 10).
- Censoring: rank null at DEPTH recorded as censored and entered into the rank co-metric at
  DEPTH+1 = 201 (a floor on degradation — stated, not hidden); censoring counts reported per
  arm × tier × stratum. `in_window@10` is uncensored by construction.

#### Exactly one decision-bearing test (multiplicity killed by construction)

One test carries the verdict; everything else is supporting evidence — reported in full,
never itself dispositive.

**Sign convention (F1), fixed once, used everywhere below:** per query, per arm,
**D_loss = in_window@10(T1) − in_window@10(T4)** (positive = membership degraded from T1 to
T4). Contrast **Δ = D_loss_L − D_loss_H** (paired by query); positive Δ means lexical
degrades more than hybrid — the pro-vector direction.

- **Decision-bearing.** S-ident stratum, chunk-level `in_window@10`, contrast Δ as defined
  above, tested two ways:
  - **Wilcoxon signed-rank, EXACT** (exact distribution/permutation, not normal
    approximation), two-sided, α = 0.05, zeros dropped per standard practice.
    Hodges–Lehmann's estimate and CI are reported but **demoted to descriptive only**
    (F5) — the near-symmetric {−2..2} support of this contrast makes HL prone to a
    degenerate `[0,0]` reading that must not be a loophole into discharge.
  - A seeded **BCa bootstrap 95% CI (10,000 resamples)** on the paired proportion difference
    Δ, computed over **ALL n queries** (zeros are data for this estimand, not dropped). This
    CI — not Wilcoxon, not HL — is what the discharge branch of the decision rule keys on
    (F2).
- **Supporting (reported in full; must be directionally consistent for a clean verdict).**
  S-prose and S-approx (F6) — identical construction, not decision-bearing, in the
  consistency set below; the Δlog2(rank) co-metric (censored at DEPTH+1 = 201, supporting
  only, never carries a verdict — F3); T2/T3 as intermediate points on the dose–response
  curve (monotonicity check between T1 and T4).
- **Registered consistency triggers (F10 — replaces the previous unregistered "material
  inconsistency"):**
  1. If either supporting stratum's (S-prose, S-approx) own all-n BCa CI excludes 0 in the
     lexical-degrading direction while the decision-bearing test discharges →
     **AMBIGUOUS**.
  2. The Δlog2(rank) co-metric forces **AMBIGUOUS** only if its bootstrap CI excludes 0 in
     the lexical-degrading direction — otherwise it is reported, never dispositive.
  3. **Monotonicity:** any tier mean outside the [T1, T4] envelope by more than its own 95%
     CI is flagged and discussed in the result, but does not alone force AMBIGUOUS — the
     endpoints (T1, T4), not the middle tiers, carry the decision.
- **Zero-differences.** The zero count (D_loss_L = D_loss_H per query) is reported. Wilcoxon
  drops zeros per standard practice. If fewer than 10 non-zero pairs remain in S-ident, the
  **Wilcoxon report only** is flagged **underpowered** (F2) — a degenerate or non-runnable
  Wilcoxon does NOT block CI-based discharge, which is defined over all n and treats zeros
  as data.

#### Pre-committed decision rule

| observed | verdict |
|---|---|
| Δ significant on the decision-bearing test (exact Wilcoxon), lexical degrading more (Δ > 0) | **SCALE CAVEAT CONFIRMED.** The 14.5k null does not extend to 138k at retrieval level. Q1 stays open; the pro-vector path requires an outcome test at scale (Reserve). M2's delete arm stays blocked. |
| Wilcoxon not significant (or degenerate/non-runnable — see below) AND the all-n BCa 95% CI upper bound on Δ (extra lexical `in_window@10` loss) ≤ 10 percentage points | **SCALE CAVEAT DISCHARGED at target-rank retrieval level.** The 14.5k picture holds at 138k. Residual scale channels (window composition at scale; outcome transfer across corpus and scale) are accepted by decision, not evidence (F10). Combined with the three converged lines, Q1 resolves provisionally toward deletion; M2 unblocks for the delete-arm decision (not for a silent delete — M2 is decided on its own section). |
| Significant in the reverse direction (Δ < 0, hybrid degrades more) | Caveat discharged a fortiori; reported as a fusion-at-scale finding, descriptive only. |
| anything else | **AMBIGUOUS.** Report; escalate by increasing n, never by reinterpreting. |

A degenerate or non-runnable Wilcoxon (e.g. an all-ties stratum) counts as "not significant"
for this table and does **not** block CI-based discharge (F2/F5); the "<10 non-zero pairs →
underpowered" rule applies to the Wilcoxon **report** only, never to the BCa branch.

**Trivial discharge on T4 ceiling, per stratum (F3 — replaces the deleted anti-ceiling
gate).** If **T4** chunk-level `in_window@10` ≥ 95% in **both arms** in a stratum (integer
trigger: ≥ 143/150 for n=150, ≥ 95/100 for n=100), the caveat is **discharged trivially for
that stratum** — no membership loss materialized at full scale — reported with the all-n
BCa CI for that stratum. This replaces the original T1-ceiling gate, which fired backwards:
T1 ceiling is the *ideal* starting condition for measuring degradation (everything visible
at the small tier), not a disqualifying one — the dead case was always
T4-ceiling-in-both-arms, which is discharge evidence, not failure. Δlog2(rank) remains
supporting-only everywhere and never carries a verdict, on this path or any other.

The 10 pp bound is pre-set and admittedly a judgment call: an extra one-in-ten loss of
window membership at scale could plausibly move outcomes and cannot be waved off; below
that, with outcomes already shown insensitive to window composition at 14.5k, the burden of
proof shifts to whoever wants to keep the store. The bound is registered here so it cannot
be tuned after the numbers exist. n_min for the bound to be reachable under a true zero
effect is 154 at p_nz = 0.4 (1.96²·p_nz/0.10²) — n = 150 (not the original 75) is sized to
make the discharge branch reachable across realistic non-zero rates instead of the original
design's ~[10,14]-of-75 corridor (F2).

**Direction-of-error statement, in advance:** the investigator's prior (three converged
lines) favours deletion. A null here flatters that prior. Therefore the null branch carries
the harder requirements (CI bound, not just p > 0.05; decision-bearing-stratum-specific;
adversarial results review mandatory before the verdict is recorded).

#### Falsification criteria (pre-stated)

- **Lexical degrading with scale (the pro-vector outcome):** Δ positive
  (D_loss_L > D_loss_H) and significant on the decision-bearing test (exact Wilcoxon) —
  vectors' scale story is real at retrieval level.
- **The 14.5k picture holding:** the discharge row above (all-n BCa CI upper bound ≤ 10 pp).
- The registration is falsifiable in both directions; neither outcome is "no result".

#### Gates before any scored measurement

0. **Tier integrity (F8), per tier, before any measurement:** (a) tier chunk count ==
   the frozen tier manifest's count; (b) tier build `write_errors == 0` — with the two known
   whale fixture files excluded from the corpus file list up front (already absent from the
   full index for the reason logged in Corpus-truth correction above; recorded here, not a
   new defect); (c) per-tier `vectors.lance` row count == tier chunk count; (d) an anti-join
   proves zero vectors whose `chunk_id` lies outside the tier's chunk set (out-of-tier vector
   hits would die silently at `chunkStore.getChunksByIds` (`hybrid.ts:123`), eating H-only
   candidate slots — an asymmetric arm distortion that nothing else in this design would
   catch).
1. **Wilcoxon implemented and unit-tested BEFORE scoring, EXACT.** The registered Wilcoxon
   signed-rank test in `ab-score.mjs` was never implemented (HANDOFF_Q1.md §5) — that defect
   does not repeat here. The implementation must be the **exact** distribution/permutation
   form, not normal approximation, and ships with its own unit tests before it touches real
   data: known-answer cases including an **all-ties case** and a **small-m (m=12) exact-tail
   case** (F2/F5), plus a **known-answer scorer test (F1)** in which a synthetic dataset with
   obvious lexical degradation must fire the CONFIRMED row under the Δ sign convention above.
2. **Instrument self-check (F9)** — the tier wrapper must reproduce shipped `hybridSearch`
   exactly (same ordered `chunk_id` list, all 200) on **10 probe queries × 4 tiers × 2 arms**
   against each tier's state, **0 mismatches required** (`q1-reserve2.mjs` precedent); H
   probes additionally assert `mode: "hybrid"`.
3. **Arm integrity, per call** — `chunkStore` passed **explicitly** on every call
   (`hybrid.ts:55` loaded-gun default reads the retired Lance chunk table); `mode` recorded
   per call, any H call not returning `mode: "hybrid"` voids that tier's H measurement
   (`hybrid.ts:102-104` swallows embedder failure silently) — re-run after diagnosis, void
   counts reported.
4. **Vector coverage** — `pending_embeddings == 0` in every tier state before that tier's H
   measurement is scored; reported per tier.
5. **Determinism** — seed (153), tier-construction script, query-generator script, and the
   frozen query set (`eval/scale-queries.json`) all committed **before** any measurement.

#### Costs (stated before spending)

- **Full-corpus embed.** Measured 9.6 chunks/s on this host (Apple M2 Pro, node v24.18.0,
  jina-embeddings-v2-base-code fp32, batch 32) over a 500-chunk sample → projected **~4.0 h**
  for 138,440 chunks. The prior 5.88 chunks/s / 7.2 h figure (Stage 4.5) is **not
  overwritten** — both are reported; a 500-chunk sample cannot rule out slowdown on
  pathological chunks or thermal effects over a multi-hour run.
- **Storage.** Content-hash embed cache shared across all four tiers, ≈ 2.16 GB; per-tier
  `vectors.lance` ≈ 526 MB for the full tier (smaller tiers scale down); all four tiers ≈
  4.8–5 GB total; 114 GB free on this host.
- **Tier Phase-1 builds.** The full 8,653-file corpus's Phase-1 (chunk extraction + FTS)
  measured at **577 s** wall clock in this spike; each smaller tier operates over a file
  subset and is expected to be sub-linear in file count, bounded above by 577 s.
- **Measurement volume.** 150 (S-ident) + 100 (S-prose) + 150 (S-approx) = 400 scored
  queries × 4 tiers × 2 arms = **3,200 core searches**, plus 10 probe queries × 4 tiers × 2
  arms = **80 self-check calls** (Gate 2, F9). Minutes to tens of minutes. No agents run; no
  token spend beyond orchestration.

#### Logged deviation — the embed was started before this registration was committed

The full-corpus embed (`eval/embed-full-corpus.mjs` against `vscode-state-full`) was started
**before** this registration was committed, for wall-clock economics: the ~4 h (projected)
critical path dominates every other step in this design, so waiting for the registration
commit to start it would only lengthen the total time to a result. **Direction of error:
none.** Embeddings are deterministic given the model and chunk content; a background embed
run before or after this text is committed produces the identical vectors either arm would
see, and **no search, ranking, or measurement of any kind ran** before this commit. This is
stated so the deviation is auditable, not because it biases anything.

#### Design Reserve (pre-thought, NOT commitments)

An outcome A/B at full scale (the required follow-up if the caveat is confirmed); a
`--no-embeddings` container A/B; shipping D0; a fifth tier at ~30k if the dose–response
curve needs resolution between 15k and 50k; **the directory-based tier partition** as a
sensitivity analysis (promoted only if the primary random-nesting result is challenged or
ambiguous — see Design above); per-directory heterogeneity analysis; **multi-seed T1
sensitivity** — rebuild T1 under 2 extra seeds, Phase-1 only, no new embeds, promoted only
if the result is challenged as a seed artifact.

#### AMENDMENT 1 — 2026-08-02, pre-run, post-adversarial-review

Adversarial review commissioned per the standing §6 rule (Fable agent), against this section
as committed at `80cb9bd`, **before any measurement had occurred**. Per the Q1/OUTCOME
precedent, no data existed, so the registration above was revised in place rather than
appended to; this log is the audit trail. The full review is committed verbatim at
`eval/results/q1-scale-design-review.md`.

Stated plainly, because it is the finding that matters most about the process, not just the
instrument: **of the twelve findings, at least seven ran toward false DISCHARGED — i.e.
toward the investigator's own prior (deletion) — and the sign error (F1) and the inverted
gate (F3) were the investigator's own drafting errors**, not defects inherited from elsewhere.

| # | Finding | Change | Direction the error ran |
|---|---|---|---|
| 1 | Sign contradiction: `D = metric(T4) − metric(T1)` made degradation negative, but the falsification bullet registered "positive" as the pro-vector outcome — a tail swap. | One convention fixed everywhere: `D_loss = in_window@10(T1) − in_window@10(T4)` (positive = degradation), contrast `Δ = D_loss_L − D_loss_H`; all rows restated; Gate 1 gets a known-answer scorer test that must fire CONFIRMED on synthetic lexical degradation. | **False DISCHARGED / verdict swap** — the investigator's own drafting error. |
| 2 | At n=75, the ≤10pp discharge bound is reachable under a true null only in a narrow non-zero corridor (~[10,14]-of-75), colliding with the "<10 non-zero pairs → underpowered" rule, which could route the most informative null (all zeros) to "underpowered." | Discharge keyed on the all-n seeded BCa bootstrap CI (zeros are data); the underpowered rule restricted to the Wilcoxon report only; n raised to 150 (S-ident) — n_min = 154 at p_nz = 0.4. | **Structural, toward perpetual AMBIGUOUS (pro-incumbent)** — collision resolution unknowable. |
| 3 | Gate 5 fired on T1-ceiling, the *ideal* start condition, demoting to Δlog2(rank), which had no registered decision rule — verdict machinery undefined on the modal data pattern. | Old gate deleted. New rule: T4-ceiling-in-both-arms is trivial discharge per stratum, reported with the all-n CI; Δlog2(rank) stays supporting-only, never a verdict. | **Unknowable, resolved post-hoc by the prior** — the investigator's own drafting error. |
| 4 | `dedupShellMethodCollisions` can suppress the target chunk itself in favour of its shell/method counterpart, censoring it at any depth even though production surfaces the survivor with a hint naming the target. | Hit rule extended to count the shell↔method counterpart as a hit at the survivor's rank; PRE-dedup rank logged as a diagnostic; suppression events reported per arm × tier. | **Unknowable, noise concentrated at the largest tiers.** |
| 5 | Hodges–Lehmann is near-meaningless on this support (degenerate `[0,0]` CIs), and the registration never named which CI (HL vs BCa) governs discharge — a loophole. | HL demoted to descriptive; discharge bound is the all-n BCa CI; Wilcoxon required exact, with all-ties and m=12 exact-tail unit tests. | **False DISCHARGED.** |
| 6 | Exact-symbol-name queries are near-unique trigram keys, largely insensitive to distractor mass — the hot stratum plausibly flatters the null. | New supporting stratum S-approx (symbol name replaced by its split words, same rare-word suffix, paired to S-ident targets); discharge language scoped to "exact-identifier retrieval." | **False DISCHARGED.** |
| 7 | "Rare" was undefined; computing rarity against T4 would exclude exactly the terms whose T1→T4 sensitivity the experiment measures. | Rarity defined as DF over T1's index only; numeric threshold (DF ≤ 50), deterministic tie-break, stopword handling, symbol-only fallback, all committed with the generator. | **False DISCHARGED**, had rarity been computed T4-side. |
| 8 | No tier-integrity gate, despite the corpus-truth correction already surfacing an index-integrity defect; an out-of-tier vector leak would silently eat H-only candidate slots. | New Gate 0: per-tier chunk count == manifest, `write_errors == 0`, `vectors.lance` row count == tier chunk count, anti-join proves zero out-of-tier vectors. | **Both directions** — missing chunks toward false DISCHARGED, vector leakage toward false CONFIRMED; severity-zero class either way. |
| 9 | Gate 2's self-check named no depth or arm; a wrapper diverging only past rank 10, at the pool boundary, or only in H's embedder wiring could pass a shallow, L-only probe. | Self-check widened to 10 probes × 4 tiers × 2 arms at limit=200, full ordered-list comparison, H probes assert `mode: "hybrid"`. | **Unknowable.** |
| 10 | "Material inconsistency" and the monotonicity check had no registered thresholds — a post-hoc lever; the verdict language overreached what target-rank retrieval evidence supports. | Verdict reworded to "discharged at target-rank retrieval level; residual channels accepted by decision, not evidence"; three concrete consistency triggers registered. | **False DISCHARGED.** |
| 11 | The 14,529 absent chunks are deterministically the two most extreme, most repetitive files — plausibly the most BM25-stressing distractor mass — and were absent from the external-validity limits. | One limits bullet added: measured at 138,440 chunks; the absent tail is excluded distractor mass the 153k cost basis prices in. | **Weakly false DISCHARGED.** |
| 12 | "Applied verbatim" was impossible — `build-normal-set-r2.mjs` hardcodes kluster targets/paths; its rule also prepends the split symbol name, so S-prose is identifier-led too, a fact the wording obscured. | Reworded to "derivation rule ... applied by a new committed generator"; noted both S-prose and S-ident are identifier-led, which is why the comparability claim survives. | **Mislabel, no verdict path.** |

The reviewer's SOUND list and withdrawn items — including the recomputed 497→472 pool
correction — are recorded in full in the committed review file,
`eval/results/q1-scale-design-review.md`.

#### Q1/SCALE RESULT (2026-08-02) — lexical degrades with scale where hybrid does not; the caveat is real, and it is marginal

**Gates — all green.** Gate 0(a)/(b) pre-satisfied (Phase-1 built, `write_errors == 0` on
T1–T3, chunk counts match the frozen manifest: 15,003 / 49,998 / 89,989); Gate 0(c)/(d)
(per-tier `vectors.lance` row count == chunk count, 0 out-of-tier vectors) green on T1–T3 at
run time. Gate 1: full suite **455/455** (36 files), including the 73 instrument tests
(Wilcoxon exact known-answer cases, the all-ties and m=12 exact-tail cases, the synthetic
CONFIRMED-firing scorer test). Gate 2: instrument self-check **80/80** (10 probes × 4 tiers ×
2 arms), **0 mismatches**, under the AMENDMENT-1-widened criterion (full ordered 200-row
comparison, H probes asserting `mode: "hybrid"`); `h_mode_assertion_pass: true`. Gate 3: **0
mode-integrity violations** across all **3,200** core searches (400 queries × 4 tiers × 2
arms; `mode_integrity_bad_count: 0` in every cell). Gate 4: `pending_embeddings == 0` on all
four tier states (T1–T4). **Two gate-evidence deviations were found post-hoc by the
adversarial results review — not by this measurement run — and both are closed; see Section
B (AMENDMENT 2) for the finding and the closure.**

**Verdict, mechanically selected from the pre-committed table: row 1 — SCALE CAVEAT
CONFIRMED.** Decision-bearing stratum S-ident, exact Wilcoxon signed-rank on 16 non-zero
pairs (13 positive / 3 negative), W = 25.5, **p = 0.021270751953125**, direction positive
(lexical degrading more). All-n seeded BCa bootstrap 95% CI (10,000 resamples) on Δ:
**θ̂ = +6.7 pp, [+1.3, +11.3]**, excludes zero. No consistency trigger fired (S-approx and
S-prose supporting CIs both straddle zero; Δlog2(rank) CI [−0.015, +0.285] also straddles
zero but is directionally consistent; no monotonicity flags). T4-ceiling trivial-discharge
did not trigger for any stratum (S-ident H = 140/150 < the 143 threshold).

**Headline table — `in_window@10`, per stratum × arm, T1 → T4 (of n):**

| stratum | arm | T1 | T2 | T3 | T4 | T1→T4 loss |
|---|---|---|---|---|---|---|
| S-ident (n=150) | H | 149 | 146 | 140 | 140 | −9 |
| S-ident (n=150) | L | 145 | 135 | 128 | 126 | −19 |
| S-approx (n=150) | H | 146 | 139 | 135 | 129 | −17 |
| S-approx (n=150) | L | 143 | 136 | 132 | 126 | −17 |
| S-prose (n=100) | H | 97 | 96 | 93 | 92 | −5 |
| S-prose (n=100) | L | 94 | 89 | 87 | 82 | −12 |

**Dose–response shape:** H plateaus T3→T4 (S-ident 140→140 flat, T2→T3 already the steepest H
drop at −6); L declines monotonically across all four tiers on S-ident, steepest T1→T2
(145→135, −10) and continuing to erode every tier thereafter (−7, −2). The curve is
consistent with "more distractor mass keeps eroding lexical's trigram signal" and with
"hybrid's vector half stops the bleeding once the exact identifier anchors a declaration
embedding" — see the mechanism finding below.

**The four required caveats from the adversarial results review, at full strength — this
row's survival is conditioned on stating them, not on omitting them:**

1. **Hit-rule sensitivity.** p = 0.021 under the registered (post-dedup + shell/method
   counterpart) hit rule; **p = 0.09625 → AMBIGUOUS** under the pre-amendment,
   target-chunk-only rule (13+/5−, CI [−0.0067, +0.1067]); p = 0.04139 under the pre-dedup
   chunk-id rank (dedup-free, 15+/5−, CI [+0.0067, +0.1200]). **The AMENDMENT-1 hit-rule
   extension (F4) is load-bearing for CONFIRMED-vs-AMBIGUOUS.** Its three added positive
   pairs are corroborated, not manufactured, by the dedup-free pre-dedup ranks: s_ident_95
   (ScanCodeChord) L degrades T1→T4 8→53 vs H 4→21; s_ident_103 (KeyCodeChord) L 17→138 vs H
   5→27; s_ident_104 (ModelPickerWidget) L 14→85 vs H 1→6. **No variant discharges** — the CI
   upper bound is 0.107–0.120, above the 10 pp bound, in all three.
2. **Magnitude.** θ̂ = +6.7 pp, CI [+1.3, +11.3] pp, is **below the registration's own 10 pp
   materiality line at the point estimate**. Row 1 fires on statistical significance alone;
   it has no magnitude gate. "Confirmed" here means direction, not established
   outcome-relevance.
3. **The registered consistency triggers guard only the discharge branch** — no supporting
   result could ever have demoted CONFIRMED (a structural pro-CONFIRMED asymmetry, the mirror
   image of the pro-DISCHARGE asymmetries AMENDMENT 1 fixed in the design). On the data,
   support does not corroborate: S-approx Δ is **exactly zero** (9+/9−, CI [−0.06, +0.053]);
   S-prose is directionally consistent but not significant (12+/5−, p = 0.144, θ̂ = +7 pp, CI
   [−0.02, +0.14]); Δlog2 CI includes 0. **A symmetric registration would plausibly have read
   AMBIGUOUS.** Stated plainly: CONFIRMED and AMBIGUOUS route to the same next action here
   (§ below), so nothing practical rides on which label is used — but the write-up must not
   claim the cleaner verdict without carrying this note.
4. **Sign-test equivalence and near-twin dependence.** The "exact Wilcoxon" is, on this data,
   exactly a two-sided sign test on 16 unit-magnitude ties (W = 3 × 8.5 = 25.5, p = binomial
   1394/65536). Two of the 13 positives (s_ident_95/103 — ScanCodeChord/KeyCodeChord) share a
   file (`src/vs/base/common/keybindings.ts`) and an identical rare-word suffix, so they are
   not fully independent evidence; **collapsing them still gives p = 0.0352** (12+/3− of 15).
   The 13 positives are otherwise dispersed across 9 distinct top-level directories.

**The mechanism finding (descriptive, verified in code).** Hybrid's scale protection exists
**only when the exact identifier is in the query.** S-approx (identifier replaced by its
split words) degrades both arms equally (−17 each); S-ident (exact identifier present)
degrades H by only −9 against L's −19. Read in code: the shipped `hybridSearch`'s lexical
path (`src/search/hybrid.ts`) consults only trigram `chunk_fts` for ranking. `identifier_fts`
exists (`searchIdentifiers` / `searchIdentifierNearMiss` in `src/search/fts.ts`) but is **not
part of the search ranking** — exact symbol names have no exact-token lexical anchor, and
their trigram profile dilutes as the corpus grows, while the vector arm anchors on the
declaration's embedding regardless of corpus size. F6's masking hypothesis (exact-name
queries are near-unique trigram keys, insensitive to distractor mass) is **empirically
falsified, not subverted by an artifact** — paired-row inspection confirms the pattern (e.g.
S-approx s_ident_73: H rank 2→64 T1→T4; s_ident_103: H rank 3→20).

**Consequence — the natural next lexical lever, stated as a Design Reserve addition, NOT a
commitment.** An `identifier_fts` ranker folded into the RRF fusion could plausibly
neutralize the S-ident scale degradation without vectors — the F15 lesson ("one lexical line
more than halved the measured value of vectors") applied at scale. If that lever works, the
delete arm re-opens; if it fails, vectors have a defensible scale niche. This is queued, not
committed — see §4 of `HANDOFF_Q1.md`.

**Ceiling-asymmetry channel — checked, runs the OTHER way.** Base-rate asymmetry ≈ −0.3 pp
toward discharge: L's T1 out-of-window queries all worsened further at T4, a floor D_loss
cannot see (it is a binary in/out metric) — the measured Δ is therefore conservative, not
inflated. The rank co-metric agrees in direction: mean log2(rank) shift H +0.584, L +0.717.

**What this licenses, per the registered rule.** The 14.5k null does **not** extend to 138k
at retrieval level. **Q1 stays OPEN. M2's delete arm stays BLOCKED.** The pro-vector path
still requires an outcome test at scale (Reserve, expensive) — retrieval-rank movement was
already shown not to imply outcome movement (Q1/OUTCOME). The pro-deletion path now requires
**either** that outcome test showing outcome-insensitivity at scale, **or** the
`identifier_fts` lexical lever neutralizing the degradation (cheap, queued first). External
validity limits carried from the registration: measured at 138,440 chunks, absent the
14,529-chunk whale-fixture tail; queries are TSDoc-hot by construction, not agent-authored;
single corpus, single host.

#### AMENDMENT 2 — 2026-08-02, POST-scoring, after adversarial review of the results

Unlike Amendment 1 (pre-run), these corrections were made **after** seeing results, so each
states which direction the error ran. All were found by a commissioned Fable review of the
scored result (committed verbatim at `eval/results/q1-scale-results-review.md`), not by me.
**None flips the registered row** — the review's overall verdict is "row 1 survives, with
required caveats" (see the four caveats in the RESULT section above).

| # | Error | Direction it ran |
|---|---|---|
| 1 | **Gate 4 ran ~2.5 min AFTER scoring** (04:22:34Z vs scoring at 04:20:05Z); the registration required Gate 4 before scoring. | Toward false DISCHARGED — a coverage gap at scoring time would have depressed H's measured window membership. Closed post-hoc: coverage was in fact `pending_embeddings == 0` on all four tiers at the time scoring ran; the gate result did not change between the two timestamps. |
| 2 | **Gate 0(c)/(d) never ran on T4**, and T4 reused the pre-registration full index, which carries `write_errors: 2` (the two known whale fixtures) — apparently inconsistent with Gate 0(b)'s exclusion wording. | Toward false DISCHARGED. Closed by the review's direct counts on `vscode-state-full`: **138,440 vectors, 138,440 distinct chunk_ids, 0 duplicates, 0 out-of-tier** by full anti-join; T1–T3 counts match the frozen manifest. The `write_errors: 2` is the pre-registered, arm-symmetric whale-fixture absence (F11), not a new defect — it affects both arms identically. |
| 3 | **The committed instrument shipped without working CLI entry points** — `scale-rank-check.mjs` and `scale-score.mjs` document a scored-sweep/self-check/scorer invocation in their own header comments but expose no CLI to run it; measurement instead ran through three runner-authored driver scripts (`scale-run-selfcheck.mjs`, `scale-run-measure.mjs`, `scale-run-score.mjs`, committed at `8868404`). | No direction found. The review audited the drivers line-level and found them faithful: `limit=200`, `rrf_k=60`, explicit `chunkStore`, correct embedder wired per arm, seed 1001 pre-committed before any measurement. |
| 4 | **`runSelfCheck`'s mismatch counter under-counts** — it excludes reconstruction failures and mode-integrity failures from its own tally; the runner computed the AMENDMENT-1-widened criterion externally to get Gate 2's reported 80/80. | Anti-false-pass (the widening is stricter, not looser) — but this is a latent instrument defect: fix `runSelfCheck` to count what Gate 2 actually requires before this instrument is reused. |
| 5 | **`query_id`, the Δlog2 aggregate, and the monotonicity CI formula were runner constructions**, under-specified by the registration text itself. | Reviewed directly: deterministic, follows the committed F1 sign convention, seed-insensitive (200/200 alternative seeds agree), and zero-flags robust (no CI approximation could change which monotonicity flags fire). No direction found. |

The hit-rule sensitivity (F-R1) and the magnitude framing (F-R2) from the review are carried
in the RESULT text above, not repeated here. The review's structural finding — **the
registered consistency triggers guarded only the branch the investigator's own prior
(deletion) argued against** — is an asymmetry to make symmetric in any future registration on
this track, the same lesson AMENDMENT 1 already applied to the discharge branch.

## HANDOFF — operational state for the Q1/M2 track (2026-08-01)

Everything above records *reasoning*. This records *state*, which is otherwise only in
one session's head. Read this before running anything.

### Off-repo state (none of it is in git)

| path | what | rebuild cost |
|---|---|---|
| `~/.cache/mast-eval/corpus-kluster` | git worktree, kluster @ `07d705b` | seconds |
| `~/.cache/mast-eval/corpus-nest` | git worktree of `~/temp/mast-bench/nest` @ `f7fffd6` | seconds |
| `~/.cache/mast-eval/base-state-r2` | kluster corpus, **10,943 chunks, 100% embedded** | 13 s index + **~30 min embed** |
| `~/.cache/mast-eval/base-state-nest` | nest corpus, **4,994 chunks, 100% embedded** | 4 s index + **~14 min embed** |
| `~/.cache/mast-eval/model-cache` | jina ONNX weights (627 MB) | 627 MB download |
| `~/.cache/mast-eval/results/` | `q1-final-fullembed.json` ← **the authoritative result** | — |

**The embeds are the expensive asset — ~45 min of compute. Do not delete these dirs.**
Remove the worktrees with `git worktree remove <path>` (from the owning repo), never `rm -rf`.

### Env vars

- `MAST_EVAL_STATE` — overrides `BASE_STATE_DIR` in `paths.mjs`. **Required** for every
  script except `q1-nest-replication.mjs` (which hardcodes its own paths).
- `MAST_EVAL_R2=1` — makes `build-corpus.mjs` apply the source-doc excludes. Without it
  you rebuild the **leaky v1 corpus**.

### Script inventory (`eval/`) — `eval/README.md` is STALE and documents only the old N1 bake-off

| script | status |
|---|---|
| `q1-final.mjs` | ✅ **authoritative** — full embeds, unified matcher, paired CIs |
| `embed-full-corpus.mjs` | ✅ embeds every chunk in `$MAST_EVAL_STATE` |
| `build-normal-set-r2.mjs` | ✅ builds `gold-set-normal-r2.json` (TSDoc-derived) |
| `q1-nest-replication.mjs` | ⚠️ `build`/`embed` still useful; its `score` is **superseded** by `q1-final.mjs` (subset-based, strict-symbol matcher) |
| `q1-vector-value.mjs` | ⚠️ **superseded** by `q1-final.mjs`; kept for the void-run audit trail |
| `f16-rrf-sweep.mjs` | ⚠️ ran pre-full-embed; its conclusion is void (see F16 closure) |
| `build-normal-set.mjs`, `extract-normal-candidates.mjs` | ❌ **v1, VOID** (in-corpus leakage). Kept only as the record of the failure |
| `corpus-subset.json`, `corpus-subset-nest.json` | ❌ **stale** — the 3,000-chunk subsets, bypassed by full embedding. Do not reuse; they carry the needle-seeding bias. |

### Reproduce the authoritative result

```bash
cd packages/mast && pnpm build
node eval/q1-final.mjs        # ~2 min, needs the two base-state dirs above
```

### ⚠️ Uncommitted work — the real handoff risk

Nothing in this track is committed. **`src/search/fts.ts` (F15) is a shipped
behavioural change** sitting in the working tree alongside its tests
(`src/search/__tests__/fts-query.test.ts`), plus ~20 eval files and the edits to
`gold-set.json` / `paths.mjs` / `build-corpus.mjs` / `verify-gold.mjs` / `make-subset.mjs`.
Verified green at the time of writing: **382 tests / 34 files, `tsc --noEmit` clean,
eslint clean.** Commit F15 separately from the eval harness — it is the only change that
alters product behaviour.

### Next action (do not skip to A-vs-C)

1. ~~**Identifier-decomposition reserve arm**~~ — **DONE 2026-08-02**, pre-registered at
   commit `755e5fb`. Stop rule fired: decomposition-as-a-fused-ranker is a **regression**
   ((L+D)−L = −0.1661, t=−2.333 on kluster-normal; Recall@10 1.000 → 0.727). See
   "Q1/RESERVE RESULT" above.
2. ~~**RESERVE-2 — second-COLUMN construction**~~ — **DONE 2026-08-02** (registration `debeeb7`). Decomposition tested in both constructions across two tokenizers; does not live, reserve discharged. Old text: The Reserve
   specified a second FTS *column* (one joint `bm25()`); I built a second *table* (RRF
   fusion), and RRF vote-dilution is what caused the harm. The deviation runs **toward the
   incumbent**, so leaving it unrun repeats the original violation. Also fix the canary's
   symbol resolution (line-addressed targets yield no symbol to strip).
3. Real-query harvest via `metrics.args_json` — **the only instrument that can resolve
   Q1**; the reserve arm's registered authority limit forbids it justifying vectors. Write
   path verified working; n=1 today, needs ≈67 for 80% power at the observed variance.
4. Equalise arm V through `hybridSearch`'s pipeline (review finding 5). **Now cheap:** the
   validated N-ranker pipeline in `q1-reserve-decomp.mjs` (self-check 0 mismatches, exact
   reproduction of `q1-final`'s H−L) is the vehicle — arm V becomes `rankers: ['vec']`.
5. Answer pre-registered Q4/Q5 (practical significance) — note kluster arm L
   **Recall@10 = 1.000**.
6. Only then reconsider M2's A-vs-C.

---

### Q4 RESULT (2026-08-02) — the win has no nameable class, and the class that matters is absent

Answered from per-query data already emitted by `q1-reserve2.mjs` — no new runs, no new
data, as registered. Queries were split mechanically on whether they contain a code
identifier (CamelCase / snake_case / dotted), and separately at the median word count.

| class | n | H−L | 95% CI | t | sig |
|---|---|---|---|---|---|
| pure prose (pooled, 3 sets) | 57 | +0.1264 | [+0.061, +0.192] | 3.95 | **yes** |
| identifier-bearing (pooled) | **2** | +0.1577 | [−0.167, +0.483] | 1.00 | no |
| short queries (≤ 11 words) | 32 | +0.1250 | [+0.024, +0.226] | 2.56 | yes |
| long queries (> 11 words) | 27 | +0.1303 | [+0.055, +0.206] | 3.54 | yes |

**Answer to Q4: no.** Within the range these gold sets cover, hybrid's advantage is
*flat* — indistinguishable between short and long queries (+0.125 vs +0.130), and uniform
across prose. There is no sub-class to point at and say "this is what vectors are for."

**🔴 The structural finding, which outranks the answer.** Only **2 of 59** gold queries
across all three sets are identifier-bearing. **97% of the entire Q1 ranking evidence base
is pure prose.** That is not a property of code search; it is a property of how these sets
were built — every one is TSDoc/plan-prose derived. So:

- Q4 **cannot be answered for the query class that matters most** from existing data. The
  identifier arm is n=2 with a CI four times wider than the effect.
- This independently corroborates the harvest's n=2 hypothesis from the other direction:
  real queries are identifier-bearing (both harvested rows; median 5 words), and the
  Q1/OUTCOME runs confirmed it behaviourally — **0 of 147** agent searches reused the
  question's prose wording; every one was rewritten into code-token shorthand.
- Therefore the measured H−L advantage is established *on a query class agents demonstrably
  do not use*. That does not make it wrong, but it does mean **the ranking evidence base and
  the production workload are disjoint on the one dimension we can measure.**

Q4 is CLOSED as "not answerable from synthetic sets; requires the harvest." It joins
Q1/OUTCOME and arm V as a third independent line arriving at the same place: ranking
metrics on prose gold sets cannot settle Q1.

### Q1-v2 HARVEST — re-checked 2026-08-02, still n=0

```
rows_with_args=2  searches=2  self_ref=2  organic=0  chain_labelled=0
POWER: have 0 / need ~67 -> INSUFFICIENT
query shape (all n=2): identifier-bearing=2  median_words=5
```

Unchanged. **The 30 Q1/OUTCOME runs did not help**: they wrote to the A/B harness log, not
to `metrics`, because `ab-search.mjs` calls `hybridSearch` directly and deliberately skips
the MCP tool's telemetry path. That was correct for the experiment (telemetry writes would
have contaminated the frozen snapshot) but it means the organic counter did not move.

**Q1's remaining cost is still elapsed real usage of MAST for non-MAST work** — the same
blocker as 2026-08-01, now with Q4 showing exactly why it matters: the harvest is the only
instrument that can supply identifier-bearing queries, which is the only class the ranking
evidence lacks.

---

