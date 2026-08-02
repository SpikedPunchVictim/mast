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
Current test count: **380 / 34 files** (re-measured 2026-08-01; the previously
recorded 366 / 30 had gone stale). `align check` on this branch: pre-existing
`verdict: red`, the same 2 violations, and `baselined debt: 324 → 327 (+3)` — the +3
is also pre-existing, confirmed by re-running with new files removed.

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
| M2 | Decide vectors: Lance vs SQLite BLOB + JS cosine vs `sqlite-vec` | **Blocked on Q1** (see below) |

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

### M2 framing (2026-08-01) — the option set is four arms, and two have no evidence

**Three facts verified in code before any option was weighed:**

1. **Lance's chunk half is dead code post-M1.** `LanceStore.replaceChunksForFile`,
   `deleteChunksForFiles`, `getChunksByFilePath`, `chunkCount`, `getAllChunks`,
   `getChunksByIds`, and `ensureChunksTable` have **zero non-test callers** — every
   consumer routes through `SqliteChunkStore`. On disk `.mast/lance/` now holds
   `vectors.lance` alone. So `@lancedb/lancedb` (**91 MB**,
   `@lancedb+lancedb-darwin-arm64@0.27.2`) is retained for exactly one table.
2. **The differentiator has never been switched on.** `grep -rn
   'createIndex|IvfPq|ivf_pq|create_index' src/` → **0 hits**, re-confirmed
   2026-08-01 (§14.1 found the same in R3). Today's "Lance arm" is a brute-force
   scan behind a 91 MB native binary: Lance's costs, none of its ANN benefit.
3. **Live state for calibration**: `graph.db` 129 MB, `vectors.lance` 25 MB
   (~4,280 of 14,449 chunks embedded), `embed_cache` 83 MB.

**Therefore the honest option set is four arms, not three:**

| arm | | measured evidence today |
|---|---|---|
| **A** | Lance **with IVF-PQ actually enabled** | **none** — never created |
| **B** | SQLite BLOB + JS brute-force cosine | 0.955 ms/864 vec → **169 ms** @153k; **470 MB** f32 |
| **C** | `sqlite-vec` | **none** — not a dependency |
| **D** | **Delete vectors entirely** | none directly; strong circumstantial (Q1) |

**Decided on paper now: arm B is eliminated, and [R6]'s retraction holds.** 169 ms of
scan against a current `mast_search` p50 of 144 ms more than doubles query latency at
the real target, and 470 MB resident is not acceptable in a task container. The
2026-08-01 batching falsification confirmed these inputs do not move — q8 and
multi-process affect *build* time only, not query cost or memory.

**A vs C cannot be decided today and no further prose will decide it** — both arms
have zero measurements. Choosing between them from reasoning alone would be the
"invent a number" anti-pattern the global process rules forbid.

**Sequencing decision: Q1 gates M2.** Arm D dominates A/B/C — a "no" on Q1 deletes the
91 MB dependency, the 7.2 h embed, the 470 MB, the forked embedder, and the whole
cold-start `mode: "lexical"` ladder, making the backend question moot. Q1 is also
cheaper than an A-vs-C benchmark. So Q1 runs first; A vs C is benchmarked only if Q1
justifies the subsystem.

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
| D2 | Repair `eval/` as a regression harness: `paths.mjs` points at a dead session; pin the corpus | **Complete** — see Q1 §D2 result |
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

## Stage 4.5: Scale — the actual target
**Goal**: MAST is "Monorepo AST search". Make the scale target explicit and measured,
because it changes several decisions already taken.
**Status**: Not Started

**Measured chunk counts** (mast defaults, `.ts/.tsx/.js/.jsx/.md`, test/spec excluded):

| corpus | files | chunks |
|---|---|---|
| **vscode** | 8,653 | **152,969** |
| **backstage** | 7,801 | **89,515** |
| **n8n** | 9,117 | **49,509** |
| strapi | 3,548 | ~23k (est) |
| kluster (self) | 1,799 | 14,212 |
| directus | 2,089 | 7,205 |
| nest | 1,333 | 5,030 |

**vscode is 10× kluster's own index.** Every measurement in this document was taken on
a 5k–14k chunk corpus. The real target is **150k+**.

### What breaks at that scale — and what doesn't

**Already sublinear, no work needed**: FTS5 is an inverted index (BM25 costs
O(matching docs), not O(total)); graph queries use covering indexes with sub-ms
recursive CTEs; incremental indexing is O(changed files) — 379 ms for one file at any
corpus size. Post-M1 chunk storage is O(N).

