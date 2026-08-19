## Stage 5: Open questions — decide before building
**Goal**: Don't build on unexamined defaults.
**Status**: Not Started

| # | Question | Status |
|---|---|---|
| **Q1** | **Is the vector store justified at all?** E4 is one-directional by design and the harness is rotted (§14.3). **Gates M2.** Pre-registered design below | **ANSWERED (2026-08-04): delete** — M2 memo + Stage 7 |
| Q2 | Should generated/minified files be chunked at all? (451 KB single-line file → 232 `block` chunks) | Not Started |
| Q3 | `populateFile` FTS insert cost grows with index size (0.37→1.35 ms/KB *within* one run, order-independent) — survives the migration, matters at n8n scale | Not Started |
| Q4 | ~~Live index is 83% unembedded — wire embedder completion, or stop reporting `mode: "hybrid"`~~ | **Moot** — Stage 7 deleted the embedder and the `mode` surface |
| Q5 | Result diversification in `mast_search` — no per-file dedup exists (shell↔method dedup only, now in `fused.ts`). Held at P2: evidence was n=1 and confounded by lexical-only mode. Re-test — **unblocked** (Q1 answered, Q4 moot) | Not Started |
| **Q6** | ~~SQLite WAL auto-checkpoint stall on `graph.db` — periodic 1.7–3 s freeze, present even at N=1~~ | **RESCOPED 2026-08-11 — see the Q6 RESCOPE block below.** Round-1's signature is measured absent (round 2, same arm/corpus/outlier definition), but that null is itself pre-F11; HEAD's reader/writer topology is unmeasured and round 1's own suspect (`graph.db`'s default-threshold checkpoint inside `populateFile`'s transaction) is alive. Scale row **and** a HEAD-topology checkpoint probe MOVED to E1 |
| E5 | `mast index --checker` — untested. Does it convert enough truncated potentials into verified edges to justify §10.3.2's complexity? | Not Started |
| E6 | Cross-language: index `vscode`/`pulumi`; are non-TS files dropped **silently**, making `mast_project_skeleton` present a partial map as complete? (same false-green class as F5) | Not Started |
| E8 | GitNexus `impact`/`trace`/`rename` — **design study only**, per the §1 licence bar | Not Started |

---

### Q6 RESCOPE (2026-08-11) — round-1's signature is measured absent on the pre-F11 build; HEAD's topology is unmeasured

Q6's row states "periodic 1.7–3 s freeze, **present even at N=1**". That is round-1
language, and round 2 measured it absent. This block re-decides the question against
existing committed evidence rather than opening a new investigation (D6 RESCOPE
precedent: no new measurement; everything measurement-shaped moves to E1 where §6's
rules govern it). **It was adversarially reviewed before commit** (Fable,
SURVIVES-WITH-REQUIRED-CHANGES); all four required changes are applied below, and the
review's specific findings are recorded rather than absorbed silently, because three
of the four errors it found ran in this block's own favour — the §6 pattern exactly.

**The replication that carries the retirement.** The strongest evidence is not the
probe this block originally foregrounded, it is the direct like-for-like arm:

| | round 1 (`eval/e7-concurrency.json`) | round 2 (`eval/e7-round2.json`) |
|---|---|---|
| Arm A **N=1**, same arm definition/pacing/corpus | 3 reps / 120 calls | 5 reps / 200 calls |
| Outliers, **identical field** `wal_checkpoint_outliers_gt_1500ms` | **12 (10% of calls)**, "periodic, every ~10 calls" | **0** |
| Non-busy latency max | 616 ms | **178 ms** |
| Build | pre-M1 (Lance chunk store live) | post-M1 / post-F12, **pre-F11** |

The "binned away between rounds" objection fails: both files use the *same* outlier
field name and threshold, and round 2 reports raw maxima (178 ms at N=1; 186 ms on a
supplementary 150-call sequential probe run after the full sweep against an
already-6.3 MB WAL), so no sub-threshold stall is hiding under a redefinition. P3 was
a *counter-current* prediction (stalls get worse); it did not merely fail to fire.

**Two caveats on that replication, both left standing rather than argued away.**
(1) Round 2 has no *structured* per-N outlier field — the zero rests on Arm A's prose
`variance_note` plus the P3 text, in a file whose *other* prose numbers are shown
unreliable above; "identical field" overstates the symmetry, though the threshold and
name do match. (2) The two rounds measure on **different planes**: round 2's Arm A
numbers are server-derived from `lock-metrics.jsonl`, round 1 aggregated client-side
wall clock. A mitigating argument was offered in review — that round 1's mechanism
would have inflated round 2's `jit_hold_ms` (max 68 ms at N=1) regardless of plane —
and was then **withdrawn by the reviewer on checking**: round 1 (`e7-concurrency.json`)
contains **no `jit_hold` series at all** (only `index_run_hold_ms_this_window`), so the
premise cannot be tested and the argument stacked inference on round 1's own
attribution. **The plane caveat therefore stands un-mitigated.** What the data does say
is narrower: round 1's N=1 `jit_wait max` was 2 ms, so the stall was not lock-*wait*.
Settling it needs E1's probe to record client wall-clock **and** hold decomposition on
the same calls — instrumentation round 2's `jit_hold_decomposition` shows already
exists.

