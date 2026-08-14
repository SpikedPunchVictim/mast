# E1-FTS DESIGN REVIEW (2026-08-14) — adversarial review, pre-registration stage

Reviewer: independent adversarial pass, conducted before any E1-FTS code exists.
Everything below was verified against the bundled amalgamation
(`node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/deps/sqlite3/sqlite3.c`,
SQLite 3.53.2, resolved at the **repo root**, not under `packages/mast` — the pnpm store hoists it),
the retained rung databases under `~/.cache/mast-eval/e1/` (opened plain readonly, never immutable),
and the published run records. Line numbers `sqlite3.c:N` refer to that file.

---

## VERDICT

**Do not run E1-FTS as designed.** The design is aimed at the wrong FTS5 mechanism, and its primary
instrument has a timer boundary that systematically miscounts the mechanism it names. The registered
hypothesis — LSM-style segment-merge amplification — is contradicted by the merge scheduler in the
amalgamation itself: FTS5's automerge does incremental work proportional to (leaves flushed ×
level count), which is amortised **O(N log N)** and cannot produce b ≈ 1.97, cached or not. Meanwhile
a one-hour readonly probe of the five retained rung databases, run for this review, identifies a
different FTS5 mechanism that predicts the measured write times outright: the per-file
`DELETE FROM chunk_fts WHERE file_path = ?` (and its `identifier_fts` twin) compiles to a **full
table scan** — FTS5's `xBestIndex` cannot consume an EQ constraint on an ordinary column — so every
file pays a scan of all FTS content written so far, an exactly O(N²) term that matches
`b_write = 1.9685`, reproduces T5–T9 write times to within 3% under a pure `N·F` model, and on a
cold build deletes **zero rows** — it is pure waste. This mechanism also retro-explains E1-AB's
cache dose-response and the mmap tripwire without invoking merge at all. The experiment is still
worth running, but redesigned: statement-granular decomposition (`fts_del` / `fts_ins` / `commit` /
`rest`, each timed directly), and the confounded arm F replaced by an arm that skips only the no-op
deletes — which leaves the final database byte-identical and is therefore the confound-free causal
intervention the proposal says cannot exist.

---

## FINDINGS

### F1 — BLOCKING — the registered mechanism (segment merge) cannot produce the observed exponent; FTS5's merge schedule is amortised log-linear

Category (a): the motivating claim is factually wrong about what the code can do.

The proposal's mechanism is "merge volume grows with accumulated segment count, which grows with
corpus size." The scheduler says otherwise:

- `fts5IndexAutomerge` (`sqlite3.c:255626-255645`): after a flush writes `nLeaf` level-0 leaves,
  merge work is `nRem = nWorkUnit * nWork * pStruct->nLevel`, where `nWork` is the number of
  64-leaf work-unit boundaries the write counter crossed (`FTS5_WORK_UNIT = 64`,
  `sqlite3.c:250651`, installed at `:257481`). Work per flushed leaf is therefore
  **∝ nLevel**, and `nLevel` grows logarithmically in total volume (levels are added only by
  promotion, `fts5StructurePromote`; capped at `FTS5_MAX_LEVEL = 64`, `:250661`).
- `fts5IndexCrisismerge` (`:255647-255663`) fires only when a level accumulates
  `nCrisisMerge = 16` segments (`FTS5_DEFAULT_CRISISMERGE`, `:245622`) — a safety valve, and its
  triggering frequency also falls geometrically with level.
- Total merge work over a build of L total leaves is therefore Σ(leaves × levels) ≈ L·log(L) —
  the classic LSM amortisation. Over E1's 19.94× range, an O(N log N) component adds roughly
  +0.05–0.1 of apparent exponent, not +0.9.

Combined with E1-AB's own Claim 2 — slope 1.7127 with a 1 GiB cache, eviction physically
impossible — a CPU-side O(N log N) merge cannot carry the excess exponent. The design's registered
success condition ("if b_fts ≈ 1.9 … the mechanism is identified") would, on the merge hypothesis,
have been **unreachable for the reason the author didn't check**, and any b_fts ≈ 1.9 that did
appear would have been silently attributed to the wrong FTS5 subsystem. See F2.

**Change required:** re-write the hypothesis section. Merge is a minor, log-linear contributor by
construction; it is not a candidate for the exponent and must not be named as the mechanism under
test.