**The vector subsystem is the only component that degrades**, on three axes:

| | n8n 49.5k | backstage 89.5k | **vscode 153k** |
|---|---|---|---|
| Brute-force cosine (768-d, measured 0.955 ms/864 vec) | 55 ms | 99 ms | **169 ms** |
| Vector memory (f32) | 152 MB | 275 MB | **470 MB** |
| Embed time @ measured 5.88 chunks/s | 2.3 h | 4.2 h | **7.2 h** |

169 ms of scan against a current `mast_search` p50 of **144 ms total**.

### ~~🔴 The 7.2 h figure is an implementation artifact, not a model cost~~ — **FALSIFIED for batching (2026-08-01)**

> **Original claim (kept for the record):** `Embedder.embed()` accepts
> `chunks: readonly Chunk[]` but **loops one at a time**. Transformers.js accepts an
> **array** for batched inference; this does N separate forward passes. Compounding it:
> `dtype: 'fp32'` — no quantization — and a single forked worker (no multi-core).
> ⇒ "Q1/M2 are currently being decided against an embedder plausibly 10–20× slower than
> it should be."

**The batching component of that claim is now measured and false.**
Evidence: `eval/embedder-batching.json`; harnesses `eval/embedder-batching.mjs`
(arms E/D) and `eval/embedder-batching-lengthprobe.mjs`.

| arm (identical texts ⇒ zero padding) | speedup |
|---|---|
| batch-16 vs 16× sequential @ 64 tok | **1.09×** |
| batch-16 vs 16× sequential @ 514 tok | **1.00×** |

Per-chunk cost is flat across B=1…32. The mechanism: **`cpu/wall ≈ 5.9×` on a
`batch=1` call** (12 logical cores) — ORT's intra-op pool already saturates ~6 cores on
a single item, so batching has no parallelism left to claim. Worse, batching *adds*
failure modes: mixed-length batches pad to longest against unfused-ALiBi O(L²)
attention (a 16-chunk long batch measured ~59× slower than sequential), and a fixed
batch count with no token cap makes `[16,12,8192,8192]` fp32 ≈ **51.5 GB** reachable —
an OOM the per-chunk path structurally cannot hit.

**⇒ The batched-inference implementation was reverted** (preserved in `git stash`:
*"mast: batched-inference attempt — FALSIFIED"*). The 7.2 h vscode estimate **stands**.
It is not primarily an implementation artifact.

**Consequences:**
- **[R6] is no longer "pending a re-measure."** Its retraction of the M2 recommendation
  was predicated on fixing the embedder and re-measuring. That is done; batching was not
  the fix. R6 must be re-decided on its own merits.
- **Two levers remain live and untested**, and now carry the whole hypothesis:
  **`dtype: 'q8'` quantization** and **multi-process embedding**. Headroom for the
  latter is bounded — one process already draws ~6 of 12 cores.
- **Single-host caveat.** All of the above is Apple M2 Pro (ARM). ORT CPU kernels and
  thread-pool behaviour differ on x86 and in the SDD container; the "batch=1 already
  saturates" conclusion should be re-confirmed there before being treated as universal.

**Latent defect found while measuring, and still present:** `runEmbed`
(`indexer/index.ts:552–553`) slices pending chunks into 32-chunk windows, and
`selectPendingChunks` is a pure filter over `getAllChunks()`, so those windows preserve
**file order** — chunk lengths within a window are correlated, not random. Any future
batching attempt must account for this: a file with one large class yields adjacent long
chunks, so the pathological all-long batch arises routinely from file locality rather
than being a rare draw.

### [R6] M2 recommendation RETRACTED — ~~pending this~~ **now un-blocked, must be re-decided**

"Drop Lance, use SQLite BLOB + JS brute-force cosine" was scoped to ~14k chunks and
**inverts at the real target**: at 153k, brute force needs 169 ms and 470 MB, so an ANN
index becomes mandatory — which means Lance (has IVF-PQ, unused) or `sqlite-vec`, *not*
JS. Precedent: GitNexus caps embedding at 50k nodes by default and skips it above that.

**Status change (2026-08-01).** The retraction was explicitly "pending" a re-measure of
the embedder. That re-measure is complete and the embed cost did **not** move — batching
was falsified (see above), so the 7.2 h / 470 MB / 169 ms figures this retraction was
argued against all still hold. R6 is therefore no longer blocked on an embedder fix; it
is a live decision to be made on its own merits, against the *unchanged* numbers. The
only remaining way the inputs move is q8 and multi-process, and neither changes the
*query-side* brute-force cost (169 ms) or the *memory* cost (470 MB) that drive R6 —
they only affect build time. **R6 can be decided now.**

