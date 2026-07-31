# MAST Remediation — Implementation Plan

Tracks the fixes arising from the 2026-07-25/27 empirical investigation.
**Findings and evidence live in `eval/GITNEXUS_COMPARISON.md`** (read §13–§16 —
§1–§12 contain claims since proven wrong). This file tracks *work*, not evidence.

Convention: per global CLAUDE.md §1 — update `Status` as work progresses; archive
to `.history/` when every stage is Complete.

**Verification baseline** (every stage must hold these):
`pnpm -F mast test` · `pnpm -F mast typecheck` · `pnpm -F mast lint` ·
`npx align check` (repo-root CLI; pre-existing `verdict: red` with exactly 2
violations — `root-layout.tsx` cycle, `fold-build-record-repository.ts`
apiDomain→apiDb — neither naming `mast`; verify no NEW mast violation).
Current test count: **366 / 30 files**.

---

## Stage 1: Staleness correctness (the P0)
**Goal**: An agent can never be served stale line coordinates without knowing.
**Status**: In Progress

| # | Task | Status |
|---|---|---|
| 0 | Instrument `withLock` acquire/hold duration + baseline | **Complete** |
| F2 | Wire the discarded `busy` signal to `file_busy_returning_stale_cache` | **Complete** |
| F1 | `withLock` scope: whole-run → per-batch (`indexer/index.ts:46`) | **Complete** |
| **F12** | **🔴 SILENT-CORRUPTION BUG INTRODUCED BY F1 — stamp/content ordering inverted. Fix first, ~5 lines** | **Complete** |
| **F13** | ✅ `SQLITE_BUSY_SNAPSHOT` in `populateFile` escapes `checkAndRefreshIfStale` uncaught — bypasses F2's flag and violates §9.0's "do not throw". Fired 52× in real runs | **Complete** |
| **F11** | **Replace fail-fast advisory locking** — E7 falsified the current design. **Urgency downgraded by E7-r2**, design verdict unchanged | **Not Started** |
| **F14** | **`mast_signature` drops the busy flag when the symbol query returns 0 results** — `topLevelBusy` (`signature.ts:55`) is only consumed inside the per-result loop (`:76`), so an empty result set discards it. Worst case: "no results" + stale index reads as "symbol doesn't exist" | **Not Started** |
| F7 | Staleness for `mast_search` / `mast_implementors` (stat-and-flag, not refresh) | Not Started |