### F2 — BLOCKING — the actual FTS5 mechanism is the per-file DELETE full-scan: O(N²), verified in source and reproduced numerically against the retained databases

Category (a)+(c): the design misses the mechanism that the evidence, once checked, points at directly.

`populateFile` issues, per file, `DELETE FROM chunk_fts WHERE file_path = ?` and
`DELETE FROM identifier_fts WHERE file_path = ?` (`src/graph/populate.ts:318-319`). `file_path` is
UNINDEXED in both DDLs (`src/graph/db.ts:294`, `:301`). FTS5's `xBestIndex`
(`fts5BestIndexMethod`, `sqlite3.c:260775-260860`) consumes only: MATCH constraints, EQ on rowid
(`iCol<0`), rowid range constraints, and LIKE/GLOB pattern constraints via `fts5UsePatternMatch`
(`:260686`). **An EQ constraint on an ordinary column is never consumed** — SQLite core receives a
full-scan plan (`estimatedCost = 3000000.0`, `:260925`) and filters row by row, which forces every
content-shadow-table row (including the full chunk text, stored first in the record) to be
materialised per candidate row.

Verified empirically on the retained T9 database (readonly, not immutable):

```
EXPLAIN QUERY PLAN SELECT count(*) FROM chunk_fts WHERE file_path = ?
→ "SCAN chunk_fts VIRTUAL TABLE INDEX 0:"        (identifier_fts identical)
```

Timed scan probes (best of 3, warm OS cache) across all five retained rung databases
(`~/.cache/mast-eval/e1/phase-run-{T1,T3,T5,T7,T9}-r3/graph.db`), with the cold-build prediction
`files × (scan_chunk + scan_ident)/2` (content grows ~linearly, so the average scan is half the
final one):

| rung | files | scan chunk_fts | scan ident_fts | predicted write | measured write (median) | share |
|---|---|---|---|---|---|---|
| T1 | 656    | 0.6 ms  | 0.4 ms  | 0.36 s  | 1.45 s  | 25% |
| T3 | 1,393  | 1.7 ms  | 0.9 ms  | 1.8 s   | 4.56 s  | 40% |
| T5 | 2,880  | 8.4 ms  | 1.9 ms  | 14.8 s  | 23.7 s  | 63% |
| T7 | 5,976  | 20.0 ms | 9.7 ms  | 88.7 s  | 97.7 s  | 91% |
| T9 | 13,330 | 40.1 ms | 21.0 ms | 407.3 s | 500.9 s | 81% |

A rising share with N is precisely the signature of the component that carries the exponent, and it
explains E1-AB's curvature (`b_lo(A) = 1.7629`, `b_hi(A) = 2.1197`) as the quadratic term's share
growing. A two-term least-squares fit `write = a·N + b·(N·F)` on the five E1-PHASE medians
reproduces T5/T7/T9 as 20,532 / 100,442 / 500,466 ms against measured 23,725 / 97,660 / 500,885 ms
— the top rung to 0.1%.

The mechanism also retro-explains E1-AB without merge: the scan is pure **read-cursor** traffic
(`PAGER_GET_READONLY`, `sqlite3.c:77889`) over ~127 MiB of content shadow tables at T9 — cache-size
dose-responsive (arm B) and mmap-eligible inside a write transaction (arm C), the same two
observations the E1-AB RESULT attributed to "FTS5 segment merge reads". Segment merge reads via the
blob handle are real, but the scan traffic is 1–2 orders of magnitude larger.

And the sharpest fact: **on a cold build every one of these deletes matches zero rows** (probe
confirms `rows matched 0`; files are new, so no FTS rows exist). The dominant cost of a cold T9
index is, with high probability, scanning ~400 GB of logical row data to delete nothing.

**Change required:** re-register the experiment around H-DELETE-SCAN. The prediction is
quantitative and falsifiable: `b_fts_del ≈ 2`, `fts_del` share of write rising with N to ≳60% at
T9, `fts_ins` and `rest` near-linear. (The probe numbers above are motivating priors from a warm,
readonly, out-of-transaction instrument — publish them as such, not as the registered result.)

### F3 — BLOCKING — the proposed `fts_ms` timer boundary misses all segment-write and merge work, which lands at COMMIT, outside `populate.ts:318-342`

Category (b): the sites are correctly identified as the only FTS5 *statements*, but FTS5 does not do
its index-writing work inside them.

