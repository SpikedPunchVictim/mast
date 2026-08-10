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
**Status**: Complete (2026-08-07) — all eight items shipped; F11 closed the stage
(narrow-role locking; option (d)'s overlay half deferred per E7-r2, see the F11
result block). Success criteria met: every read tool either JIT-refreshes or
stat-and-flags (F7), no busy signal is droppable (F2/F13/F14), and the E7
reader-vs-reader contention class is dissolved by construction (F11).

| # | Task | Status |
|---|---|---|
| 0 | Instrument `withLock` acquire/hold duration + baseline | **Complete** |
| F2 | Wire the discarded `busy` signal to `file_busy_returning_stale_cache` | **Complete** |
| F1 | `withLock` scope: whole-run → per-batch (`indexer/index.ts:46`) | **Complete** |
| **F12** | **🔴 SILENT-CORRUPTION BUG INTRODUCED BY F1 — stamp/content ordering inverted. Fix first, ~5 lines** | **Complete** |
| **F13** | ✅ `SQLITE_BUSY_SNAPSHOT` in `populateFile` escapes `checkAndRefreshIfStale` uncaught — bypasses F2's flag and violates §9.0's "do not throw". Fired 52× in real runs | **Complete** |
| **F11** | **Replace fail-fast advisory locking** — E7 falsified the current design. **Urgency downgraded by E7-r2**, design verdict unchanged | **Complete** |
| **F14** | **`mast_signature` drops the busy flag when the symbol query returns 0 results** — `topLevelBusy` (`signature.ts:55`) is only consumed inside the per-result loop (`:76`), so an empty result set discards it. Worst case: "no results" + stale index reads as "symbol doesn't exist" | **Complete** |
| F7 | Staleness for `mast_search` / `mast_implementors` (stat-and-flag, not refresh) | **Complete** |

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

### F14 result (2026-08-07) — empty-result busy flag shipped

The dropped signal now surfaces on the response envelope: `SignatureResponse`
gains `file_busy_returning_stale_cache?: true`, set **only** when a
`file_path`-narrowed query returns zero results AND that file's JIT re-parse
could not acquire `structure.lock` (`topLevelBusy && results.length === 0` in
`signature.ts`). Non-empty responses are unchanged — the flag stays per-result,
never duplicated onto the envelope (same envelope-vs-per-entry reasoning as
`CallersResponse`). The `file_path`-omitted empty case has no JIT and therefore
no busy state to report — correct by construction, out of scope. Reproduced RED
first (`tools.test.ts`, "F14 empty-result envelope flag": envelope flag
`undefined` on unfixed code), plus omitted-when-lock-free and
no-envelope-duplication guards. Suite 451/35 (448 + 3 new, same files), tsc
clean, lint clean, `pnpm align:check` 324→324 (+0), same 2 pre-existing
non-mast violations. MAST_SPEC §9.0 result-shape note updated to name the
empty-result envelope carrier.

### F7 result (2026-08-07) — stat-and-flag staleness shipped

`mast_search` and `mast_implementors` were the last two read tools performing
**no** staleness check at all — the exact P0 class Stage 1 exists to
eliminate (`eval/GITNEXUS_COMPARISON.md` §13.3: a 20-lines-stale file
returned `start_line 161` vs ground truth 181, unflagged).

**Design: stat-and-flag, not JIT-refresh.** `mast_signature` / `mast_exports`
/ etc. re-parse a stale single file under `structure.lock` (§9.0's original
JIT policy). That doesn't generalize to `mast_search` / `mast_implementors`:
both can return results spanning dozens of files, so a naive per-result JIT
refresh would mean up to ~50 `structure.lock` acquisitions on one call, AND
re-parsing a result file mid-response could shift its rank, gain/lose a
match, or change its chunk boundaries — invalidating the very ranking that
selected the result being "refreshed" (§13.7). So for these two tools only:
after results are computed, `statSync` each **unique** result `file_path`
(no lock, no re-parse, no DB write) and compare disk mtime against the
`files` table's stored mtime. Newer-on-disk or a failed stat (deleted/
renamed file — coordinates are definitely untrustworthy) sets
`file_busy_returning_stale_cache: true` on that result; a path absent from
`files` (nothing indexed to be stale against) is left unflagged.

**Shared helper**: `findStaleFiles(db, config, filePaths)` in
`src/mcp/staleness.ts`, returning a `ReadonlySet<string>` of paths to flag.
Both tools call it once with their deduplicated `filesReferenced` list (one
batched `where('path', 'in', ...)` query, guarded for the empty-array case
per the codebase's existing convention — `store/sqliteChunkStore.ts`,
`search/fts.ts`, `graph/queries.ts` all early-return before an empty `in`).
`search.ts` and `implementors.ts` map their results to spread the flag on
*before* `JSON.stringify` for token counting, so `_stats.tokens_returned`
reflects the flagged payload actually returned — `fusedSearch` itself is
untouched; flagging happens at the tool layer only, per the eval
instrumentation's no-contamination rule.

**Type change**: `ImplementorResult` (`ast/types.ts`) gains
`file_busy_returning_stale_cache?: true` with a WHY-comment explaining the
stat-and-flag (not re-parse) semantics; `SearchResult` already declared the
field (F2, never previously set).

**Red-first evidence**: 6 new tests in a new `F7 — stat-and-flag staleness
(mast_search / mast_implementors)` describe block in `tools.test.ts`
(isolated tmpdir/db/ctx, same reasoning as the F2 suite — forcing on-disk
mtimes to the future would leak into other describe blocks' line-number
assertions). With `staleness.ts`/`types.ts`/`search.ts`/`implementors.ts`
reverted, 4 of the 6 failed with `AssertionError: expected undefined to be
true` (the two happy-path tests passed trivially, as they assert *absence*
of the flag) — a genuine assertion failure, not an import/syntax break.
Tests cover: stale file flagged / fresh file not (two-file search), a
second call still flags the same file (proves no refresh happened), a
deleted-after-indexing file's results flagged, an all-fresh happy path with
no flags anywhere, and the `mast_implementors` equivalents (one stale
implementor flagged, the other not; happy path unflagged).

**Verification**: full suite 457/35 (451 baseline + 6 new, same file count),
`tsc --noEmit` clean, `eslint` clean, `pnpm align:check` `baselined debt: 324
→ 324 (+0)`, red on the same 2 pre-existing violations (`root-layout.tsx`
cycle, `fold-build-record-repository.ts`), neither naming `mast`.

**Known naming tension, deferred to C1**: this reuses
`file_busy_returning_stale_cache` for a signal that is not actually about
`structure.lock` contention — `mast_search`/`mast_implementors` never
attempt to acquire the lock, so nothing is ever "busy" in the sense the
other tools' flag means. Per the task brief, inventing a second field name
here was explicitly out of scope; C1 ("unify confidence signals") is where
`stale`/`file_busy` get properly split apart.

**[renamed to `stale` by C1, 2026-08-09]**

### F11 result (2026-08-07) — narrow-role locking shipped

Shipped the plan's own "minimum viable outcome" (R5 review verdict, this
section above): **`structure.lock` narrows to a coarse-writer role; the JIT
path stops using it entirely.** Not option (d)'s full lock-free-read +
write-behind overlay — that half stays deferred, see the last paragraph
below.