### Scaling levers that are NOT vectors, by leverage

1. **Scoping — highest leverage, already built, barely used.** `mast_project_skeleton`
   takes `directory`/`max_depth`; `mast_search` takes `file_pattern`/`chunk_type`/
   `only_exported`. A monorepo task touches 1–2 packages: scoping turns vscode into a
   5k-chunk problem, where every strategy works. Make the §12 prompt scope by default.
2. **Identifier decomposition at index time** — index `checkAuthToken` also as
   `check auth token` in a second FTS column. Makes conceptual queries hit *lexically*.
   Zero query cost, tiny index cost; best value/effort ratio here. (The zero-result
   assist already splits terms — this promotes it from fallback to first-class.)
3. **Graph expansion from lexical seeds** — a lexical hit expanded via
   `POTENTIAL_CALL`/`IMPLEMENTS`/`PARENT_OF` yields a semantic neighbourhood using
   indexes that already exist. This is what GitNexus's process-grouping does.
4. **Per-package / federated indexes** — one state dir per workspace package; query the
   relevant ones. Matches pnpm workspaces and makes reindexing parallel.
5. **Coarse-to-fine embedding** — embed only shells + top-level declarations
   (measured: `class_shell`+`function`+`interface`+`type` = 1,727 of 5,029 = **34%**),
   then use FTS/graph within the matched class. Cuts embed cost ~66%. Note
   `is_exported` filtering is NOT a useful lever — **81% of chunks are exported**.
6. **Result budgets (`maxTokens`)** — grows in value with corpus size.
7. **ANN** — only if vectors survive Q1, and only above ~50k chunks.

**The synthesis**: the subsystem costing 7.2 h to build, 470 MB to hold, and 169 ms per
query is the one whose value has *never been measured* (Q1/E4). And the live index has
been 83% unembedded — i.e. running lexical-only in practice — without anyone noticing a
quality problem.

---

## Stage 5: Open questions — decide before building
**Goal**: Don't build on unexamined defaults.
**Status**: Not Started

| # | Question | Status |
|---|---|---|
| **Q1** | **Is the vector store justified at all?** E4 is one-directional by design and the harness is rotted (§14.3). **Gates M2.** Pre-registered design below | **In Progress** |
| Q2 | Should generated/minified files be chunked at all? (451 KB single-line file → 232 `block` chunks) | Not Started |
| Q3 | `populateFile` FTS insert cost grows with index size (0.37→1.35 ms/KB *within* one run, order-independent) — survives the migration, matters at n8n scale | Not Started |
| Q4 | Live index is **83% unembedded** (`pending_embeddings: 4166`/5,030) — wire embedder completion, or stop reporting `mode: "hybrid"` | Not Started |
| Q5 | Result diversification in `mast_search` — no per-file dedup exists (`hybrid.ts:133` dedups shell↔method only). Held at P2: evidence was n=1 and confounded by lexical-only mode. **Re-test after Q1/Q4** | Not Started |
| **Q6** | **SQLite WAL auto-checkpoint stall on `graph.db` — periodic 1.7–3 s freeze, present even at N=1** (E7 secondary finding, previously unknown; unrelated to locking). Investigate `wal_autocheckpoint` / explicit checkpointing | Not Started |
| E5 | `mast index --checker` — untested. Does it convert enough truncated potentials into verified edges to justify §10.3.2's complexity? | Not Started |
| E6 | Cross-language: index `vscode`/`pulumi`; are non-TS files dropped **silently**, making `mast_project_skeleton` present a partial map as complete? (same false-green class as F5) | Not Started |
| E8 | GitNexus `impact`/`trace`/`rename` — **design study only**, per the §1 licence bar | Not Started |

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

---

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
   commit `c5f4486`. Stop rule fired: decomposition-as-a-fused-ranker is a **regression**
   ((L+D)−L = −0.1661, t=−2.333 on kluster-normal; Recall@10 1.000 → 0.727). See
   "Q1/RESERVE RESULT" above.
2. ~~**RESERVE-2 — second-COLUMN construction**~~ — **DONE 2026-08-02** (registration `a042cb1`). Decomposition tested in both constructions across two tokenizers; does not live, reserve discharged. Old text: The Reserve
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