- Inserts tokenize into an in-memory hash; nothing touches `%_data` unless the pending hash
  exceeds `nHashSize` = 1 MiB (`sqlite3Fts5IndexBeginWrite`, `sqlite3.c:257391-257404`;
  `FTS5_DEFAULT_HASHSIZE`, `:245623`) or rowids regress (they don't here — per-table rowids are
  monotone within the transaction).
- The flush — segment write, then `fts5IndexAutomerge` and `fts5IndexCrisismerge`
  (`fts5FlushOneHash` return path, `:256407-256408`) — otherwise happens at **xSync**:
  `fts5SyncMethod` (`:262278`) → `sqlite3Fts5FlushToDisk` → `sqlite3Fts5StorageSync` (`:265544`)
  → `sqlite3Fts5IndexSync` (`:257419`) → `fts5IndexFlush`. `xCommit` is explicitly a no-op whose
  comment says the work was already done by `fts5SyncMethod` (`:262302-262308`).
- xSync fires during COMMIT processing of the enclosing transaction — i.e. inside the raw
  `commit` at `src/graph/populate.ts:181`, which the proposed `fts_ms` span does not cover.

Most files' pending data is under 1 MiB, so **nearly all insert-side FTS index construction would
be booked into `rest_ms`** — exactly the false-null direction the proposal worried about, and it is
structural, not incidental. (Under F2 this mostly deflates `fts_ins`, not the headline, but an
instrument with a known systematic miscount must not be registered as "confound-free".)

**Change required:** time the COMMIT (`populate.ts:170/181`) as its own span. FTS flush+merge cost
is `commit_ms` minus the b-tree page-flush share; it cannot be isolated further without patching
SQLite, so register `commit_ms` as "contains FTS flush+merge plus pager commit" and interpret
accordingly.

### F4 — SUBSTANTIVE — cut arm F; the confound-free causal arm exists and is strictly better: skip only the no-op DELETEs

Category (c) as proposed; fixable.

The proposal is right that arm F (skip all FTS writes) confounds "FTS work removed" with "database
69% smaller", and right that the confound flatters a positive result. But the conclusion "therefore
decomposition must be primary and the arm is merely a bounded check" concedes too much. Because the
cold-path deletes match zero rows (F2), **an arm G that skips only `populate.ts:318-319` produces a
byte-identical final database** — no rows removed, no FTS state touched, identical inserts,
identical merges. E1-AB's `db_bytes` byte-identity gate applies verbatim as arm G's validity gate.
Arm G removes exactly the hypothesised mechanism and nothing else. It converts the experiment from
correlational (a timer decomposition can still be confounded by shared-resource coupling — e.g.
scans evicting pages that other statements then re-fault) to causal.

The internal-consistency gate also only works with G: `write(A) − write(G)` measures the same
quantity as `fts_del_ms(A)`. As registered — `write(A) − write(F)` vs `fts_ms(A)` — the gate
compares a size-confounded difference to a commit-miscounting timer; it can fail (or pass) for
reasons that have nothing to do with the instrument being "wrong", making its registered meaning
unfalsifiable. That is the Priority-3 construction flaw, resolved by G.