**Design implemented**:
1. **JIT path** (`mcp/staleness.ts`'s `checkAndRefreshIfStale`): the
   `acquireLock` call is gone. Staleness detection (`stat()` vs stored
   mtime) and the TOCTOU parse-retry are unchanged; once a re-parse
   succeeds, the write goes straight to `populateFile` with no lock
   acquisition attempt at all.
2. **`populateFile`** (`graph/populate.ts`, shared by JIT and reindex) now
   opens its transaction with `BEGIN IMMEDIATE` instead of Kysely's
   deferred `BEGIN`, wrapped in a dedicated `busy_timeout` of
   **`IMMEDIATE_WRITE_BUSY_TIMEOUT_MS = 200`** (an exported constant with a
   full WHY-comment on-site) — set before `BEGIN IMMEDIATE`, restored to the
   connection's shared 5000ms default (`DEFAULT_BUSY_TIMEOUT_MS`) in every
   exit path (success, body error, and the `BEGIN IMMEDIATE` failure itself,
   which has nothing to roll back). On `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT`
   exhaustion, `checkAndRefreshIfStale`'s existing F13 retry-then-map loop
   (unchanged, `MAX_POPULATE_RETRIES = 1`) still returns
   `{ refreshed: false, busy: true }` — never a throw.
3. **Coarse writers are untouched**: `mast index` / the startup reindex,
   `mast_reindex`, the manifest/`index.json` phase (`writeFileSync`, which
   SQLite can never coordinate), and the checker-resolver flush all still
   acquire `structure.lock` with their existing retry policies.
   `insertEdges`'s transactionless RMW still runs only inside reindex pass 2
   under that same lock. `removeDeletedFiles` and `SqliteChunkStore`'s
   write methods (test-only `ChunkWriter` seam, unused in the production
   path) were deliberately left on Kysely's plain `db.transaction()` —
   neither participates in JIT, so F11's scope does not reach them.
   **`structure.lock`'s narrowed role**: the ONLY thing it still protects is
   what §"What structure.lock genuinely protects" above identified —
   coordinating the plain-JSON manifest phase against everything else, plus
   giving reindex batches a coarse, bounded-wait queue among themselves and
   against the CLI. It no longer participates in JIT at all.

**`BEGIN IMMEDIATE` mechanism chosen: option (a), `db.connection()` +
raw statements — and why**. Kysely's better-sqlite3 driver hardcodes a
plain `BEGIN` (`sqlite-driver.js`'s `beginTransaction`,
`CompiledQuery.raw('begin')`) with no config knob for `IMMEDIATE`. Option
(b) (a custom driver subclass overriding `beginTransaction` globally) was
rejected: `IMPLEMENTATION_PLAN.md`'s own audit requirement — "verify no
read-only transaction path exists that would newly take write locks" — held
up under inspection (every `db.transaction()` call site in `src/` is a
write: `populateFile` x1 remaining caller, `removeDeletedFiles`,
`SqliteChunkStore.replaceChunksForFile`/`deleteChunksForFiles`), so (b)
would have been *safe*, but it would also have made every one of those
OTHER writers immediate for no reason this task asked for, and it offers no
way to scope the short `busy_timeout` to JUST `populateFile`'s window
without a pragma toggle around every transaction, not only this one. Option
(a) — `db.connection().execute(async (conn) => { ...raw 'begin immediate' /
'commit' / 'rollback'... })` — scopes both the `IMMEDIATE` semantics and the
short `busy_timeout` to exactly this one transaction, so it was chosen.

**Race-freedom of the busy_timeout toggle and the raw-statement sequence**:
the pragma set/restore and the `begin immediate`/`commit`/`rollback`
statements all run inside the SAME `db.connection().execute()` callback,
against the SAME checked-out connection, so nothing external can interleave
a statement into that window — this was not just asserted from the plan
brief's phrasing but independently verified two ways: (1) reading
`kysely`'s `RuntimeDriver` (`runtime-driver.js`) shows that because the
SQLite adapter reports `supportsMultipleConnections: false`, EVERY
connection acquisition on a given `Db` instance — via `db.transaction()`,
`db.connection()`, or a plain query — is serialized through one
`ConnectionMutex`; (2) empirically, a throwaway script ran 20
independently-staggered (random 0–30ms start delay, random 0–20ms
in-transaction delay via real `setTimeout`, not just back-to-back
synchronous calls) concurrent `db.connection().execute()` transactions
against one shared `Db` — zero interleaving errors, all 20 rows landed. A
second script confirmed the contended path directly: a real second
better-sqlite3 connection holding `BEGIN IMMEDIATE` made a
`db.connection()`-based transaction wait ~229ms (matching the 200ms
`busy_timeout` plus overhead) and then fail with `SQLITE_BUSY`, with the
pragma correctly restored to 5000 afterward and the shared connection left
in a clean, reusable state (verified via a follow-up successful insert). A
third script confirmed rollback-then-restore on a genuine mid-transaction
error (`SQLITE_CONSTRAINT_UNIQUE`) behaves the same way. This closes the gap
between "Kysely says `SingleConnectionProvider` serializes checkouts" (true
only for NESTED calls reusing an already-checked-out connection) and the
actual mechanism that matters here (`ConnectionMutex`, guarding the
OUTERMOST acquisition too) — both had to hold for the design to be safe
against same-process concurrent JIT writes, and both were verified rather
than assumed.

**E7 contention class dissolved by construction**: E7's root cause was
`structure.lock` being one global, no-file-component lock
(`store/lock.ts`'s `markerPath`), so a JIT re-parse of file A blocked a JIT
re-parse of file B despite disjoint rows — 35–88.5% JIT failure rates under
pure reader-vs-reader concurrency with zero reindex running. Removing the
lock from this path entirely means two JIT refreshes of different files
now run their parse step (the dominant cost per E7-r2: hold p95 15–47ms,
chunk writes ~0.4ms mean) fully in parallel, with no shared resource to
contend over until each reaches its own `populateFile` write — which
serializes same-process siblings cheaply via `ConnectionMutex` (no I/O, no
real wait) and governs genuine cross-connection contention (a concurrent
reindex batch, or another `mast serve` process) via `BEGIN IMMEDIATE`'s
honest bounded wait instead of a fail-fast lock retry.

**Test migration**: the F2/F14 busy-flag suites in
`src/mcp/tools/__tests__/tools.test.ts` used to force `busy` by holding
`structure.lock` (`holdStructureLock` + `makeStale`) — with JIT no longer
touching that lock, this forcing mechanism now produces a successful
refresh instead, breaking 8 of the suite's existing assertions. Replaced
with `holdWriteLock`: a second raw better-sqlite3 connection to the SAME
`graph.db` holding a genuine `BEGIN IMMEDIATE` write reservation — the
condition `populateFile`'s own transaction now actually contends against.
All 8 migrated tests kept their exact `busy`-flag expectations (F2's
envelope-level cases across `mast_exports`/`mast_dependencies`/
`mast_callers`/`mast_rename_impact`, `mast_signature`'s per-result case, and
F14's three empty-result-envelope cases), renamed only where "lock" language
needed to become "contended write" language. `holdStructureLock` itself was
KEPT (not deleted) — it is now used by exactly one test, described next.
Two new tests were added:
- **`F11 inversion`** (`describe('F11 inversion — holding the old
  structure.lock no longer gates JIT')`) — the behavioral proof of F11: make
  a dedicated `inversion.ts` fixture stale, hold the OLD advisory lock via
  `holdStructureLock`, call `mast_exports`, and assert BOTH that the
  response carries no `file_busy_returning_stale_cache` flag AND that its
  `exports` array contains a symbol only present in the NEW file content —
  the stronger assertion proves a real re-parse happened, not merely that
  staleness went undetected.
- **`F11 bounded freeze`** — with a `holdWriteLock` holder genuinely
  contending, a `mast_exports` call against a stale file returns
  busy-flagged in asserted `< 2000ms` wall-clock, proving the dedicated
  200ms `busy_timeout` — not the inherited 5000ms connection default — governs
  this path, per the HARD CONSTRAINT section below.

**Red-first evidence** (both runs done by temporarily reverting only
`graph/populate.ts`, `mcp/staleness.ts`, and `store/lock.ts` via `git
stash`, keeping the already-updated test file, then restoring): (1) the
full pre-migration suite run (updated production code, unmigrated tests)
showed exactly the predicted 8 failures, all `AssertionError: expected
undefined to be true` at the `file_busy_returning_stale_cache` assertions —
475 passed / 8 failed, same file count. (2) Running the NEW/migrated tests
against REVERTED (pre-F11) production code: the `F11 inversion` test failed
for precisely the intended reason — `expected ... to not have property
"file_busy_returning_stale_cache"` / received `true`, i.e. the OLD advisory
lock still forced busy on old code, which is exactly the behavior F11
removes. The migrated F2/F14 tests and the bounded-freeze test, run against
the SAME reverted code, all PASSED — worth recording precisely rather than
glossing over: `holdWriteLock` bypasses `structure.lock` entirely (it never
touches it), so on old code the JIT path still acquired the now-irrelevant
advisory lock for free, reached `populateFile`'s pre-F11 deferred-`BEGIN`
read-then-write, and hit the SAME `SQLITE_BUSY_SNAPSHOT`/`SQLITE_BUSY`
condition the already-shipped F13 retry-then-map already classifies as
`{ busy: true }` — just via the 1–2ms fast-fail path (per the HARD
CONSTRAINT section's Phase 2/3 finding) instead of a lock-acquisition
failure. That both mechanisms independently converge on the same observed
contract is a genuine finding, not a shortcoming of the red-phase check: it
confirms F2/F14's `busy`-flag contract survived the redesign unbroken, while
the `F11 inversion` test is the one assertion in this suite that actually
depends on WHICH mechanism is doing the gating, which is exactly why it
was written.

**Verification**: full suite 485/37 (483 baseline + 2 new tests, same file
count — the F11 inversion and bounded-freeze tests; no test was deleted,
only migrated), `tsc --noEmit` clean, `eslint` clean, root `pnpm
align:check` unchanged: `baselined debt: 324 → 324 (0)`, red only on the
same 2 pre-existing non-mast violations (`application/ui/.../root-layout.tsx`
import cycle, `application/api/.../fold-build-record-repository.ts`'s
`apiDomain`→`apiDb` dependency violation).

**Deferred, on the record**: option (d)'s in-memory overlay / lock-free-read
half — decoupling response freshness from index persistence entirely,
threading an overlay through 8 tools' result assembly — is explicitly NOT
implemented here. It remains deferred per the E7-r2 sizing verdict (Stage 4
above) until scale evidence from a larger corpus (E1's n8n rung, 12,641
files) shows the contention M1 incidentally fixed at nest's ~1,338-file
scale reappears. Nothing shipped in F11 forecloses building it later: the
overlay would sit in front of `checkAndRefreshIfStale`'s existing
stat-then-refresh call, which is unchanged in shape (still synchronous
staleness detection, still a bounded write attempt, still a `busy` signal on
failure) — only the write mechanism underneath it (advisory lock → `BEGIN
IMMEDIATE`) changed.

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
**Status**: Complete (2026-08-07) — M1 shipped earlier; M2 resolved as **arm D (delete)**
via the M2 DECISION MEMO (2026-08-04, below) and executed as Stage 7. The A-vs-C backend
benchmark was cancelled, not deferred (memo condition 6).

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
**Status**: Complete (2026-08-09) — F3/F4/F5/F10 all shipped. The corpus
edge-count success criterion below (1,038 → toward 1,124 `this.` + 20
`super.`) remains E2's registered measurement — Stage completion does not
claim it; see each result's "What is explicitly NOT claimed" note.

| # | Task | Status |
|---|---|---|
| F3 | `parseCallee`: unwrap `await_expression` (`typescript.ts:1360`) — one line | **Complete** |
| F4 | Implement `this.` / `super.` resolution (documented in §10.3.1, never built) | **Complete** |
| F5 | `mast_callers` potential set for methods — **design change**, see below | **Complete** |
| F10 | Surface `potential_truncated` (silent cap at 50; real count was 71) | **Complete** |

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

### F3+F4 result (2026-08-09) — await unwrap + this/super resolution

**Design: ride the existing receiver-binding machinery, no parallel mechanism.**
Both tasks extend `LocalTypeEnvironment`'s existing typed-receiver path
(`local-type-env.ts`) rather than adding a second resolution mechanism — F4 in
particular seeds `this`/`super` as ordinary receiver bindings the same way
`field_type`/`parameter_type` already work, so `resolveCall` and
`resolveCallTarget`'s per-rule file-scoping needed no new *kind* of machinery,
only two new resolution-rule branches.

**F3 — await unwrapping, three shapes verified via a tree-sitter S-expression
dump against the current `tree-sitter-typescript` grammar** (a throwaway probe
test, deleted before commit):
- `(await x).m()`: the member_expression's `object` field is
  `parenthesized_expression(await_expression(identifier))` — three levels deep.
  `receiverString` (`typescript.ts`) now unwraps this specific shape via a new
  `unwrapAwaitedReceiver` helper, applied before the existing
  identifier/`this.field`/`this`/`super` dispatch, so `x`'s existing binding
  (parameter, field, etc.) applies unchanged.
- `await x.m()`: `await_expression` wraps the whole `call_expression` directly
  (not the receiver) — `collectCalls`'s recursive visit already reaches the
  inner `call_expression` (it does not skip `await_expression`), and
  `parseCallee` already read its `function` field correctly. This shape needed
  no code change; only a pinning test (`await this.users.create(x)`, asserting
  `field_type`).
- `x.m<T>()`: `call_expression`'s `function` field is unaffected by an
  intervening `type_arguments` node — `childForFieldName('function')` returns
  the `member_expression` regardless. No code change; pinning test only.
- Confirmed unchanged: `const y = await makeFoo(); y.bar()` still produces no
  edge — F3 unwraps syntax around an *already-bound* receiver, it does not run
  type inference through an assignment. §10.3.1's "does NOT catch" list is
  unchanged.

**F4 — this./super. resolution, two new `CallerResolution` values**
(`ast/types.ts`): `'this_method'` and `'super_method'`, additive TEXT values
in the `edges.resolution` column — no schema bump, same precedent as
`'checker'` (MAST_SPEC.md §6.3's comment already documents `'checker'` as
schema-free-additive; grepped `packages/mast/src` and `graph/db.ts`'s schema
DDL for any `CHECK`/enum constraint on the column — none exists, so nothing at
the DB layer needed updating).
1. `receiverString` gained two branches: a bare `this` node (tree-sitter type
   `'this'`) → the literal string `"this"`; a bare `super` node (type
   `'super'`) → `"super"`. Verified via the same S-expression dump: in
   `this.helper()`, the member_expression's `object` field is the `this` node
   itself (not a nested member_expression), so this sits alongside — not
   inside — the pre-existing `this.field` special case (which handles
   `this.repo.findByEmail()`, an unrelated shape where `this` is the *inner*
   node of a nested member_expression).
2. `emitClassEdges` (`typescript.ts`) now builds one `classScopeBindings` array
   per class — the renamed `fieldBindings` plus `{ receiver: 'this', type:
   className, resolution: 'this_method' }`, and, only when the class's
   `extends_clause` named a parent (`baseClassName`, captured at the same site
   that already emits the `EXTENDS` edge, so the binding and the edge can never
   disagree), `{ receiver: 'super', type: baseClassName, resolution:
   'super_method' }`. Passed to `emitCallEdges` for every method in the class,
   which seeds them into that method's `LocalTypeEnvironment` alongside the
   field bindings — `resolveCall('this', 'foo')` then yields
   `{ callee: 'ClassName.foo', resolution: 'this_method' }` through the
   unmodified generic receiver-type path. No extends clause → no `super`
   binding seeded → `super.foo()` calls fall through to `identifier_fts`'s
   `potential_matches` set, exactly as the mandate requires (never guess).
3. **Nested-function shadowing guard.** `collectCalls` already skipped
   `function_declaration`/`method_definition`/`class_declaration`/
   `abstract_class_declaration` (their calls belong to their own scope, per
   the pre-existing comment). Verified via the S-expression dump that this
   list was incomplete for `this`-shadowing purposes: `function_expression`
   (anonymous `function(){}` and named-expression forms) and the two
   generator forms (`generator_function_declaration`,
   `generator_function`) are distinct tree-sitter node types not covered by
   the existing list, and each introduces its own dynamic `this` exactly like
   `function_declaration` does. All three were added to the skip list with a
   WHY-comment. **Arrow functions were confirmed absent from the skip list
   (unchanged)** — they inherit the enclosing scope's `this` by JS semantics,
   confirmed via the dump that `collectCalls`'s visit descends into
   `arrow_function` bodies normally, so a `this.helper()` call inside an arrow
   nested in a method still reaches the same shared `LocalTypeEnvironment` and
   resolves to `this_method`.

**`resolveCallTarget` file-scoping for the two new labels** (`populate.ts`):
- `'this_method'`: resolved by a new `resolveSameFileScoped` helper — the
  identical file-scoped lookup `'same_file'` already used (extracted out, not
  duplicated), keyed on the qualified `ClassName.methodName` toName instead of
  a bare name. Correct because `emitClassEdges` only ever seeds the `this`
  binding from the class node it is currently walking — the class is
  guaranteed declared in the calling file.
- `'super_method'`: resolved by a new `resolveQualifiedNameScoped` helper —
  the identical two-step lookup `'field_type'`/`'parameter_type'`/
  `'new_expression'` already used (import's `resolved_path` first, following
  the re-export chain; then same-file declaration), also extracted out of
  those three cases rather than duplicated a fourth time. The one behavioral
  difference: `onUnresolved` is a caller-supplied continuation —
  `field_type`/`parameter_type`/`new_expression` still pass
  `legacyGlobalFirstMatch` (unchanged, pre-existing coverage-gap fallback);
  `super_method` passes `async () => null`, so an unresolvable parent class
  name (ambient/global type, or a shape the resolver doesn't track) drops the
  edge instead of guessing across the whole graph — the mandate's "no bare-name
  global fallback for these new rules."

**Red-first evidence.** New tests were written against the unfixed code first
and run via `pnpm exec vitest run` (not a stash/pop — no production file
needed reverting since the F3/F4 code did not exist yet at test-writing time).
First run: **5 failed / 20 passed** (25 total in the two touched files) — all
5 failures were `expected undefined not to be undefined` (assertion-level,
proving each test exercises a real, then-missing behavior, not a broken
import): `(await repo).findById(id)` (F3 receiver unwrap), `this.helper()`
resolution, `super.base()` resolution, and `this.helper()` inside an arrow
(F4, three failures). Four tests in the same red run passed "for free" before
any F3/F4 implementation existed — `await x.m()` and `x.m<T>()` (already-working
shapes, F3 pinning only), no-super-without-extends, and no-`this`-inside-a-
nested-`function_declaration` (the pre-existing skip already covered that one
shadowing case) — confirming those assertions describe already-correct
behavior rather than untested gaps. Implementing `unwrapAwaitedReceiver`, the
`this`/`super` `receiverString` branches, `classScopeBindings` seeding, the
three-form skip-list extension, and the two `resolveCallTarget` branches
turned all 5 green with no regressions elsewhere.

**Test design.** Pure-layer coverage
(`ast/extractors/__tests__/call-edges.test.ts`, +9 tests: 4 F3 + 5 F4) follows
the file's existing `edgesOf`/`potentialCalls` fixture pattern exactly. One
integration test (`graph/__tests__/verified-callers.test.ts`, +1 test) drives
`populateFile` + `insertEdges` directly (the file's established
`populateFixture` helper) and asserts `queryVerifiedCallers` returns a
`this_method`-resolved caller — proving `resolveCallTarget`'s new branch is
actually wired into the real pipeline, not just reachable in the pure
extractor. `super_method` was deliberately NOT given a second full-pipeline
test: `resolveQualifiedNameScoped` is the identical helper `field_type`
already exercises end-to-end via the Q4b/barrel-chain/ambiguity-fallback
tests in the same file, so a second integration test would duplicate coverage
those already provide (§5.5 test budget) — the `super_method`-specific
behavior (the `async () => null` fallback and the binding-seeding condition on
`extends`) is fully covered at the pure layer instead.

**What is explicitly NOT claimed here.** No corpus-level before/after
`POTENTIAL_CALL` edge count was measured against a real external corpus — the
Stage 3 "Success criteria" above (1,038 → toward 1,124 `this.` + 20 `super.`
call sites) is E2's registered measurement, a separate experiment requiring
pre-registration per the project's methodological rules (HANDOFF §6). This
task's evidence is unit-level only: the resolver now produces `this_method`/
`super_method` edges where it previously produced none, proven by the tests
above; whether that closes the corpus-measured gap awaits E2.

**Verification** (from `packages/mast`): `pnpm test` — **538/538 passed, 37
files** (baseline 528/37; +10 net new tests — 9 pure-layer + 1 integration).
`pnpm typecheck` — clean. `pnpm lint` — clean. Repo-root `pnpm align:check` —
`baselined debt: 324 -> 324 (0)`, red only on the 2 pre-existing non-mast
violations (`application/ui/src/views/root-layout.tsx` import cycle;
`application/api/src/domain/spec/fold-build-record-repository.ts` domain→db
import) — unchanged from C1's verification, confirming F3/F4 introduced no
new architecture drift.

**Deviations**: none from the mandated design. **Noticed but not done**: F5
(qualified names in `identifier_fts`) and F10 (`potential_truncated`) remain
unimplemented — explicitly out of scope per the task brief; Stage 3's overall
`Status` is left as "In Progress" rather than "Complete" to reflect this.

### F5 result (2026-08-09) — qualified identifiers indexed

**The defect.** `mast_callers`/`mast_rename_impact` document `'Class.method'` as
the query convention for a method symbol. `searchIdentifiers` (`search/fts.ts`)
phrase-quotes the term before querying `identifier_fts`, and that table's
`unicode61` tokenizer treats `.` as a separator (`graph/db.ts`'s DDL). A phrase
match therefore requires the tokens `Class` and `method` to sit at ADJACENT
positions in the row's `identifiers` column. `identifier_fts` rows were built
purely from `extractIdentifiers` — a regex over raw chunk text that extracts
every BARE `\w+` token, deduplicates, and whitespace-joins — which essentially
never places a class name immediately before a same-chunk method name (the two
tokens are separated by the rest of the chunk's vocabulary between them). The
potential set for any method query was therefore silently empty
(`eval/GITNEXUS_COMPARISON.md` §13.4/§6.4a), independent of whether a real
caller existed — 58% of symbols in the eval corpus are methods.

**The shipped design (as mandated, no relitigation of the choice).** The
extractor now emits QUALIFIED compound strings — literal `"Class.method"` text
— into each chunk's identifier row, appended after the bare bag and
deduplicated. This was chosen over indexing the unqualified leaf name (`method`
alone), which would have widened the potential set ambiguously across classes
(`Foo.close` vs `Bar.close` both firing on a bare `close` query) — exactly the
imprecision `mast_callers`'s "review required, not verified" contract cannot
absorb silently.

Two sources feed the compounds, both riding the SAME `LocalTypeEnvironment`
resolution `extractEdges` already computes for `POTENTIAL_CALL` edges — no
parallel mechanism, same precedent as F3/F4:
1. **Declaration self-discoverability.** Every `method`-chunk's own qualified
   `symbol_name` (already `${className}.${methodName}` at construction —
   constructor/getter/setter forms included, since they share the same naming)
   is appended to its OWN identifier row. This makes `mast_rename_impact`'s
   documented "the declaration typically appears in `potential_matches`" claim
   actually true for methods.
2. **Resolved call-site mentions.** In `TypeScriptExtractor.extract()`, after
   `edges` is built, every `POTENTIAL_CALL` edge whose `toName` contains `.`
   (i.e. `LocalTypeEnvironment.resolveCall` matched a receiver binding —
   `field_type`, `parameter_type`, `new_expression`, `this_method`, or
   `super_method`) is grouped by `fromName` and appended to the matching
   CALLING chunk's identifier row (matched by `chunk.symbol_name === fromName`,
   the same qualified name `emitCallEdges` used as scope). Deriving this from
   the already-computed `edges` array (rather than re-walking the AST or
   threading a new return value through `extractEdges`) meant `extractEdges`'s
   existing signature — and all 16 tests in `call-edges.test.ts` that assert
   against it directly — needed zero changes.

   This also HEALS a case F3/F4's own "noticed but not done" left open:
   extraction and `insertEdges`' DB-layer resolution are independent passes.
   When a receiver's type is imported from an unresolvable specifier (external
   package, broken relative path), `resolveQualifiedNameScoped`
   (`graph/populate.ts`) finds the import row but a `null` `resolvedPath` and
   returns `null` with NO fallback — the edge never reaches `graph.db`, even
   when an unrelated file coincidentally declares a same-named qualified
   symbol. The qualified compound is emitted regardless (extraction never
   looks at import resolution), so the mention still surfaces in
   `potential_matches` instead of vanishing. Proven by the tool-level test
   below.
3. **Genuinely-unresolvable receivers contribute nothing — honestly.** DI
   container lookups, factory return types, chained calls without
   intermediate binding, dynamic dispatch, and generic type parameters
   (§10.3.1's documented "does NOT catch" list) never produce a
   `LocalTypeEnvironment` binding, so `resolveCall` returns `null`, no
   `POTENTIAL_CALL` edge exists, and no qualified compound is ever added for
   that call site — F5 does not guess. This residual gap is real and is
   `mast index --checker` / future-work territory, not this fix's; MAST_SPEC.md
   §10.3.1 now says so explicitly instead of the previous (overstated, for
   qualified queries) blanket claim that an unresolved identifier "still lands
   in `identifier_fts`."
4. **Markdown** contributes no identifier rows at all — unchanged; nothing in
   this task touches `MarkdownExtractor`.

**Mechanism verification — the adjacency claim.** `graph/db.ts`'s
`identifier_fts` DDL tokenizer is
`"unicode61 separators '.-_/()[]{}<>:;,=+*&|!?'"` — `.` is explicitly a
separator, so a stored value like `"... Bar.close"` tokenizes into two
POSITION-ADJACENT tokens (`bar`, `close`), which is exactly what
`searchIdentifiers`'s phrase-quoted `MATCH '"Bar.close"'` requires. Proven at
the real-pipeline level (`search/__tests__/fts-query.test.ts`, new describe
block `searchIdentifiers — qualified compounds (F5)`, 2 tests) rather than
asserted from documentation:
- **Positive match, two independent chunks.** A `UserRepository` class in one
  file (declaration) and an `AuthService` calling `this.repo.findByEmail()` in
  another (field-typed mention) — `searchIdentifiers(db, 'UserRepository.findByEmail')`
  returns chunk ids resolving to BOTH the declaration chunk and the calling
  chunk.
- **Cross-class precision, adversarial single-chunk fixture.** One chunk
  (`Caller.run`) is engineered to contain the qualified compound `Bar.close`
  (a real resolved call) AND the unrelated bare token `Foo` (an unused
  constructor-param-property annotation) in the SAME row, with `Foo` and
  `close` deliberately non-adjacent in the bare bag (three unrelated tokens —
  `this`/`void`/etc. — sit between them in dedup-insertion order).
  `searchIdentifiers(db, 'Foo.close')` returns `[]` (no false adjacency);
  `searchIdentifiers(db, 'Bar.close')` returns that same chunk. This is the
  concrete case the F5 mandate flagged as a theoretical risk ("bag-order
  dedup makes it rare") — demonstrated rare here by construction, not merely
  asserted.

**Tool-level test — which fixture shape lands in `potential_matches`, and
why.** `mcp/tools/__tests__/tools.test.ts`, new describe block `mast_callers —
potential set for methods (F5)`, isolated fixture (own `tmpDir`/`db`, same
pattern as the existing "F2 — file_busy_returning_stale_cache" block): a
`target.ts` declaring `class Repo { findById(): void {} }` and a `caller.ts`
importing `Repo` from `'unresolvable-external-package'` (a specifier that
never resolves) and calling `this.repo.findById()` from a `field_type`
constructor-param-property binding. Two assertions:
1. `verified_callers` does NOT contain `Service.check` — the import's
   `resolvedPath` is `null`, so `resolveQualifiedNameScoped` returns `null`
   with no fallback and `insertEdges` drops the edge (proven, not assumed —
   this is the shape #2 above describes).
2. `potential_matches` IS non-empty and contains `{ file_path: 'caller.ts',
   context: 'Service.check' }` — the qualified compound
   `identifier_fts` row heals exactly the gap the first assertion proves
   exists.

This shape was chosen over a genuinely-unresolvable-receiver shape (e.g. a DI
lookup) specifically because #3 above proves those NEVER produce a qualified
compound at all — they would leave `potential_matches` empty for the qualified
query, which would not exercise F5's fix (it would only re-prove the
already-documented, unhealed residual gap).

**Schema bump.** `store/config.ts`'s `CURRENT_SCHEMA_VERSION` bumped `1.2.0` →
`1.3.0`, with a WHY-comment: this is a CONTENT-format change to an
already-existing `identifier_fts` column (no new column, so a naive
schema-diff would miss it) — an old index's identifier rows lack the qualified
compounds, so a qualified-name query against un-reindexed state would silently
regress to empty, exactly the "confidently wrong, not erroring" hazard §7.4's
migration guard exists to prevent. Verified `mcp/startup.ts` needs no code
change — it keys off the `CURRENT_SCHEMA_VERSION` constant, confirmed by
grepping for direct version-string literals (none found outside the constant
and its doc references) and by `mcp/__tests__/startup.test.ts`'s existing
schema-mismatch coverage passing unmodified. The Docker seed (§7.4) picks up
the new format automatically on its next build/reindex — no seed data exists
to migrate under the never-shipped constraint.

**Red-first evidence.** Three new test files/blocks written against the
unfixed code and run via `pnpm exec vitest run` before any production change:
`src/ast/extractors/__tests__/qualified-identifiers.test.ts` (new file, 4
tests), the new `searchIdentifiers — qualified compounds (F5)` block in
`fts-query.test.ts` (2 tests), and the new `mast_callers — potential set for
methods (F5)` block in `tools.test.ts` (2 tests). First run: **6 failed / 2
passed** across the 8 new tests (109 total in the three touched files after
the additions) — all 6 failures were assertion-level (`expected [...] to
include '...'`, `expected false to be true`, `expected 0 to be greater than
0`), proving each exercises real, then-missing behaviour rather than a broken
import or setup error. The 2 tests that passed "for free" — the DI-style
unresolvable-receiver pure-layer test, and the tool-level "verified_callers
does NOT contain the caller" test — confirmed the negative-space assertions
(no compound for an unresolvable receiver; the edge really is dropped at
`insertEdges`) already held true before any F5 code existed, isolating the red
failures to exactly the intended fix surface.
Implementing `appendQualifiedCompounds` and the `qualifiedMentionsByFromName`
grouping in `TypeScriptExtractor.extract()` turned all 6 red assertions green
with zero regressions elsewhere; one test assertion (the DI-unresolvable pure
test) needed a follow-up correction — it initially failed AFTER the fix
because it hadn't accounted for the chunk's own declaration-self-discoverable
compound (`Bootstrap.start`) always being present, conflating "no compound
from the unresolvable call" with "no compound at all" — corrected to exclude
the chunk's own name before asserting.

**Verification** (from `packages/mast`): `pnpm test` — **546/546 passed, 38
files** (baseline 538/37; +8 net new tests — 4 pure-layer + 2 FTS-integration +
2 tool-level). `pnpm typecheck` — clean. `pnpm lint` — clean. Repo-root
`pnpm align:check` — `baselined debt: 324 -> 324 (0)`, red only on the 2
pre-existing non-mast violations (`application/ui/src/views/root-layout.tsx`
import cycle; `application/api/src/domain/spec/fold-build-record-repository.ts`
domain→db import) — unchanged from F3/F4's verification, confirming F5
introduced no new architecture drift.

**Deviations**: none from the mandated design — no changes to `fused.ts`,
`declex.ts`, `eval/`, `vitest.config.ts` exclusions, or
`searchIdentifierNearMiss` semantics; `collectPotentialMatchCandidates` and the
tools were untouched except doc comments. **Noticed but not done**: F10
(`potential_truncated`) remains unimplemented, unchanged from F3/F4's note —
out of scope for this task. Also noticed but out of scope: the
`extractEdges`-derived compound grouping only covers `TypeScriptExtractor`
(the only extractor that emits `POTENTIAL_CALL` edges); `MarkdownExtractor`
correctly contributes no identifier rows at all, so this is not a gap, just
worth naming as a boundary. No corpus-level before/after `potential_matches`
count was measured against a real external corpus — same E2 scope boundary
F3/F4 recorded; this task's evidence is unit/integration-level, proving the
mechanism works, not corpus-scale recall improvement.

### F10 result (2026-08-09) — potential_truncated shipped

**The defect.** `collectPotentialMatchCandidates` (`search/potential-matches.ts`)
fetched `identifier_fts` hits with `limit = 50` and nothing surfaced that the cap
was hit — `eval/GITNEXUS_COMPARISON.md` M4: the `isUndefined` query reported 50
candidates when the real `identifier_fts` match count was 71, silently dropping 21
candidates and invalidating a recall claim built on the output. `CallersResponse`/
`RenameImpactResponse` had no truncation field. MAST_SPEC.md §9.0's Confidence
signals (C1) table had already reserved the vocabulary — `potential_truncated` —
against exactly this task (F5's result, above, and C1's result both name it as
deliberately out of scope).

**Design: count-only-when-full, share the match-expression construction.**
`fts.ts` gained `countIdentifierMatches(db, symbolName)` — same phrase-quoted FTS5
MATCH expression as `searchIdentifiers`, `count(*)`, no `LIMIT` — built via a new
private `buildIdentifierMatchExpr` helper both functions call, so the two can never
disagree about which rows count as a match (duplicating the quoting logic was
rejected: a drift between the two would make the "real count" lie in the opposite
direction of the original bug). `collectPotentialMatchCandidates` now runs
`countIdentifierMatches` ONLY when the capped fetch came back full
(`identRows.length === limit`) — under the cap, the fetch count already IS the real
count, and the extra query would be pure waste on the overwhelming majority of
calls (most symbols have far fewer than 50 identifier mentions). The function's
return type changed from `PotentialMatchCandidate[]` to
`{ candidates, truncatedMatchCount? }` — `truncatedMatchCount` is set only when the
fetch was full AND the real count exceeds `limit` (an exactly-full fetch with no
more real matches is not truncation). `collectPotentialMatches` passes the field
through unchanged to its own `PotentialMatchesResult`; `mast_callers`/
`mast_rename_impact` surface it as `summary.potential_truncated` (omitted-when-false,
same convention as `file_busy_returning_stale_cache`/`index_empty`).

**Raw-truncation vs. filtering — the precision the task brief called out
explicitly.** `potential_truncated` is computed at the RAW `identifier_fts` fetch,
before verified-overlap exclusion and checker-verdict filtering (both of which run
afterward, inside `collectPotentialMatches`/the tool handlers). So
`potential_matches`/`summary.potential_count` can still be smaller than the fetch
cap even when `potential_truncated` is present — that is filtering doing its job
(already visible via `checker_classified_non_call_site`/
`checker_classified_different_declaration`), not evidence the truncation signal is
wrong. Documented in the TSDoc on `CallersResponse.summary.potential_truncated`
(`ast/types.ts`), in `PotentialMatchCandidatesResult.truncatedMatchCount`'s TSDoc, and
in MAST_SPEC.md's C1 table row and §9 `mast_callers` prose.

**Checker pass consumes the collector unchanged.** `graph/checker-resolver.ts`'s
Phase A calls `collectPotentialMatchCandidates` for every indexed symbol and only
ever used the candidates array, never a truncation count — its call site needed
exactly the one-line destructuring touch the task brief anticipated
(`const candidates = await ...` → `const { candidates } = await ...`), with a
WHY-comment noting Phase A has no summary surface to carry the field to and
deliberately ignores it. `checker-resolver.test.ts`'s existing 16 tests pass
unchanged, confirming Phase A's classification semantics were not touched.

**Test budget call (§5.5).** The positive (cap-hit) case is covered at the collector
layer with an injected `limit = 5` against 7 real matching chunks
(`search/__tests__/potential-matches.test.ts`, new file, 3 tests: capped +
truncation-count-reported; under-cap + no signal; zero-match + no signal) — the
single shared definition every consumer (`mast_callers`, `mast_rename_impact`, the
checker pass) goes through. A production-cap-exceeded (51+ mention chunks) fixture
at the tool layer was judged disproportionate for one field's coverage: `tools.test.ts`
gets one negative test instead (`add`'s potential set, nowhere near the cap ⇒
`summary` must NOT carry `potential_truncated`) plus a comment stating the budget
call explicitly, per the task brief's own guidance. `fts.ts`'s new
`countIdentifierMatches` also got 2 direct unit tests in `fts-query.test.ts` (uncapped
count for a real identifier; 0 for an empty/unmatched term) — the natural home for a
new exported function in the file that already tests its sibling `searchIdentifiers`.

**Red-first evidence.** All 5 new positive/shape-asserting tests were written and run
against the unfixed code first (`pnpm exec vitest run` on the two touched test
files). Result: **5 failed / 8 passed** (13 total across the two files) — the 5
failures were `TypeError: countIdentifierMatches is not a function` (2, proving the
export didn't exist yet) and `AssertionError: Target cannot be null or undefined`
(3, `result.candidates` on what was then a bare array — proving the collector's
return shape hadn't changed yet), all assertion/type-level failures, not import or
syntax breaks. The tool-layer negative test (`tools.test.ts`) was NOT expected to be
red — it asserts the ABSENCE of a property that also doesn't exist pre-fix, so it
passes trivially both before and after; it is a regression guard, not evidence of
the fix, and is called out as such rather than mis-described as a red test.
Implementing `buildIdentifierMatchExpr`/`countIdentifierMatches` (`fts.ts`) and the
`{ candidates, truncatedMatchCount? }` return shape + count-only-when-full gating
(`potential-matches.ts`) turned all 5 green with no regressions elsewhere.

**Verification** (from `packages/mast`): `pnpm test` — **552/552 passed, 39 files**
(baseline 546/38; +6 net new tests — 3 collector-level + 2 `countIdentifierMatches`
unit tests + 1 tool-level negative test; +1 file — the new
`potential-matches.test.ts`). `pnpm typecheck` — clean. `pnpm lint` — clean.
Repo-root `pnpm align:check` — `baselined debt: 324 -> 324 (0)`, red only on the 2
pre-existing non-mast violations (`application/ui/src/views/root-layout.tsx` import
cycle; `application/api/src/domain/spec/fold-build-record-repository.ts` domain→db
import) — unchanged from F5's verification, confirming F10 introduced no new
architecture drift.

**Deviations**: none from the mandated design — the 50 cap itself was not changed
or made configurable; `fused.ts`, `declex.ts`, `eval/`, `vitest.config.ts`
exclusions, and `checker-resolver.ts`'s Phase A classification semantics are
untouched (only the one destructuring touch its collector call site needed).
**Noticed but not done**: no corpus-level measurement of how often the 50-entry cap
is actually hit in a real external corpus — same E2 scope boundary F3/F4/F5
recorded; this task's evidence is unit/integration-level, proving the signal fires
correctly on a controlled fixture, not how often it fires in practice.

---

## Stage 3.5: Tool defects and honest surfaces
**Goal**: Fix tools that are slow, silently lying, or advertising things they don't do.
**Status**: Complete (2026-08-09) — F8/F9/M6/C1 all shipped.

| # | Task | Status |
|---|---|---|
| F8 | `mast_project_skeleton` costs **~28 s/call** — 99% in `estimateFullFileBound`; `FULL_FILE_BOUND_CACHE_LIMIT=200` LRU-thrashes against 1,334 files (`telemetry/tokenizer.ts:68,97`). Cap the *work*, not the cache | **Complete** |
| F9 | `mast init --extensions` / `--exclude` are parsed and **ignored** (`cli/init.ts:20–23`); `loadStateConfig` has zero callers outside `config.ts`, and `serve` *overwrites* the persisted config. Honour them or delete the flags | **Complete** |
| M6 | `mast serve` silently bootstraps an empty state dir and answers every query `{"results":[]}` — indistinguishable from "symbol doesn't exist". Fail fast | **Complete** |
| C1 | Unify confidence signals — MAST already computes `resolution` and `reason`; add the missing ones uniformly: `stale`/`file_busy` (done F2, extend per F7) and `truncated` (F10) | **Complete** |

**Why this is its own stage**: F8 was ranked the **#2 betterment** of the R3 review and
is the single largest practical DX cost measured — the orientation tool the §12 prompt
tells the agent to call *first* spends ~99% of its latency computing a telemetry
counterfactual. F9/M6 are both "the tool lies about what it did".
**Evidence**: §14.4 (M2/F8), §14.4 (M3/F9), §13.5 (M6), §13.8 item 8 / §14.8 item 5 (C1).

### F8 result (2026-08-07) — telemetry work cap shipped

**Design shipped, "cap the work, not the cache" — two parts**:

1. **Per-call tokenization budget** (`FULL_FILE_TOKENIZE_BUDGET_PER_CALL = 32`,
   `telemetry/tokenizer.ts`): `estimateFullFileBound` now only exactly reads+tokenizes
   the first 32 cache-miss paths per call, in the caller's dedup'd path order (deterministic).
   Cache hits are free (never consume budget). Once the budget is exhausted, further
   cache misses are size-estimated (`Math.ceil(sizeBytes / BYTES_PER_TOKEN_ESTIMATE)`,
   `BYTES_PER_TOKEN_ESTIMATE = 4`) instead of read, and deliberately **not cached** — an
   estimate must never masquerade as an exact cached count. A failed read still spends
   its granted budget slot (the stat that granted it already succeeded); a failed
   *stat* (missing file) is rejected before the budget check and spends nothing.
   Successive calls over the same path set progressively convert estimates to exact,
   cached counts. WHY 32: profiling showed the tokenizer costs a ~22-24ms/call floor
   *regardless of content length* — 32 calls is ~0.7-0.8s worst case per call, versus
   the ~28s this function cost tokenizing all 1,334 files in one pass. §14.1's
   "negligible overhead" goal (< 1ms/call) predates `mast_project_skeleton` existing as
   a whole-project-scale caller and is not literally met by this ~0.7-0.8s worst case —
   flagged in MAST_SPEC.md §14.1 and in this task's report rather than silently
   papered over; see "deviations" below.
2. **Cache limit raised** (`FULL_FILE_BOUND_CACHE_LIMIT`: 200 → 8192): 200 was tuned
   for "one working session's file set" before `mast_project_skeleton` — which
   references *every* project file — existed as a caller. Cache entries are a path
   string plus two numbers, so 8192 entries is ~2-3 MB worst case, comfortably covering
   the ~10k-file corpora at the 150k-chunk scale target (Stage 4.5). The LRU eviction
   mechanism itself (`cacheTouch`) is unchanged.

**`FullFileReader` DI seam extended**: `statMtime(path): number` replaced with
`stat(path): { mtimeSeconds, sizeBytes }` — one method, not `statMtime` + a new
`statSize`, because `fs.statSync` already yields both from a single syscall and every
cache-miss path now needs the size too. Same "callers catch failures" contract.

**Net behavior**: first `mast_project_skeleton` call on a 1,334-file project ≈ 32 exact
reads + ~1,300 cheap stat-only estimates — sub-second, down from ~28s. Each subsequent
call converts 32 more paths to exact/cached; the whole project converges to fully-exact,
fully-cached counts in ⌈1334/32⌋ ≈ 42 calls, after which every call is 100% cache hits
(no reads, no estimates) with zero LRU thrash (8192 > 1,334).

**Caller survey** (grep for `estimateFullFileBound`): `search.ts`, `exports.ts`,
`signature.ts`, `callers.ts`, `dependencies.ts`, `implementors.ts`,
`rename-impact.ts` all call it with small `filesReferenced` sets (single-file lookups,
or a dedup'd `Set` of a bounded results list — typically ≤ 50 paths), i.e. already
under the 32-path budget only some of the time, but never at the 1,334-file scale that
made `mast_project_skeleton` (the sole full-project caller) the actual defect. Their
behavior changes only in that a set of >32 unique files now gets 32 exact + the rest
estimated on the first call instead of all-exact — a correctness-neutral,
convergent-to-exact change; no tool-layer changes were needed anywhere.

**Red-first evidence**: `src/telemetry/__tests__/tokenizer.test.ts` — 6 new tests
covering the budget, free cache hits, uncached estimates, cross-call convergence,
missing/unreadable-file budget interaction, and eviction at the raised bound, written
against the target `FullFileReader.stat` seam *before* the interface existed in
`tokenizer.ts`. First run: **8 of 12 tests failed** (the 6 new tests plus the two
existing mtime-cache tests, which also use the `stat` seam) — `reader.statMtime` was
`undefined` on the new-shape fakes, thrown and swallowed by the existing catch block,
so every path silently contributed 0 and `readFile` was never called. Implementing the
budget + seam change turned all 12 green.

**One test-only production seam added, not in the original mandate**:
`__seedFullFileCacheForTests` (`tokenizer.ts`) — direct profiling
(`countTokens('x')` × 8192 ⇒ 182.35s, 22.26ms/call) confirmed the tokenizer's per-call
cost is a fixed floor independent of content, so genuinely populating the cache to its
raised 8192-entry bound through real reads (to test eviction) would cost ~3 minutes —
longer than the defect this stage fixes. `__seedFullFileCacheForTests` seeds cache
entries through the same `cacheTouch` insert-and-evict-oldest path production code
uses, skipping only the (here irrelevant) tokenization cost, so the eviction test still
exercises the real, unmodified `FULL_FILE_BOUND_CACHE_LIMIT` and mechanism.

**Verification** (from `packages/mast`): `pnpm test` — **490/490 passed, 37 files**
(baseline 485/37; +5 net new tests — 6 added, 1 rewritten from the original
single-pass eviction test which is no longer feasible at the raised bound: see above).
`pnpm typecheck` — clean. `pnpm lint` — clean. Repo-root `pnpm align:check` —
`baselined debt: 324 -> 324 (0)`, red only on 2 pre-existing non-mast violations
(`application/ui/src/views/root-layout.tsx` import cycle;
`application/api/src/domain/spec/fold-build-record-repository.ts` domain→db import).

**Deviations**: (1) §14.1's "negligible overhead" goal is stated as `< 1ms per tool
call`; the mandated 32-file budget's worst case (~0.7-0.8s) is 2-3 orders of magnitude
over that literal figure, though it is 35-40x better than the ~28s it replaces and
converges to true-zero marginal overhead as the cache warms. The `< 1ms` figure predates
`mast_project_skeleton` existing as a whole-project-scale caller of this counterfactual;
reconciling the two is a spec-level decision left to the managing session rather than
silently changed here. (2) One test-only export, `__seedFullFileCacheForTests`, was
added beyond the mandated design surface — see above for why direct real-call testing
of the raised cache bound is impractical (~3 minutes) and how the seam preserves
fidelity to the real eviction mechanism.

### F9 result (2026-08-08) — init flags honoured, persisted config read

**Decision: honour, not delete.** §8's `mast init` docs already advertise
`--extensions`/`--exclude`, and the persistence machinery (`writeStateConfig` /
`loadStateConfig`, `store/config.ts`) already existed as dead code — `loadStateConfig`
had zero callers, so `<state_dir>/config.json` was write-only. Connecting the two was
the evident design intent; deleting the flags would have been the smaller diff but
would have thrown away working machinery and a documented CLI surface for no reason
other than that nothing had wired it up yet.

**Priority chain shipped** (`resolveConfig`, `store/config.ts`):

- **State directory** (unchanged — must resolve before the state dir's config.json can
  be loaded from inside it): `stateDirOverride` (CLI `--state-dir`) > `MAST_STATE_DIR`
  env > `state_dir` key in `mast.config.json` > built-in default (`.mast`).
- **Every other config key** (new, highest priority first): explicit `resolveConfig`
  overrides (`extensions`/`excludePatterns` — `mast init --extensions`/`--exclude`) >
  `mast.config.json` in `projectRoot` > persisted `<resolved_state_dir>/config.json`
  (via `loadStateConfig`, now actually called) > built-in defaults.

**Path-portability rule (CRITICAL, enforced)**: `pickStateConfigCustomization`
(`store/config.ts`) takes ONLY the 7 customisation keys —
`file_extensions`, `exclude_patterns`, `rrf_k`, `declaration_exact_ranker`,
`chunk_split_threshold`, `context_lines`, `markdown_heading_depth` — off a loaded state
config.json, via an explicit picked-keys merge (per-field `if` checks, not a
spread-minus-deletes), plus a runtime safety net that throws if a future edit ever
assigns a key outside that list. **`state_dir`/`project_root`/`resolved_state_dir`/
`resolved_project_root` are never read back.** WHY: `writeStateConfig` persists a full
`ResolvedConfig` including ABSOLUTE paths resolved in the process that wrote it; the SDD
pipeline mounts the same workspace volume at different container paths across runs, so
an absolute path loaded back from a previous container would silently point the
resolver at a location that doesn't exist (or, worse, exists but belongs to an
unrelated project) in the current container. Every path field in the returned
`ResolvedConfig` always comes from the CURRENT resolution — verified by
`store/__tests__/config.test.ts`'s dedicated path-portability test, which persists a
state config whose path fields point at
`/nonexistent-container-mount/from-a-different-container/.mast` and asserts the
resolved paths never contain that string. The picked customisation keys are also
minimally shape-validated (string array / number / boolean) rather than trusted on
cast — unlike `mast.config.json`, which stays an unvalidated `JSON.parse` cast per the
existing precedent comment (developer-authored, colocated with source control) — because
a state config.json is machine-written but still crosses a trust boundary (an arbitrary
file on disk that could be stale, foreign, or hand-edited); a key that fails validation
is silently dropped so a lower-priority layer fills it in, rather than propagating a
malformed value.

**`cli/init.ts` flag parsing**: `parseExtensionsFlag`/`parseExcludeFlag` split on `,`,
trim each entry, and drop empties; `parseExtensionsFlag` additionally normalises bare
names to leading-dot form (`'py'` and `'.py'` both accepted — `MastConfig.file_extensions`
internally always stores the dotted form `walkProject` globs on). Both return `undefined`
when the flag is absent, so flag-absent `mast init` calls `resolveConfig` exactly as
before (byte-identical behavior) — the `extensions`/`excludePatterns` options only enter
the merge when the CLI flag was actually passed.

**`bootstrapState` idempotency, traced**: `cli/serve.ts:17` calls
`resolveConfig({ stateDirOverride: opts.stateDir })` — no `projectRoot`, so `project_root`
resolves to `cwd`, but `resolved_state_dir` is driven entirely by `stateDirOverride` (or
the `MAST_STATE_DIR`/default fallback). Since F9 wires `resolveConfig` to call
`loadStateConfig(resolvedStateDir)` internally, this `serve`-time resolution ALREADY
picks up the persisted customisation keys before `bootstrapState` ever runs. `startup.ts`'s
`bootstrapState` then calls `writeStateConfig(config.resolved_state_dir, config)` —
`config` is the same already-customised resolution, so this write re-persists the
customisation instead of overwriting it with fresh defaults (the pre-F9 bug). No changes
were needed inside `bootstrapState`/`startup.ts` itself — the fix is entirely in
`resolveConfig` reading the layer that `writeStateConfig` was already writing. Proven by
`cli/__tests__/cli.test.ts`'s end-to-end regression test (see below), which calls
`bootstrapState` directly against a `serve`-style resolution and asserts the persisted
config.json still carries the custom `--extensions`/`--exclude` values afterward.

**Call-site survey** (per the mandate): `cli/serve.ts`, `cli/index-cmd.ts`,
`cli/status.ts`, `cli/metrics-cmd.ts`, `cli/query.ts`, and `mcp/startup.ts` all resolve
config via a plain `resolveConfig({ projectRoot, stateDirOverride })` call with no other
config manipulation — none needed changes. The persisted-config read-back falls out of
the `resolveConfig` change automatically at every call site; no deviation to record here.

**Red-first evidence**: interface fields (`ResolveConfigOptions.extensions`/
`excludePatterns`) and `cli/init.ts`'s parse-function stubs (naive `raw.split(',')`, no
trim/normalize) were added first so the full test suite below would compile and fail on
assertions, not imports. First run (`store/__tests__/config.test.ts` +
`cli/__tests__/cli.test.ts`): **7 failed / 42 passed** —
`resolveConfig — explicit extensions/excludePatterns overrides` (2 tests: override
ignored, DEFAULTS/mast.config.json values returned instead), `resolveConfig — persisted
state config layer` → "picks up custom file_extensions..." (state config never read) and
"explicit overrides win..." (overrides not applied), `mast init — flag parsing` → the
whitespace/normalization test (`' a , ,b '` returned untrimmed with empty entries and no
dot-prefix), and the end-to-end init/serve-bootstrap test (`result.filesIndexed` was 3,
not 1 — extensions/exclude both ignored). Two tests in the same red run passed
"for free" before any implementation existed: `mast.config.json` already won over
`DEFAULTS` pre-F9 (no state-config layer needed to observe that), and the
path-portability test held trivially because nothing was read from the persisted file
at all yet. Implementing `pickStateConfigCustomization` + the new merge order in
`resolveConfig`, and the real `parseCommaSeparatedList`/`normalizeExtension` logic in
`cli/init.ts`, turned all of it green.

**Verification** (from `packages/mast`): `pnpm test` — **501/501 passed, 37 files**
(baseline 490/37; +11 net new tests — 2 explicit-override tests, 3 persisted-state-layer
tests, 1 path-portability test, 4 flag-parsing tests, 1 end-to-end init+serve-bootstrap
regression test). `pnpm typecheck` — clean. `pnpm lint` — clean. Repo-root
`pnpm align:check` — `baselined debt: 324 -> 324 (0)`, red only on the 2 pre-existing
non-mast violations (`application/ui/src/views/root-layout.tsx` import cycle;
`application/api/src/domain/spec/fold-build-record-repository.ts` domain→db import).

**Deviations**: none from the mandated design. **Noticed but not done**: the
`mast.config.json` boundary (config.ts:71-88 comment) remains an unvalidated
`JSON.parse` cast per its documented precedent — only the NEW persisted-state-config
boundary got the minimal shape validation the F9 mandate asked for; retrofitting
`mast.config.json` itself with the same validation is a separate, unscoped decision
left to the managing session.

### M6 result (2026-08-09) — empty-state honesty shipped

**Why a blanket refuse-on-empty was wrong.** `eval/GITNEXUS_COMPARISON.md` §13.8 item 4
names the defect precisely: `mast serve` on an empty/never-indexed state dir answers every
query `{"results":[]}`, indistinguishable from "symbol doesn't exist". The naive fix —
refuse to serve whenever the state dir is empty — breaks the §7.4 startup ladder by
design: Step 3 opens the MCP transport and accepts queries *before* Step 4's background
reindex has filled the index, specifically so time-to-first-query stays in single-digit
seconds on a cold container (§7.4's whole reason for existing). An empty state dir during
that window is not a bug to refuse; it is the designed SDD container flow, and Step 4
converges it to correct within seconds. A blanket refusal would have broken every cold
start. The shipped design instead splits the defect into the one case that is genuinely
unrecoverable (Part A) and the one that is a legitimate, transient window needing only an
honest signal (Part B).

**Part A — fail fast only where nothing can ever fill the index** (`mcp/server.ts`).
`assertServableIndex(config, options)` is a new, directly-testable, pure function
extracted out of `serve()` — called after Step 1 (`bootstrapState`) and *before*
`openDatabase` (Step 2). Ordering is load-bearing: `openDatabase` creates `graph.db` with
an empty schema as a side effect of opening a missing file (`graph/db.ts`), which would
make a post-`openDatabase` "is graph.db absent" check see a false negative a moment later
— the same hazard `cli/query.ts`'s `runQuery` already documents for its own graph.db
check, which `isNeverIndexed` (the function's internal predicate) mirrors. The refusal
fires only when BOTH: (a) `--no-startup-reindex` was passed (the one flag that disables
the mechanism that would otherwise fill the index), AND (b) the state dir is
never-indexed — `graph.db` absent, OR (`index.json`'s `chunk_count === 0` AND
`last_indexed` is null/absent, read via `loadIndexMeta`). Deliberately NOT
"chunk_count === 0" alone: a state dir indexed over a genuinely empty file set still
writes a live `graph.db` and a `last_indexed` timestamp — that is an honestly-answerable
index (Part B's territory), not a permanently-stuck one. With the startup reindex enabled
(the default), `assertServableIndex` is a no-op via its first line — the §7.4 ladder is
untouched, exactly as the "do not gate or delay the default path" prohibition required.
Throws `NeverIndexedError` (extends `Error`, mirrors `cli/query.ts`'s `QueryError`
precedent) naming the state dir, explaining every query would return empty forever, and
suggesting `mast init` / `mast index` or dropping `--no-startup-reindex`.

**Part B — honest signal during the legitimate empty window** (`mcp/tools/_helpers.ts`,
`ast/types.ts`, all 8 result-bearing read-tool handlers). One helper,
`isIndexEmpty(ctx): Promise<boolean>`, wraps a single `ctx.chunkStore.chunkCount() === 0`
check. Every read tool with a primary result array — `mast_search` (`results`),
`mast_project_skeleton` (`files`), `mast_exports` (`exports`), `mast_signature`
(`results`), `mast_callers` (`verified_callers` AND `potential_matches` both empty —
checked at BOTH of its two return points, the zero-symbol early return and the normal
path), `mast_dependencies` (`imports`), `mast_implementors` (`results`),
`mast_rename_impact` (all FOUR sections: `declaration_sites`, `verified_callers`,
`potential_matches`, `barrel_exports`) — attaches `index_empty: true` to its response
envelope, called ONLY on the already-empty-result path via `&&`-short-circuit (`results.length
=== 0 && await isIndexEmpty(ctx)`), so a populated response never pays the `chunkCount()`
query. `ast/types.ts` gained `readonly index_empty?: true` on all 8 response interfaces —
one full TSDoc on `SearchResponse` (the semantics: "empty because nothing indexed" vs
"empty because no match", composes independently with `suggestions`/
`file_busy_returning_stale_cache`, omitted-when-false per the existing convention), the
other 7 carry a one-line `@see`-style pointer back to it plus the tool-specific "which
field(s) must be empty" note. `mast_status` was left untouched (it already reports
`chunk_count`/`index_fresh` — it IS the diagnostic surface); `mast_efficiency` and
`mast_reindex` are not result-bearing and were untouched.

**Red-first evidence.** Both parts' tests were written against the UNFIXED code before any
implementation, then verified red via `git stash push` on the 11 production files (keeping
only the 2 test files on disk), a targeted `vitest run` against that reverted tree, then
`git stash pop` to restore the implementation. First run (targeted):
**12 failed / 97 passed** (109 total) — 4 Part A failures in `mcp/__tests__/startup.test.ts`
(`assertServableIndex is not a function` / `toBeInstanceOf` on `undefined`) and 8 Part B
failures in `mcp/tools/__tests__/tools.test.ts` (`expected undefined to be true` on
`res.index_empty` for each of the 8 tools' empty-index fixture). All failures were
assertion-level, not import/compile errors, confirming the tests exercise real behavior
gaps rather than broken imports. Implementing `assertServableIndex`/`NeverIndexedError`
(`mcp/server.ts`) and `isIndexEmpty` + the 8 per-tool `index_empty` attachments turned all
12 green with no other test regressions.

**Test design.** Part A is tested by calling `assertServableIndex` directly against a
`ResolvedConfig` — no MCP transport, no `serve()` call, no stdio — covering: never-indexed
+ `--no-startup-reindex` → throws with the state dir, `mast init`, `mast index`, and
`--no-startup-reindex` all present in the message; never-indexed + startup reindex enabled
(default, and explicit `false`) → no throw; an already-INDEXED dir + `--no-startup-reindex`
→ no throw; and the Part-A/Part-B boundary case — a dir indexed over zero files
(`last_indexed` set, `chunk_count` 0) + `--no-startup-reindex` → no throw, proving Part A
does not encroach on Part B's territory. Part B uses two fixtures in `tools.test.ts`: a
genuinely empty index (`runIndex` over a tmpdir with zero source files — the same
"indexed but nothing in it" state that stands in for the §7.4 ladder's transient window,
since a read tool cannot distinguish "never indexed, reindex pending" from "indexed,
nothing there"), asserting `index_empty: true` on all 8 tools' empty-query responses; and
the file's SHARED, already-populated fixture, asserting `index_empty` is ABSENT (not
present-and-false) on both a no-match query (`zzzNoSuchThing`/`zzzNoSuchSymbol`/unknown
interface, per tool) and a with-results query, for every tool that has a natural
with-results case in that fixture (all 8).

**Verification** (from `packages/mast`): `pnpm test` — **527/527 passed, 37 files**
(baseline 501/37; +26 net new tests — 12 red-phase-proving tests [4 Part A + 8 Part B
empty-fixture] plus 14 Part-B no-carry tests against the populated fixture). `pnpm
typecheck` — clean. `pnpm lint` — clean. Repo-root `pnpm align:check` — `baselined debt:
324 -> 324 (0)`, red only on the 2 pre-existing non-mast violations (`application/ui/src/
views/root-layout.tsx` import cycle; `application/api/src/domain/spec/
fold-build-record-repository.ts` domain→db import) — unchanged from F9's verification,
confirming M6 introduced no new architecture drift.

**Deviations**: none from the mandated design. **Noticed but not done**: `mast query`'s
CLI error-surface docs (MAST_SPEC.md §8, the "State dir with no `graph.db`" bullet) still
say the never-indexed guard "does not implement the broader empty-state serve semantics
tracked separately (IMPLEMENTATION_PLAN.md M6)" — now stale phrasing (M6 is done), but
`cli/query.ts`'s `runQuery` guard is a genuinely separate code path from `mast serve`
(no `assertServableIndex`/`isIndexEmpty` wiring) and was out of this task's file scope;
left for the managing session to decide whether `mast query` should gain the same
`index_empty` signal or just have its doc comment's cross-reference updated.

### C1 result (2026-08-09) — confidence signals unified

**The split decision, and why.** F7 (above) reused `file_busy_returning_stale_cache`
for `mast_search`/`mast_implementors`'s stat-and-flag staleness signal — a decision
the F7 result explicitly flagged as a "known naming tension, deferred to C1". The
name is a misnomer there: `mast_search`/`mast_implementors` never attempt to acquire
`structure.lock` or re-parse anything, so nothing is ever "busy" in the sense the
JIT-refresh tools' flag means. The two signals also demand **different agent
actions** — the exact reason the misnomer was worth fixing, not merely cosmetic:
- `file_busy_returning_stale_cache` (JIT tools): a refresh **was attempted** and lost
  to genuine write contention. The correct response is to **retry shortly** — the
  contention is expected to clear (§7.6's 200ms `busy_timeout`).
- `stale` (the new C1 name, `mast_search`/`mast_implementors`): **no refresh was ever
  attempted**, by design (re-parsing a result file mid-response could invalidate the
  ranking that already selected it, per F7's stat-and-flag design). The correct
  response is to treat the result's coordinates as untrustworthy until a
  `mast_reindex` call, or any JIT-refreshing tool call against the file, heals it —
  retrying the same `mast_search` call will NOT clear the flag on its own.
Conflating these under one field name meant an agent (or a future maintainer) reading
`file_busy_returning_stale_cache: true` on a `mast_search` result had no way to tell
"retry" from "reindex" apart from re-deriving it from which tool it came from. The
project is never-shipped (no consumers, no back-compat obligation — see
`IMPLEMENTATION_PLAN.md`'s recurring "never shipped" framing), so the rename carried
zero migration cost — the only reason it was deferred to its own task instead of done
inline in F7 was scope discipline (per F7's task brief, inventing a second field name
was explicitly out of scope for that task).

**What changed — a rename plus documentation, no new machinery.** Per
`eval/GITNEXUS_COMPARISON.md` §13.8 item 5 / §14.8 item 5 ("frame as unification, not
a new feature") and this project's CLAUDE.md §4.2 (no premature abstraction): no
confidence enum, no wrapper object, no field beyond the rename.
1. `SearchResult.file_busy_returning_stale_cache` → `SearchResult.stale?: true`
   (`ast/types.ts`), TSDoc rewritten to state the stat-and-flag semantics and the
   agent action (treat coordinates as untrustworthy; `mast_reindex`/JIT-tool-call
   heals it).
2. `ImplementorResult.file_busy_returning_stale_cache` → `ImplementorResult.stale?:
   true` (`ast/types.ts`), same TSDoc treatment.
3. `search.ts`/`implementors.ts`'s flag-spreading sites updated to spread
   `{ stale: true as const }` instead of the old field name; their F7 WHY-comments
   gained a one-line note that `stale`, not `file_busy_returning_stale_cache`, is the
   name used here (that name is reserved for the JIT tools, where a refresh really is
   attempted).
4. `staleness.ts`'s `findStaleFiles` TSDoc updated to describe the `stale` output
   contract and note the C1 split; `checkAndRefreshIfStale`'s own JIT-side
   `file_busy_returning_stale_cache` documentation is UNCHANGED (JIT tools keep the
   old name — it is accurate there).
5. **JIT tools (`mast_signature`, `mast_exports`, `mast_callers`, `mast_dependencies`,
   `mast_rename_impact`) are completely untouched** — their `file_busy_returning_
   stale_cache` field, behavior, and tests (the F2/F14 blocks in `tools.test.ts`) are
   byte-for-byte what F11 left them.

**MAST_SPEC.md §9.0 unification.** Added a new "Confidence signals (C1)" table (new
`#### Confidence signals (C1)` subsection, placed after the existing "Empty-index
signal (M6 Part B)" paragraph and before the `mast_search` tool section) — one table,
columns `field | carried by | meaning | agent action`, rows for `resolution`
(`VerifiedCaller`, six values, high confidence/safe to act), `reason`
(`PotentialMatch`, mandatory review), `file_busy_returning_stale_cache` (JIT tools,
refresh attempted and contended, retry shortly), `stale` (`mast_search`/
`mast_implementors`, no refresh attempted by design, reindex/JIT-call heals it),
`index_empty` (all primary-result read tools, nothing indexed at all), `truncated`
(`TypeContextEntry`, declaration clipped at 50 lines — the one row that is an
always-present `boolean`, not an omitted-when-false flag, called out explicitly so the
table doesn't overstate a uniform convention that doesn't hold), and a reserved final
row, `potential_truncated` — **not implemented here**, ships with F10 (Stage 3);
documented now purely so F10 lands into an agreed vocabulary instead of inventing one.
The two pre-existing §9.0 paragraphs that named the old F7 field
(the stat-and-flag bullet and the "Result shape" paragraph) were updated to say
`stale` and point at the new table; every other §9.0 paragraph (TOCTOU Policy,
Empty-index signal) describes the JIT tools' `file_busy_returning_stale_cache` or
`index_empty` and was left unchanged, since C1 does not touch either.

**Grep sweep for the old field name** (`file_busy_returning_stale_cache`, across
`src/`, `MAST_SPEC.md`, `IMPLEMENTATION_PLAN.md`, `README.md`; `eval/` and `dist/`
excluded from scope per the task's hard prohibitions): every occurrence that
DESCRIBES the F7 stat-and-flag signal specifically was updated (the sites listed
above); every occurrence describing the JIT tools' own busy flag (F1/F2/F11/F13/F14
narrative in this file, `MAST_SPEC.md` §7.6/§9.0's JIT paragraphs, `README.md`'s
general locking-and-busy-flag paragraph, `mtime-stamp-ordering.test.ts`,
`staleness.test.ts`) was left untouched — those describe a signal that did not change.
Historical result blocks (F2, F7, F11 above) were left as history rather than
rewritten; the F7 result's "Known naming tension, deferred to C1" paragraph gained a
one-line `[renamed to `stale` by C1, 2026-08-09]` note rather than being rewritten.

**Red-first evidence.** The F7 describe block in `tools.test.ts` (renamed
`F7/C1 — stat-and-flag staleness, \`stale\` field (mast_search / mast_implementors)`)
was updated to assert `.stale`/`not.toHaveProperty('stale')` FIRST, plus one new
regression test (`never carries the old file_busy_returning_stale_cache name on a
stale result`), then run against the unrenamed production code. **5 of 7 tests failed**
with `AssertionError: expected undefined to be true` (the 2 happy-path tests, which
assert absence, passed trivially against either field name) — a genuine assertion
failure proving the tests exercised the real rename, not an import/syntax break.
Applying the `ast/types.ts`/`search.ts`/`implementors.ts`/`staleness.ts` rename turned
all 7 green with no other regressions.

**Verification** (from `packages/mast`): `pnpm test` — **528/528 passed, 37 files**
(baseline 527/37; +1 net new test — the C1 regression guard). `pnpm typecheck` —
clean. `pnpm lint` — clean. Repo-root `pnpm align:check` — `baselined debt: 324 -> 324
(0)`, red only on the 2 pre-existing non-mast violations (`application/ui/src/
views/root-layout.tsx` import cycle; `application/api/src/domain/spec/
fold-build-record-repository.ts` domain→db import) — unchanged from M6's verification.

**Deviations**: none from the mandated design. **Noticed but not done**: F10's
`potential_truncated` remains unimplemented (Stage 3's scope, only its vocabulary is
reserved in the new MAST_SPEC.md table, per the task's explicit "No new machinery"
instruction); the `README.md` line describing read tools returning
`file_busy_returning_stale_cache: true` under concurrent-reindex contention was left
as-is since it describes the JIT tools' general locking behavior, not `mast_search`/
`mast_implementors` specifically, and is still accurate.

---

## Stage 4: Determinism, hygiene, and the measurement harness
**Goal**: Make future measurements trustworthy and stop spec drift recurring.
**Status**: Not Started

> **Sequencing note: do D0 BEFORE Stage 3.** It is a force multiplier for every
> remaining verification task, not a nice-to-have. See its rationale below.

| # | Task | Status |
|---|---|---|
| **D0** | **CLI query surface — parity with the MCP read tools (`mast query <tool> <json>`)** | **Complete** |
| D1 | Sort `walkProject` output (`indexer/walker.ts:43`) — kills ±4/3,940 edge nondeterminism | **Complete** — see D1 result below |
| D2 | Repair `eval/` as a regression harness: `paths.mjs` points at a dead session; pin the corpus | **Complete** — see Q1 §D2 result |
| **D6** | **Build the stats/regression suite** — the metric set below, with a baseline captured before each fix | Not Started |
| D7 | Self-oracle invariant tests over a real corpus (e.g. *every `call_expression` visited yields an edge or a recorded drop-reason*) + property-based call-shape generation (`recv.m()`, `this.m()`, `await x.m<T>()`, `super.m()`, `(await x).m()`) | Not Started |
| E1 | Scaling ladder as **regression proof** for Stage 2 — otel(902) / langchainjs(2,047) / strapi(3,600) / backstage(7,021); n8n(12,641) only post-migration | Not Started |
| E7 | JIT under real agent concurrency (4 concurrent MCP clients + in-flight reindex) — **can falsify F1**: if contention degrades non-linearly, per-batch locking made it worse and the answer is a single-writer queue | **Complete — FALSIFIED** |
| E7-r2 | Re-measure E7 against the post-M1/post-F12 build, to size F11 — same harness/arms, three new probes (hold decomposition, event-loop freeze, `SQLITE_BUSY_SNAPSHOT` repro) | **Complete** |
| D3 | Spec conformance: quarantine mechanism prose; add `spec-conformance.test.ts` with `// MAST_SPEC.md:NNN` citations | **Complete** — see D3 result below |
| D4 | Test-assertion rule: no `unknown[]` in response type annotations; every returned array gets a content assertion | **Complete** — see D4 result below |
| D5 | Adopt ADR directory (`.history` → numbered ADRs, `002-2026-07-22-name.md`, zero-padded) | Not Started |

**Success criteria**: two identical index runs produce identical edge sets; `eval/`
runs against a pinned corpus; the three known false spec claims are either true,
tested, or moved to a non-normative appendix.
**Evidence**: §15.5 (nondeterminism), §14.2 (harness rot), §14.5 (spec drift), §14.6
(assertion strength).

### D1 result (2026-08-10) — deterministic walk order shipped

`walkProject` now sorts entries lexicographically by `relativePath` before
returning (plain code-unit comparison, deliberately not `localeCompare` —
locale-sensitive collation would make "deterministic" depend on the host
locale). fast-glob's filesystem-order results fed edge insertion in varying
order, and `insertEdges`' bare-name fallback resolution is
insertion-order-sensitive, producing the measured ±4/3,940 edge
nondeterminism (§15.5); sorting at the source makes index order, manifest
order, and edge insertion reproducible in one place. The stale docstring
("results are in an arbitrary order") is corrected; the contract is
reproducibility, not semantic priority. Two tests in `cli.test.ts` ("D1 —
walkProject deterministic ordering"): exact lexicographic order over a
multi-directory fixture created in non-lexicographic order, and
identical-orderings-across-consecutive-walks. **Honest red-phase note**: the
pre-fix order was arbitrary, not reliably unsorted, so a guaranteed-red test
does not exist for this defect — the tests are the executable spec of the new
contract (§5.4a structural-protection clause), and the nondeterminism
evidence lives in §15.5's measurement. Implemented directly by the managing
session (two-line fix below the managed-agent threshold). Verification:
554/39 tests, tsc clean, lint clean, align 324→324 (+0).

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

### D4 result (2026-08-10) — shape-only-assertion sweep + `unknown[]` ban shipped

**Scope**: `eval/GITNEXUS_COMPARISON.md` §13.7/§14.6 measured 65 of 694 `expect()`
calls suite-wide as SHAPE-only at review time (12/117 concentrated in
`tools.test.ts`), naming `tools.test.ts:437–446`'s
`typeof res.summary.potential_count === 'number'` as the exact pattern that masked
M4's truncation defect. The enforceable rule: no `unknown[]`/bare `unknown` in a
test's response type annotation, plus a content assertion on every returned array.
Re-measured per the task brief rather than trusting the old counts (suite had grown
554→555 tests, 39→40 files including this work's own meta-test).

**Before/after — `unknown[]` and bare-`unknown` response annotations** (found via
`grep -rn "unknown\[\]"` / `": unknown\b"` across `src/**/__tests__/*.test.ts`,
cross-checked against the new AST meta-test below):

| file | `unknown[]` found | bare `unknown` field found | fixed |
|---|---|---|---|
| `mcp/tools/__tests__/tools.test.ts` | 43 | 2 (`is_exported`, legitimate) | 43 retyped to concrete minimal shapes; 2 allowlisted with a written reason (runtime-type verification, not shape laziness) |
| `telemetry/__tests__/metrics.test.ts` | 5 | 0 | 5 retyped |
| `mcp/__tests__/staleness.test.ts` | 0 | 2 (`(err as { code: unknown }).code`) | 2 allowlisted — an error-narrowing idiom on a caught driver exception, not a tool/CLI response |
| all other 36 test files | 0 | 0 | — |

**Total: 50 occurrences found, 48 retyped to concrete field shapes (0 remaining
anywhere in the suite), 4 allowlisted with a written per-site reason (0 unjustified
allowlist entries).** The concentration matched the review's own finding almost
exactly — `tools.test.ts` and `metrics.test.ts` (both JSON-serialized tool-response
boundaries) accounted for 48/50 hits; the two non-response hits in `staleness.test.ts`
are a `catch`-block narrowing idiom the rule was never meant to target.

**Shape-only assertions strengthened** (beyond the type-annotation fix — same files,
since that is where the `unknown[]` concentration and the shape-only concentration
coincided): 15 tests in `tools.test.ts`, 2 in `metrics.test.ts`. Representative
examples — `mast_callers`' "returns summary with verified and potential counts" (the
review's own cited pattern) now asserts exact `summary`/`verified_callers`/
`potential_matches` content instead of `typeof … === 'number'`; `mast_status`'s
`indexed_files`/`chunk_count` are pinned to `6`/`70` (deterministic outputs of a fixed
fixture) instead of `toBeGreaterThan(0)`; `mast_implementors`' `Circle.methods` is
pinned to the exact qualified method list instead of a bare length check. Two
assertions on genuinely non-pinnable values (`tokens_full_file_upper_bound` — real
`@anthropic-ai/tokenizer` output, not a formula) keep a bound, now with an explicit
one-line comment naming why exact pinning would be dishonest.

**Vacuous-pass findings (2) — test premises that were false, masked by shape-only
assertions.** Both are test-fixture bugs, not production defects; verified against
production behavior before touching either, per the task's STOP-and-verify rule:

1. **`mast_search` "limit is respected"** queried `'a'` with `limit: 2` and asserted
   `results.length <= 2`. Empirically, query `'a'` matches **zero** results against
   this suite's fixture (too short for the FTS tokenizer), so the assertion passed
   regardless of whether `limit` did anything at all — the cap was never exercised.
   Verified `limit` actually works by re-running against `'helper'` (60 candidates in
   `large.ts`, 10 returned unlimited, exactly 2 returned with `limit: 2`, matching
   `helper0`/`helper1` by rank) before rewriting the test to use that query.
2. **`mast_efficiency` "returns a valid session efficiency result (empty session)"**
   called `mast_efficiency({scope: 'session'})` through the file-shared `ctx`
   (`sessionId: 'test-session'`) — the same session every earlier describe block in
   the file had already recorded calls under. Direct query confirmed **48** rows
   already existed under that session id by the time this test ran; the four
   `typeof x === 'number'` checks passed identically whether the session was actually
   empty or not. `querySessionSummary` itself aggregates correctly by session id
   (the intended contract) — the bug was test isolation, not production code. Fixed
   by giving this one assertion its own genuinely-unused session id (same shared
   `db`, no new fixture needed) so "empty" is actually true, then asserting the full
   exact response.

No production-code defect was found by this sweep (unlike M4, which this rule exists
to prevent recurring) — both findings were test-only and are fixed in place.

**Enforcement — `src/__tests__/assertion-rule.test.ts` (new).** A cross-cutting AST
scan (TypeScript compiler API, already a project dependency) over every
`src/**/__tests__/*.test.ts` file: walks each file's AST for `ArrayTypeNode`s whose
element is the bare `unknown` keyword and `PropertySignature`s typed bare `unknown`
(a distinct node kind from function parameters, so mock handler signatures like
`tool(name, desc, schema: unknown, handler)` are not false positives). A violation is
allowed only with a same-line or nearby (≤20 lines above) `mast-assertion-rule-allow:
<reason>` comment carrying a non-trivial reason (≥15 chars after the marker) — both
existing allowlisted cases are documented above. **Mechanism and limits are stated in
the test file's own header comment**, restated here per the task brief: this test
mechanically enforces the `unknown[]`/bare-`unknown` ban; it does **not**, and cannot
cheaply, verify "every returned array gets a content assertion" — judging whether a
given `expect()` call constitutes real content verification is a semantic call no
regex/AST scan makes reliably. That half was this one-time manual sweep; the
mechanical ban exists so the annotation laziness that enabled M4-class shape-only
assertions to go unnoticed cannot quietly return.

**Process note**: the task's prescribed order was meta-test-first (red phase informs
the sweep worklist). This work instead discovered the worklist via targeted `grep`
first and swept from it, writing the AST meta-test afterward as the enforcement
mechanism — the meta-test still ran red on first execution (the two `staleness.test.ts`
narrowing-idiom cases, not yet allowlisted at that point) and every red item was
resolved before the meta-test went green. End state is equivalent to the prescribed
order; noted as a deviation for the record.

**Verification**: 555 tests / 40 files (was 554/39 — the meta-test is the one net-new
test), `tsc --noEmit` clean, `eslint src` clean, `pnpm align:check` from repo root:
baselined debt 324 → 324 (0), red only on the 2 pre-existing non-mast violations
(`application/ui/src/views/root-layout.tsx` import cycle,
`application/api/src/domain/spec/fold-build-record-repository.ts` layer violation —
both unrelated to this change).

### D3 result (2026-08-10) — audit found the claims already fixed; one live config-example drift caught red

**Three-claim audit (the task's actual mandate — not a rewrite).** Independently
re-verified each of the three historical false claims cited by
`eval/GITNEXUS_COMPARISON.md` §14.5 against the current spec text and current code:

1. **Lock granularity (§7.6).** TRUE. §7.6 states JIT re-parse "does NOT acquire
   `structure.lock`" and instead goes through `populateFile`'s own `BEGIN IMMEDIATE` +
   dedicated 200ms `busy_timeout`. `graph/populate.ts:91`
   (`IMMEDIATE_WRITE_BUSY_TIMEOUT_MS = 200`) and `mcp/staleness.ts`'s doc comment
   ("F11 removed `structure.lock` from this path entirely") confirm it exactly — no
   `structure.lock` acquisition anywhere on the JIT path. F11's rewrite (cited in the
   task brief) holds.
2. **Process model (§7.4).** TRUE. The 4-step startup ladder (bootstrap → schema
   check → open transport with all 11 tools registered, SERVER READY → async
   background reindex) matches `mcp/server.ts` line for line: `registerAllTools`
   completes and `await server.connect(transport)` returns BEFORE Step 4's
   `void (async () => { await runIndex(...) })()` fires — the `void` prefix and
   post-connect placement prove the background reindex cannot delay tool
   registration or transport readiness.
3. **this/super resolution (§10.3.1).** TRUE. `emitClassEdges`
   (`ast/extractors/typescript.ts`) seeds `this` → the enclosing class name
   (`resolution: 'this_method'`) and, only when an `extends` clause is present,
   `super` → the parent class name (`resolution: 'super_method'`) — exactly as
   documented. The nested-scope exclusion claim also holds: `collectCalls`'
   skip-list (`function_declaration`, `method_definition`, `class_declaration`,
   `generator_function`, etc.) excludes `this.foo()` inside those bodies but has no
   `arrow_function` entry, matching the spec's "arrow functions inherit the
   enclosing `this` and are not excluded" claim precisely. F4's fix holds.

**Quarantine result: nothing moved to Appendix A.** All three claims are TRUE,
testable-in-principle, and contract-relevant — the brief's own instruction is "do NOT
quarantine text that is true, testable, and contract-relevant." No mechanism prose in
§7.4/§7.6/§10.3.1 needed deletion; no Appendix A section was added to MAST_SPEC.md
because there is nothing non-normative to file into it. This matches the task's own
expectation ("Expect this to be a SMALL diff — most drift is already fixed").

**Conformance suite shipped — `src/__tests__/spec-conformance.test.ts` (new, 17
assertions across 12 `it` blocks).** Each assertion extracts a targeted value from
`MAST_SPEC.md`'s own text (anchored to a distinctive section phrase, never a line
number) and compares it against the corresponding code constant or behavior, so a
drift on *either* side goes red:

- §4.1's `mast.config.json` example (`rrf_k`, `chunk_split_threshold`, `context_lines`,
  `markdown_heading_depth`, `declaration_exact_ranker`, `file_extensions`,
  `exclude_patterns`) ↔ `resolveConfig()`'s resolved defaults against a fresh project
  root (the real resolution path, not a re-declared expectation that could drift
  independently of `DEFAULTS` the same way the spec's own copy did).
- §8's `mast init --state-dir` documented default (`<path>/.mast`) ↔
  `resolveConfig()`'s `state_dir`.
- §5's `index.json` example `schema_version` ↔ `CURRENT_SCHEMA_VERSION`.
- §7.4's "currently `"1.3.0"`" constant prose ↔ `CURRENT_SCHEMA_VERSION`.
- §7.4 Step 3's "all 11 tools" enumeration (count AND names) ↔ `registerAllTools`'s
  actual registrations, captured via the same capture-server trick `cli/query.ts`'s
  `createCaptureServer` uses, built against a real (if empty) on-disk database rather
  than a synthetic `AppContext` double.
- §7.6's dedicated JIT-write `busy_timeout` (200ms) ↔ `IMMEDIATE_WRITE_BUSY_TIMEOUT_MS`.
- §7.6's `proper-lockfile` stale threshold (10 seconds / `10000`) ↔ `store/lock.ts`'s
  `STALE_MS` (read from source text rather than exported, to avoid widening
  `lock.ts`'s public API for one test-only value — same technique used for the next
  item).
- §9's `mast_callers`/`mast_rename_impact` potential-match cap (50) ↔
  `collectPotentialMatchCandidates`'s default `limit` parameter (also a source-text
  read — it is a default parameter value, not a named export).
- §14.2's per-call tokenize budget (32) ↔ `FULL_FILE_TOKENIZE_BUDGET_PER_CALL`.
- §14.5's tokenizer label ↔ `TOKENIZER_LABEL`, compared as an exact string.

Per the task brief, no timing claims (§9.0's "10–50ms" JIT figure, §7.4's cold-start
"2–4 seconds") are asserted — stated explicitly in the test file's header comment as
deliberately out of scope for CI (flake risk), remaining verified by the `eval/`
measurement harness (E7/E7-r2, D6) instead. Extraction failure is fail-loud by design:
every anchor lookup throws naming the missing anchor rather than silently passing.

**Red-phase finding — real drift caught on first run.** 16/17 assertions passed
immediately; `exclude_patterns matches` failed:
```
- Expected
+ Received
  Array [
-   "**/node_modules/**",
-   "**/dist/**",
-   "**/coverage/**",
+   "node_modules/**",
+   "dist/**",
+   "coverage/**",
    ".kluster/**",
    "**/*.test.ts",
    "**/*.spec.ts",
  ]
```
§4.1's `mast.config.json` example was missing the `**/` prefix `store/config.ts`'s
`DEFAULTS.exclude_patterns` actually carries on the `node_modules`/`dist`/`coverage`
entries (needed to match those directories at any depth in a monorepo, not just at
the project root) — a genuine, previously-undetected spec/code drift, distinct from
the three historical claims this stage was scoped to re-audit. Fixed in the spec per
the task's process rule (code wins): `MAST_SPEC.md` §4.1's example now reads
`"**/node_modules/**"`, `"**/dist/**"`, `"**/coverage/**"`. Re-run after the fix: 17/17
green. No production `src/` constant was touched.

**Verification**: 572 tests / 41 files (was 555/40 — 17 net-new assertions in one new
file), `tsc --noEmit` clean, `eslint src` clean, `pnpm align:check` from repo root:
baselined debt 324 → 324 (0), red only on the same 2 pre-existing non-mast violations
(`application/ui/src/views/root-layout.tsx` import cycle,
`application/api/src/domain/spec/fold-build-record-repository.ts` layer violation).

**Deviations**: none from the mandated scope. The task's example numbers (F5's
schema-version bump to 1.3.0) were pre-verified true rather than found drifting — the
red phase's one finding was the `exclude_patterns` prefix mismatch instead, reported
per process rule 1 exactly as the schema-version scenario would have been.

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

**D0 result (2026-08-07):** Shipped as designed — no re-implementation of tool logic
in the CLI.

- **Shared-registry refactor.** Extracted `mcp/register-tools.ts` exporting
  `registerAllTools(server, ctx)`, containing the 11 `registerXTool(server, ctx)` calls
  (search, project-skeleton, exports, signature, callers, dependencies, implementors,
  reindex, status, efficiency, rename-impact) that previously lived inline in
  `mcp/server.ts:77-87`. `server.ts` now calls `registerAllTools` — registration order
  preserved, behavior-preserving (verified: full suite green before/after with no test
  changes needed in `mcp/tools/__tests__/*`).
- **Capture-dispatch design.** `cli/query.ts`'s `createCaptureServer()` builds a
  structural `{ tool(name, description, schemaShape, handler) }` object, narrowed via
  one pre-approved `as unknown as McpServer` (the same seam
  `mcp/tools/__tests__/tools.test.ts`'s `createMockServer` already uses), passed to
  `registerAllTools`. `runQuery` looks up the captured `(schemaShape, handler)` pair by
  tool name, and invokes the handler directly — the exact function an MCP client's call
  would have invoked, so JIT/staleness/`_stats` behavior can never drift between the two
  transports.
- **Zod validation at the CLI edge.** The parsed JSON argument is validated with
  `z.object(tool.schemaShape).parse(...)` — the identical per-tool zod shape the MCP
  layer validates with (project CLAUDE.md §3.2: validate at the trust boundary) — before
  the handler ever sees it.
- **Red-first evidence.** `cli/query.ts` was stubbed with `runQuery` throwing
  `new Error('not implemented')` and `registerQueryCommand` throwing likewise; the 14
  new tests in `cli/__tests__/cli.test.ts` were run against the stub first. All 14 failed
  on assertion/behavior grounds, not import or syntax errors:
  `mast query — dispatch/serialization parity > '<tool>' > CLI --json output
  structurally matches...` (9 rows: mast_search, mast_project_skeleton, mast_exports,
  mast_signature, mast_callers, mast_dependencies, mast_implementors,
  mast_rename_impact, mast_status) plus the isolated `mast_efficiency` case all failed
  with `Error: not implemented`; the 4 error-path tests (`rejects an unknown tool name`,
  `rejects malformed JSON`, `rejects args that fail the tool's zod schema`, `rejects a
  state dir with no graph.db`) failed with `AssertionError: expected error to be
  instance of QueryError` (the stub threw plain `Error`, not `QueryError`). Real
  implementation turned all 14 green with no test changes.
- **Verification.** `pnpm -F mast test`: 471 tests / 35 files green (baseline 457/35 +
  14 new — no regressions, no skips). `pnpm -F mast typecheck`: clean. `pnpm -F mast
  lint`: clean. `pnpm align:check` (repo root): `baselined debt: 324 → 324 (0)`, red only
  on the same 2 pre-existing violations (`root-layout.tsx`, `fold-build-record-
  repository.ts`) — no new violation from `register-tools.ts` or `query.ts` (mast is a
  single flat align component, `packages/mast/**`, so neither file's placement could
  trip a dependency-direction rule).
- **Manual smoke test** (built `dist/`, ran against a throwaway single-file project):
  `mast query mast_status '{}' <path>` pretty-prints; `mast query mast_search
  '{"query":"add"}' <path> --json` emits the single-line MCP text with a populated
  `_stats` block; `mast query mast_bogus '{}' <path>` prints `unknown tool "mast_bogus";
  available tools: mast_callers, mast_dependencies, mast_efficiency, mast_exports,
  mast_implementors, mast_project_skeleton, mast_reindex, mast_rename_impact,
  mast_search, mast_signature, mast_status` to stderr and exits 1.
- **Success criterion met**: the three throwaway harness scripts under
  `~/temp/mast-bench/` (`mcp-call.mjs`, `mcp-call2.mjs`, `jit-probe.mjs`) are now
  deletable — `mast query <tool> <json>` replaces what they hand-rolled over stdio.
  Deletion itself left to whoever owns that scratch directory; it is outside
  `packages/mast/`.
- **Deviations**: none from the brief's mandated architecture or CLI contract.
  `mast_reindex` was included in `registerAllTools` (preserving the original 11-tool
  registration list, per instruction 1) and is reachable via `mast query mast_reindex`,
  but — per the brief's explicit test list — has no dedicated dispatch-parity test row;
  it is a write op, not a read tool, and duplicating its own coverage (already exercised
  in `mcp/tools/__tests__/reindex.test.ts`) was out of scope for this stage's §5.5
  budget.

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

**S1 (added 2026-08-07, promoted from HANDOFF §5's defect list): batch
`replaceChunksForFile`'s insert.** `src/store/sqliteChunkStore.ts:82` issues ONE
multi-row `INSERT` for all of a file's chunks; at 11 columns/row, SQLite's
32,766-parameter ceiling caps a single file at ~2,979 chunks, and a larger file's
insert rolls back entirely — loud (`write_errors` + CLI exit 1) but the file is then
silently absent from the index for any orchestration that gates only on exit code.
Found via vscode's whale fixture files. This is the known write-path correctness
defect at the 150k-chunk target; fix = chunked inserts inside the same transaction.

**S1 result (2026-08-07):** fixed the whole defect class, not just the named site —
a survey of every multi-row write in `store/` and `graph/` found 8 sites sharing the
same SQLite `MAX_VARIABLE_NUMBER=32,766` ceiling (better-sqlite3 12.11.1 / SQLite
3.53.2):

| # | site | file:region | cols/row | rows/batch (`⌊32766/cols⌋`) |
|---|---|---|---|---|
| 1 | `chunks` insert | `store/sqliteChunkStore.ts` `replaceChunksForFile` | 11 | 2,978 |
| 2 | `chunks` insert (production path) | `graph/populate.ts` `replaceChunksInline` (`populateFile`'s default, no-override path) | 11 | 2,978 |
| 3 | `symbols` insert | `graph/populate.ts` `populateFile` | 7 | 4,680 |
| 4 | `imports` insert | `graph/populate.ts` `populateFile` | 5 | 6,553 |
| 5 | `chunk_fts` insert | `graph/populate.ts` `populateFile` | 4 | 8,191 |
| 6 | `identifier_fts` insert | `graph/populate.ts` `populateFile` | 3 | 10,922 |
| 7 | `edges` insert (`onConflict(doNothing())`) | `graph/populate.ts` `insertEdges` | 6 | 5,461 |
| 8 | two `IN`-list SELECTs (`fromNames`, `structuralToNames`) | `graph/populate.ts` `insertEdges` | 1 param/name | 32,766 |

Site 2, not site 1, is the one that actually fired on vscode — `populateFile`'s
default path writes `chunks` inline via `replaceChunksInline`, not through
`SqliteChunkStore`; `SqliteChunkStore.replaceChunksForFile` is a parallel write path
(used directly, and as the write-failure test injection point) with the identical bug.

**Design.** One shared, pure, unit-tested helper pair in a new module,
`src/graph/sqliteBatch.ts`: `SQLITE_MAX_VARIABLES = 32_766` (exported constant, WHY
sourced from better-sqlite3/SQLite's `MAX_VARIABLE_NUMBER` default) plus
`chunkRowsForSqlite<T extends object>(rows)`, which computes batch size as
`Math.floor(SQLITE_MAX_VARIABLES / columnsPerRow)` with `columnsPerRow` read from
`Object.keys(rows[0]).length` (every call site builds rows through one fixed-shape
mapper, so row 0's key count is authoritative — documented as an explicit assumption
in the TSDoc), and a sibling `chunkValuesForSqlite<T>(values, paramsPerValue = 1)` for
the bare-scalar `IN`-list sites (site 8). Both return `[]` for empty input, not `[[]]`.
Placed in `graph/` (not `store/`) because `store/sqliteChunkStore.ts` already imports
`Db` from `../graph/db.js` — `store -> graph` is the existing dependency direction, and
`graph/` importing from `store/` would add a new one; mast is one flat align component
so this is a placement choice, not a conformance requirement, but the existing edge
direction is the more legible default. `pnpm align:check` was re-run post-fix to
confirm no new edge was introduced (see Verification below).

**Atomicity preserved.** Every batch runs inside the SAME `db.transaction()`/`trx` the
unbatched call used — batching is applied to the STATEMENT, not the transaction
boundary. A whale file's chunks still commit or roll back atomically together with its
symbols/edges/imports/FTS rows; see the WHY-comment at `store/sqliteChunkStore.ts`'s
`replaceChunksForFile` (first fixed site) and the fuller one at `graph/populate.ts`'s
`replaceChunksInline` (the production path). Site 7's `.onConflict((oc) =>
oc.doNothing())` is re-applied per batch (each batch is its own statement). Site 8's
`structuralToMap` first-row-wins dedup is preserved exactly: `structuralToNames` is
already deduped via `Set` before batching, so each name lands in exactly one
`IN`-list batch — cross-batch collisions are structurally impossible, and the
within-batch dedup loop (`if (!structuralToMap.has(row.name))`) runs unchanged,
processing batches in their original order.

**Red-first evidence (§5).** Unit spec `src/graph/__tests__/sqliteBatch.test.ts` (10
tests: empty input, single row, exactly-at-ceiling batch boundary, ceiling+1 spill, a
1-column max-batch-size shape, content/order preservation, plus the `chunkValuesForSqlite`
equivalents) was written against a stub that threw `not implemented` — confirmed RED
(10/10 failing) before the helper was implemented, then green after.
Integration red: `src/graph/__tests__/whale-file.test.ts` calls `populateFile` directly
with a synthesized extraction (3,000 chunks × 11 cols = 33,000 params; 5,000 symbols ×
7 cols = 35,000 params; matching identifier rows) — on unfixed code this failed with:

```
SqliteError: too many SQL variables
  at replaceChunksInline (src/graph/populate.ts:254:8)
```

Sibling red test added to `src/store/__tests__/sqliteChunkStore.test.ts`
("`replaceChunksForFile` writes a whale-scale chunk set past the SQLite
bound-parameter ceiling", 3,000 chunks) failed identically on unfixed code:

```
SqliteError: too many SQL variables
  at src/store/sqliteChunkStore.ts:82:71
```

Both became green after the fix, asserting `written: true` / exact DB row counts for
chunks and symbols, and the removed-count contract (`chunksRemoved` /
`replaceChunksForFile`'s return value) held across a whale-scale replace.

**Deliberate test-budget call (§5.5).** Sites 7 (edges) and 8 (the two `IN`-list
SELECTs) are covered by the shared helper's unit tests plus code review, not a
dedicated whale-scale integration fixture — building a fixture with >5,461
RESOLVABLE edges (site 7's cap) requires thousands of cross-referencing symbols with
real POTENTIAL_CALL/IMPLEMENTS/EXTENDS resolution, which is disproportionate effort
for a mechanical batching change already proven correct by the shared helper's tests
and by sites 3–6 (which use the identical `chunkRowsForSqlite` call) landing 5,000
symbols correctly in the whale-file integration test.

**Verification (2026-08-07):**
- `pnpm -F mast test`: **483 passed (37 files)** — baseline 471/35 plus 12 new
  (10 helper unit tests, 1 whale-file integration test, 1 sibling
  `SqliteChunkStore` whale test).
- `pnpm -F mast typecheck`: clean.
- `pnpm -F mast lint`: clean.
- `pnpm align:check` (repo root): `baselined debt: 324 → 324 (0)`; red only on the 2
  pre-existing non-mast violations (`application/ui` import cycle,
  `apiDomain -> apiDb`) — no new debt introduced by this change.

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

**[Correction, 2026-08-02 — see Q1/SCALE below]:** vscode's true chunk count is **138,440**,
read from `graph.db`'s `chunks` table after indexing. 152,969 was the CLI stdout counter,
which silently includes two files whose chunk writes failed deterministically on SQLite's
32,766-parameter INSERT ceiling (`replaceChunksForFile`, `src/store/sqliteChunkStore.ts`).
See the Q1/SCALE registration's corpus-truth-correction subsection for the full root cause
and the product-defect finding.

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
| **Q1** | **Is the vector store justified at all?** E4 is one-directional by design and the harness is rotted (§14.3). **Gates M2.** Pre-registered design below | **ANSWERED (2026-08-04): delete** — M2 memo + Stage 7 |
| Q2 | Should generated/minified files be chunked at all? (451 KB single-line file → 232 `block` chunks) | Not Started |
| Q3 | `populateFile` FTS insert cost grows with index size (0.37→1.35 ms/KB *within* one run, order-independent) — survives the migration, matters at n8n scale | Not Started |
| Q4 | ~~Live index is 83% unembedded — wire embedder completion, or stop reporting `mode: "hybrid"`~~ | **Moot** — Stage 7 deleted the embedder and the `mode` surface |
| Q5 | Result diversification in `mast_search` — no per-file dedup exists (shell↔method dedup only, now in `fused.ts`). Held at P2: evidence was n=1 and confounded by lexical-only mode. Re-test — **unblocked** (Q1 answered, Q4 moot) | Not Started |
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
ordering (registration `ad88009` 08:41Z → instrument `e61008c` 09:02Z → seal → runs
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
as committed at `3e497da`, **before any measurement had occurred**. Per the Q1/OUTCOME
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
| 3 | **The committed instrument shipped without working CLI entry points** — `scale-rank-check.mjs` and `scale-score.mjs` document a scored-sweep/self-check/scorer invocation in their own header comments but expose no CLI to run it; measurement instead ran through three runner-authored driver scripts (`scale-run-selfcheck.mjs`, `scale-run-measure.mjs`, `scale-run-score.mjs`, committed at `f40f2bf`). | No direction found. The review audited the drivers line-level and found them faithful: `limit=200`, `rrf_k=60`, explicit `chunkStore`, correct embedder wired per arm, seed 1001 pre-committed before any measurement. |
| 4 | **`runSelfCheck`'s mismatch counter under-counts** — it excludes reconstruction failures and mode-integrity failures from its own tally; the runner computed the AMENDMENT-1-widened criterion externally to get Gate 2's reported 80/80. | Anti-false-pass (the widening is stricter, not looser) — but this is a latent instrument defect: fix `runSelfCheck` to count what Gate 2 actually requires before this instrument is reused. |
| 5 | **`query_id`, the Δlog2 aggregate, and the monotonicity CI formula were runner constructions**, under-specified by the registration text itself. | Reviewed directly: deterministic, follows the committed F1 sign convention, seed-insensitive (200/200 alternative seeds agree), and zero-flags robust (no CI approximation could change which monotonicity flags fire). No direction found. |

The hit-rule sensitivity (F-R1) and the magnitude framing (F-R2) from the review are carried
in the RESULT text above, not repeated here. The review's structural finding — **the
registered consistency triggers guarded only the branch the investigator's own prior
(deletion) argued against** — is an asymmetry to make symmetric in any future registration on
this track, the same lesson AMENDMENT 1 already applied to the discharge branch.

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
| L  | chunk_fts BM25 (shipped lexical) — **RE-RUN in full** alongside the new arms (AMENDMENT 1, F3: no row reuse from f40f2bf) |
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
pipeline, same frozen tier states, same frozen query set — rather than reusing f40f2bf's raw
rows, for three registered reasons: (a) the f40f2bf rows carry only per-target ranks, not full
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
   per-target ranks against the archived f40f2bf raw rows and reports agreement/divergence.
   Any divergence is documented as run-level drift — informative context for interpreting Δ′,
   never a reason to discard the fresh rows, which are what the decision statistic uses
   regardless of what this report finds.
E. **Vector coverage** — pending_embeddings == 0 per tier (H arms only).

#### Costs

**6,400 scored searches (AMENDMENT 1, F3): 4 arms × 400 queries × 4 tiers** — L and H are now
RE-RUN in full alongside L+I and H+I rather than reused from f40f2bf — **+ 80 probe calls**
(10 probes × 4 tiers × 2 arms, Gate A). Gate D's cross-run comparison (above) reuses the
freshly-collected L/H rows already counted in the 6,400 and adds no further search cost — only
a comparison against the archived f40f2bf rows. Still minutes to tens of minutes; zero embeds;
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
as committed at `9ecceca`, **before any measurement had occurred**. Per the Q1/SCALE and
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
| 3 | Reuse of f40f2bf's L/H rows is false economy guarded by a weak sample: raw rows carry only per-target ranks (Gate D is necessarily per-target, not a full reconstruction); 20 queries misses real drift 67% of the time at f=2%, 36% at f=5%; and the paired Δ′ would subtract a 2026-08-02 H row from a 2026-08-03 L+I row, landing run-level environment drift INSIDE the decision statistic. | L and H RE-RUN in full alongside L+I/H+I (6,400 total scored searches, still minutes, zero embeds); Gate D demoted to a cross-run reproducibility REPORT, descriptive, never gating. | **Unknowable** — collision/drift direction can't be signed in advance. |
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
the archived `f40f2bf` blob; the adversarial results review independently verified
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
as committed at `74c5d96`, **before any measurement or query-set generation had occurred** —
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

## M2 DECISION MEMO (2026-08-04) — arm D (delete) recommended; the scoped-out gaps confronted on the record

Written per HANDOFF_Q1.md §4a, BEFORE any A-vs-C benchmark and before any deletion or F18
productization work. Nothing in this memo is new measurement; every number cites an entry
above or the committed evidence under `eval/results/`. **Execution does not begin until the
project owner ratifies this memo** — the decision below is the inheriting session's
recommendation, recorded with its full basis so ratification or rejection can be equally
informed.

### The option set (unchanged from the M2 framing, Stage 2)

| arm | | evidence today |
|---|---|---|
| A | Lance with IVF-PQ enabled | none — never created |
| B | SQLite BLOB + JS brute-force | eliminated on paper (169 ms / 470 MB @153k) |
| C | `sqlite-vec` | none — not a dependency |
| **D** | **delete vectors entirely** | Q1 program: four converging lines + DECLEX closure |

### The decision rule this memo applies

Keep a subsystem when its measured benefit, in the units the cost is paid in — agent task
outcomes, query latency, resident memory, build time, dependency weight — exceeds its
measured cost. Retrieval-rank advantages count only insofar as a measured mechanism
converts them into those units. The standard of evidence demanded scales with the cost of
the thing being defended: F18's marginal cost is near zero, so retrieval-level evidence
suffices to justify it; the vector subsystem's cost is large, so outcome-level conversion
is demanded of it before its retrieval-level advantages count. This asymmetry is
deliberate, not an oversight. The cost-threshold half of the rule is the same one that
eliminated arm B on paper — B was eliminated on cost thresholds alone, before benefit ever
entered the analysis, so it is precedent for cost-threshold reasoning only, not for the
benefit-conversion standard applied to vectors here.

### The ledger

**Costs of keeping vectors (all measured, none moved):**
- 91 MB native dependency (`@lancedb/lancedb`) retained for exactly one table, with its
  differentiator (IVF-PQ) never enabled — today's arm is brute-force scan behind the dep.
- 7.2 h embed at the 153k target (batching FALSIFIED as a fix, Stage 4.5 — the figure is
  a model cost; q8/multi-process untested and affect build time only).
- 470 MB f32 resident + 169 ms/query brute-force at 153k against a 144 ms total p50 — or
  else an A-vs-C benchmark program whose only purpose is keeping the option alive.
- The forked background embedder, `vectors.lock`, the cold-start `mode: "lexical"` ladder,
  83 MB embed cache, ~140 MB Docker model-weights layer (MAST_SPEC.md §13.8.1), Docker-seed
  Phase 2 build time.
- The operational datum: the live index ran **83% unembedded** (Stage 5 Q4) (duration
  unquantified) — lexical-only in practice — and nobody noticed a quality problem.

**Benefits of keeping vectors (all measured):**
- Retrieval-rank advantages on prose gold sets: kluster-normal H−L = 0.1669 [0.028, 0.306]
  SIG (not robust to lexical-baseline choice: LOO t = 2.206 vs crit 2.228); S-prose T4
  LEVEL 92/100 vs lexical's 82/100; fresh-set off-stratum L+D deficits −7.25/−7.67 pp,
  seed-robust.
- **Zero measured outcome-level benefit at the point estimate**: Q1/OUTCOME b = c = 0 at
  k = 12, including six verbatim-shared queries whose windows differed (overlap 3–9/10)
  and whose answers did not — but this is concordance within bounds, NOT equivalence: the
  95% upper bound on the outcome-changing rate is **22.1%** pooled (25% by rule of three)
  and **≈39%** on the S-ident stratum alone (n = 6). Effective discrimination was below
  nominal k: three of the four mechanical failures are ground-truth extraction artifacts;
  regraded, both marginals are 11/12 — brushing the registered Gate 5 ceiling. The plan's
  own mandated honest phrasing for this result:

  > *Outcome-concordant at k = 12 under mechanical grading — indeed answer-identical on
  > 12/12 — with effective discrimination below 8/12 because three of the four failures
  > are ground-truth extraction artifacts, an S-ident stratum shadowed by
  > Grep-resolvability, and a mechanism that is query authoring rather than re-querying.*

### Gap 1 — the S-prose T4 LEVEL gap vs H, and the kluster-normal H−L baseline

Confronted, not minimized: hybrid genuinely ranks prose queries better, at every scale
tier, seed-robustly. Three measured facts govern its weight:
1. The advantage is retrieval-level only. The single outcome-level measurement in this
   program (Q1/OUTCOME) found rank deltas of exactly this kind produced byte-identical
   `(file, symbol)` answers on 12/12 tasks (bounded — see the ledger: 22.1%/39% upper
   bounds, not equivalence).
2. The mechanism is measured, not conjectured: **0 of 147** harness-run agent searches
   (the 30 Q1/OUTCOME runs: ~15k-chunk corpus, one prompt style, Bash surface, read-only
   investigative tasks) used the question's prose wording — agents rewrite into
   code-token shorthand before searching. The S-prose stratum (TSDoc-derived prose) is a
   query population real agents were never observed to issue. The stratum where vectors
   retain their advantage is the stratum agents demonstrably do not use.
3. The home-field baseline is fragile: kluster-normal significance does not survive
   leave-one-out lexical-baseline selection.

**The bet:** prose-rank advantage does not convert to outcomes because agents rephrase.
Residual risk: a future query population that cannot rephrase (see Gap 5).

### Gap 2 — harm on identifier-free / mixed-case-prose queries: UNTESTED

D fired on 0.67% / 0.50% of the two off-strata — below the registered 10% exposure floor,
so the harm gate structurally could not fire. The realistic shipped-D exposure (mixed-case
prose mentioning **non-target** identifiers) lies outside every stratum and has never been
measured. Confronted:
- The harm mode is mechanically bounded: D reorders only when a query token exactly
  matches a chunk's own `symbol_name` (full or dotted-segment, case-insensitive). The
  failure shape is anchor-displacement — a target demoted by an exactly-named non-target.
- The only observed off-stratum D effect in 3,200 original row-pairs was one instance:
  rank 1→2, still in-window — but D fired on well under 1% of off-stratum queries, so
  near-zero observed harm is the expected consequence of near-zero exposure, not evidence
  of per-fire safety. One displacement among a handful of fires is not a low per-fire harm
  rate; it is a single data point.
- The measured-harmful construction (D+esc) is excluded — F18 ships WITHOUT escape, and
  the esc-arm harm contrast (harmful at every cap, every cell excluding 0) is precisely
  why extending D's reach requires a fresh registration.

**The bet:** the harm surface stays benign at ship because it is mechanically bounded to
exact symbol-name/dotted-segment token matches, not because real off-stratum exposure is
known to be safe — that exposure is declared ignorance, not measured safety. Mitigations
attached as conditions: config kill-switch backed by D-fire displacement telemetry,
regression fixtures, and a dated harvest-review commitment (see Conditions, below).
This stays an explicit bet, not a demonstrated safety property.

### Gap 3 — outcome-at-scale: still Reserve, unmeasured

Q1/OUTCOME ran at ~15k chunks; no outcome A/B exists at 153k. Confronted: the insulation
mechanism (query rewriting + window-membership sufficiency) has no named scale dependence;
the one stratum where scale measurably bit lexical (S-ident) is the one F18 holds flat
T1→T4 (.9867 → .9867, same 148 queries); the remaining deficits are T4 LEVEL gaps, not
scale-growth effects (Q1/SCALE found no significant scale differential on the
non-identifier strata) — fresh-set L+D −7.25/−7.67 pp vs H off-stratum, and the S-prose
LEVEL gap of 10 pp (92 vs 82/100) — on strata the harness log suggests agents don't use.
**The bet:** those gaps don't convert at scale. This is the least-evidenced leg of the
decision and is named as such.

### Gap 4 — counterpart-credit composition and generalization limit

23/148 (15.5%) of L+D's T4 window hits are shell-counterpart credits (H: 14/148); 2 of the
3 queries where L+D beats H are credits. Confronted: the dedup-aware hit rule is the
registered metric and mirrors the shipped shell↔method dedup UX (the shell outline names
the target member and carries the `related` navigation hint), so a credit is a usable
result, not a scoring fiction — but ".9867 ≥ H" is window-parity, not exact-hit parity, and
is recorded as such. Generalization: closure covers symbol-shaped-token queries from
TSDoc-rich exported declarations on this corpus only — and the closure population is
TSDoc-derived **TypeScript** declarations; non-TS languages (the spec's extensibility
target) are outside it. Accepted because that population is inferred to be the dominant
real-query shape — stated honestly: the shorthand-rewriting finding (agents don't reuse
prose wording) rests on n = 147 harness-run searches, while the "identifier-bearing,
median 5 words" shape itself is evidenced only by the organic harvest at n = 2;
"empirically dominant" is therefore an inference from thin real-query data, not a directly
measured population frequency, and is stated as such.

### Gap 5 — a surface the handoff list does not name: doc-chunk retrieval

Markdown `doc` chunks are ranked by the same pipeline, and prose-over-docs is the one
query population where the rewrite-into-code-tokens insulation does NOT apply (docs need
not contain identifiers). No Q1 stratum measured doc retrieval — in either direction:
vectors' benefit on docs is exactly as unmeasured as lexical's sufficiency. Post-delete,
doc search is trigram-BM25-only. Named as part of the bet rather than silently absorbed.
`.md` doc chunks are indexed and ranked by the shipped pipeline TODAY (Q1/OUTCOME had to
exclude them explicitly) — the exposure begins at deletion, not at a future product
decision. The re-entry trigger is therefore doc-retrieval becoming load-bearing OR any
telemetry/harvest evidence of doc-query traffic; current doc-query traffic is unmeasured.

### The bet, in one place

Deleting the vector store on this evidence bets that: (1) prose-rank advantage without
outcome advantage stays outcome-irrelevant, because agents rephrase; (2) D's untested harm
surface stays benign, because its harm mode is mechanically bounded to exact
symbol-name/dotted-segment matches — real off-stratum exposure is declared ignorance, and
the D-fire telemetry condition exists to convert that ignorance into data; (3)
outcome-neutrality holds at 153k, where it was measured only at 15k; (4) window-parity
built partly on shell credits is parity where it counts; (5) doc retrieval survives on
trigram BM25. Any of these can be wrong. None of them is currently evidenced to be wrong,
and the subsystem's dependency and complexity costs are certain (its performance costs are
priced only at the brute-force configuration) while every one of its benefits stops at the
retrieval layer.

### The middle option, considered and rejected

Flipping the default to the already-shipped `--no-embeddings` configuration (MAST_SPEC.md
§13.11; the experimental L arm WAS this configuration) and keeping the vector subsystem
dormant would capture the embed-time/RAM/model-weights-layer costs while remaining fully
reversible. Rejected: never-shipped status already makes deletion cheap to reverse at the
code level, so the reversibility this option buys is not scarce; a dormant 91 MB
dependency and a dead subsystem contradict the deletion-hygiene half of the rationale; and
dormant code paths rot unmeasured.

### DECISION: arm D — delete the vector store; ship F18 (ranker D, WITHOUT escape)

Vectors' value claim has been given four independent, pre-registered chances to
materialize at the outcome level or to find a niche lexical cannot serve. The one niche
that survived three of those chances (S-ident at scale) is now closed: the concept is a
one-line lexical rule, but the shipping artifact is a symbol-gated ranker with
dotted-segment matching, ordering rules, and its own regression suite, measured at
efficacy +14.67 pp [+9.33, +20.0] and a seed-invariant decision-contrast upper bound of
exactly 0. What remains on the benefit side is a prose-stratum rank advantage that the
program's only outcome measurement says does not reach the user (bounded — see the
ledger: 22.1%/39% upper bounds, not equivalence), on queries that 147 harness-run agent
searches (the 30 Q1/OUTCOME runs: ~15k-chunk corpus, one prompt style, Bash surface,
read-only investigative tasks) show agents rewriting away from rather than issuing
verbatim. Against that stand costs that are certain on the dependency and complexity
axes; the 470 MB / 169 ms figures price the brute-force configuration only (arm A with
IVF-PQ was never measured), and the 7.2 h embed is a build-time, cached cost, not a
per-query one. Under the decision rule above, D.

### Conditions attached to the delete (constitutive, not advisory)

1. **F18 scope:** ranker D exactly as measured — symbol-gated, full-name + dotted-segment,
   case-insensitive, WITHOUT the escape variant. Any escape-like extension requires a
   fresh pre-registration (measured harmful as constructed).
2. **Regression suite:** Gate B's fixtures (dotted `Class.method` segment match, camelCase
   full match, case-insensitivity, high-multiplicity-segment ordering) become permanent
   tests, not throwaway instrument checks.
3. **Kill-switch:** D ships behind a config flag, default on — the untested harm surface
   gets an operational escape hatch that is not a code change. F18 ships with D-fire
   telemetry written to the existing `metrics` table: per-query, whether D fired, and the
   pre-fusion vs post-fusion rank of the anchored result and of the displaced result
   (when any). Without this, neither the kill-switch nor re-entry criterion 1 has an
   actual input signal.
4. **Deletion is total at code level** (never-shipped: no migrations, no back-compat):
   `@lancedb/lancedb`, `vectors.lance`, `embedder.ts`/`background-embedder.ts` fork,
   `vectors.lock`, embed cache, model-weights Docker layer, seed Phase 2, the
   `mode` discriminator and cold-start ladder Step 4's embed half. AST/graph/FTS tools are
   untouched (pure tree-sitter + SQLite). The honest `mode` surface post-delete is a
   product design point for F18 productization, not this memo.
5. **The organic harvest remains the standing real-query instrument** — unchanged status.
   The archived embedded assets (`eval/ASSETS.md`) are retained off-repo so re-entry never
   re-pays the 7.4 h embed to reconstruct the H baseline. A dated re-entry review fires at
   organic-harvest n ≥ 67 (the plan's own power target) or 90 days after deletion ships,
   whichever comes first. Organic n = 0 at that review is itself a finding — it means the
   standing instrument has no data source — and forces an explicit re-decision of the
   monitoring plan.
6. **Plan consequences:** Stage 5 Q4 (wire embedder completion) and Stage 4.5 lever 7
   (ANN) become moot; the A-vs-C benchmark is cancelled, not deferred.

### Re-entry criteria — what evidence would reverse this decision

- Harvested agent-authored queries, scoped to those answerable against the frozen
  archived snapshot, showing window-membership degradation vs the archived H baseline
  (the harvest instrument exists; the comparison is pre-registerable then).
- A product shift that makes prose-first retrieval load-bearing (doc search as a feature,
  markdown-heavy corpora) — Gap 5's trigger.
- Sustained D-fire displacement telemetry (condition 3) showing D demoting in-window
  targets on real queries at a rate materially above the single instance observed in this
  program.

Re-entry runs through the A-vs-C benchmark at that time, with the then-current corpus —
not through resurrecting this program's arms.

### Adversarial review of this memo (Fable agent, 2026-08-04)

Verdict: SURVIVES-WITH-REQUIRED-CHANGES. Seven required changes were mandated; all seven
are applied above — the memo now incorporates them. The review's error-direction finding:
the memo's overstatements ran predominantly pro-delete — the same direction the program's
§8 warning names. Full review committed verbatim at `eval/results/m2-memo-review.md`.

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

## Stage 7: Vector-store deletion (2026-08-06, per M2 memo condition 4)

**Goal**: remove the vector subsystem entirely. Post-delete, `mast_search` is L+D exactly
as measured (FTS BM25 + ranker D under RRF). AST/graph/FTS tools untouched.

**Design decisions (recorded before implementation):**

1. **Re-entry anchor is the git tag `mast-pre-vector-delete`** (= `a966237`, the F18
   commit). Instrument re-runs of vector arms and H-baseline reconstruction happen from
   that tag; HEAD does NOT keep the vector-dependent eval imports runnable. The `eval/`
   files stay in-repo as the record, but at HEAD their `dist/search/vector.js` etc.
   imports will not resolve — accepted and recorded (§3 says the experiments are settled;
   re-entry checks out the tag). Archived embedded assets per `eval/ASSETS.md` complete
   the re-entry kit.
2. **Never-shipped ⇒ no back-compat.** The `mode` discriminator and `similarity_score`
   are REMOVED from the search response (not frozen at `"lexical"`/`null`), `mast_status`
   drops `pending_embeddings`/`embedding_mode`/`model` and the `"embedding_backlog"`
   freshness cause, and the config keys `embedding_model`/`transformers_cache_dir` go.
   Sequenced in TWO steps so the excision diff stays pure removal: 7.1 excises the
   subsystem with the response shape temporarily unchanged (`mode` hardcoded
   `"lexical"`, `similarity_score` always `null`); 7.2 redesigns the surfaces honestly.
3. **No `CURRENT_SCHEMA_VERSION` bump**: nothing the new code READS changes shape —
   chunks/graph/FTS are untouched; `vectors.lance`/`embed_cache`/`vectors.lock` become
   orphans. Startup best-effort-deletes orphaned vector state from the state dir (logged,
   never fatal). `metrics.mode` column stays (historical rows); new rows write NULL.
4. **`hybridSearch` is renamed in 7.2** (the name asserts a vector+lexical hybrid that no
   longer exists) — target name `fusedSearch`, via `mast_rename_impact` checklist. The
   `chunkStore` parameter becomes REQUIRED in 7.1, which retires the HANDOFF §5 defect
   "`hybrid.ts:55` defaults chunkStore to the RETIRED Lance chunk table" and the
   "`hybrid.ts:102-104` swallows embedder failure" defect (the swallow goes with the
   embedder).
5. **Deletion list (memo condition 4, mapped to files):** `@lancedb/lancedb` +
   `@huggingface/transformers` deps; `src/store/lance.ts`; `src/search/vector.ts`;
   `src/indexer/embedder.ts` + `background-embedder.ts` (+ fork host wiring in serve);
   the `vectors.lock` half of `src/store/lock.ts`; embed-cache handling; Phase 2 of the
   indexer (`runEmbed`/`selectPendingChunks`); the serve ladder's embed half (the Phase 1
   startup scan STAYS); `--phase1-only` CLI flag (Phase 1 is all there is);
   Docker model-prewarm / mast-seed Phase 2 references (repo-wide sweep in 7.3).

### Stage 7.1: Excise the vector subsystem (pure removal, surface frozen)
**Success criteria**: vector/embedder/lance modules deleted; `hybridSearch` is FTS+D only
with `chunkStore` required; deps removed from package.json + lockfile; suite green with
the response shape TEMPORARILY unchanged (`mode: "lexical"` literal, `similarity_score:
null`); no import of deleted modules anywhere in `src/`.
**Status**: Complete (2026-08-06) — 5 modules + 4 vector-test files deleted;
`hybridSearch(db, input, config, chunkStore)` with `chunkStore` REQUIRED (retires the
HANDOFF §5 retired-Lance-default and swallowed-embedder-failure defects); deps removed:
`@lancedb/lancedb`, `@huggingface/transformers`, plus orphaned `apache-arrow` (logged
deviation, `pnpm why -r`-verified; no other workspace package declares any of the three);
lockfile −50 packages. Suite **446/35 green**; tsc + lint clean; zero-hit grep for
deleted symbols; align **324→324 (+0)** — improved from the +3 baseline (deleted files
no longer emit unresolved `@lancedb`/`@huggingface` specifiers), the 2 real repo-level
violations unchanged and unrelated. Other logged deviations: `ChunkRecord` relocated to
`store/sqliteChunkStore.ts` (its real owner post-Lance); `transformers_cache_dir`
resolution + `embedding_model` config keys deferred intact to 7.2 (avoid inconsistent
half-removal); `mast_search` tool description text deferred to 7.2 (frozen surface).
**Eval-suite resolution (runner decision, not the agent's):** 5 eval instrument test
files (`declex-cli`, `declex-score`, `scale-score`, `idfuse-score`, `scale-rank-check`)
fail at HEAD by design — their import chains reach deleted dist modules. Resolved by
NAMED exclusion in `vitest.config.ts` with the tag pointer (record stays in-repo,
runnable home is `mast-pre-vector-delete`), not deletion (they are the experiment
record) and not a red suite (every commit passes). Vector-independent eval tests
(`declex-ranker`, `idfuse-ranker`, …) still run at HEAD. The stale `@lancedb`
forks-pool comment in vitest.config.ts updated (pool kept for better-sqlite3 /
tree-sitter).

### Stage 7.2: Honest surfaces
**Success criteria**: `mode`/`similarity_score` removed from response + `_stats`;
`mast_status`/CLI status fields per decision 2; orphan-state cleanup on startup;
`hybridSearch` → `fusedSearch` rename with callers; config keys removed.
**Status**: Complete (2026-08-06) — suite **448/35** green (+2 net: −6 removed-field tests,
+8 new: config/index.json old-key tolerance, orphan cleanup incl. EACCES no-throw,
unconditional-cleanup bootstrap); tsc + lint clean; all greps zero-hit except the
tolerance test's own fixture literals (intentional); align 324→324 (+0). Renames done as
git moves (`hybrid.ts`→`fused.ts`, `hybrid-declex.test.ts`→`fused-declex.test.ts`).
Logged judgment calls, ratified: `AppContext.searchMode` deleted (only consumer was the
removed `embedding_mode` field); `freshnessCause(staleFiles)` signature narrowed with its
dead parameter, not just its type; `metrics.mode` column retained for historical rows,
new rows NULL. **Carried finding → 7.3 scope: `packages/mast/README.md` is badly stale**
(documents LanceDB/transformers/mode/similarity_score/embedding config keys) — rewrite
in 7.3 alongside MAST_SPEC.md.

### Stage 7.3: Repo sweep + docs + verify
**Success criteria**: repo-wide grep sweep for transformers-cache/mast-seed/lance
references outside `packages/mast` resolved; MAST_SPEC.md rewritten where the vector
subsystem appeared (§2, §3, §4.1, §5, §6.2, §7.1–7.4, §7.6, §8, §9 `mast_search`/
`mast_status`, §11, §13.1–13.3, §13.8, §13.11, §14); plan + handoff updated; full ladder
green (suite / tsc / lint / align at pre-existing baseline).
**Status**: Complete (2026-08-07) — README fully rewritten; MAST_SPEC.md rewritten
per-checklist with every post-edit grep survivor justified (section numbers kept stable
on deletion to preserve cross-references); repo sweep fixed a GENUINELY BUILD-BREAKING
issue (claude-runner + fold-runner Dockerfiles ran `warm-model.mjs`, which imports the
dependency Stage 7.1 removed — model-prewarm steps deleted, both orphaned scripts
deleted, fold-runner README fixed, CURRENT_STATE.md annotated per its correction
convention); historical records (MAINTENANCE.md, .specify plans, foldv2's own embedder
docs) intentionally untouched and named. Ladder: 448/35 green, tsc + lint clean, align
324→324 (+0). **Runner-executed follow-up to the agent's out-of-scope finding:** the
orphaned `VectorEntry` interface and the stale cosine-gate comment in `ast/types.ts`
(survived 7.1/7.2 — nothing imported them, so no grep tripped) excised; re-verified.
**Open item, user-owned:** `.claude/CLAUDE.md` still describes `mast_search` as
"semantic + keyword discovery" — one-line fix proposed to the project owner (agent
correctly declined to edit an instruction file).

**Stage 7 exit state**: the vector store is fully deleted. `mast_search` is lexical
BM25 + declaration-exact (F18) under RRF — L+D exactly as measured. The M2 memo's
condition-5 monitoring clock is LIVE as of the deletion ship (2026-08-07): the re-entry
review fires at organic harvest **n ≥ 67** or **2026-11-05**, whichever comes first;
organic n = 0 at that review is itself a finding forcing a re-decision of the monitoring
plan. `metrics.declex_json` is the accumulating input signal.

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