**Call counts — do NOT quote P3's narrative figures.** `prediction_verdicts.
P3_wal_checkpoint_stalls` states "2,367 Arm A + 5,340 Arm B". Those figures **do not
reconcile with the same file's own per-N tables**: Arm A sums to **3,000**
(200+400+800+1,600) and Arm B to **4,800** (320+640+1,280+2,560), total **7,800**;
the non-busy subsets are 2,741 / 4,340, also neither figure. The zero-outlier
conclusion is unaffected (Arm A's `variance_note` independently reports 0 at every N),
but cite the per-N tables. **The unreconciled narrative figures are an instrument-record
defect and are logged in HANDOFF_Q1.md §5.**

**The two rounds named DIFFERENT suspects, and round 1's is alive at HEAD.** This block
originally headlined "the prime suspect has been deleted", leaning on round 2's
reattribution to `chunks.lance`'s full-file rewrite — which round 2 itself flags as
`plausible_explanation_not_fully_isolated`. But **round 1's own contamination note
attributes the stall to `graph.db`'s own connection**: "WAL mode … with no explicit
`wal_autocheckpoint` override, so the default ~1000-page threshold triggers a blocking
passive checkpoint **inside `populateFile`'s transaction** periodically". That
component is untouched at HEAD. Neither suspect was isolated, and the deletion of one
of them does not retire the other. The Lance-deletion framing is therefore **withdrawn
as the headline**; it survives only as one of two candidate mechanisms.

**Round 2's null covers a system that no longer exists either.** Round 2 was captured
**2026-07-28** and was the F11 *sizing* measurement — it ran on a **pre-F11** build
where every JIT refresh still serialized on `structure.lock` (its Arm A numbers are
derived from `jit-staleness` lock events, a caller that post-F11 does not exist).
F11 then removed the lock from the JIT path entirely, so readers and `populateFile`
commits now overlap at the SQLite level in a topology **no WAL measurement has ever
covered**. The symmetry is the point: this block's own "re-running would measure a
different system" argument applies equally to round 2's null. Mitigating, and verified:
F11 bounded the JIT write's own busy-wait at `IMMEDIATE_WRITE_BUSY_TIMEOUT_MS = 200` ms
(`graph/populate.ts`), so the multi-second *busy-wait* stall class is designed out —
but checkpoint work performed *inside* a commit is not bounded by `busy_timeout`, and
that class is untouched.

**What survives, and where it goes.**

1. **Checkpoint cost at scale — MOVES to E1.** Every WAL measurement in this program was
   taken on nest (~1,338 files). Nothing has measured checkpoint behaviour at the real
   target (vscode: 138,440 chunks, 736 MB `graph.db`). Same reasoning that moved D6's
   ms/file and parse-vs-index rows to E1; rides E1's pinned corpora at no extra corpus
   cost.
2. **HEAD-topology probe — ALSO to E1.** A WAL-backlog / checkpoint probe under
   *concurrent readers* on the post-F11 build, which is the configuration nothing has
   measured. This is a scope *addition* to E1 relative to what the D6 RESCOPE handed it.
3. **Mechanism isolation — declined for the pre-F11 system, folded into (2) for HEAD.**
   Isolating a mechanism that no longer reproduces on a build whose topology has since
   changed is archaeology; the useful version of the question is (2), measured forward.
4. **`wal_autocheckpoint` tuning remains untried.** Verified: `graph/db.ts` sets
   `journal_mode = WAL`, `foreign_keys`, and `busy_timeout = 5000` and **never**
   overrides `wal_autocheckpoint` (only a test uses `wal_checkpoint(TRUNCATE)`). Q6's
   original suggestion should be evaluated against E1's numbers, not speculatively.

**Two claims this block previously made that are WITHDRAWN as unsound.**

- **The live-WAL "deferred checkpoint" datum — withdrawn, and the withdrawal is now
  MEASURED, not argued from documentation.** Observed on the live index (14,605
  chunks, `graph.db` 157 MB): `wal_autocheckpoint` = default 1000 pages (≈4 MB at
  `page_size` 4096), on-disk `graph.db-wal` = 10.8 MB. This block previously read that
  2.6× ratio as evidence that passive checkpoints are being *deferred*. Experiments
  with mast's own driver (better-sqlite3, same pragmas) settle it:
  - A passive checkpoint **never shrinks** the `-wal`; it resets and reuses at the
    high-water mark (`{busy:0, log:2450, checkpointed:2450}`, file 11.66 MB before
    **and** after). Only `TRUNCATE` shrinks it (→ 0.00 MB).
  - **A single 2,600-page transaction produced an 11.66 MB WAL with no reader ever
    existing and nothing deferred** — reproducing the live signature from ordinary
    write behaviour alone. So a 2.6×-over-threshold file is evidence of a past large
    transaction and nothing more.
  - The asserted mechanism is **false as stated**: a completed `.get()` in autocommit
    leaves the next passive checkpoint fully unobstructed (1525/1525) — better-sqlite3
    holds **no snapshot between statements**. An *open iterator* does pin checkpointing
    (`checkpointed: 0`), released on close. Note for future readers: the reader-block
    signal is the `checkpointed < log` gap, **not** the `busy` column, which stays 0.
  **Verdict: the 10.8 MB observation is SILENT on deferral**, neither supporting nor
  refuting it.
- **First `PRAGMA wal_checkpoint` prior for E1 — measured on a copy of the live DB**
  (`graph.db` + `-wal` + `-shm` all copied; copying only the `.db` silently drops WAL
  contents). Result: **`{busy:0, log:889, checkpointed:889}`, wal 10.86 MB with
  capacity for 2,635 frames but only 889 live frames (~3.6 MB) — UNDER the 1000-page
  threshold.** The live WAL is ~66% dead space, a high-water mark consistent with the
  08-10 21:06 full reindex, with **no over-threshold backlog**. The real 157 MB
  database behaves exactly like the synthetic one (no truncation on passive; TRUNCATE
  works). Honest caveat: opening a copy rebuilds the wal-index, so how many of the 889
  the live server had already backfilled is unknowable from a copy — 889 is the
  backlog **ceiling**, not necessarily its actual depth. E1 carries this reading, dated
  2026-08-11.
- **The dismissal of the `mast metrics --locks` lead.** D6's summarizer on live data
  (as of this reading: **680** `index-run` cycles, hold p50 64 ms, p95 585 ms, **max
  1,802 ms**; count drifts upward as index runs accumulate) shows a max inside Q6's
  1.7–3 s band. This block previously dismissed it on the claim that "`index-run` takes
  `structure.lock` once per `runIndex` call (`indexer/index.ts:181`)". **That claim is
  false.** Line 181 is only the `caller: 'index-run'` label in the options literal;
  `runIndex` acquires the lock at **four** sites — cleanup (`:214`), per pass-1 batch
  (`:295`, commented "scoped to this batch only"), per pass-2 batch (`:365`), and the
  manifest phase (`:377`). A cycle is therefore **per batch**, and 1,802 ms is a
  per-batch hold, 2.4–3.5× round 2's Arm B `index-run` hold envelope on nest
  (max 506–755 ms). Worse for the original dismissal: **round 1's own record
  hypothesizes exactly this link** — large batch holds "appear to correlate more with
  WAL-checkpoint stalls landing inside a batch transaction (compounding with normal
  per-batch FTS cost) than with simple accumulated-version growth alone". The honest
  statement is therefore **unattributed**, and the first draft of this bullet got the
  supporting data wrong in its own favour (caught by the results review, corrected
  here by recomputation from the live `lock-metrics.jsonl`, 680 released cycles). The
  five largest holds are **1,802 / 1,370 / 1,147 / 1,115 / 1,024 ms**. The burst
  reading — "the three largest are consecutive releases within ~3.5 s of one run" — is
  false: that burst (2026-08-01T03:52:27.715/29.130/30.483Z) is holds **#1, #5 and
  #4**, while the **second and third largest are isolated** (1,370 ms on 08-07T18:21Z,
  1,147 ms on 08-11T00:08Z, different runs entirely). The correction **strengthens**
  the unattributed verdict rather than weakening it: the burst-fits-batch-work story
  covers fewer of the large holds than claimed, and two of the top three are single
  unexplained events. Candidate mechanisms remain at least three — batch volume, Q3's
  FTS-growth cost, checkpoint-inside-commit — and E1's probe (2) is where this gets
  attributed. For scale: round 2's Arm B `index_run` hold maxima on nest were
  **485–755 ms** (N=1..8: 506 / 755 / 520 / 485), so 1,802 ms is **2.4–3.7×** that
  envelope.

**Status change**: Q6 → **round-1 signature RETIRED for the measured pre-F11 system;
HEAD topology UNMEASURED; both the scale row and a HEAD-topology checkpoint probe MOVE
to E1.** Q6 is no longer an available "smaller alternative to E1" — not because it is
closed, but because what remains of it can only be answered inside E1's ladder.

## Deliberately not doing

- **GitNexus adoption** — PolyForm Noncommercial; unusable commercially (§1).
- **F6 (batch Lance writes + version pruning)** — superseded by Stage 2; batching a
  store we're removing is wasted work.
- **E3 (Phase 2 embed manifest check)** — already answered: `vectors.lance` has 55
  manifests/256 KB because the embed path already batches (`indexer/index.ts:281`).
- **M5 (`edges` PK dedup)** — withdrawn; specified and tested intent
  (`verified-callers.test.ts:413–444`), not a defect.
- **Per-chunk quarantine on write failure** — decision was loud failure; a bad chunk
  fails its file loudly rather than being partially recovered.

---