**Success criteria**: max `structure` hold drops from **280,782 ms** (baseline,
`eval/baseline-locks.json`) to bounded per-batch; a JIT re-parse succeeds while an
index run is in flight; `mast_search` never returns stale coordinates unflagged.
**Tests**: `indexer/__tests__/` — JIT refresh succeeds during a concurrent multi-file
reindex. `mcp/tools/__tests__/` — search flags a result whose file changed on disk.
**F1 result** (`eval/f1-lock-scope.json`): max hold **11,078 ms** (25x reduction from
280,782 ms; p50 28 ms matches the spec's 10-50 ms claim, but the tail still climbs on
a full reindex of an already-large index — §15.2's superlinear FTS cost, Stage 2's
job, not F1's). A JIT refresh now succeeds during a realistic (incremental)
in-flight reindex; it can still fail during a *full* reindex of an already-large
corpus if it lands inside one of that run's uniformly-multi-second batches — F1
bounds the blast radius to one batch, it does not eliminate per-batch cost growth.
**Note**: Stage 2 shrinks the stale window as a side effect (245 s → tens of seconds);
F1 is still required — that's mitigation, not a fix.

### F12 — 🔴 F1 inverted the stamp/content ordering (silent stale, no flag)

**Verified in code.** `runIndex` parses **unlocked** at `indexer/index.ts:217` (the
comment at `:210–213` says so explicitly), then stats the file at `:282` — *after* the
parse, inside the write lock. So content is read at `T_parse` and stamped with an mtime
read at `T_stat > T_parse`.

If any process edits the file in that window — which spans a batch's lock wait plus
earlier files' `populateFile` calls, i.e. **seconds** under §15.2's FTS growth — the DB
stores **pre-edit content with a post-edit mtime**. Every later staleness check
(`mcp/staleness.ts:51`, `diskMtime <= storedMtime` → fresh) is **permanently disarmed**.
Stale coordinates, served forever, with no `file_busy_returning_stale_cache` flag.
This is the exact P0 class Stage 1 exists to eliminate.

**F1 caused this by inverting a safe ordering.** *Before* F1, the stamp was
`entry.mtime` from the run-start walk — i.e. **older** than the parsed content, so a
mid-run edit made staleness fire *redundantly* (safe). F1 replaced it with a post-parse
re-stat to prevent mtime *regression*, and thereby created the opposite, unsafe hazard.
**F1's "invariant 1" WHY-comment (`:98–102`) asserts an atomicity that does not hold:
the hazard is `parse→write`, not `stat→write`, and no lock can fix it because editors
never take the lock.**

**The JIT path does it correctly** — `staleness.ts` stats at `:44` *before* parsing at
`:69` and stamps that pre-parse value at `:87`, so a post-stat edit leaves stamp <
content and staleness re-fires (self-healing). Copy that ordering.

**Fix** (~5 lines, M1-independent, ship before anything else):
1. Stat immediately **before** `doExtract`; stamp that value.
2. Add a monotonic write-guard in `populateFile` — refuse to replace a row whose stored
   mtime exceeds the incoming stamp, inside the existing transaction. This also fixes
   the reindex-vs-JIT race *better than the lock does*: today the lock serializes the
   writes but lets the older parse win.
**Test first** (§5.2 — it's a bug, so the reproducing test comes first): parse, mutate
the file, run the write phase, assert the staleness check still fires.
**Caveat for the design doc**: mtime-granularity blind spot (an edit in the same tick
compares equal) — the git racy-lstat problem. Near-moot on APFS nanosecond mtimes;
real on coarse-mtime shared volumes.

**F12 result**: both parts shipped as designed. (1) `indexer/index.ts`'s parse loop now
stats each file immediately before `doExtract` and carries that pre-parse stamp through
to the write untouched (no re-stat at write time); the header WHY-comment's invariant 1,
which asserted an atomicity that didn't hold, is corrected to the actual ordering
property. (2) `graph/populate.ts`'s `populateFile` refuses to replace a row whose stored
mtime exceeds the incoming stamp, returning `written: false` rather than silently
no-op'ing; `IndexResult.staleWriteRejections` and a `[mast] WARN` log make a rejection
visible instead of indistinguishable from a successful write (the `writeErrors`
precedent). `indexer/index.ts:313`'s final-phase re-stat (manifest rebuild) was left
unchanged — it has no accompanying content read in that phase, so there is no
stamp/content pair to invert, and a manifest/`files.mtime` disagreement self-heals
through the next JIT check. Reproduced RED first (`indexer/__tests__/mtime-stamp-ordering.test.ts`
— `{ refreshed: false, busy: false }` on unfixed code where the fixed code produces
`{ refreshed: true, busy: false }`) and added a monotonic-guard test
(`graph/__tests__/storage.test.ts`). One pre-existing test
(`graph/__tests__/checker-resolver.test.ts`) relied on an arbitrary non-monotonic
`mtime: 2_000` literal following a real indexed baseline; updated to a genuinely newer
stamp (`fileRow.mtime + 1_000`) since the guard now — correctly — rejects it. Full suite:
377/33 (baseline 374/32 + 3 new tests, 1 new file), `tsc --noEmit` clean, `eslint` clean,
`align check` unchanged (still red on the same pre-existing 2 violations, neither
naming `mast`).

### 🔴 HARD CONSTRAINT ON F11 — `busy_timeout` IS the process-freeze window

From `eval/eventloop-probe.json`. **Theory was right; E7-r2's "no freeze" was an
artifact.**

**Phase 1 (decisive, bare better-sqlite3, no MAST code):** a blocked write freezes the
*entire* process. Heartbeat gap tracks block duration almost exactly — **1,602 ms block
→ 1,651 ms gap; 3,130 ms → 3,178 ms**. Zero `setInterval` heartbeats fire during the
block; `monitorEventLoopDelay` max matches. better-sqlite3's synchronous busy-wait
blocks the event loop, as the API's nature implies.

**Phase 2/3 (why the real path looked safe):** `populateFile`'s **deferred**-BEGIN
read-then-write returns `SQLITE_BUSY` in **1–2 ms** against *any* competing holder —
even one that never commits — never invoking the busy handler at all. That is a
structural SQLite property (promoting an open read transaction while another connection
holds the write reservation), not a fast retry. So today's 5,000 ms default is largely
**inert**, because the code never reaches the wait. E7-r2's single "5.26 s block" run is
explained by its 200 ms head start (vs this probe's 1,500 ms) racing the snapshot ahead
of the competing lock.

**The trap this sets for F11:** `BEGIN IMMEDIATE` is confirmed to work — it eliminates
both `SQLITE_BUSY_SNAPSHOT` *and* the instant-`SQLITE_BUSY` failure, and falls back to
an honest bounded wait (committed at ~1,290 ms against a 1,200 ms hold). **But adopting
it makes the timeout live for the first time.** With the inherited 5,000 ms default,
every genuine contention becomes a **5-second freeze of that whole `mast serve`
process** — every tool call, not just the writer.

**⇒ F11 MUST set a short, dedicated `busy_timeout` (~100–300 ms) on the write path at
the same commit that adopts `BEGIN IMMEDIATE`.** Never inherit the 5,000 ms default
there. This also means "just use SQLite as the cross-process queue" is bounded by how
long a process can afford to be frozen — which caps queue depth and is the real argument
for option (d)'s write-behind (a dropped persist costs latency, never a freeze).

Option **(c)** stays **refuted**, now on directly measured grounds rather than inference.

### F13 — 🔴 `SQLITE_BUSY_SNAPSHOT` bypasses F2's stale flag (found by E7-r2)

**Not latent — it fired 52× across 23/32 real Arm-B reps**, including 22 JIT-side
failures, despite every caller correctly holding `structure.lock`.

**Verified in code** (`src/mcp/staleness.ts`): `extractFile` **is** wrapped in
try/catch (returns `{refreshed:false, busy:true}` on failure), but the `populateFile`
call that follows is **not**. A `SQLITE_BUSY_SNAPSHOT` there propagates uncaught through
the `finally` (which releases the lock) and straight out of `checkAndRefreshIfStale`.
The caller never receives `busy: true`, so **F2's `file_busy_returning_stale_cache`
never gets set** — the agent gets a thrown error instead of an interpretable flag.

`MAST_SPEC.md` §9.0 is explicit that this is wrong: *"Do not throw — the agent has no
recovery for a thrown error, but it can interpret the flag."* So this is a direct
spec violation, and it partially undermines shipped F2 work.

**Cause**: Kysely issues a deferred `BEGIN` (`sqlite-driver.js:32–34`); F12's monotonic
guard added a **read-then-write** inside that transaction, which is exactly the shape
that can fail `SQLITE_BUSY_SNAPSHOT` — and `busy_timeout` cannot wait it out (the
snapshot is already stale; waiting cannot help).

**Fix** (small, ship before F11): catch `populateFile` failures in
`checkAndRefreshIfStale`; map `SQLITE_BUSY*` codes to `{refreshed:false, busy:true}`
so F2's contract holds; let genuinely unexpected errors surface distinctly rather than
being silently reclassified as "busy". Consider `BEGIN IMMEDIATE` for the guard
transaction as the deeper fix — but note that is F11 territory and interacts with the
lock redesign.
**Test first**: reproduce with a concurrent writer holding a snapshot (E7-r2 reproduced
it 5/5 in isolation via `err.code === 'SQLITE_BUSY_SNAPSHOT'`); assert the tool response
carries the flag rather than throwing.

**F13 result** (`src/mcp/staleness.ts`, `src/mcp/__tests__/staleness.test.ts`): shipped as
designed. `checkAndRefreshIfStale`'s `populateFile` call is now wrapped in a bounded
retry loop (`MAX_POPULATE_RETRIES = 1`, i.e. 2 attempts total, no sleep between —
`SQLITE_BUSY_SNAPSHOT` means the snapshot is stale, not merely locked, so waiting cannot
help; only a fresh transaction can). `SQLITE_BUSY_SNAPSHOT`/`SQLITE_BUSY` are detected by
`err.code`, never by string-matching the message. On retry exhaustion the function
returns `{ refreshed: false, busy: true }` — the same TOCTOU contract every other path in
this function already honors — instead of throwing. Any other `SQLITE_*` code is NOT
retried and NOT reclassified as busy; it propagates immediately (deliberately, to avoid
repeating the parse_errors/write_errors misclassification this codebase already fixed
once). A test-only `populateFileImpl` injection parameter (defaulting to the real
`populateFile`, mirroring `populateFile`'s own `ChunkWriter` seam) lets the regression
tests induce a **genuine** `SQLITE_BUSY_SNAPSHOT` — a second real `better-sqlite3`
connection commits a write between a Kysely transaction's first read and its own write
attempt, the same deterministic technique as `mast-bench/e7r2-busy-snapshot-repro.mjs` —
rather than mocking `populateFile` wholesale. Three new tests
(`src/mcp/__tests__/staleness.test.ts`): busy-exhausted-returns-flag (the assertion that
would have caught the original bug), retry-succeeds-and-actually-writes, and
non-busy-error-propagates-undisturbed. Full suite: 380/34 (baseline 377/33 + 3 new tests,
1 new file), `tsc --noEmit` clean, `eslint` clean, `pnpm align:check` unchanged (still red
on the same pre-existing 2 violations, neither naming `mast`). The deeper fix
(`BEGIN IMMEDIATE` for the guard transaction) is explicitly out of scope — it is F11
territory and interacts with the `structure.lock` redesign.

### F11 — E7 falsified per-batch advisory locking (`eval/e7-concurrency.json`)

All three pre-committed criteria fired. **JIT failure rate with ZERO reindex running:
35% (N=2) · 70% (N=4) · 88.5% (N=8)** — separate `mast serve` processes on one state
dir, purely reader-vs-reader.

**Root cause — not the lock's *scope*, its *granularity* and *semantics*:**
`markerPath(stateDir, type)` (`store/lock.ts:10–12`) takes **no file component**, so
`structure.lock` is **one global lock per state dir**. A JIT re-parse of file A blocks
a JIT re-parse of file B despite touching disjoint rows. Combined with fail-fast
semantics (3×100 ms, no queue — `mcp/staleness.ts:56`), concurrent readers starve
each other.

**[CORRECTION to my own framing]** I wrote each criterion as *"if this fires, F1's
per-batch locking made contention worse."* **That attribution is wrong.** Arm A ran no
reindex at all, so F1's 170 acquisitions/run played no part — reader-vs-reader
contention is **pre-existing**, present before F1, and F1 only ever addressed
reindex-vs-reader. F1 is **insufficient, not harmful**; its 25× hold reduction stands.
The remedy (single-writer queue) is unchanged, but the reasoning is
"advisory-fail-fast was never adequate for concurrent readers," not "F1 regressed it."
Recording this because it is the same class of error as §15.2's R1 attribution slip:
*the criterion fired; the causal clause I attached to it was unverified.*

**Design space — R5 review verdict** (options (a)–(c) all weakened by verified facts):
- **(c) "delete the lock, rely on SQLite" — REFUTED.** Three verified blockers:
  (i) `busy_timeout` is **already 5000 ms** — better-sqlite3's default
  (`lib/database.js:34`), never overridden in `src/`. **My "it's unset" premise was
  wrong**; E7 was measured *with* it. (ii) better-sqlite3 is **synchronous**, so a
  busy-wait is a native block that freezes the MCP server's whole event loop — deleting
  the advisory lock converts fail-fast-in-300 ms into freeze-everything-for-5 s, a
  *worse* interactive failure mode (and the observed 1.7–3 s WAL stalls, Q6, are this
  shape). (iii) Kysely issues a **deferred `BEGIN`**
  (`sqlite-driver.js:32–34`), so read-then-write transactions can fail
  `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` cannot wait out. `insertEdges`
  (`populate.ts:134+`) and the checker-resolver flush are **transactionless RMW** today
  and rely on the lock.
- **(b) per-file locks — reject.** Stale-recovery cost per marker; a 16-file batch needs
  16 locks in sorted order to avoid deadlock; 12k files at n8n scale; and it covers
  neither the manifest phase nor pass-2 edge resolution (which reads *other* files'
  symbols).
- **(a) fair FIFO queue — overbuilt as the primary mechanism.** No off-the-shelf
  cross-process fair queue exists, and E7 showed fairness was **not** the problem.
- **(d) RECOMMENDED — decouple response freshness from index persistence.**
  1. JIT read path becomes **lock-free**: stat → parse in-memory → resolve the response
     against the fresh parse → return. The E7 contention class disappears by
     construction. 2. **Write-behind, best-effort** persist afterwards under a short
     `BEGIN IMMEDIATE` with F12's monotonic guard; on busy, drop it — costs latency,
     never correctness. 3. Coarse writers **keep `proper-lockfile`** (reindex batches,
     manifest phase, checker-resolver) — its PID/stale recovery is verified working and
     it is the only thing that can cover the plain-JSON manifest writes.
  **Honest costs**: threading an in-memory overlay through 8 tools' result assembly
  (centralizable in `_helpers.ts`, but touches `hybrid.ts` field sourcing); repeated
  parse cost until a persist lands; match-vs-content skew (a result can vanish after
  refresh — the overlay must handle "dropped after refresh"); and pure read-only would
  never converge, hence write-behind rather than no-write.
  **Precedent strengthens it**: §9.0 already excludes vectors from JIT, and §13.3 found
  **no tool refreshes its result set anyway** — today's JIT write only ever heals the
  argument file, so its marginal value is smaller than the design implies.

**What `structure.lock` genuinely protects** (so F11 cannot delete it outright): the
manifest/`index.json` phase writes **plain JSON via `writeFileSync`** — SQLite can
never coordinate that, and the manifest reader at `index.ts:159` is itself *unlocked*
today (pre-existing gap). Minimum viable outcome is a **narrow role, not removal**.

**Blocked on**: F12 (ship first). **Not blocked on M1** — see sequencing note below.

**Sizing update (E7 round 2, `eval/e7-round2.json`, post-M1/post-F12)**: the raw
contention numbers behind this section's urgency have themselves mostly resolved as an
M1 side effect (JIT failure rate 69.8%/88.5% → 4.1%/14.1% at N=4/N=8; hold p95 284ms →
15–47ms). The design verdict below (options a–c refuted, (d) recommended) is
unchanged, but round 2 downgrades this from P0 to P1: ship the small
`SQLITE_BUSY_SNAPSHOT`/write-failure-handling fix it also surfaced (not latent —
fires under real load, bypasses F2's flag) before committing to the full write-behind
redesign. See Stage 4's E7-r2 entry for the complete readout.

**Event-loop-freeze contradiction resolved (`eval/eventloop-probe.json`)**: E7-r2's
`eventloop_freeze_probe` reported "not frozen" — a concurrent read returned in 29ms
while a write was mid a 5.26s busy_timeout wait — apparently contradicting this
section's own "(ii)" claim that better-sqlite3's synchronous busy-wait freezes the
whole event loop. A dedicated 3-phase re-measurement resolves this **in favor of the
theory**: a minimal, mast-free primitive test (Phase 1 — two bare better-sqlite3
connections, one holding `BEGIN IMMEDIATE`, the other arming an independent
`setInterval`/`monitorEventLoopDelay` liveness probe before its own write attempt)
shows an unambiguous total freeze in both the success-after-wait and timeout
directions (heartbeat gap ≈ block duration, zero heartbeats fire during the block).
The prior "not frozen" result was an artifact: F13's own `isRetryableBusySnapshot`
fix, plus an isolated mechanism test (Phase 3, against the real `dist/graph/db.js`
Kysely config) shows that `populateFile`'s deferred-BEGIN read-then-write shape fails
in 1-2ms under ANY competing writer — even one that never commits anything — rather
than ever reaching a genuine multi-second busy_timeout wait. Today's code is
accidentally shielded from the freeze scenario by that fast-fail shape, not because
the freeze isn't real. Wrapping the SAME guard transaction in `BEGIN IMMEDIATE`
(this section's own "deeper fix") is confirmed to eliminate `SQLITE_BUSY_SNAPSHOT`
and correctly fall back to an honest busy_timeout wait — but per Phase 1, that wait's
duration is also the freeze window for the WHOLE server if the connection's shared
5000ms `busy_timeout` (graph/db.ts) is reused unmodified. **Actionable refinement**:
any write that adopts `BEGIN IMMEDIATE` (F12's guard, or option (d)'s write-behind
persist) needs a short, dedicated `busy_timeout` override (~100-300ms), not the
shared 5000ms default — option (d)'s own "on busy, drop it" framing already implies
this, but it wasn't previously stated as a hard requirement. Option (c) ("delete the
lock, rely on SQLite") remains refuted, now on directly measured grounds rather than
the "verified fact" citation alone. A separate, still-unfixed defect was found in the
same pass: `mast_signature`'s response has no top-level busy/stale field, so a JIT
`{busy:true}` result is silently discarded whenever the requested symbol's query
comes back with zero results (`signature.ts`'s per-result `topLevelBusy` attachment
never runs if `symbols` is empty) — not fixed, measurement-only scope.

**Fairness was NOT the problem** (no client starved while others succeeded, either
arm), so retry-parameter tuning is not the answer.
**Also verified under load**: F2's `file_busy_returning_stale_cache` was correct across
**2,861** busy-outcome calls — no silent stale results. Stale-lock recovery works:
SIGTERM ~0 ms, SIGKILL ~5 s, no leak.
**Measurement confound, flagged honestly**: Arm B's absolute holds (max 21.6 s) ran ~2×
above `f1-lock-scope.json` because the repeated runs grew `chunks.lance` to 4,636
versions / 444 MB — Stage 2's O(n²), not an F1 regression.

---

## Stage 2: Chunk store migration (Lance → SQLite)
**Goal**: Remove the O(n²) write path at its root.
**Status**: In Progress (M1 complete; M2 not started)

| # | Task | Status |
|---|---|---|
| — | Spike: env-gated `SqliteChunkStore` + measurement | **Complete** |
| — | `chunk_id` collision fix (prerequisite) | **Complete** |
| — | Loud write failure (prerequisite) | **Complete** |
| M1 | Promote SQLite store to default; retire the env gate | **Complete** |
| M2 | Decide vectors: Lance vs SQLite BLOB + JS cosine vs `sqlite-vec` | Not Started |

**Success criteria**: `nest --phase1-only` ≤ 82 s (measured spike: **4.4 s** vs Lance
**269–284 s**); state 194 MB → ~17 MB; read-set content identical between arms.
**Tests**: `store/__tests__/lance.test.ts` equivalent for the SQLite store; a
version-manifest-count assertion is meaningless post-migration — replace with an
O(N) row-count/growth assertion.
**Blocked on**: nothing. Both prerequisites shipped.
**Evidence**: §14.1 (why replacement not deletion), §15.1 (measurements).

### M1 result (`eval/m1-migration.json`)

**Design decision: chunks live IN `graph.db`, not a separate `chunks.db`.** The
spike's own `chunks.db` was deliberately quarantined; M1 folds the `chunks` table
into `graph/db.ts`'s existing schema so `graph/populate.ts`'s `populateFile` writes
chunks in the SAME per-file `db.transaction()` as `symbols`/`edges`/`imports`/
`chunk_fts` — proven, not asserted: `graph/__tests__/storage.test.ts` — "a chunk-write
failure rolls back the WHOLE transaction — no orphaned symbols/files/FTS rows" injects
a failing chunk writer and asserts zero rows land anywhere. `mcp/staleness.ts`'s JIT
refresh, which pre-M1 wrote chunks to Lance ONLY (a latent bug once SQLite became the
default — JIT edits would have been invisible to every reader), now goes through
`populateFile` alone and is correct by construction. `busy_timeout = 5000` was added
to `graph/db.ts`'s `openDatabase` (previously unset — found during E7) since SQLite is
now the sole chunk store and multi-process contention routes through it; F11 (lock
redesign) is unchanged/out of scope.

**Measured** (fresh state dirs, `mast-bench/m1-{common,nest,directus}-sqlite`):

| corpus | files | duration_ms | vs spike sqlite | state bytes | vs Lance baseline |
|---|---|---|---|---|---|
| nest/common | 189 | 435 | 388 | 2.6 MB | — |
| nest | 1,338 | 4,528 | 4,184 | 17 MB | 194–233 MB → 17 MB |
| directus | 2,085 | 10,732 | 8,791 | 33 MB | 409 MB → 33 MB |

All three land within ~20–25% of the spike's own SQLite-arm numbers (noise, not
regression) and reconfirm the O(n²) elimination: nest's manifest-free state is
**~11–13× smaller** than the Lance baseline, matching the spike's ~17 MB prediction
almost exactly. `chunk_count` matched the pre-migration Lance build exactly (5,030 =
5,030) with 0 parse/write errors on all three corpora — the chunk_id-collision defect
`store-spike.json` flagged (§ real-world case: `directus/app/src/shims.d.ts`) is
confirmed fixed.

**Read-set diff**: comparing against the 2-day-old `mast-state` Lance reference was
confounded — the live `nest` checkout had uncommitted edits to 14 files from earlier
E7 concurrency-test sessions, so BM25's corpus-wide statistics legitimately differed
between the two builds (score deltas, occasional tie-reorders — the exact mechanism
`store-spike.json` §"score_drift_explanation" documented, not a new defect). Re-ran as
a single-parse-pass, dual-write comparison instead (one `walkProject`/`extractFile`
pass over the CURRENT `nest` snapshot feeding both a Lance chunk table and the SQLite
`chunks` table from byte-identical `Chunk[]`, then diffing `hybridSearch` /
`getChunksByFilePath` / `collectPotentialMatchCandidates` with only the chunk-store
backend swapped): **0 content differences** — full chunk set identical (5,030 rows in
both arms, 0 parse errors), 20/20 `mast_search` queries identical, 5/5 `mast_exports`
files identical, 5/5 `mast_callers` symbols identical. See `eval/m1-migration.json`
for the full readout.

**New tests**: `graph/__tests__/storage.test.ts` (atomicity, 2 tests — the transaction
join above), `indexer/__tests__/chunk-store-growth.test.ts` (2 tests — chunk-row count
stays exactly equal to current live content across 10 rewrites of one file, and grows
by exactly 1 per incrementally-added file, replacing the meaningless
version-manifest-count check), `mcp/tools/__tests__/tools.test.ts` (`is_exported`
round-trips as a real `boolean`, not `0|1`, through the full `mast_search` MCP
response, not just the store's own unit test).

---

## Stage 3: Call-graph correctness
**Goal**: `mast_callers` stops returning confidently-empty answers.
**Status**: Not Started

| # | Task | Status |
|---|---|---|
| F3 | `parseCallee`: unwrap `await_expression` (`typescript.ts:1360`) — one line | Not Started |
| F4 | Implement `this.` / `super.` resolution (documented in §10.3.1, never built) | Not Started |
| F5 | `mast_callers` potential set for methods — **design change**, see below | Not Started |
| F10 | Surface `potential_truncated` (silent cap at 50; real count was 71) | Not Started |

**Success criteria**: `POTENTIAL_CALL` edges rise from **1,038** toward the
**1,124 `this.` + 20 `super.`** call sites the corpus contains (E2 acceptance
denominators). `mast_callers {"symbol":"Injector.resolveConstructorParams"}` returns
its 3 real call sites (currently 0).
**F5 design note**: preferred fix is indexing **qualified** names into
`identifier_fts` (schema bump + reindex — free under never-shipped), NOT passing the
unqualified leaf name, which widens the set ambiguously across classes.
**Tests**: `ast/extractors/__tests__/call-edges.test.ts` (pure layer) — incl. a
nested-`function` shadowing guard for F4. `tools.test.ts` with a **method** fixture
asserting the *potential set* (the existing method fixture only asserts
`declaration_sites`).

---

## Stage 3.5: Tool defects and honest surfaces
**Goal**: Fix tools that are slow, silently lying, or advertising things they don't do.
**Status**: Not Started

| # | Task | Status |
|---|---|---|
| F8 | `mast_project_skeleton` costs **~28 s/call** — 99% in `estimateFullFileBound`; `FULL_FILE_BOUND_CACHE_LIMIT=200` LRU-thrashes against 1,334 files (`telemetry/tokenizer.ts:68,97`). Cap the *work*, not the cache | Not Started |
| F9 | `mast init --extensions` / `--exclude` are parsed and **ignored** (`cli/init.ts:20–23`); `loadStateConfig` has zero callers outside `config.ts`, and `serve` *overwrites* the persisted config. Honour them or delete the flags | Not Started |
| M6 | `mast serve` silently bootstraps an empty state dir and answers every query `{"results":[]}` — indistinguishable from "symbol doesn't exist". Fail fast | Not Started |
| C1 | Unify confidence signals — MAST already computes `resolution` and `reason`; add the missing ones uniformly: `stale`/`file_busy` (done F2, extend per F7) and `truncated` (F10) | Not Started |

**Why this is its own stage**: F8 was ranked the **#2 betterment** of the R3 review and
is the single largest practical DX cost measured — the orientation tool the §12 prompt
tells the agent to call *first* spends ~99% of its latency computing a telemetry
counterfactual. F9/M6 are both "the tool lies about what it did".
**Evidence**: §14.4 (M2/F8), §14.4 (M3/F9), §13.5 (M6), §13.8 item 8 / §14.8 item 5 (C1).

---

## Stage 4: Determinism, hygiene, and the measurement harness
**Goal**: Make future measurements trustworthy and stop spec drift recurring.
**Status**: Not Started

> **Sequencing note: do D0 BEFORE Stage 3.** It is a force multiplier for every
> remaining verification task, not a nice-to-have. See its rationale below.

| # | Task | Status |
|---|---|---|
| **D0** | **CLI query surface — parity with the MCP read tools (`mast query <tool> <json>`)** | **Not Started** |
| D1 | Sort `walkProject` output (`indexer/walker.ts:43`) — kills ±4/3,940 edge nondeterminism | Not Started |
| D2 | Repair `eval/` as a regression harness: `paths.mjs` points at a dead session; pin the corpus | Not Started |
| **D6** | **Build the stats/regression suite** — the metric set below, with a baseline captured before each fix | Not Started |
| D7 | Self-oracle invariant tests over a real corpus (e.g. *every `call_expression` visited yields an edge or a recorded drop-reason*) + property-based call-shape generation (`recv.m()`, `this.m()`, `await x.m<T>()`, `super.m()`, `(await x).m()`) | Not Started |
| E1 | Scaling ladder as **regression proof** for Stage 2 — otel(902) / langchainjs(2,047) / strapi(3,600) / backstage(7,021); n8n(12,641) only post-migration | Not Started |
| E7 | JIT under real agent concurrency (4 concurrent MCP clients + in-flight reindex) — **can falsify F1**: if contention degrades non-linearly, per-batch locking made it worse and the answer is a single-writer queue | **Complete — FALSIFIED** |
| E7-r2 | Re-measure E7 against the post-M1/post-F12 build, to size F11 — same harness/arms, three new probes (hold decomposition, event-loop freeze, `SQLITE_BUSY_SNAPSHOT` repro) | **Complete** |
| D3 | Spec conformance: quarantine mechanism prose; add `spec-conformance.test.ts` with `// MAST_SPEC.md:NNN` citations | Not Started |
| D4 | Test-assertion rule: no `unknown[]` in response type annotations; every returned array gets a content assertion | Not Started |
| D5 | Adopt ADR directory (`.history` → numbered ADRs, `002-2026-07-22-name.md`, zero-padded) | Not Started |

**Success criteria**: two identical index runs produce identical edge sets; `eval/`
runs against a pinned corpus; the three known false spec claims are either true,
tested, or moved to a non-normative appendix.
**Evidence**: §15.5 (nondeterminism), §14.2 (harness rot), §14.5 (spec drift), §14.6
(assertion strength).

**E7 result** (`eval/e7-concurrency.json`): all three pre-committed falsification
criteria **FIRED**. X2 is the headline — with **zero reindex running anywhere**, pure
reader-vs-reader JIT lock traffic (N separate `mast serve` processes, per §7.6's
cross-process rationale, each editing its own file and re-querying it) drives JIT
failure rates to **35% (N=2) / 70% (N=4) / 88.5% (N=8)**. X1 fires by the letter of
the criterion (waitMs p95 goes from ~1ms at N=1 to ~306ms at N=4, a ~306x jump against
a 4x client increase) though the actual shape is a cliff-then-plateau bounded by the
3×100ms retry ceiling, not unbounded growth — the ceiling itself is what floods into
X2's failure rate. X3 fires on like-for-like successful-refresh latency (p95 314ms →
1152ms, N=1 → N=8, a 3.67x regression). **Conclusion, stated plainly per the
pre-commitment: F1's per-batch advisory locking is the wrong design for concurrent
agents — `structure.lock` is one global lock per state dir (not per-file), so two
agents editing unrelated files still serialize on it, and `proper-lockfile`'s
retry-and-fail semantics (no fairness queue) convert contention into outright failure
rather than a bounded wait.** F1 was scoped to fix reindex-vs-reader contention and did
that (see Stage 1's F1 result above); it does not and cannot fix reader-vs-reader
contention, which this test shows is the more common shape once ≥2 agents are active.
**Recommendation: a single-writer queue** (fair, bounded-wait) rather than continuing
to tune advisory-lock retry parameters. Two secondary findings, reported not fixed
(measurement-only task): a periodic ~1.7–3s SQLite WAL-autocheckpoint stall on
`graph.db` recurs every ~10 JIT writes at **every** concurrency level including N=1 —
unrelated to locking, not previously known, needs its own plan item; and Arm B's
absolute batch-hold numbers (max 21.6s) run ~2x above `f1-lock-scope.json`'s clean
capture (max 11.1s) because this experiment's own repeated-run methodology grew
`chunks.lance` to 4,636 versions/444MB over the course of the test (Stage 2's O(n²)
issue) — flagged as a measurement confound, not a regression in F1 itself. No dramatic
per-client starvation was observed in either arm (fairness is not the problem;
fail-fast-with-no-queue is).

**E7 round 2 result** (`eval/e7-round2.json`) — re-measured against the post-M1/
post-F12 build to size F11, same harness and arm definitions as round 1. All three
pre-committed predictions resolved: **P1 CONFIRMED** (Arm A N=4 fail rate 69.8% →
4.1%, N=8 88.5% → 14.1% — an 8–17x reduction; M1 materially fixed most of what round 1
measured, as a side effect of removing the O(n²) chunk store, not by design). **P2
CONFIRMED** (jit-staleness hold p95 ~284ms → 15–47ms, a 6–19x reduction; the hold
decomposition shows parse, not chunk storage, now dominates the shrunk hold — chunk
writes cost ~0.4ms mean, confirming the ~0.2ms/file prediction). **P3 REFUTED** (WAL
auto-checkpoint stalls, round 1's secondary finding above, did not get worse — zero
outliers >1500ms across 7,700+ calls this round, vs round 1's 10% at N=1 alone; most
likely explanation is that Lance's retired single-file rewrite, not graph.db's own
checkpoint cost, was the real contributor to round 1's stalls, though this was not
independently isolated). Arm B's fail rate similarly dropped ~8–15x at every N (97.5%/
71.2%/87.3%/92.2% → 8.8%/6.9%/6.2%/12.1%), driven by the reindex itself finishing ~60x
faster post-M1 (M1 result above), shrinking the collision window.

**New finding, more urgent than F11 itself**: `SQLITE_BUSY_SNAPSHOT` (the hazard the
R5 review's option (c) analysis flagged as "may be latent — today all callers hold
`structure.lock`") is **not latent** — it fired 52 times across 23 of 32 real,
correctly-lock-serialized Arm B reps (`indexer/index.ts:347`'s loud `writeErrors`
path), and separately, 22 times as a JIT-side failure that **bypasses F2's flag
entirely**: `checkAndRefreshIfStale` (`mcp/staleness.ts`) does not wrap its
`populateFile` call in any catch, so the exception propagates uncaught and the caller
receives a raw unparseable error string instead of `{ file_busy_returning_stale_cache:
true }`. Verified in code and reproduced in isolation (`err.code ===
'SQLITE_BUSY_SNAPSHOT'`, 5/5, immune to `busy_timeout`). Reported per the
measurement-only task's instructions — **not fixed**.

**Event-loop-freeze probe**: not observed, even under a raw-lock-bypass scenario more
severe than two real callers can currently trigger (both always take `structure.lock`
first) — a concurrent unrelated read returned in 29ms while a forced write was still
blocked mid-`busy_timeout` wait (5.26s total). De-risks, but does not eliminate, the R5
review's "freeze the whole event loop" argument for urgency.

**Sizing verdict for F11** (design verdict from round 1 unchanged — fail-fast on
disjoint-file refreshes is still wrong-by-design; this only sizes urgency/mechanism):
ship a small, targeted fix first — catch `populateFile`'s failure in
`checkAndRefreshIfStale` and degrade to `{ busy: true }` like a lock-acquisition
failure does, restoring F2's contract. Defer the full option (d) lock-free-read +
write-behind redesign (its "honest costs" — an in-memory overlay threaded through 8
tools' result assembly, repeated parse cost, match-vs-content skew — are real and no
longer offset by round-1-sized urgency) until evidence from a larger corpus (e.g. E1's
n8n rung, 12,641 files) shows the contention M1 incidentally fixed at nest's ~1,338-file
scale reappears at scale.

### D0 — CLI query surface (raised P2 → P1 by the R3 review, §14.8 item 3)

**The argument is architectural, not a feature request.** Every read tool is already a
thin wrapper over a pure function (`hybridSearch`, `querySymbolByName`,
`collectPotentialMatches`), so `mast query <tool> <json>` is ~40 lines of dispatch.

**Why it is P1:** the tools are reachable *only* over an MCP stdio transport. That is
the direct cause of how much of this investigation cost what it did — three throwaway
MCP clients had to be hand-written to test anything
(`mcp-call.mjs`, `mcp-call2.mjs`, `jit-probe.mjs` under `/Users/spikedpunchvictim/temp/mast-bench/`).
**Both adversarial reviews and the original benchmark found bugs the unit tests missed,
and the transport barrier is why those bugs were expensive to reach.** Every remaining
stage — especially Stage 3's call-graph verification and Stage 5's open questions —
pays that tax again until this lands.

**Also a correctness issue in its own right:** `mast --help` already advertises
*"semantic code search over an MCP **or CLI** surface"*. The CLI half does not exist.

**Success criteria**: every MCP read tool invocable from the CLI with identical output;
the three throwaway harness scripts become deletable; `--json` for machine use.
**Tests**: `cli/__tests__/cli.test.ts` — one `describe.each` over `(tool, args)` rows
asserting CLI output matches the tool's own result shape. Do **not** duplicate each
tool's behavioral tests at the CLI layer (§5.5) — assert dispatch and serialization only.

### D6 — the metric set (capture a baseline BEFORE each fix)

Numerators alone mislead; each pairs with a denominator or a spec claim.

| Metric | Catches | Today |
|---|---|---|
| `structure` lock hold max/p99, by caller | The Stage-1 P0. Falsifiable vs `MAST_SPEC.md:824` (10–50 ms) | 280,782 ms |
| `_versions` count/bytes vs file count | O(n²) storage growth | 2,756 / 176 MB |
| ms/file at ≥4 corpus sizes | Growth *law*, not a point | 51→93→184→364 |
| parse-only vs full-index ratio | Separates parser cost from write-path cost | 1.5 vs 184 ms/file |
| `POTENTIAL_CALL` by `resolution` **÷ source-side call sites** | F3/F4 regression | 1,038 ÷ (1,124 `this.` + 20 `super.`) |
| identifier_fts matches ÷ `potential_matches` returned | M4 silent truncation | 71 ÷ 50 |
| Per-tool p50 latency | Would have caught F8's 28 s | uncaptured |
| Useful state bytes ÷ total | Data vs manifest garbage | 21 MB ÷ 194 MB |
| Indexed extensions ⊆ config; no indexed path matches excludes | F9 (config ignored) | violated |
| `chunk_count > 0` / zero-result rate | M6 (empty state dir) | uncaptured |

**Note**: `eval/baseline-locks.json` and `eval/store-spike.json` are the first two
instalments; D6 is generalizing them into a repeatable suite rather than one-off files.
**Blocked on**: D2 (the harness must run against a pinned corpus to be comparable).

---

## Stage 5: Open questions — decide before building
**Goal**: Don't build on unexamined defaults.
**Status**: Not Started

| # | Question | Status |
|---|---|---|
| Q1 | Is the vector store justified at all? E4 is one-directional by design and the harness is rotted (§14.3) | Not Started |
| Q2 | Should generated/minified files be chunked at all? (451 KB single-line file → 232 `block` chunks) | Not Started |
| Q3 | `populateFile` FTS insert cost grows with index size (0.37→1.35 ms/KB *within* one run, order-independent) — survives the migration, matters at n8n scale | Not Started |
| Q4 | Live index is **83% unembedded** (`pending_embeddings: 4166`/5,030) — wire embedder completion, or stop reporting `mode: "hybrid"` | Not Started |
| Q5 | Result diversification in `mast_search` — no per-file dedup exists (`hybrid.ts:133` dedups shell↔method only). Held at P2: evidence was n=1 and confounded by lexical-only mode. **Re-test after Q1/Q4** | Not Started |
| **Q6** | **SQLite WAL auto-checkpoint stall on `graph.db` — periodic 1.7–3 s freeze, present even at N=1** (E7 secondary finding, previously unknown; unrelated to locking). Investigate `wal_autocheckpoint` / explicit checkpointing | Not Started |
| E5 | `mast index --checker` — untested. Does it convert enough truncated potentials into verified edges to justify §10.3.2's complexity? | Not Started |
| E6 | Cross-language: index `vscode`/`pulumi`; are non-TS files dropped **silently**, making `mast_project_skeleton` present a partial map as complete? (same false-green class as F5) | Not Started |
| E8 | GitNexus `impact`/`trace`/`rename` — **design study only**, per the §1 licence bar | Not Started |

---

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