**Change required:** drop arm F entirely. Add arm G behind a driver flag (same injection style as
E1-AB's `dbOptions`, `src/indexer/index.ts:127-133`). Gates: `db_bytes(G) == db_bytes(A)` per rung,
and `|(write_A − write_G) − fts_del_A| ≤ 0.15 · fts_del_A` at T7 and T9, within-block pairs (15%
justified below, F8).

### F5 — SUBSTANTIVE — one `fts_ms` span cannot discriminate the mechanism; time four spans directly, none by subtraction

The registered analysis fits one `b_fts`. Under F2 the FTS cost is two populations with different
exponents: delete-scan (predicted b ≈ 2) and insert/tokenise (predicted ≈ linear, its flush booked
at commit per F3). A single span yields a blended exponent whose value depends on the rung range —
uninterpretable drift built into the primary statistic. Time separately, each by direct
start/stop stamps: `fts_del_ms` (`populate.ts:318-319`), `fts_ins_ms` (`:321-344`), `commit_ms`
(`:170-181`, BEGIN+COMMIT), `rest_ms` (everything else in the write span, timed directly, not
derived). Registered tiling gate: `(fts_del + fts_ins + commit + rest) / write ≥ 0.95` per run —
the analogue of Gate P (`eval/e1-phase-schedule.mjs:32`, `GATE_P_FLOOR = 0.95`); since the spans
tile the same loop the realised value should sit ≥ 0.99, and the 0.95 floor is inherited rather
than re-derived. `rest_ms = write_ms − fts_ms` as proposed is the wrong construction: it makes the
tiling untestable and silently absorbs every uninstrumented cost into the null side.

### F6 — SUBSTANTIVE — Priority-5 failure modes, enumerated against the redesign

1. **`chunks` (92.3 MiB) carrying the exponent, read as a null.** Real risk in the original
   design; contained in the redesign because `rest_ms` is timed directly and fitted. Note
   `chunks.chunk_id` is a TEXT primary key — if chunk ids are hash-like, its autoindex takes
   random-order inserts, a plausible second-order super-linear term under cache pressure. Register
   the outcome taxonomy now: FULL (b_fts_del ≥ 1.6 and b_rest ≤ 1.35), PARTIAL (b_fts_del ≥ 1.6
   and b_rest > 1.35), NULL (b_fts_del < 1.6). PARTIAL must be reachable, not treated as failure.
2. **Coarse ladder missing the T5→T9 localisation.** The scan share rises from 25% to ~85% across
   the ladder; a 3-rung design would fit a blend and lose the curvature check (`b_lo` vs `b_hi`)
   that corroborated E1-AB. Five rungs minimum (see F9).
3. **`rho_D(T9) = 0.8486` contamination.** The decomposition runs at control pragmas only, so the
   anomaly's lever (cache size) is never moved: no contamination path into this experiment. The
   anomaly itself remains unexplained — the scan mechanism does not obviously produce a
   faster-with-smaller-cache non-monotonicity (SPECULATION either way), so it stays open as the
   successor-probe target the E1-AB RESULT already named.
4. **Warm-probe prior mistaken for a registered prediction.** The F2 table is from a readonly,
   out-of-transaction, OS-warm instrument; in-build scans run inside `BEGIN IMMEDIATE` with a cold
   SQLite cache. If the pre-registration quotes the 81–91% shares as *thresholds*, a true-mechanism
   run could "fail" on instrument mismatch. Register direction and floor (share rising with N,
   ≥ 50% at T9), not the probe's point estimates.
5. **Batch-lock time.** The write span includes `withLock` acquisition per 16-file batch
   (`src/indexer/index.ts:367`); uncontended on a cold build, it lands in `rest_ms` and is
   negligible, but say so in the registration so a reviewer doesn't rediscover it.

### F7 — MINOR — timing overhead is negligible at every rung and cannot bias the slope

Measured on this machine: `Date.now()` ≈ 43.5 ns/call (1e6-iteration microbench). The redesign adds
≤ 8 stamps per file: T1 656 files → ~0.23 ms against a 1,452 ms write phase (0.016%); T9 13,330
files → ~4.6 ms against 500,885 ms (0.0009%). The differential across rungs bounds the slope bias
at < 0.001 — three orders below E1-AB's per-block slope spread (0.0224–0.1236). The Priority-3
concern is quantitatively dead. (Statement-level spans on better-sqlite3 are synchronous on the
main thread; the stamps bracket real work, not event-loop gaps.)

### F8 — MINOR — thresholds, with justification from the existing records

Within-rung write spreads (E1-PHASE control): T1 8.63% (1,414/1,452/1,536), T9 1.49%
(497,485/500,885/504,941). Per-block 3-point slope spreads (E1-AB): A 0.0546, B 0.0224, D 0.1236.
Proposed registered numbers:

- `b_fts_del ≥ 1.6` — inherits E1-PHASE H1's write bar; predicted ~2.0, so ~0.4 of margin against
  a ~0.05 slope spread (≈ 8σ by E1-AB's blocks).
- `fts_del` T9 share of write ≥ 0.50 — probe prior is 0.81; floor set at the point where "carries
  the phase" stops being defensible, not near the prior.
- Arm G: `write_A/write_G ≥ 2` at T9 (predicted ~5) and `b_write(G) ≤ 1.35` (E1's registered
  linearity bar; predicted ~1.1–1.3 with merge's log term). Both fire only on an unmistakable
  effect, per the SLOPE_MATERIAL_DELTA lesson (E1-AB fired by 0.0204 on a bar sold as blunt —
  `eval/results/e1-ab-results-review.md` F3).
- Consistency gate 0.15: T9 write spread 1.5% + T1's worst-case 8.6%, paired within block; 15% is
  ~2× the worst observed within-rung dispersion, so a failure means instrument disagreement, not
  noise.
- Tiling ≥ 0.95 per run (F5). `db_bytes(G) == db_bytes(A)` exact (F4).

None of these can fire vacuously: each has a registered refutation direction, and PARTIAL is a
first-class outcome (F6.1).

### F9 — MINOR — rungs, blocks, runtime (from the retained run records)

Per-block ladder cost, control arm, summing measured medians (`eval/results/e1-phase-runs.jsonl`,
`eval/results/e1-runs.jsonl`):

- 3 rungs (T1/T5/T9): ≈ 565 s/block — saves only ~2 min/block over 5 rungs because T9 alone is
  ~533 s, and repeats E1-AB's no-CI, no-curvature weakness that its own results review criticised
  (`e1-ab-results-review.md:149-150`).
- 5 rungs (E1-PHASE ladder): ≈ 682 s/block → 3 blocks ≈ 34 min.
- 9 rungs: ≈ 1,012 s/block → ≈ 51 min; buys residual degrees of freedom the question no longer
  needs once the causal arm exists.

Arm G predicted from F2's residuals: T9 ≈ 120–150 s duration → G ladder ≈ 170–200 s/block, three
blocks ≈ 9–10 min. **Recommendation: 5 rungs × 3 blocks × 2 arms (A, G), interleaved
Latin-square-fashion within block as E1-AB did — ≈ 45–50 min total plus calibration.** Directly
comparable to E1-PHASE's estimand, supports the b_lo/b_hi split, and the pairing powers the
consistency gate.

### F10 — MINOR — the remaining factual claims in the proposal, checked

- `src/indexer/index.ts:70-75` docblock names the FTS5 candidate: **verified** (the sentence sits
  at lines 74-75 of the `phaseMs` docblock; note it says "scales with chunks rather than with
  database size" — under F2 the true mechanism scales with chunks × files, so the docblock's
  prediction is also superseded, not just untested).
- DDL: `chunk_fts` trigram, `identifier_fts` unicode61 with separators — **verified**
  (`src/graph/db.ts:290-303`).
- dbstat: **reproduced exactly** on the retained T9 db (readonly): chunk_fts_data 147.5 MiB
  (35.2%), chunk_fts_content 89.1 MiB (21.3%), identifier_fts_content 38.3 MiB (9.2%),
  identifier_fts_data 10.8 MiB (2.6%), chunks 92.3 MiB (22.0%), FTS family 68.7%, total 418.8 MiB
  = 439,140,352 bytes, freelist 0. Counts: 13,330 files, 73,359 chunks, 73,359 chunk_fts rows,
  69,875 identifier_fts rows.
- `populate.ts:937-938` (removeDeletedFiles) on the cold path: **does not run.** Cold run ⇒ empty
  previous manifest ⇒ `deleted = []` (`src/indexer/index.ts:264-269`), and the orphan sweep over an
  empty fresh DB yields `[]` (`:284-291`); `removeDeletedFiles` early-returns on an empty list
  (`src/graph/populate.ts:925`). `populate.ts:318-342` plus the commit at `:181` is the complete
  cold-path FTS5 cost surface.
- FTS5 defaults in this build: `automerge = 4`, `usermerge = 4`, `crisismerge = 16`,
  `hashsize = 1 MiB`, `pgsz = 4050` (`sqlite3.c:245619-245623`, applied `:246659-246664`).
  `automerge` is settable 0–64 via `INSERT INTO t(t, rank) VALUES('automerge', N)`; 0 disables
  (guard `nAutomerge>0`, `:255632`); 1 is coerced back to 4 (`:246560`). `crisismerge` ≤ 1 is
  coerced to 16 and clamped to `FTS5_MAX_SEGMENT − 1` = 1999 (`:246585-246587`, `:241975`). It
  cannot be disabled — an `automerge=0` arm still crisis-merges at 16 segments/level. Under F1/F2
  no merge-lever arm is needed.
- Trigram tokenizer: `fts5TriTokenize` (`sqlite3.c:266942-267014`) advances one character per
  emitted token — posting volume ≈ one token per character versus roughly one per word for
  unicode61. That is a **constant multiplier** on volume (and, through it, a log-term increment via
  more leaves/levels). The author's suspicion is confirmed: it moves the curve's constant and the
  merge log factor, and cannot manufacture an exponent. It does, however, multiply the *scan*
  constant too (bigger content+data tables), which is part of why chunk_fts dominates the scan cost.

---

## RECOMMENDED DESIGN

**Question re-registered:** is the per-file FTS5 delete-scan (`populate.ts:318-319`) the mechanism
behind the write phase's super-linear exponent? (H-DELETE-SCAN, superseding the merge hypothesis.)

- **Arms:** A (control, exact production path) and G (identical but the two DELETE statements are
  skipped under a driver-injected flag). No arm F. No pragma arms.
- **Instrumented quantities (arm A and G alike):** `fts_del_ms`, `fts_ins_ms`, `commit_ms`,
  `rest_ms` — four directly-timed spans tiling the write phase; existing `phaseMs` unchanged.
- **Rungs/blocks:** T1/T3/T5/T7/T9 × 3 blocks, both arms interleaved within block. ≈ 45–50 min.
- **Gates:** tiling ≥ 0.95 per run; `db_bytes(G) == db_bytes(A)` per rung; Gate 0/3 inherited from
  E1-PHASE unchanged; fresh binary ⇒ no absolute-time reuse from prior experiments (E1-AB's
  registered consequence applies).
- **Registered outcomes:** MECHANISM_IDENTIFIED iff `b_fts_del ≥ 1.6` AND T9 `fts_del/write ≥ 0.50`
  AND `write_A/write_G(T9) ≥ 2` AND `b_write(G) ≤ 1.35`. PARTIAL iff the decomposition conditions
  hold but `b_rest > 1.35` or the G conditions fail. NULL iff `b_fts_del < 1.6`. Consistency gate
  `|(write_A − write_G) − fts_del_A| ≤ 0.15·fts_del_A` at T7/T9 adjudicates instrument validity,
  not the outcome.
- **Publish the motivating probe** (scan plans + timed scans on the retained rung DBs, F2's table)
  in the registration as prior evidence, clearly marked warm/readonly/out-of-transaction.
- **Product note, out of experimental scope:** if H-DELETE-SCAN confirms, the fix is a guard —
  skip both DELETEs when the file's `files` row did not previously exist (the F12 monotonic-guard
  SELECT at `populate.ts:216-220` already knows) — plus, for the update path, an indexed deletion
  strategy (e.g. external-content FTS5 or a rowid map). That guard is precisely arm G's condition,
  which is why arm G doubles as a fix rehearsal.

## WHAT I COULD NOT VERIFY

- That in-build scan cost matches the warm readonly probe: in-build scans run inside
  `BEGIN IMMEDIATE` with SQLite-cache misses; the probe's 25–91% shares are order-of-magnitude
  priors, not measurements of the build itself. The redesigned experiment measures this directly.
- Any explanation of `rho_D(T9) = 0.8486`. The scan mechanism does not obviously produce it.
  SPECULATION territory; remains the open anomaly.
- Whether `chunks`' TEXT-PK autoindex contributes a second super-linear term (F6.1) — plausible,
  unmeasured; `rest_ms` will answer it.
- The exact point where SQLite core invokes vtab xSync during COMMIT (deep in the VDBE commit
  path); I verified the FTS5 side (`fts5SyncMethod` does the flush, `xCommit` is a documented
  no-op) but did not trace the core call site line-by-line.
- Authorship timing of the `index.ts:70-75` docblock relative to E1-PHASE (not recoverable from the
  file; the plan's narrative supports it).

## WHAT SURVIVED

- The author's dbstat measurement: reproduced to the decimal, all five figures and the 68.7% share.
- "A constant factor cannot produce a super-linear exponent" — and the trigram tokenizer is exactly
  a constant factor on posting volume (with a log-term side effect). The author's own rigour flag
  here was correct.
- The decision to make within-run decomposition primary and to distrust arm F's size confound —
  both correct instincts; the review sharpens rather than reverses them.
- `populate.ts:318-342` as the complete set of cold-path FTS5 *statements* (the commit-time flush
  is the one non-statement cost, F3).
- The E1-AB source finding (write cursors `curPagerFlags = 0` at `sqlite3.c:77886`, read cursors
  `PAGER_GET_READONLY` at `:77889`, FTS5 blob reads read-only at `:251470`) — re-verified and, if
  anything, strengthened: the delete-scan adds a much larger read-cursor population to the same
  mmap/cache-sensitive channel both E1-AB arms responded to.
- Timer overhead as a non-issue (F7): the Priority-3 worry was worth raising and is quantitatively
  closed.
