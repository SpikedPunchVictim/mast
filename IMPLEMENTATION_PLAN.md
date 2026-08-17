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
| **D6** | **Build the stats/regression suite** — RESCOPED 2026-08-10 (see the D6 RESCOPE block): 5 of 10 rows retired/served by shipped instruments, 3 moved to E1/E2; remaining scope = latency percentiles, lock summarizer, config invariant test | **Complete** — see D6 result below |
| D7 | Self-oracle invariant tests over a real corpus (e.g. *every `call_expression` visited yields an edge or a recorded drop-reason*) + property-based call-shape generation (`recv.m()`, `this.m()`, `await x.m<T>()`, `super.m()`, `(await x).m()`) | **Complete** — see D7 result below |
| E1 | Scaling ladder as **regression proof** for Stage 2 — otel(902) / langchainjs(2,047) / strapi(3,600) / backstage(7,021); n8n(12,641) only post-migration. Inherits the D6 RESCOPE rows (ms/file growth law, parse-vs-index ratio, state-size linearity) **and, added 2026-08-11 by the Q6 RESCOPE, WAL checkpoint cost at scale + a HEAD-topology (post-F11, concurrent-reader) checkpoint probe** | **PRE-REGISTERED 2026-08-11, AMENDED ×3 (latest 2026-08-12)** — see the E1/E2 PRE-REGISTRATION block below; E2 rides the same registration but **not** the same builds (A3-MAT-8). Decision-bearing axis is a **9-rung nested chunk ladder inside n8n**, not these five repos, which are now a no-verdict replication panel minus n8n itself. Corpora pinned, **nothing measured yet** |
| E7 | JIT under real agent concurrency (4 concurrent MCP clients + in-flight reindex) — **can falsify F1**: if contention degrades non-linearly, per-batch locking made it worse and the answer is a single-writer queue | **Complete — FALSIFIED** |
| E7-r2 | Re-measure E7 against the post-M1/post-F12 build, to size F11 — same harness/arms, three new probes (hold decomposition, event-loop freeze, `SQLITE_BUSY_SNAPSHOT` repro) | **Complete** |
| D3 | Spec conformance: quarantine mechanism prose; add `spec-conformance.test.ts` with `// MAST_SPEC.md:NNN` citations | **Complete** — see D3 result below |
| D4 | Test-assertion rule: no `unknown[]` in response type annotations; every returned array gets a content assertion | **Complete** — see D4 result below |
| D5 | Adopt ADR directory (`.history` → numbered ADRs, `002-2026-07-22-name.md`, zero-padded) | **Complete** — see D5 result below |
| D8 | Deploy freshness — the installed `mast` binary (`dist/`, gitignored) had drifted 3 days / one schema version behind `src/`, so no agent was running the shipped sweep; `build` added to the verification baseline | **Complete** — see D8 result below |

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

### D7 result (2026-08-10) — diagnostics seam + self-oracle corpus test + call-shape matrix shipped; one real extractor defect found and fixed

**Part 1 — the `onCallSite` diagnostics seam.** `extractEdges` (and its call path
through `emitClassEdges`/`emitCallEdges`) gained an OPTIONAL
`onCallSite?: (outcome: CallSiteOutcome) => void` parameter, threaded positionally
through all three functions and invoked exactly once per `call_expression` node
`collectCalls` returns — chosen over a returned diagnostics-tally object because a
callback needs no allocation on the hot path when `undefined` (the default): one
`onCallSite?.(...)` optional-chain check per call site, zero cost otherwise. The
closed outcome union, as shipped (`CallSiteOutcome` in `typescript.ts`, exported for
test use only):

```ts
export type CallSiteOutcome =
  | 'edge_emitted'          // parseCallee + resolveCall both succeeded — a
                             // POTENTIAL_CALL edge was pushed.
  | 'unparseable_callee'    // parseCallee returned null (chained call, dynamic/
                             // computed receiver, or any callee shape receiverString
                             // can't stringify).
  | 'unresolved_receiver'   // callee parsed to a non-null receiver string, but
                             // LocalTypeEnvironment.resolveCall found no binding for it
                             // (unannotated local, DI lookup, etc.).
  | 'bare_call_unresolved'; // receiver-less call (`foo()`) whose name matched neither
                             // an import nor a same-file symbol.
```

These four names fell directly out of `emitCallEdges`' existing decision points — no
new branches were invented to produce them. `collectCalls` itself was also exported
(test-only; not part of the tool-facing surface) so the oracle test can independently
enumerate the same call sites the extractor visits. TSDoc on `CallSiteOutcome` and
`extractEdges` states the boundary explicitly: calls inside nested-scope-skipped
function/method/class bodies are never handed to `parseCallee` and are therefore, by
design, outside this invariant — `collectCalls`' own skip-list (unchanged) is what
defines "visited."

**Part 2 — self-oracle over mast's own `src/` (53 non-test `.ts` files, `__tests__`
excluded).** New `src/ast/extractors/__tests__/call-oracle.test.ts`. The accounting
invariant (a) is checked per file: an independently-built `expectedCallSites()` helper
mirrors `extractEdges`' top-level scope dispatch (function/generator declarations,
class methods, arrow-function-valued const/let) using ONLY the exported `collectCalls`
primitive plus tree-sitter's own `SyntaxNode` API — not `extractEdges`' own private
dispatch helpers — so the oracle and the extractor can disagree if either one drifts.
Assertion (b) — every emitted `POTENTIAL_CALL` edge's `context` is non-empty and
contains `(` — is what caught the real defect below. Assertion (c) logs the live
outcome distribution as an informational `console.log` plus a `total > 0` floor.

**Live self-corpus outcome distribution** (53 files, post-fix):

| outcome | count |
|---|---|
| `edge_emitted` | 866 |
| `unparseable_callee` | 604 |
| `unresolved_receiver` | 592 |
| `bare_call_unresolved` | 93 |
| **total call sites visited** | **2,155** |

This is the live denominator E2's registered corpus measurement can later reuse the
same seam against — `edge_emitted` / total ≈ 40% on mast's own source, which is
consistent with §10.3.1's "60–80% coverage in a Fastify+DI codebase" characterisation
being an upper bound for a codebase (mast itself) that leans more heavily on bare
utility-function calls and dynamic/chained shapes than a typical DI-heavy service.

**Part 3 — the call-shape matrix** (`call-shape-matrix.test.ts`, `describe.each` x
`it.each`, no new dependency — project CLAUDE.md §8.5 rules out `fast-check` for this
finite a shape space). 7 receiver forms x 4 call wrappers = 28 cells, plus 1 auxiliary
cell for the receiver-less `bare_call_unresolved` bucket (not reachable from the 7x4
grid, whose every cell has a receiver) = **29 cells total, zero skipped**.

Receivers: annotated param, field (`this.repo` via constructor parameter property),
bare `this`, bare `super`, `new`-bound local, unannotated local (factory return —
must NOT resolve), chained `getX()` (must NOT resolve). Wrappers: plain `r.m()`,
awaited-whole-call `await r.m()`, paren-awaited-receiver `(await r).m()`, generic
`r.m<T>()`.

**Grammar-validity verification (the task's "(await this).m()? verify" question).** A
scratch tree-sitter parse dump (`tree.rootNode.toString()`, deleted before finishing)
showed BOTH `(await this).m()` and `(await super).m()` parse with no ERROR node —
tree-sitter's grammar accepts a bare `await this`/`await super` operand syntactically,
unlike what the real TypeScript checker would flag. **No cell was skipped**: all 29
are grammar-valid. Per-cell trace confirmed both parse to
`parenthesized_expression(await_expression(this|super))`, i.e. the SAME shape F3's
`unwrapAwaitedReceiver` already handles for identifier/field receivers — so
`(await this).m()`/`(await super).m()` resolve to `this_method`/`super_method`
exactly like their un-awaited forms. This is new, previously-untested coverage (not a
defect): F3's await-unwrap logic generalises to the `this`/`super` receiver bindings,
not just identifier/field ones.

**Extractor defect found and fixed** (the most important finding of this task).
`call-oracle.test.ts`'s context-assertion (Part 2(b)) failed on first run:
`cli/index-cmd.ts:9 -> Command.command: expected 'program' to contain '('`. Root
cause: `emitCallEdges` computed `callLine` from `call.startPosition` — the START of
the whole `call_expression` node. For a single-line call this is the call's own line;
for a multi-line fluent/chained call like

```ts
program
  .command('index [path]')
  .description('Build or update the index')
  ...
```

the `call_expression` node for the `.command(...)` call starts at `program` (line 9),
not at `.command(` (line 10) — so `callLine` pointed at the receiver's line and
`context` (`lines[callLine - 1].trim()`) was the bare text `program`, containing no
parentheses at all. This silently violated `EdgeRecord.context`'s own doc comment
("Trimmed source text of the call-site line") for every multi-line chained call in the
codebase — exactly the class of gap D7 exists to make visible (§14.6's oracle-vs-
sampling framing: F3/F4 shipped without corpus verification because no invariant made
gaps like this visible). Per the task's process rule 2, this was verified (real corpus
hit, root-caused via direct code + tree-sitter S-expression inspection), then FIXED
rather than left red: a new `calleeLine()` helper computes the line from the callee's
own token — the `property` field of a `member_expression` callee (the method name
itself), falling back to `call.startPosition` for a bare identifier callee (unaffected,
matches prior behavior exactly). This is a minimal, purely additive fix to line/context
attribution only — it does not touch resolution logic, so it could not and did not
change any `CallSiteOutcome` classification. (The corpus-wide outcome counts shown
above did shift slightly from the fix's own diff — `calleeLine`'s new code is itself
part of the `src/` corpus the oracle scans, and its own call sites got classified too;
not evidence of a resolution-logic change.) Fixed in `typescript.ts`; no other file
needed a matching change. All 16 pre-existing `call-edges.test.ts` tests still pass
unmodified (single-line calls were never affected, since callee-token and
call-expression-start coincide on one line).

**Red-first evidence.** Both new test files were written against a stubbed seam
(`onCallSite` parameter present in all three signatures, deliberately never invoked —
each branch's `onCallSite?.(...)` call commented `// RED-PHASE-STUB`) before any
wiring existed:
- `call-shape-matrix.test.ts`: **29/29 failed** — every cell's actual tally was
  `{edge_emitted: 0, unparseable_callee: 0, unresolved_receiver: 0,
  bare_call_unresolved: 0}` against a nonzero expected tally, e.g. `{edge_emitted: 1,
  ...}` for the annotated-param/plain cell.
- `call-oracle.test.ts`: the accounting-invariant test failed on **50 of 53 corpus
  files** with `outcomes-sum=0 vs collectCalls=N` (N up to 91, `telemetry/metrics.ts`)
  — a genuine assertion failure proving the tests exercise the real seam, not an
  import/syntax break. (3 files legitimately have 0 call sites in visited scopes and
  passed trivially at 0=0.) The aggregate-distribution test failed with `expected 0 to
  be greater than 0`. The `sanity: corpus size` test passed (unrelated to the seam).
  The context-assertion test failed independently for the real `cli/index-cmd.ts`
  reason above — that failure exists with or without the seam wired, since it doesn't
  use `onCallSite` at all.

Restoring the real `onCallSite?.(...)` calls (removing the stub comments) turned the
seam tests green; the separate `calleeLine()` fix turned the context-assertion green.

**Verification** (from `packages/mast`): `pnpm test` — **605/605 passed, 43 files**
(baseline 572/41 — +33 net-new tests: 29 matrix + 4 oracle, +2 net-new files).
`pnpm typecheck` — clean. `pnpm lint` — clean. Repo-root `pnpm align:check`: baselined
debt 324 → 324 (0), red only on the same 2 pre-existing non-mast violations
(`application/ui/src/views/root-layout.tsx` import cycle,
`application/api/src/domain/spec/fold-build-record-repository.ts` layer violation) —
unchanged from D3's verification.

**Deviations**: the `calleeLine` fix for multi-line chained-call `callLine`/`context`
attribution was not in the mandated design (which scoped the production change to
"a minimal accounting channel") — it was added because the self-oracle's own
mandated assertion (Part 2(b)) found a real, verifiable defect, and leaving the
assertion red (or loosening it to hide the defect) would have violated both the
task's own explicit instruction ("do not adjust the expected cell to match wrong
behavior") and this repo's full-suite-green requirement. The fix is minimal (one new
9-line helper, one call-site substitution), does not touch resolution logic, and is
covered by the same oracle assertion that found the bug — no separate regression
test was added beyond that, since the oracle now runs on every `pnpm test` and would
re-catch a regression. **Noticed but not done**: the callee-line fix was verified only
via the full existing suite + the new oracle/matrix tests, not via a dedicated
unit test isolating a synthetic multi-line-chain fixture in `call-edges.test.ts` — the
real corpus hit (`cli/index-cmd.ts`) already serves as that regression's proof by
construction (it's now part of the oracle's own scanned corpus and will re-fail if
the fix regresses). No MAST_SPEC.md changes beyond the one-sentence non-normative
mention of the diagnostics seam in §10.3.1 (below) — the seam is deliberately not a
documented tool-facing contract.

### D5 result (2026-08-10) — numbered archive convention adopted

`.history/`'s mixed naming (`MM.DD.YY` directories alongside ISO-stamped files —
which breaks lexicographic ordering across year boundaries, §14.5's closing note)
is replaced by flat, zero-padded `NNN-YYYY-MM-DD-slug.md` records: 001 (2026-05-14
session log), 002 (archived v1 plan), 003 (bug fixes), 004
(IMPLEMENTATION_PLAN_VEXP, archived), 005 (Fable feedback). A `.history/README.md`
documents the convention (number orders, date documents; append-only; records are
historical, never normative, never conformance-tested) and carries an
original-name index so the many code comments citing `IMPLEMENTATION_PLAN_VEXP.md`
etc. remain resolvable — citations in code and result blocks are history and were
deliberately NOT rewritten. Renames done with `git mv` (history preserved).
Implemented directly by the managing session (file housekeeping, below the
managed-agent threshold). Verification: full suite/typecheck/lint unaffected
(no source changes), align 324→324 (+0).

### D8 result (2026-08-11) — the shipped sweep was not the running tool; build added to the verification baseline

**Found while verifying the inherited baseline, not by a test.** `which mast` resolves
to `/opt/homebrew/bin/mast` → a symlink into this repo's own
`packages/mast/dist/cli/index.js`. That artifact was **built 2026-08-07 13:53** and
carried `CURRENT_SCHEMA_VERSION = '1.2.0'`, while `src/store/config.ts` was at
`1.3.0`. The live `.mast/index.json` read `"schema_version": "1.2.0"`. So the binary
that MCP — and therefore every agent session, including the one that found this —
actually executed predated the whole 2026-08-08..08-10 sweep: F5 (qualified
identifiers / 1.3.0), F3/F4, F10, M6, C1, F9, and D6's `--locks`/`--json`/percentile
columns were in source and absent from the tool. `mast query` (D0) was present, having
landed 08-07 before the build.

**Why nothing caught it.** The verification baseline is entirely source-level —
`vitest` runs TypeScript through its own transform, `tsc --noEmit` emits nothing by
definition, `eslint src` never looks at output, and `align:check` reads source
imports. `dist/` is gitignored, so the divergence is invisible in `git status` and in
every diff review. The project's Definition of Done (`.claude/CLAUDE.md` §10) lists
tests, typecheck, lint, and docs — **not the artifact agents run**. Every one of the
sweep's 20 commits could therefore be honestly verified and still not reach the tool,
and did not.

**Severity, stated plainly.** This is the §6 "reports success wrongly" class. No
shipped behaviour was wrong; the *record* was — the plan said these tools behaved as
specified, and against the running binary they did not. The acute risk is to E1: a
registered measurement driven through `mast query` or the MCP surface on a stale
artifact would attribute evidence to the wrong code version, and no gate in the
registration ceremony as currently written would notice.

**Verified fix, end to end.** `pnpm -F mast build` → `dist` at `1.3.0`. Migration
exercised against a **copy** of the live state dir (not the live one — this session's
MCP server still held the old binary and an open connection, and racing two writers
across a schema change is the exact hazard the guard exists to prevent):
`mast serve` on the copy ran §7.4 Step 2's guard, wiped derived state, and full-
reindexed to `schema_version: 1.3.0`. Post-migration spot checks on the rebuilt
binary: `mast metrics --locks` (D6, 08-10) exists and reports; `mast query
mast_callers '{"symbol":"SqliteChunkStore.replaceChunksForFile"}'` returns a populated
`potential_matches` (declaration chunk + one call site) — the F5 behaviour that was
structurally empty for every method query before 1.3.0. The copy's reindex covered 77
files / 838 chunks rather than the repo's 1,830 because `serve` resolves
`project_root` from cwd and correctly ignored the persisted absolute path (§4's
path-portability rule, F9) — scope, not a defect. **The live state dir subsequently
migrated on its own** at `2026-08-11T04:06:57Z` (`index.json` now `1.3.0`, 1,830
files / 14,607 chunks) when its `mast serve` next restarted — the expected path, not
a manual step.

**What the stale binary contained — settled by the dist artifact, not by the git
timeline.** The first draft justified `mast query`'s presence with "landed 08-07
before the build", which the git record contradicts (D0 `3007e94` committed
**14:36 -0700**, *after* the build's 13:53 mtime). Commit times cannot order against
`dist` mtimes here. The **artifact** settles both questions, using a discriminator
verified in this repo: the build is plain `tsc` with `tsconfig.tsbuildinfo`, and a
sweep of all 54 modules found it re-emits **strictly on own-content change** with
**zero** dependency-driven re-emits (`dist/mcp/register-tools.js` kept its 13:53 mtime
though the tool modules it imports changed through 08-10). Therefore:

- **D0 WAS in the stale binary, at final content.** `dist/cli/query.js`,
  `dist/cli/index.js` and `dist/mcp/register-tools.js` all still carry **08-07 13:53**
  mtimes — the 08-10 18:58 build skipped them — so their content at the 13:53 build
  already equalled current committed content. This corroborates the direct empirical
  check (`mast query mast_status '{}'` → valid JSON, exit 0, run against the stale
  binary). The original claim was substantively right; only its stated reason was wrong.
- **The stale binary was PRE-F11.** `dist/store/lock.js` **was** re-emitted at 18:58,
  and F11 (`f4d730f`, 08-07 **17:08 -0700**) is the only commit that ever touched
  `src/store/lock.ts` — so its content at the 13:53 build differed from post-F11
  content. **Consequence: all agent/MCP usage from 08-07 to 08-10 ran the pre-F11
  JIT-lock topology.** This bears directly on the Q6 RESCOPE — the post-F11 topology
  has had almost no operational hours, reinforcing "HEAD unmeasured". (Residual
  inference: a mid-edit `lock.ts` at 13:53 cannot be strictly excluded; D0 at 14:36
  and F11 at 17:08 make clean pre-F11 content the only plausible timeline.)
  `lock-metrics.jsonl` does not corroborate independently — it holds **zero**
  `jit-staleness` events across its whole 08-01→08-11 span (1,360 events, all
  `index-run`), consistent with pre-F11 *and* no JIT refresh ever firing here.

**Operationally, D8 was NOT closed by the rebuild: rebuild ≠ restart.** Found by the
results review's empirical pass and verified directly: `mast serve` **PID 38988
started 2026-08-10 17:08:03 — 110 minutes BEFORE the 18:58 rebuild — and still holds
the live `graph.db` open** (5 fds, confirmed by `lsof`). Node caches modules at
startup, so that process keeps executing the **1.2.0 / pre-F11** image regardless of
what `dist` now contains, while the state dir it is attached to has since migrated to
**1.3.0**. That is precisely the stale-code-against-new-schema hazard §7.4's startup
guard exists to prevent — and the guard cannot fire, because it only runs at startup.
**Any state-dir migration must be paired with a server restart**, and a session that
rebuilds `dist` mid-flight is still talking to the old code until its MCP server is
restarted. Added to the §7 operational rule in HANDOFF_Q1.md.

**The invariant codified** (§6: hunt the class, codify an invariant): **`pnpm -F mast
build` joins the verification baseline** whenever a change must reach the running MCP
server, and is recorded as such in HANDOFF_Q1.md §7.

**D8a (2026-08-11) — the product detector, first rejected then adopted on evidence.**
This block originally declined a product-level detector: `package.json` version is
`0.1.0` and unbumped across the whole sweep, so a version field in `mast_status` would
not have fired; `schema_version` would have fired here but only because F5 happened to
bump it (F10/C1/D6 did not), so it detects one drift class while implying coverage of
all of them; and a dist-vs-src mtime assertion inside `vitest` fails vacuously or
spuriously depending on whether `dist/` exists in the checkout. **That reasoning was
answered by use.** Asked "what version is the running mast MCP server?", the answer had
to be reconstructed from a PID start time, a `dist` mtime, and a behavioural inference,
with no in-product way to read it. The rejection optimised for what a detector
*catches*; the question operators actually ask is *"which schema am I serving?"*, and
nothing answered it.

Shipped, red-first (`expected undefined to be '1.3.0'` before implementation):
`StatusResult.schema_version`, on both `mast_status` and `mast status` (human and
`--json`). **Sourced from the binary's `CURRENT_SCHEMA_VERSION` constant, never from
`index.json`** — the two are equal after any normal startup because §7.4 Step 2's guard
wipes on mismatch, and they diverge in precisely the case worth exposing: a long-lived
process on an old image against a since-migrated state dir. Reading it off disk would
report the migrated value and hide the divergence. Pinned by a D3 conformance
assertion (§9's example ↔ the constant); D4's rule caught an `unknown` annotation in
that very assertion — both standing instruments earning their keep on a change this
small.

**Scope stated honestly: this is detection, not remediation, and it is narrow.** It
exposes schema-version drift only; a stale binary whose schema version happens to match
(the F10/C1/D6 class) remains invisible, exactly as the original rejection argued — so
`build` + restart stays the real guarantee, and this field is a diagnostic, not a
safety net. Nothing here fixes the process-level problem, because nothing can from
inside the server: a Node process cannot reload its own cached module graph, and a tool
that exited to force a respawn could not report its own outcome — the stdio transport
dies with the process. Lifecycle belongs to the supervisor (`mast serve` runs until its
parent closes stdin, §8). The split is deliberate: **detection in-product, remediation
at the client.**

**Standing-obligation finding, recorded here because it is now measured.** The M2
condition-5 organic harvest is **n = 0**. `metrics` in the live `graph.db` held **11
rows total** (8 `mast_search`, 3 `mast_exports`), **0 with `declex_json` set**, newest
`2026-08-06T16:15:19Z` — every row predates the 08-07 deletion ship that started the
clock, so none of them counts toward condition 5 and the schema wipe destroyed no
harvest data (rows dumped before the wipe for the record). All eight primary read
tools do call `recordToolCall`; `mast_status` deliberately does not. The review fires
at n ≥ 67 **or 2026-11-05**, whichever comes first; on this trajectory it lands on
n = 0, which the memo already names as itself a finding forcing a monitoring
re-decision.

**Noticed, not fixed (P3, same class as the `--session`/`--global` drift D6
recorded).** MAST_SPEC §14.3 states metrics writes "are non-blocking … enqueued on a
per-tick batch (flushed every 1s or every 100 rows, whichever comes first)".
`recordToolCall` (`telemetry/metrics.ts`) is a direct `await`ed insert whose errors are
swallowed — non-blocking to the *caller's* correctness, but not batched, and no flush
window exists. The "worst-case data loss on abrupt exit is one flush window" claim
therefore describes a mechanism that is not there. Left as found; it belongs with the
P3 spec-drift decision, not in this fix.

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

### D6 RESCOPE (2026-08-10) — the metric table re-decided post-deletion, post-remediation

The table above was drawn against the pre-Stage-7, pre-remediation system. Two things
have since invalidated parts of it: the vector store (and its Lance `_versions`
pathology) no longer exists, and this remediation cycle shipped fixes AND standing
instruments (D3's spec-conformance test, D7's `onCallSite` oracle, F10's
`potential_truncated`, M6's `index_empty`, the `metrics` table's per-call
`duration_ms`) that already cover several rows. Per-row verdicts:

| Row | Verdict | Why |
|---|---|---|
| `structure` lock hold by caller | **SURVIVES, narrowed** | Stage 1 closed; F11 removed JIT from the lock, so the metric now describes coarse writers only. `store/lockMetrics.ts`'s JSONL sink is the standing instrument; D6 ships a summarizer over it (below). The 10–50ms spec figure was rewritten by F11's §7.6 update; timing is deliberately not conformance-tested (D3). |
| `_versions` count/bytes | **RETIRED — subject deleted** | Lance is gone (Stage 7); the O(n²) class it caught is structurally gone (M1, O(N) proven). Successor signal: graph.db bytes ÷ chunk_count linearity, which belongs to E1's ladder, not a standing suite. |
| ms/file at ≥4 corpus sizes | **MOVED to E1** | This row *is* the scaling ladder — external corpora + a growth-law claim = a registered measurement, not a standing metric. |
| parse-only vs full-index ratio | **MOVED to E1** | Same: meaningful only against pinned corpora at multiple sizes; E1's instrument should capture it per tier. |
| `POTENTIAL_CALL` by resolution ÷ call sites | **SERVED by D7** | The `onCallSite` seam computes the denominator and distribution on every `pnpm test` run over mast's own src (2,155 sites / 866 edges baseline, D7 result). By-resolution counts on a real index are one SQL away (`SELECT resolution, COUNT(*) FROM edges WHERE edge_type='POTENTIAL_CALL' GROUP BY resolution`). External-corpus denominators are E2. No new code. |
| identifier_fts ÷ potential returned | **RESOLVED by F10** | `potential_truncated` surfaces the real count per call, in-product. Truncation *frequency* is queryable organically from the metrics table when wanted. |
| Per-tool p50 latency | **SURVIVES — implement now** | `metrics.duration_ms` already records it per call; `mast metrics --by-tool` shows only averages. D6 adds p50/p95 columns (below). Would have caught F8's 28s. |
| Useful state ÷ total bytes | **RETIRED — pathology deleted** | The garbage was Lance's manifests. Post-deletion state is graph.db + three small JSON files; linearity goes to E1 with row 2's successor. |
| Config-honoured invariants | **SURVIVES — implement now** | F9 fixed the config path and D3 pins the defaults, but the *index-run* invariant (every indexed path matches `file_extensions`, none matches `exclude_patterns`) is a runtime property nothing asserts end-to-end. D6 adds the invariant test (below). |
| chunk_count > 0 / zero-result rate | **RESOLVED by M6 / organic telemetry** | `index_empty` + the serve refusal cover the emptiness half in-product; zero-result *rate* is an organic-telemetry query over `metrics.results_json`, same channel as the standing declex_json harvest — not a suite metric. |

**D6 as re-decided therefore ships exactly three things** (small, deterministic, no
external corpora, no registration ceremony — everything measurement-shaped moved to
E1/E2 where the methodology rules govern it):
1. **p50/p95 columns in `mast metrics --by-tool`** (and its `--json` shape), computed
   from the existing `duration_ms` column.
2. **A lock-hold summarizer** over `store/lockMetrics.ts`'s JSONL (count/p50/p95/max
   by caller), exposed as `mast metrics --locks`, generalizing
   `eval/baseline-locks.json`'s one-off capture into a repeatable report.
3. **The config-honoured index invariant test**: after a real `runIndex`, every
   `files.path` row matches a configured extension and none matches an exclude
   pattern.

The "Blocked on: D2" note above is stale for the re-decided scope — none of the three
deliverables needs a pinned corpus. E1 inherits the corpus-pinning requirement along
with the rows moved to it.

### D6 result (2026-08-10) — latency percentiles, lock summarizer, config invariant test shipped

All three re-decided deliverables ship, red-first per §5.1 where red was honestly
obtainable.

**1. p50/p95 latency columns.** `computeDurationPercentiles` (`telemetry/metrics.ts`)
implements **nearest-rank, no interpolation**: sort ascending, take the value at rank
`ceil(P/100 * N)` (1-indexed); returns `{p50: 0, p95: 0}` for an empty array rather
than throwing. Chosen over interpolated definitions (linear/R-7) because §14.9
declines to assert an SLA on this data — nearest-rank is the simplest definition that
avoids an interpolation-method debate. `queryMetricsSummaryWithPercentiles` wraps the
existing `queryMetricsSummary` and fetches the window's raw `duration_ms` values in one
extra query (no SQL percentile aggregate in better-sqlite3's default build), computing
percentiles in JS per tool group — safe at the row counts §14.4 bounds the `metrics`
table to (~1,500 rows/day pre-rollup, thousands at most for any realistic `--since`
window). `mast metrics --by-tool` gained `p50 ms`/`p95 ms` columns in the human table;
`--json` did not previously exist on this command at all (a pre-existing spec/code
drift — MAST_SPEC.md documented it, the code didn't implement it) and is added now,
serializing the percentile-augmented rows directly.

**2. Lock-hold summarizer, `mast metrics --locks`.** Read `store/lockMetrics.ts`
first per instruction — its `LockEvent` union (unchanged by this task) is `'acquired'
{type, caller, waitMs, timestamp}`, `'released' {type, caller, holdMs, timestamp}`,
`'failed' {type, caller, waitMs, timestamp}`, written as one JSON line per event to
`<stateDir>/lock-metrics.jsonl` (`LOCK_METRICS_FILENAME`, now exported for reuse
instead of duplicating the literal). New module `telemetry/lockMetricsSummary.ts`:
`summarizeLockMetricsJsonl` (pure — takes JSONL text, not a path) validates each line
against a zod `discriminatedUnion('kind', …)` schema (zod is an existing dependency —
no new one added) and groups by `caller`, computing `count` (number of completed
`released` cycles), `hold_p50/p95/max_ms` (from `released.holdMs`), `wait_p50/p95/
max_ms` (from `acquired.waitMs`), and `failed_count` (from `failed` events) — reusing
`computeDurationPercentiles` from deliverable 1 for both hold and wait percentiles
(same nearest-rank method, one definition). Malformed lines (bad JSON or a shape that
doesn't match any `LockEvent` variant) are skipped and counted in
`malformed_line_count`, never thrown. `readLockMetricsSummary(stateDir)` is the thin
filesystem wrapper: returns `null` when the file is missing or empty, which the CLI
renders as "No lock metrics recorded." (human) or `{callers: [], malformed_line_count:
0}` (`--json`), exit 0 in both cases — never a crash. The CLI branch short-circuits
before `openDatabase` is ever called (`--locks` never touches `graph.db`).

**3. Config-honoured index-run invariant test**
(`cli/__tests__/cli.test.ts`, describe block "D6 — config-honoured index-run
invariant"). Fixture tree: `.ts`/`.js` files (configured extensions), `.py`/`.txt`
files (unconfigured), a nested `node_modules/` file, and a `**/skipme/**`-pattern
file (both matching a configured extension but an exclude pattern). Runs a real
`runIndex`, reads `files.path` back out of `graph.db`, and asserts — using
`walker.ts`'s exported `globToRegex`, the same glob-matching primitive production
code uses for `file_pattern` filters — that every indexed path ends with a configured
extension AND matches no exclude pattern, plus the positive assertion that both
includable files (`good.ts`, `nested/deep/another.js`) are present. **Outcome: GREEN
as a regression floor, no defect found** — F9's config plumbing (Stage 3.5) holds at
the one point that actually matters, a real index run, not just at `resolveConfig`
in isolation.

**Red-first evidence.** Deliverable 3 was run first, per §5.1, and was expected/found
GREEN (a floor, not a bug fix — reported here per the "stop and report prominently"
instruction for a RED outcome, which did not occur). Deliverables 1 and 2's pure
functions were TDD'd properly: `computeDurationPercentiles` and
`queryMetricsSummaryWithPercentiles`'s tests were written and run against the
pre-implementation code first — `queryMetricsSummaryWithPercentiles is not a function`
(9 failing assertions) — then implemented to green. `summarizeLockMetricsJsonl` and
`readLockMetricsSummary`'s tests were likewise run first against a nonexistent module
(`Failed to load url ../lockMetricsSummary.js` — 0 tests collected, hard failure) then
implemented to green (9/9). CLI wiring (`--json` on `--by-tool`, `--locks`) got three
thin tests in a new `cli/__tests__/metrics-cmd.test.ts`, exercising
`registerMetricsCommand` via a fresh `commander.Command` + `parseAsync` with captured
stdout — no existing precedent tested a `metrics-cmd`/`status` action handler
directly, so these are new coverage, not a duplicate of the pure-function unit tests
(§5.4a: they catch flag-wiring bugs — wrong option name, `--json` not actually
serializing, `--locks` accidentally still opening `graph.db` — that no unit test on
the underlying functions can).

**Verification.** `pnpm -F mast test`: **627 tests / 45 files** (605/43 baseline + 22
tests / +2 files — 9 in `metrics.test.ts`, 9 in the new `lockMetricsSummary.test.ts`,
3 in the new `metrics-cmd.test.ts`, 1 in `cli.test.ts`). `pnpm -F mast typecheck`:
clean. `pnpm -F mast lint`: clean. `pnpm align:check` (repo root): `baselined debt: 324
→ 324 (0)`, red only on the same 2 pre-existing non-mast violations (`application/ui`
import cycle, `apiDomain`→`apiDb` layering) — no new mast violations.

**Deviations from the task brief.** None load-bearing. `--json` did not exist at all
on `mast metrics` before this change (MAST_SPEC.md §14.6 claimed it did — pre-existing
spec/code drift, not introduced here); this task adds it, since deliverable 1
explicitly requires percentile columns "in both the human table and the `--json`
shape." `failed_count` on the lock summary's per-caller rows is one field beyond the
brief's literal list ("count, p50, p95, max hold ms — and wait/acquire duration") —
kept because it falls directly out of the sink's third `LockEvent` variant with no
extra parsing, and a failed acquisition is arguably the most operationally important
signal in this data; flagged here rather than silently added.

**Noticed, not done (out of scope for this task).** MAST_SPEC.md's `mast metrics`
usage block also lists `--session`/`--global` options that do not exist in
`metrics-cmd.ts` — a second pre-existing spec/code drift, left as found (only the
`--locks`/percentile-column additions specified by this task's rescope were made to
the spec; the `--session`/`--global` drift is a separate, unscoped defect).

### E1/E2 — the scaling ladder and call-graph denominators: PRE-REGISTRATION (written 2026-08-11, BEFORE any measurement)

**Nothing below may be edited after the first scored measurement.** Amendments are
appended with a timestamp, a reason, and which direction the error runs. Registration is
committed before the instrument is built, per the Q1/OUTCOME and Q1/SCALE precedents.

#### Why one registration for two experiments

**AMENDED 2026-08-12 (A3-C2) — the original economy is dead, and was left standing through
two amendments.** The first draft's rationale was "one shared build, read twice": E1 reads
the **cost** of an index run, E2 reads the **content** of the graph it produced. AMENDMENT 1
moved E1's decision onto the n8n tier ladder and E2's onto `nest`, and A3-MAT-8 below
establishes that E2 cannot read a product build at all — `extractFile` takes no `onCallSite`
parameter (`ast/extract.ts:44-50`), so E2 runs its own harness pass. **No build is shared
between the two experiments any more.**

What *is* shared, and still justifies one registration rather than two: the corpus pinning
and worktree discipline, Gates 0/1, the run-manifest schema, the seeded run-order shuffle,
and the harness itself. They remain **scored and decided separately**; a void on one side
does not void the other, and neither can contaminate the other's measurement — now for the
stronger reason that they no longer touch the same artifact.

#### What this measures — and does not (scope, stated first)

**E1**
- **Indexing cost as a function of corpus size**, on the post-M1 / post-S1 / post-F11
  build. This is a **regression proof for Stage 2**: M1's O(N) claim was measured at
  ≤ ~5k files (nest, directus, common). Nothing has measured whether it survives 5–20k.
- It does **not** measure query or retrieval latency at scale. Q1/SCALE owns retrieval;
  this experiment does not re-litigate it and cannot speak to it.
- It does **not** measure index correctness beyond the integrity gates below. A rung can
  pass every E1 metric while producing a semantically poor index.

**E2**
- **`POTENTIAL_CALL` edge yield against a source-side denominator** on codebases nobody
  here has tuned an extractor against. mast's own `src/` is currently the only corpus with
  this measured (866 / 2,155 ≈ 40%, D7 result).
- It does **not** measure whether emitted edges are **correct**. The `onCallSite` oracle
  checks *accounting* — every visited call site yields exactly one outcome — not truth. A
  wrong edge and a right edge both count `edge_emitted`. Yield is an upper bound on
  precision-weighted coverage, and is reported as such.
- It does **not** re-open Stage 3's kluster-corpus figure (1,038 → 1,124 `this.` + 20
  `super.`). That number stays as recorded; E2 measures external corpora, which is exactly
  what Stage 3's "What is explicitly NOT claimed" note deferred to here.

#### Corpora — a nested ladder inside one corpus, plus a replication panel

**AMENDED 2026-08-11 (A1-F3, A1-F1) and 2026-08-12 (A3-FATAL-2, A3-MAT-9). The original
design made five unrelated repos the decision-bearing axis; it no longer does. The
amended design then stated the ladder's rungs in one unit and cut them in another; it no
longer does that either.**

**Decision-bearing axis (E1): nine seeded nested file subsets of `n8n` at
`9d9e9bf97e8a`**, strict supersets `T1 ⊂ T2 ⊂ … ⊂ T9`. This is the Q1/SCALE recipe verbatim
(that registration's own words: "Single-point measurement at full scale confounds corpus
content with corpus scale"), executed with `eval/scale-build-tiers.mjs`, which is the tier
constructor. (`eval/make-subset.mjs` is **not** tier tooling — it freezes Q1's embedding
subset. The first draft miscited it; corrected per A3-C5.)

**Rungs are defined in chunks, because chunks are the exposure variable the fit uses**
(A3-FATAL-2). The first draft stated targets in *files* — "≈1k / 2k / 5k / 8k / all
indexed files" — and the cut rule in *chunks*, while `scale-build-tiers.mjs:36` cuts on
chunk targets. The two units were simply incoherent, and every published figure downstream
inherited the file-flavoured reading. Targets are now **geometric fractions of the realized
total chunk count `C_total`** of the full n8n index at the pin, spanning **20×**:

| rung | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 |
|---|---|---|---|---|---|---|---|---|---|
| fraction of `C_total` | 0.0500 | 0.0727 | 0.1057 | 0.1538 | 0.2236 | 0.3252 | 0.4729 | 0.6877 | 1.0000 |

`f_i = 20^{−(9−i)/8}`, so the rungs are **exactly evenly spaced in `ln N`** — the scale the
fit is performed on, which is what makes `Sxx` computable in advance from geometry alone.
Construction: seeded shuffle (**seed = 811**) of the full indexed file list produced by the
prerequisite build (run **P0**, below); take the file prefix whose cumulative chunk count is
nearest `f_i · C_total`; nesting is automatic because every rung is a prefix of one shuffle.
T9 = every indexed file.

**Nine rungs, not five** (owner decision, discharging A3-MAT-1 and enabling A3-FATAL-1's
fix). It raises the bootstrap's cluster count 5 → 9 (Rademacher atoms 32 → 512; Webb
6-point 6⁹ ≈ 10.1 M), roughly triples `Sxx`, and — the reason that actually matters — buys
**7 lack-of-fit degrees of freedom against 18 of pure error**, which is what makes the
re-derived trigger 1 a real test rather than a coin flip.

Across rungs the only thing varying in expectation is corpus *mass* — the quantity a growth
law is about — not corpus *kind*.

**Realized chunk counts must agree across a rung's repetitions.** Extraction is
deterministic over a fixed file list, so the three reps of a tier must report **identical**
`chunk_count` from their own `graph.db`. Any disagreement is a nondeterminism finding, is
reported as such, and voids that tier pending diagnosis. This is cheap, and it is the only
check that would catch a tier whose file list drifted between reps.

**Replication panel (E1 supporting, E2 external validity), pinned now.**

| rung | repo | pin (this registration commits these SHAs) | role |
|---|---|---|---|
| P1 | `open-telemetry/opentelemetry-js` | `7f3e7eaa9f6b` | replication |
| P2 | `langchain-ai/langchainjs` | `62fc484b2a0d` | replication |
| P3 | `strapi/strapi` | `0a8a9b40d064` | replication |
| P4 | `backstage/backstage` | `25463a867ce7` | replication |
| **N** | **`nestjs/nest`** | **`f7fffd6`** (already pinned, `eval/ASSETS.md`) | **E2 decision-bearing**; E1 replication |

**`n8n` is no longer a panel rung** (A3-MAT-9). It was listed as P5 *and* as the ladder's
source, so the panel's top point was the ladder's top point — the panel's whole claim is
that it is external to the decision-bearing axis, and it was not. **T9 is the full-n8n
measurement**; listing it twice double-counted it and would have let the ladder's own top
rung appear to corroborate the ladder. `nest` still appears in both experiments, which is
benign for the opposite reason: the E1 panel carries **no** verdict, so no verdict is
double-counted.

**Why `nest` carries E2** (A1-F1): §10.3.1's coverage band is explicitly scoped to "a
Fastify + DI service codebase," and **none** of the other five checkouts — P1–P4 plus n8n —
depends on `fastify`, verified by searching every non-`node_modules` `package.json` to
depth 4 in all five. Nest
ships 3 fastify-bearing packages and 48 DI-bearing ones, is already pinned, and is this
project's established honest-broker corpus ("the only corpus nobody here tuned anything
against", `eval/ASSETS.md`). **Registered caveat, stated before measuring:** nest is a DI
*framework*, not a DI *service* built on one. Its call shapes are plausibly more
metaprogrammatic than the spec's referent. This makes nest the best available test of the
band and still an imperfect one; the verdict language below is scoped accordingly, and
adding a genuine Fastify+DI *service* corpus sits in the Design Reserve.

Pinned via `git worktree add --detach <sha>` per `eval/ASSETS.md` (**never `rm -rf` to
remove — `git worktree remove`**). Source checkouts live at `~/temp/enterprise-apps/`;
those are live working copies at whatever HEAD `update-repos.mjs` last left, which is
precisely why the ladder measures detached worktrees at the SHAs above and not the
checkouts themselves.

**Index configuration is pinned too** (A1-F9). Every run indexes under `resolveConfig`'s
**defaults as of this commit, with no overrides** — `file_extensions` `['.ts','.tsx',
'.js','.jsx','.md']`, `exclude_patterns` `['**/node_modules/**','**/dist/**',
'**/coverage/**','.kluster/**','**/*.test.ts','**/*.spec.ts']` (`store/config.ts:39-48`).
The resolved config is recorded in every run manifest. An unpinned config is a free lever
over `N` itself; note in particular that `.md` **is** indexed and that `*.test.js` /
`*.spec.js` are **not** excluded, so neither the "source files" intuition nor the raw
`find` below describes what actually gets indexed.

**No remembered file count is evidence.** The Stage 4 E1 row quotes otel 902 /
langchainjs 2,047 / strapi 3,600 / backstage 7,021 / n8n 12,641. Those figures have **no
provenance anywhere in this plan** — no result block produces them — and a raw `find` for
`.ts/.tsx/.js/.jsx` outside `node_modules` over today's checkouts gives **1,059 / 2,153 /
4,895 / 7,645 / 19,056**. **Neither set is the measurement, and the `find` figures are the
wrong anchor in both directions** (A1-F9): they count test files the config excludes and
omit the `.md` files it includes. The ladder's x-axis is **the chunk count `runIndex`
actually produced under the pinned config**, read from each run's own `graph.db` at Gate 1.
The quoted figures are retained only to show the panel is roughly log-spaced; a realized
count that reorders it re-orders the panel, and the discrepancy is logged as a finding.

**AMENDMENT 1 disavowed that anchor and then went on using it** (A3-FATAL-2, second half).
Every quantitative claim it published — span 18.0×, `N log N` effective exponent 1.120,
`Sxx ≈ 16.1`, `SE(b) ≈ σ/4.01`, the `σ < 0.47` reachability ceiling — was computed on the
raw-`find` counts in the very paragraph that called them the wrong anchor. Those figures are
**withdrawn**. The amended arithmetic below is derived from the ladder's *geometry* (evenly
spaced in `ln N` by construction, so `Sxx` depends only on the rung count and the span) and
is **re-derived from the frozen manifest's realized chunk counts at Gate 1b before any
scoring**. Nothing in the verdict machinery depends on a remembered count.

This inherits Q1/SCALE's corpus-truth lesson literally: that experiment's headline count
was the CLI stdout counter and was wrong by 14,529 chunks. **Ground truth is a `SELECT
COUNT(*)` against `graph.db`, never stdout.**

#### Design — cold builds, randomized run order, three repetitions

Each **run** = one corpus (tier or panel rung) × one repetition, into a **fresh state
dir**, never `--incremental`. Three repetitions each: 9 tiers × 3 = **27 decision-bearing
runs**, plus 5 panel corpora × 3 = **15 replication runs**. Run order is a **committed
seeded shuffle (seed = 811)** over all 42 (corpus, rep) pairs, so corpus size cannot align
with OS page-cache warmth or thermal drift — at this timescale (seconds to a minute per
run) those are the dominant non-corpus variance sources, and a naive small-to-large
ordering would confound them with the exposure variable exactly.

**Run P0 — the prerequisite full-n8n build, registered rather than assumed**
(A3-FATAL-3). The tier manifest cannot be frozen without it: `scale-build-tiers.mjs:3-5`
reads a **completed `graph.db`** to obtain the per-file chunk counts the cut rule needs. The
first draft, and AMENDMENT 1 after it, required this build implicitly and put it in **no
gate, no run count and no cost line** — on a harness that, like every `eval/*.mjs`, imports
from `../dist/` directly, which is exactly the exposure Gate 0 exists for. P0 is therefore:

- **Run under Gate 0 and Gate 1 in full**, with its own manifest entry, `schema_version`,
  `dist/` build timestamp, resolved config, and `graph.db`-sourced counts.
- **Excluded from every fit**, from both run counts above, and from every verdict. It is
  construction, not measurement.
- **Declared as a peek.** P0 yields a T9-scale `durationMs` observed *before* the ladder is
  frozen. The mitigation is ordering, and it is binding: **this amendment — the rung
  fractions, seed 811, the 1.35 threshold, the estimator, every trigger and every gate — is
  committed before P0 runs.** With the verdict machinery already immutable, a glimpse of one
  duration cannot tune anything. Said plainly rather than hidden: the investigator will have
  seen roughly what a full n8n index costs before the scored runs begin.

**Fixed-overhead calibration run** (A1-F4a): before the shuffle, the harness performs
**10 index runs against an empty corpus** (a directory with zero indexable files). Their
median `durationMs` is `c` — `runIndex`'s own fixed cost (walk setup, `loadIndexMeta`,
`openDatabase`) with zero indexing work in it. `c` is recorded in the manifest and used by
the estimator below. Without it the pure power law absorbs an additive constant and biases
`b` **downward**, which flatters HOLDS.

#### Measured rows

| id | row | source | inherited from |
|---|---|---|---|
| **E1-R1** | growth law: index wall-clock vs corpus size | `runIndex` result + independent wall clock | D6 RESCOPE |
| **E1-R2** | parse-only vs full-index ratio | harness parse pass vs full run | D6 RESCOPE |
| **E1-R3** | state-size linearity: `graph.db` bytes ÷ `chunk_count` | `stat` + SQL | D6 RESCOPE |
| **E1-R4** | WAL checkpoint cost at scale | `PRAGMA wal_checkpoint` at run boundaries | Q6 RESCOPE |
| **E1-R5** | HEAD-topology probe under concurrent readers | reader wall clock + `mast metrics --locks` | Q6 RESCOPE |
| **E2-R6** | `POTENTIAL_CALL` by `resolution` ÷ source-side call sites | `onCallSite` seam + SQL | D6 RESCOPE → E2 |

**E1-R2 construction, and its validity risk.** No parse-only mode exists in the product —
`mast index` has `--state-dir`, `--incremental`, `--show-progress`, `--checker` and
nothing else, and the `nest --phase1-only` figure in Stage 2's success criteria came from
the spike era, not from a shipped flag. The harness therefore builds its own parse pass
(walk → read → tree-sitter parse → `extractChunks`/`extractEdges`, no `graph.db` opened,
no writes) over the identical file list. **This is a harness reimplementation of Phase 1's
parse half, not a product mode**, and the ratio inherits whatever drift the
reimplementation carries. Gate 2 is what makes it usable. Adding a `--parse-only` flag to
the product to serve a measurement is out of scope — E1 is an experiment, not a feature.

**Gate 2 no longer checks edge count** (A1-F2). The original text required the parse pass
to match the full index on chunk count **and edge count**. That is structurally
impossible: `insertEdges` silently drops every edge whose from/to name fails DB resolution
(`graph/populate.ts:425` TSDoc; drop sites `:537`, `:543`) and dedupes on `PRIMARY KEY
(from_id, to_id, edge_type)` via `.onConflict(doNothing())` (`populate.ts:556-567`,
`graph/db.ts:257`), so N call sites between one symbol pair collapse to one row and every
call into an external package vanishes. No product-side extractor-level edge counter
exists. The gate would therefore have voided R2 on every corpus, or been "satisfied" by
the harness comparing its own extraction to its own extraction — proving nothing.
**Registered consequence:** R2's ratio covers Phase 1's parse half only and **excludes
pass-2 name resolution and edge insertion by construction**. It is a parse-vs-write-path
ratio over the chunk pipeline, not over the whole index, and is read as nothing more.

**E1-R5 construction, and the honest limitation.** The probe runs against an
**already-built, warm state dir** while a *second* full index writes into it — the
production topology (`mast serve` holding readers open while a reindex runs), and the
post-F11 configuration nothing has ever measured. Reading against a state dir
mid-*first*-build would return `index_empty`, which is a confidence signal, not a latency
measurement.

**Registered, after A1-F6 — the parameters the first draft left free; amended 2026-08-12
per A3-MAT-3/5/6:**
- **Corpora: T1 and T9** (the ladder's smallest and largest). Running only a small corpus
  is the one configuration where the ABSENT branch is easily reachable, and leaving the
  choice open was a free lever toward retirement.
- **K = 4 concurrent readers**, and this is an admitted convenience, not a derived number
  — rounds 1–2 swept N ∈ {1..8}. K = 4 sits mid-sweep; a sensitivity sweep is in the
  Design Reserve.
- **Minimum 400 scored reader calls per corpus**, paced at one call per reader per 250 ms.
  Without a registered denominator, "≥ 1% of calls" over a few dozen calls degenerates to
  "any single call."
- **A call is scored only if it overlaps write activity** (A3-MAT-5). Its start **and** end
  timestamps must fall strictly inside a writer index run. 400 calls at K = 4 paced 250 ms
  is ≈ 25 s of reader traffic against a T1 pass measured in single-digit seconds, so under
  the first draft's wording most scored calls would have seen **no writer at all** — diluting
  a ≥ 1% criterion by roughly the duty cycle and pushing R5 toward ABSENT for free. The
  writer therefore runs **repeat non-incremental indexes back-to-back** until the scored
  count is reached, and unscored calls are recorded but excluded. (Verified benign: a
  non-incremental reindex genuinely rewrites everything — `toIndex = currentFiles`,
  `indexer/index.ts:232`, and the skip is gated on `options.incremental` at `:278` — so
  repeat passes are real write load, not no-ops.)
- **Query payload: derived from the probed corpus's own index** (A3-MAT-3). The first draft
  reused Q1/SCALE's frozen probes (`eval/scale-queries.json`) — which are **vscode-specific**
  (`strata.probes.queries[0]` targets `supportsTelemetry` in
  `src/vs/platform/telemetry/common/telemetryUtils.ts`) — against n8n tiers. Absent terms
  are the cheapest reads a search engine performs: FTS5 returns empty early and ranker D
  never engages, which suppresses exactly the contention R5 exists to detect. The payload is
  instead **10 declaration names sampled with seed 811 from that corpus's own `symbols`
  table**, stratified to span common and rare terms, emitted as
  `eval/e1r5-queries-<corpus>.json` and **committed before the probe runs**.
- **Per-corpus idle baseline, measured first:** the same K readers, same payload, same
  count, with **no writer running**. The stall metric is **excess over that corpus's own
  idle baseline**, not an absolute number.

**Why the thresholds moved** (A1-F6a/b). The original registered 1,700 ms; round 1's own
instrument field is `wal_checkpoint_outliers_gt_1500ms` (verified in
`eval/e7-concurrency.json` and `eval/e7-round2.json`), so **1,500 ms** is the measured
signature's own threshold and is what this registration now uses — the looser number
flattered retirement for no stated reason. The original's other bound, 755 ms, was
imported from round 2's Arm B **server-side lock-hold** envelope on **nest** at **~1.3k
files** on a **pre-F11** build, and compared against **client wall clock of `mast query`
CLI processes** — a different plane, corpus, scale, and build. Each `mast query` call is a
fresh node process that resolves config, opens the DB and registers all tools
(`cli/query.ts:79-113`), so at T9 scale it can plausibly exceed 755 ms with zero stalls.
**That bound is withdrawn** and replaced by the idle-baseline comparison above.

**Reader lifecycle, stated as an unargued gap.** Production's topology is `mast serve`
holding connections open; the probe uses process-per-call CLI readers, which rebuild the
wal-index and reopen the DB every call. `mast query` does dispatch through the real MCP
handlers (`cli/query.ts:142-155`), so the *read path* is the shipped one — but the
*connection lifecycle* is not, and that is exactly the dimension a WAL probe is sensitive
to. Registered as a known external-validity limit of R5, not resolved.

**There is no non-invasive in-flight backlog probe.** `PRAGMA wal_checkpoint(PASSIVE)`
*performs* the checkpoint work it would be observing, so sampling it during the write
would measure the instrument. Backlog is therefore read **at run boundaries only** (before
the write starts, after it completes); during the write the observables are reader latency
and `mast metrics --locks` hold/wait distributions, both non-invasive. This limitation is
registered, not discovered later.

**Direction-of-error statement for R5** (A1-F6f, absent from the first draft): the
investigator's effective prior is **retirement** — round 2 measured the signature absent,
and the Q6 RESCOPE already retired it for the pre-F11 system. Every free parameter the
first draft left open (threshold, corpus, denominator) leaned that way. The ABSENT branch
therefore carries the harder requirement: both corpora, the full 400-call minimum, and the
idle-baseline comparison, not an absolute threshold that scale alone could satisfy.

#### Exactly one decision-bearing test per experiment

**E1 — the growth exponent.** Fit `(durationMs − c) = a · N^b` by OLS on log–log over the
**27 tier runs**; `b` is the growth exponent, `b = 1` is linear (cost per unit flat).

**The fitted clock is `runIndex`'s own `durationMs`** (`indexer/index.ts:173` → `:414`),
not the external wall clock (A1-F4c — the first draft named two sources and fitted
neither, which is a free lever). `c` is the calibration constant measured above. Both the
**adjusted** fit (`durationMs − c`) and the **raw** fit (`durationMs`) are reported; **if
they land on opposite sides of 1.35 the verdict is AMBIGUOUS**, which removes the choice
between them as a post-hoc lever.

**Estimator** (A1-F4b — 5-cluster BCa is withdrawn as unsound; its acceleration constant
comes from a delete-one jackknife over five values, ~10% of cluster resamples contain ≤ 2
distinct tiers and ~0.16% contain one, for which the slope is undefined, and the first
draft registered no handling for degenerate resamples):
- **Primary: OLS over the 27 tier runs with HC3 heteroscedasticity-robust standard errors**
  (df = 25), 95% CI on `b` using `t₀.₉₇₅,₂₅ = 2.060`. The nested design is what licenses
  this — tiers are subsets of one corpus, so a tier's cost is a fixed quantity plus
  run-to-run noise, not a draw from a population of corpora.
- **Sensitivity, reported always: a wild cluster bootstrap over the 9 tiers**, with the
  parameters A3-MAT-1 found unregistered:
  - **Webb 6-point weights**, not Rademacher. At 5 clusters Rademacher offers 2⁵ = **32**
    distinct weight vectors, so AMENDMENT 1 traded BCa's degeneracy for a bootstrap whose
    reference distribution has 32 atoms — one degenerate method for another. Nine clusters
    give Rademacher 512 atoms, which is workable but still coarse in the tails a 95% CI
    reads; Webb's 6-point weights give 6⁹ ≈ **10.1 M**. Webb is the standard remedy for
    exactly this small-`G` regime.
  - **10,000 draws, seed 811, cluster = tier.**
  - **Restricted residuals** (imposing `H₀: b = 1.35`) for the **hypothesis test**;
    **unrestricted residuals** for the **percentile-t CI**. This is the Cameron–Gelbach–Miller
    convention, and leaving the choice unregistered was a free lever over the headline
    interval.
  - **Studentized (bootstrap-t) intervals**, studentizing with the CR1 cluster-robust SE —
    not raw percentile, which is the weaker construction at small `G`.
  **If the primary and the sensitivity land on opposite sides of 1.35, the verdict is
  AMBIGUOUS.**
- The **replication panel** (5 corpora × 3 reps) is fitted the same way and reported, but
  is **supporting only and never carries a verdict** — content confounds scale across
  unrelated repos, which is the whole reason the decision-bearing axis is nested.

**The exposure variable is `chunk_count`, not file count.** `b_chunk` is decision-bearing;
`b_file` is supporting. Reason: the write path scales in chunks — the O(n²) pathology
Stage 2 removed was per-chunk-write against Lance's manifests — while mean file size
varies across these five corpora as a matter of corpus *content*, so a file-count exponent
would fold content variation into the scale estimate. Both are reported.

**Registered threshold: `b = 1.35`.**

| observed | verdict |
|---|---|
| `b_chunk` 95% CI **upper** bound < 1.35 — on the HC3 primary **and** the wild-cluster sensitivity, **and** on both the adjusted and raw fits | **O(N) HOLDS at ladder scale.** Stage 2's regression proof extends from ~5k files to T9. |
| `b_chunk` 95% CI **lower** bound > 1.35, on the HC3 primary | **SUPER-LINEAR REGRESSION.** M1's O(N) claim does not extend; Stage 2 reopens as a scale defect. |
| CI straddles 1.35, **or** primary and sensitivity disagree across it, **or** adjusted and raw disagree across it | **AMBIGUOUS.** Report; escalate by adding tiers or repetitions, never by reinterpreting and never by adding an unrelated corpus. |

Why 1.35, registered before the numbers exist so it cannot be tuned: FTS index growth is
expected to contribute a mild `N log N` term, so a threshold at 1.0 would fail a healthy
system by construction. Across the ladder's **20× span in chunks**, that term's *effective*
exponent is `1 + ln(ln N_max / ln N_min) / ln 20`, which for any plausible realized
`C_total` in [50k, 200k] chunks evaluates to **1.09–1.11** — 1.094 at 200k, 1.101 at 100k,
1.108 at 50k. Call it **≈ 1.10**; it is re-derived exactly at Gate 1b. The pathology class
this experiment exists to detect is quadratic (`b ≈ 2`): across the same span, `b = 1.35`
costs **2.85×** more than linear and `b = 2` costs **20×**. 1.35 sits above the expected
`N log N` and far below the pathology.

(The 18.0× / 1.120 / 2.75× / 18× figures from AMENDMENT 1 are withdrawn — A3-FATAL-2: they
were computed on the raw-`find` **file** counts that same amendment disavowed, for a ladder
that is cut on **chunks**. The threshold itself, 1.35, is unchanged; it was registered at
`fd46152` and both the old and new rationales place it in the same gap.)

**Power, and the reachability arithmetic** (A1-F4d; re-derived per A3-FATAL-2 and extended
per A3-MAT-1). Because the rungs are evenly spaced in `ln N` by construction, `Sxx` follows
from geometry alone and does not depend on any remembered corpus count. With 9 rungs
spanning 20×, the spacing is `d = ln 20 / 8 = 0.3745`, and `Σ_{k=−4}^{4} k² = 60`:

- **Cluster level (9 tier means):** `Sxx = 60 d² = 8.414`, `SE(b) = σ_tier / 2.901`, df = 7,
  `t₀.₉₇₅,₇ = 2.365`. HOLDS needs `b̂ + t·SE < 1.35`; at the expected `b̂ ≈ 1.12` that
  requires **`σ_tier < 0.28`**.
- **Run level (27 runs):** `Sxx = 3 × 8.414 = 25.24`, `SE(b) = σ / 5.024`, df = 25,
  `t₀.₉₇₅,₂₅ = 2.060` → **`σ < 0.56`**.

**Both are published, and the cluster-level one is the honest number** (A3-MAT-1). HC3 over
27 runs at 9 distinct x-values treats tier-level lack-of-fit as if it shrank with
repetitions, and it does not: adding reps drives down pure error while leaving any
systematic tier-level departure untouched. Quoting only `σ < 0.56` would therefore overstate
the design's power in precisely the situation the experiment cares about. **Widening 5 → 9
rungs is what makes the honest ceiling livable:** at 5 rungs the same calculation gives
`Sxx_cluster = 5.22`, df = 3, `t = 3.182`, and `σ_tier < 0.165` — a bar ordinary
between-tier variation could plausibly breach, i.e. a HOLDS branch at real risk of being
arithmetically unreachable. Q1/SCALE published its `n_min = 154`; this is the analogue.

**This design is still sized to detect a quadratic regression, not to resolve `b = 1.0`
from `b = 1.2`.** If the realized CI straddles 1.35 from below 1.0, the honest verdict is
AMBIGUOUS-underpowered, and the registered escalation is more tiers or more repetitions —
never a narrower threshold, and never (as the first draft wrongly proposed) another
unrelated corpus, which would deepen the confound rather than resolve it.

**Registered consistency triggers.**
1. **Lack of fit — RE-DERIVED 2026-08-12 (A3-FATAL-1). The previous form was wrong in the
   investigator's favour and had been re-certified as "verified and unchanged."** It read:
   *"if `ms/chunk` is strictly monotonically increasing across all five tiers (p = 1/120
   under exchangeability) while the CI discharges → AMBIGUOUS."* Under the very `N log N`
   model used two paragraphs above to justify `b = 1.35`, `ms/chunk ∝ log N`, which **rises
   ~41% across the span** (`ln 19056 / ln 1059 = 1.415` on the old ladder; ~1.35 on the
   amended one) — so **strict monotone increase is the *expected healthy* signature**, and
   the trigger fired on it. Worse, the registered escalation for AMBIGUOUS is *more
   repetitions*, which tightens tier means and makes a monotone ordering **more** likely: an
   escalation that increases the chance of the outcome it is escalating from. `ms/chunk` is
   not exchangeable across tiers under the fitted model, so no permutation argument applies
   to it at all.

   **The trigger now applies to departure from the fitted law, which is what "the single
   exponent misdescribes this ladder" actually means.** With 3 reps at each of 9 rungs the
   classical decomposition is available and is the right instrument:
   - **Statistic:** the lack-of-fit `F` test on the **adjusted** log–log fit —
     `F(7, 18)` = (lack-of-fit MS, 9 − 2 = 7 df) / (pure-error MS, 9 × (3 − 1) = 18 df),
     at **α = 0.05**.
   - **Registered on the adjusted fit only.** The raw fit carries a known omitted additive
     constant, which *guarantees* curvature, so a raw-fit lack-of-fit test would fire by
     construction and mean nothing. The raw `F` is reported as descriptive.
   - **A practical-significance floor, required jointly with significance.** The trigger
     fires only if `F` is significant **and** the fitted quadratic-in-`ln N` term implies a
     departure from the straight-line fit exceeding **5% in predicted time at the ladder's
     endpoints**. Benchmark, computed for this ladder's geometry: the `N log N` term's own
     curvature produces a maximum endpoint departure of **0.69%** in log-time (mid-ladder
     +0.47%, endpoints −0.69%). A 5% floor clears that by ~7× while sitting far below a
     linear-plus-quadratic mixture's signature. Without the floor, a design with tight pure
     error would fire on the 0.7% term itself and AMBIGUOUS would be predetermined — the
     A1-F4d defect class.
   - **Fires → AMBIGUOUS**, with the registered escalation (more rungs or more reps).
   - **What it does and does not detect, stated plainly:** a *pure* power law of any
     exponent is a straight line in log–log, so this trigger is silent on quadratic-only
     data — the CI on `b` owns that case. It detects **mixtures**, e.g. a linear pipeline
     with one quadratic subcomponent that only dominates at scale, where a single exponent
     is the wrong description of the ladder. The two instruments are complementary, not
     redundant; the previous trigger was neither.
2. Any run with `write_errors > 0` is **VOID** — that is an S1 regression, and S1's whole
   point was that a non-zero `write_errors` means chunks are silently absent from the index.
   Diagnose, then re-run.
3. If R3's `bytes/chunk` at T9 exceeds 1.5× T1's, it is flagged and discussed in the result;
   it does not alone force AMBIGUOUS (state overhead has a fixed component that amortizes
   differently across a 20× span).
4. **Parse-error rate** (A1-F12). Files that fail to parse consume walk/read/parse time and
   contribute **zero** chunks, so a parse-error rate that rises with tier size inflates
   `ms/chunk` with `N` through a channel the model does not represent. If any tier's parse-
   error *rate* exceeds 2× the median tier's, it is flagged and **must be discussed before
   the verdict is recorded**. (Nested tiers make this unlikely — they are subsets of one
   corpus — which is another reason the nested axis is decision-bearing; the panel, where
   vendored/fixture density genuinely varies, is supporting only.)
5. **`b_file` vs `b_chunk` disagreement** (A1-F10). If the supporting file-count exponent
   and the decision-bearing chunk-count exponent land on opposite sides of 1.35, that is
   reported and discussed — it means chunks-per-file is itself varying with scale — but it
   does not override the registered exposure choice.

**Direction-of-error statement, in advance:** the investigator's prior is that M1 fixed
this — O(N) was proven at small scale and Stage 2 is marked Complete. **"O(N) HOLDS"
flatters that prior.** The HOLDS branch therefore carries the harder requirements: a CI
upper bound rather than a point estimate near 1, trigger 1 above, and a mandatory
adversarial results review before the verdict is recorded.

**E2 — the §10.3.1 coverage band.** §10.3.1 reads, verbatim (`MAST_SPEC.md:2018-2024`):
"In a Fastify + DI service codebase, the resolver catches roughly the field/parameter/
import cases — **typically 60–80% of real call sites** depending on how heavily the
codebase uses factories and containers." Quantity: `edge_emitted ÷ total call sites
visited`, from the `onCallSite` seam run over a corpus's indexed file set.

**Decision-bearing corpus is `nest` alone** (A1-F1). The claim is scoped to Fastify+DI, and
the other five checkouts — P1–P4 plus n8n, the ladder's source — contain no Fastify at all;
testing a scoped claim against out-of-scope corpora and then mandating a spec rescope is not
a test, it is a formality that returns the investigator's prior.

| observed on **nest** | verdict |
|---|---|
| yield ≥ 60% | **SUPPORTED.** §10.3.1's band holds on the closest available Fastify+DI corpus. Whether the realized value also falls below 80% is descriptive; the upper edge is not a failure condition. |
| yield < 60% | **NOT ATTAINED** (softened 2026-08-12, A3-MAT-2, owner decision). Registered reading: *the band is not attained on the closest available Fastify+DI corpus.* That is **evidence for a spec revisit, not a mandate** to rescope §10.3.1 or remove the figure. Reason: `n = 1`, and the one corpus is a DI *framework* rather than the DI *service* the spec names — a single out-of-referent miss cannot carry a spec change on its own. Recorded as a spec-drift **candidate**, alongside the P3 items, for a decision that weighs it against the caveats rather than executing on it. |

The table is exhaustive by construction — the first draft's three rows left the pattern
"one corpus above 80%, none in 60–80%" with **no verdict at all** (A1-F7), which is the
Q1/SCALE AMENDMENT-1 F3 class: verdict machinery undefined on a reachable data pattern,
resolvable only post-hoc by the prior.

**P1–P4 and n8n are external validity, and carry no verdict.** Their yields are reported in
full and answer a different, narrower question: how far the band travels outside its stated
scope. A miss on all of them licenses **no** spec change.

**Direction-of-error statement:** mast's own `src/` measures 40%, below band, so the
investigator's prior is that the band is optimistic — **NOT ATTAINED flatters that prior**.
That branch therefore carries the mandatory adversarial results review, and the nest caveat
above (framework, not service) must be restated wherever the verdict is quoted.

**The denominator is narrower than the spec's** (A1-F8), and this is registered rather than
discovered later. §10.3.1's band is over "real call sites"; the seam's denominator is
`collectCalls`' *visited* sites, which **by design** exclude calls inside nested-scope
function/method/class bodies (D7 result: such calls "are never handed to `parseCallee` and
are therefore, by design, outside this invariant"). Callback-heavy code — promise chains,
array HOFs, route-handler closures — is systematically absent from the denominator, so the
measured yield **overestimates** coverage of real call sites. Direction: this runs
**against** the UNSUPPORTED prior. Mitigation: every corpus additionally reports raw
`call_expression` node count alongside visited sites, so the size of the excluded region is
quantified rather than assumed small.

Supporting, reported in full, never dispositive: the by-`resolution` breakdown (`SELECT
resolution, COUNT(*) FROM edges WHERE edge_type='POTENTIAL_CALL' GROUP BY resolution`),
including the `this_method` / `super_method` share F4 shipped; the four-way `CallSiteOutcome`
distribution per corpus against mast's own 866 / 604 / 592 / 93 baseline.

**E1-R5's falsification, registered separately** (it is a defect probe, not a growth law):
round 1's signature was periodic **1.7–3 s** reader stalls.

| observed, on **each** of T1 and T9, over ≥ 400 scored calls (scored = overlapping write activity) | verdict |
|---|---|
| ≥ 1% of reader calls exceed **1,500 ms** (round 1's own instrument threshold) | Round-1's stall class is **PRESENT at HEAD**; Q6 reopens as a live defect. |
| 0 calls exceed 1,500 ms **and** that corpus's p99 exceeds its own idle-baseline p99 by **≤ 250 ms in absolute terms** | **ABSENT at HEAD topology** — which, with round 2's pre-F11 null, retires the class. |
| anything between | Reported; class **INDETERMINATE**. |

**The "within 2× idle baseline" multiplier is withdrawn** (A3-MAT-6). It was derived
nowhere, and it is **vacuous at T9**: any corpus whose idle p99 reaches 750 ms has a 2×
bound of ≥ 1,500 ms, at which point the clause is strictly implied by the row's other
condition and contributes nothing. The replacement is absolute and derived: round 1's
signature was periodic **1,700–3,000 ms** stalls, so an excess an order of magnitude below
the *smallest* stall ever observed is the operative "no trace of this class" bar — hence
**250 ms**. Direction, stated because it matters: an absolute bar is **harder** to satisfy
at T9 than a multiplier would be, so this change runs **against** retirement, which is the
correct direction given R5's registered prior.

Both corpora must land in the same row for a clean verdict; a split (e.g. ABSENT at T1,
INDETERMINATE at T9) is reported as INDETERMINATE overall, because scale is exactly the
axis this row exists to probe.

#### Registered readings for the supporting rows (A1-F10)

The first draft measured R2, R3 and R4 and registered no interpretation for any of them —
in a design whose banner is "exactly one decision-bearing test per experiment", a measured
row with no registered reading is a post-hoc lever. Each now has one, and none carries a
verdict:

- **R2 (parse ÷ full ratio):** descriptive. It answers "how much of Phase 1's chunk pipeline
  is parsing versus writing", scoped by the exclusion above. No threshold; no verdict; its
  only registered use is to inform where a future optimisation would pay.
- **R3 (`graph.db` bytes ÷ chunk_count):** descriptive, policed by trigger 3. It is the
  successor signal to the retired Lance `_versions` row, and a flat value across tiers is
  the *expected* post-M1 picture, not a discharge criterion for anything.
- **R4 (checkpoint cost at scale):** descriptive, and explicitly **not** a defect test. It
  exists to give the deferred `wal_autocheckpoint` question (Q6 RESCOPE item 4) real numbers
  to be decided against instead of speculation. Registered reading: boundary
  `PRAGMA wal_checkpoint` `(busy, log, checkpointed)` and TRUNCATE wall-clock per tier,
  reported as a curve against chunk count. **No threshold is registered because none is
  justified by anything measured so far** — inventing one here would be a post-hoc lever
  wearing a pre-registration's clothes.

#### Falsification criteria (pre-stated)

- **Super-linear indexing (the regression outcome):** `b_chunk` CI lower bound > 1.35 on the
  nested tier ladder.
- **O(N) holding:** `b_chunk` CI upper bound < 1.35, on both the primary HC3 fit and the
  wild-cluster sensitivity, adjusted and raw.
- **The spec's coverage band failing:** `nest` yield below 60% — read as NOT ATTAINED, per
  the softened consequence registered above.
- **The round-1 stall class living at HEAD:** ≥ 1% of concurrent-reader calls over 1,500 ms
  **on both probed corpora** (A3-MAT-4 — this bullet previously read "on either probed
  corpus" while the verdict table says a split is INDETERMINATE overall. The contradiction
  was introduced by AMENDMENT 1, which added the second corpus here but not there. **The
  table wins**, because the table is the instrument that is actually scored, and "either"
  would have made a single-corpus PRESENT reading dispositive against a design that
  deliberately probes two scales).
- Every one of these is falsifiable in both directions; no outcome here is "no result."

#### Gates before any scored measurement

0. **Binary identity — the D8 gate.** `pnpm -F mast build` runs first; the run manifest
   records `mast status --json`'s `schema_version` and `dist/`'s build timestamp; the
   harness invokes the freshly built binary **by absolute path**, never a `PATH` lookup.
   Any run whose recorded `schema_version` ≠ the source tree's `CURRENT_SCHEMA_VERSION` is
   **VOID**. This gate exists because D8 established that a stale gitignored `dist/` served
   three days and one schema version of agent sessions undetected, and because **every
   `eval/*.mjs` script imports from `../dist/` directly** — the harness is exposed to the
   identical failure. Rebuild is not restart: any long-lived `mast serve` involved in R5
   must be started *after* the build. **This gate covers run P0** (the prerequisite
   full-n8n build) and **E2's harness pass**, neither of which the first draft brought
   under it — see A3-FATAL-3 and A3-MAT-8.
1. **Corpus integrity, per run:** detached worktree at the pinned SHA with
   `git status --porcelain` empty; tier file lists match the frozen tier manifest exactly;
   `write_errors == 0` (else VOID, per trigger 2); `parse_errors` **recorded but not gated**
   — corpora legitimately contain files this extractor cannot parse, and gating on that
   would silently select for corpora that flatter the tool, so the rate is policed by
   trigger 4 instead; indexed file count and chunk count read from `graph.db`, never stdout;
   the resolved config recorded in the manifest. **Added 2026-08-12:** a tier's three
   repetitions must report **identical** `chunk_count`; disagreement is a nondeterminism
   finding and voids that tier pending diagnosis.
   **Gate 1b — ladder geometry and reachability, re-derived from the frozen manifest before
   any scoring** (A3-FATAL-2). Once P0 has run and the 9 rungs are cut, the harness computes
   and **commits**, from the manifest's realized chunk counts: the realized span, each rung's
   realized fraction of `C_total`, `Sxx` at run and cluster level, both `SE(b)` multipliers,
   both σ ceilings, and the `N log N` effective exponent. The projected figures above
   (`Sxx_cluster = 8.414`, `σ_tier < 0.28`, `σ < 0.56`, `b_eff ≈ 1.10`) assume rungs land
   exactly on their target fractions; real file prefixes land near, not on. **If the realized
   `Sxx_cluster` falls more than 20% below 8.414, the cut is re-examined before any scored
   run** — not after, and never by moving the threshold. This gate exists because AMENDMENT 1
   published an entire power analysis computed on an anchor it had itself disavowed in the
   same document; arithmetic that is never re-derived against reality is decoration.
2. **Parse-only fidelity (R2):** the parse pass's **file count, chunk count and symbol
   count** must equal the full index's **exactly**. Edge count is deliberately **not** in
   this gate — see the R2 construction note above (A1-F2): edge rows are lossy and deduped
   relative to extractor emissions, so equality is structurally impossible and requiring it
   would void R2 everywhere. Any mismatch on the three checkable counts voids R2 for that
   run.
3. **Cold-start discipline:** fresh state dir per run; never `--incremental`; run order is
   the committed seeded shuffle (seed 811). Each run records **both** clocks. Gate:
   `external − durationMs ≤ max(5%, 500 ms)`. The absolute floor is not slack — process
   boot, commander, config resolution and `openDatabase` all sit outside `startMs`
   (`indexer/index.ts:173`), a fixed 150–300 ms that is 4–9% of a ~3.5 s T1 run, so a bare
   5% rule would fire systematically on the *healthiest* small-tier runs (A1-F5 — the
   Q1/SCALE Gate-5 class, a gate firing on the ideal condition). Retakes are **capped at 2
   per run**; a third failure is logged as a finding rather than retaken, because selective
   retention of fast-boot runs would bias small-tier totals down and the slope **up**.
4. **WAL instrument rules — carried verbatim from the Q6 RESCOPE so they cannot be
   re-derived wrongly.** Backlog is read via `PRAGMA wal_checkpoint`, **never** from `-wal`
   file size, which is a high-water mark and is *silent* on deferral. The reader-block
   signal is the **`checkpointed < log` gap**, not the `busy` column, which stays 0. Any
   copy of a live database copies `.db` + `-wal` + `-shm` together. Never open `graph.db`
   with `?mode=ro&immutable=1` — it is WAL-blind. **Measured prior carried into R4:**
   `{busy:0, log:889, checkpointed:889}` on the live 14,605-chunk index, 2026-08-11 — 889
   is the backlog **ceiling**, not its depth, because opening a copy rebuilds the wal-index.
   (A3-C3: this registration cites the live index as both 14,605 and 14,610 chunks. They are
   the **same index at two moments of 2026-08-11**, five chunks apart — the WAL reading above
   was taken before the operator restart, the 14,610 figure in Costs after it. The reading's
   own context is left as measured rather than retro-fitted; only the discrepancy is
   reconciled here.)
5. **Determinism and instrument hygiene:** the six pin SHAs, seed 811, the frozen tier
   manifest, the harness scripts, and the run-manifest schema are committed **before** any
   measurement. Every script ships a working CLI entry point — Q1/SCALE logged that defect
   class **twice** (`ab-score.mjs`, `idfuse-score.mjs`); a third occurrence is a process
   failure, not a cosmetic note.
6. **Measurement ordering** (A1-F10). R5 runs a **second index into an already-built state
   dir**, so after R5 that directory is no longer the scored run's artifact. R3's `stat`,
   R4's boundary checkpoint reading, and E2's seam/SQL extraction must all be taken
   **before** R5 touches a corpus — or R5 must run against a dedicated copy. Registered
   here because nothing else in the design forces the order.
7. **Scorer correctness — known-answer tests, green BEFORE the scorer sees real data**
   (AMENDMENT 2). The scorer's statistics ship as `eval/__tests__/e1-score.test.mjs`, run by
   the normal suite (`vitest.config.ts` already includes `eval/**/*.test.mjs`, and its own
   comment names this defect class), so the gate is enforced by `pnpm -F mast test` rather
   than by a bespoke script a runner has to remember to invoke. Required cases, all over the
   frozen tier chunk counts with seeded multiplicative noise:
   - **(a) Known quadratic** (`total = a·N²`) must fire **SUPER-LINEAR REGRESSION**. A
     scorer that cannot fire this row on data built to fire it returns the investigator's
     prior on every input.
   - **(b) Known linear** (`total = a·N`) must fire **O(N) HOLDS**.
   - **(c) Known linear-plus-large-constant** (`total = c + a·N`) must fire HOLDS on the
     **adjusted** fit *and* must exhibit a lower raw-fit exponent — this is the only case
     that proves the calibration subtraction is wired the right way round rather than merely
     present. A sign error here biases `b` down, i.e. toward HOLDS. **Numeric margin, added
     2026-08-12 (A3-MAT-7): "visibly lower" is not a test.** The dataset is constructed with
     `c` equal to 40% of T1's total time; the assertions are that the **adjusted** fit
     recovers the constructed truth `b = 1.0` within **±0.05**, and that the **raw** exponent
     sits at least **0.10 below** the adjusted one. Both numbers are properties of the
     constructed dataset, not of the outcome.
   - **(d) HC3 and the wild cluster bootstrap** each checked against a fixed dataset whose
     OLS slope and robust SE are computed independently, not by the code under test.
   - **(e) Degenerate input** — all-equal timings, and a single-tier dataset — must **not**
     silently produce HOLDS. They must raise or return an explicit undefined verdict.
   - **(f) E2's two-row table and R5's three-row table** each exercised on synthetic inputs
     that land in every row, including R5's split-corpora INDETERMINATE case.
   - **(g) E1's own three-row table, every row and every feeding mechanism** (A3-MAT-7 — the
     first draft of this gate exercised E2's and R5's tables but **not E1's**, which is the
     only one that carries the headline verdict, and whose AMBIGUOUS row has *three*
     independent mechanisms, none of them constructed):
     - SUPER-LINEAR fired via the **CI lower bound** — a dataset with `b̂ ≈ 1.42` whose CI
       lower bound clears 1.35.
     - AMBIGUOUS via a **CI straddling** 1.35.
     - AMBIGUOUS via **primary/sensitivity disagreement** across 1.35.
     - AMBIGUOUS via **adjusted/raw disagreement** across 1.35.
     - **The point-estimate killer:** a dataset whose point estimate is **below** 1.35 but
       whose CI **upper** bound is above it must return **AMBIGUOUS, never HOLDS**. Without
       this case a scorer that keys verdicts off `b̂` instead of the interval bounds passes
       every other case in this gate — and it fails toward HOLDS on precisely the noisy data
       where the distinction decides the experiment.
   - **(h) Trigger 1's lack-of-fit test.** A pure power law (any exponent) must **not** fire
     it. A linear-plus-quadratic mixture constructed to exceed the 5% endpoint-departure
     floor **must** fire it. A mixture constructed to sit at the `N log N` term's own 0.7%
     departure must **not** fire it even when pure error is made small enough for `F` to be
     significant — that pair is what verifies the practical-significance floor is wired in
     rather than merely written down.

   **Why this gate is here at all, stated plainly:** the first draft of this registration
   omitted it. Q1/SCALE registered the equivalent gate specifically because `ab-score.mjs`
   shipped with its headline Wilcoxon test *registered but never implemented* — the exact
   failure of omitting a check on the machinery that produces the verdict. Carrying that
   file's CLI-entry-point lesson (Gate 5) while dropping its scorer-test lesson was an
   inconsistency in the author's favour.
8. **E2 harness fidelity — the gate E2 never had** (A3-MAT-8). `extractFile` takes
   `(filePath, projectRoot, contextLines, chunkSplitThreshold, markdownHeadingDepth)` and
   **no `onCallSite` parameter** (`ast/extract.ts:44-50`); the seam exists only on
   `extractEdges` (`ast/extractors/typescript.ts:1148-1162`). **E2 therefore cannot ride a
   Gate-0-verified product build.** It is a harness pass that self-reports *both* its
   numerator and its denominator — the one measurement in this registration with no
   independent check on either — while R2, a merely *descriptive* row, was given Gate 2.
   That asymmetry is backwards, and it survived two amendments. The compensating control:
   - The harness pass over `nest` must reproduce that corpus's Gate-0-verified build on
     **file count, chunk count and symbol count exactly** — the same three counts Gate 2
     uses, and for the same reason.
   - Its `edge_emitted` count must be **≥** the `POTENTIAL_CALL` row count in that build's
     `graph.db`. Greater-or-equal is the only sound direction: A1-F2 established that edge
     rows are lossy (unresolved names dropped, `populate.ts:537,543`) and deduped
     (`db.ts:257`) relative to extractor emissions, so equality is structurally impossible
     and a **lower** harness count would mean the harness is not seeing the whole corpus.
   - The harness records its own import path and the built `dist/` timestamp, so Gate 0's
     binary-identity claim extends to it rather than stopping at the product CLI.
   - Any mismatch **voids E2 for that corpus**, which — since `nest` is E2's sole
     decision-bearing corpus — voids E2's verdict rather than degrading it silently.

   Adding an `onCallSite` parameter to `extractFile` would let E2 read the product path
   directly and retire this gate. **That is a product change made to serve a measurement,
   and it is out of scope** — the same reasoning that kept `--parse-only` out for R2. Gate 8
   is the compensating control, not a preference.

#### Costs (stated before spending)

- **Index time, expressed in the only unit that survives A3-FATAL-2.** A minutes figure
  derived from the disavowed file counts would repeat the defect this amendment exists to
  fix, so the budget is stated in **full-n8n-index-equivalents**, `t` = the cost of one T9
  build:
  - **Ladder:** `Σ f_i = 3.092` equivalents per repetition × 3 reps = **9.28 t**.
  - **Prerequisite:** run P0 = **1.00 t**.
  - **Panel:** P1–P4 + `nest` ≈ **0.90 t** per rep × 3 = **2.69 t**. This one term is
    still sized off the provisional raw-`find` ratios, because no better anchor for
    *other* repos exists until they are built; it is a budget line, and no verdict
    depends on it.
  - **Total ≈ 13 t**, plus 10 calibration runs (empty corpus, negligible), parse-only
    passes, process startup, and R5's writer/reader load on two corpora.

  Against the original registration's ≈ 5.5 t, the amended design costs **≈ 2.4×** — not
  "roughly doubles" (A3-C4), which understated it while the design grew from 5 rungs to 9
  and acquired a prerequisite build. At these absolute numbers that is not a constraint
  worth trading validity for. `t` itself is unknown until P0 runs, and **that is the point**:
  this projection is itself the quantity under measurement — a budget, not a prediction — and
  a realized ladder an order of magnitude above it *is* the R1 result, not a cost overrun.
- **Disk.** The live index is 157 MB at 14,610 chunks (≈11.3 KB/chunk). If chunk yield
  tracks it, T9 could reach ~1.5–2 GB and one full set of tiers plus panel ~5–7 GB.
  **Only the final repetition's state dirs are retained**; earlier reps are deleted once
  their manifest is written, subject to Gate 6's ordering. Host: 79 GB free of 926 GB (92%
  used). `~/.cache/mast-eval/vscode-state-*` holds ~6.9 GB that is reclaimable if needed —
  per `eval/ASSETS.md`, Q1/SCALE's *conclusions* do not depend on those dirs surviving, only
  the ability to cheaply re-run ranking arms.
- **No agents, no embedding, no model calls.** Token spend is orchestration only.

#### Design Reserve (pre-thought, NOT commitments)

A tenth rung at vscode (8,653 files / 138,440 chunks, already pinned and built once for
Q1/SCALE) — note it is a *different corpus*, so promoting it extends the panel, not the
nested ladder; a genuine **Fastify+DI service** corpus for E2, which nest only approximates
(the closest candidate is this monorepo's own `application/api`, disqualified as the home
corpus); a K-sweep for R5 across N ∈ {1..8} matching rounds 1–2; per-language yield
breakdown for E2; **`wal_autocheckpoint` tuning**
(Q6 RESCOPE item 4) evaluated against R4's realized numbers and never speculatively;
attribution of the 1,802 ms `index-run` hold — which the Q6 RESCOPE leaves explicitly
**unattributed** across at least three candidate mechanisms (batch volume, Q3's FTS-growth
cost, checkpoint-inside-commit) — promoted only if R5 reproduces holds in that band.

#### AMENDMENT 1 — 2026-08-11, pre-run, post-adversarial-review

Adversarial design review commissioned per the standing §6 rule (Agent tool, model
`fable`) against this section as committed at `fd46152`, **before any measurement had
occurred**. Per the Q1/SCALE and Q1/OUTCOME precedents, no data existed, so the
registration above was revised **in place** rather than appended to; this log is the audit
trail. Every code claim the reviewer made was **independently verified against source
before being accepted** — the reviewer has been wrong before, and §6 requires it.

Stated plainly, because it is the finding about the process rather than the instrument:
**of the twelve findings, five run toward the investigator's own priors** (E1 → "O(N)
HOLDS"; E2 → "UNSUPPORTED"), and four more are free levers with no fixed direction that
would have been resolved after the data existed. Q1/SCALE's review found 7 of 12 running
the same way. **This is now the third consecutive review round in which the majority of
defects flattered the investigator** — that regularity is itself the argument for the
review step, and it should be quoted at anyone who proposes skipping it.

| # | Finding | Change | Direction the error ran |
|---|---|---|---|
| F1 | E2 tested a claim §10.3.1 scopes to "a Fastify + DI service codebase" against five corpora, **none of which depend on `fastify`** (verified: every non-`node_modules` `package.json` to depth 4 in all five). The "all five must miss" bar, presented as conservative, was near-automatic — and the consequence ("the spec must be rescoped") did not follow from missing a band on out-of-scope corpora. | `nestjs/nest` @ `f7fffd6` (3 fastify + 48 DI packages, already pinned, the project's honest-broker corpus) becomes E2's **sole decision-bearing** corpus, with an explicit registered caveat that it is a DI *framework*, not a DI *service*. P1–P5 demoted to external validity, licensing **no** spec change. | **Strongly flatters UNSUPPORTED** — the worst defect in the registration. |
| F2 | Gate 2 required the parse pass to match the full index on **edge count**. Structurally impossible: `insertEdges` drops unresolved names (`populate.ts:537,543`) and dedupes on `PRIMARY KEY (from_id,to_id,edge_type)` (`db.ts:257`), and no product-side extractor-level edge counter exists. The gate would have voided R2 everywhere, or passed vacuously on harness-vs-harness. | Gate 2 now checks **file + chunk + symbol** counts. R2's scope narrowed in writing to Phase 1's chunk pipeline, explicitly excluding pass-2 resolution. | **Free lever** — the likely real outcome was a post-hoc redefinition of "edge count". |
| F3 | Five unrelated repos made corpus **content** perfectly confounded with `N`. Q1/SCALE faced this exact problem and solved it with seeded nested subsets of one corpus; the reversal was justified nowhere. Worse, the registered escalation for AMBIGUOUS was *another corpus*, deepening the confound. | Decision-bearing axis is now a **seeded nested tier ladder inside n8n** (T1⊂…⊂T5, seed 811), the Q1/SCALE recipe verbatim on existing tooling. The five repos become a replication panel that carries no verdict. Escalation is more tiers/reps, never another corpus. | **Two-way** — content noise widens the CI (opposes), but the HOLDS branch's causal claim ("Stage 2's proof extends") was unsupportable by the design (flatters when it fires). |
| F4 | Four statistical defects: (a) a pure power law with no additive constant biases `b` **downward**; (b) BCa on 5 clusters draws its acceleration from a 5-value jackknife, ~10% of resamples hold ≤2 distinct clusters, and no degenerate-resample handling was registered; (c) `total_index_ms` was never defined — R1 named two clocks and the fit named neither; (d) no reachability arithmetic, where Q1/SCALE published `n_min = 154`. | (a) 10 empty-corpus calibration runs measure `c`; both adjusted and raw fits reported, opposite sides of 1.35 → AMBIGUOUS. (b) BCa withdrawn; primary is OLS + HC3 over 15 points, with a wild cluster bootstrap as a registered sensitivity, disagreement → AMBIGUOUS. (c) `durationMs` fixed as the fitted clock. (d) `σ < 0.47` published as the residual-sd ceiling for HOLDS to be reachable. | **(a) and (b) flatter HOLDS; (c) free lever; (d) risked a predetermined AMBIGUOUS.** |
| F5 | Gate 3's flat 5% clock-agreement rule fires on the *ideal* condition: `startMs` sits inside `runIndex` (`index.ts:173`) so 150–300 ms of process boot is 4–9% of a ~3.5 s T1 run. Remedy "re-take the run" cannot fix a structural offset — outcomes were an infinite loop, a de facto void of the cheapest anchor, or selective retention of fast-boot runs. | Gate becomes `max(5%, 500 ms)`; retakes capped at 2, then logged as a finding; both clocks recorded always. | **Opposes HOLDS** (selective retention would bias the slope up) — and it is the Q1/SCALE Gate-5 class repeating: a gate firing backwards. |
| F6 | R5 imported thresholds across corpus, build, plane and instrument: 1,700 ms where round 1's own field is `wal_checkpoint_outliers_gt_1500ms`; 755 ms taken from a **pre-F11, nest, server-side lock-hold** envelope and applied to **client wall clock of per-call CLI processes**. Rung, denominator, pacing and payload all unregistered; no direction-of-error statement. | Threshold → **1,500 ms**. The 755 ms bound **withdrawn**, replaced by each corpus's own idle baseline (p99 within 2×). T1 **and** T5 both probed, ≥400 scored calls, 250 ms pacing, frozen payload. Reader-lifecycle mismatch registered as a known limit. Direction statement added. | **Flatters retirement** — every free parameter leaned the same way. |
| F7 | E2's three-row table left "one corpus >80%, none in 60–80%" with **no verdict** — a reachable pattern with undefined machinery. | Table reduced to two exhaustive rows (≥60% / <60%). | **Toward the prior** — the gap would have been closed after the data existed. Q1/SCALE AMENDMENT-1 F3 class, repeating. |
| F8 | The seam's denominator excludes calls in nested-scope bodies by design (D7), so callback-heavy code is absent from it and the measured yield **overestimates** coverage of the spec's "real call sites". The registration never said so. | Exclusion registered explicitly; raw `call_expression` count reported alongside visited sites so the excluded region is quantified. | **Opposes UNSUPPORTED** — but the registered quantity was silently not the spec's quantity. |
| F9 | The index config was unpinned — a free lever over `N` itself. Defaults index `.md` and exclude `*.test.ts` but **not** `*.test.js` (`config.ts:39-48`), so the registration's raw-`find` anchor was wrong in both directions. | Config pinned in writing (defaults at this commit, no overrides), resolved config recorded per run, and the `find` figures re-labelled as the wrong anchor rather than a sanity check. | **Free lever, unknown direction.** |
| F10 | R2, R3 and R4 were measured with **no registered interpretation** — R4 with no threshold, no verdict row, and absent from the falsification criteria, its only consumer a post-hoc tuning decision. `b_file`/`b_chunk` disagreement unhandled. Sequencing unregistered: R5's second index overwrites the artifact R3 and E2 read. | A registered reading per supporting row (explicitly descriptive, verdict-free — including R4, where **no threshold is registered because none is justified**); trigger 5 for exponent disagreement; Gate 6 fixes R3/R4/E2-before-R5. | **Free levers.** |
| F11 | Arithmetic audit: `N log N` effective exponent 1.120 ✓, 11.3 KB/chunk ✓, 3.29 ms/file ✓, trigger 1's p = 1/120 ✓ — all reproduced. One wobble: the span is 19,056/1,059 = **18.0×**, not 19, so b=1.35 costs 2.75× (not 2.8×) and b=2 costs 18× (not 19×). The shuffle seed was never printed, where Q1/SCALE printed 153. | Figures corrected; **seed = 811** stated in the registration. | **Trivial, flattered the threshold's rationale** by slightly overstating the pathology. |
| F12 | `parse_errors` recorded-but-ungated was correctly argued, but no consistency trigger existed either: unparseable files consume time and yield zero chunks, so a parse-error rate rising with `N` inflates `ms/chunk` through an unmodelled channel. | Trigger 4: any tier whose parse-error *rate* exceeds 2× the median must be discussed before the verdict is recorded. | **Two-way, most plausibly opposes HOLDS.** |

**Verified and unchanged** (the reviewer attacked these and could not break them): the six
pins are real commits; S1's whale-file hazard is genuinely retired so trigger 2's
`write_errors == 0` is enforceable rather than a deterministic rung-killer; ground-truth
counts from `graph.db` rather than stdout is mechanically correct (`chunksAdded` is counted
pre-write, `index.ts:282`); the "no parse-only product mode" admission is exact
(`index-cmd.ts:12-20`); `mast query` dispatches through the real MCP handlers; the seeded
run-order shuffle; **Gate 0, the D8 binary-identity gate, in full**; chunk count as the
exposure variable; log–log as the estimation scale; trigger 1; Gate 4's WAL rules,
transcribed from the Q6 RESCOPE without drift; and the registered admission that no
non-invasive in-flight backlog probe exists.

#### AMENDMENT 2 — 2026-08-12, pre-run, self-identified

Not from a review. Found while distilling the remaining build work for the project owner,
against the registration as committed at `468d585`, **before any measurement had
occurred** — so, per the same precedent as AMENDMENT 1, the gate was added in place and
this log is the audit trail.

**The defect: no known-answer test on the scorer.** Q1/SCALE's Gate 1 required its
statistical test to be "implemented and unit-tested BEFORE scoring", with named cases,
because `ab-score.mjs` had shipped with its registered Wilcoxon test **never implemented**
(HANDOFF_Q1.md §5). This registration inherited that file's *other* lesson — Gate 5's
working-CLI-entry-point rule, where the same defect class recurred a second time in
`idfuse-score.mjs` — but silently dropped the scorer-test lesson.

| aspect | statement |
|---|---|
| **Change** | New **Gate 7**: six known-answer cases (quadratic → SUPER-LINEAR; linear → HOLDS; linear-plus-constant → adjusted HOLDS with a demonstrably lower raw exponent; independent HC3/bootstrap checks; degenerate inputs must not silently discharge; every verdict-table row exercised). Enforced by `pnpm -F mast test`, since `vitest.config.ts` already includes `eval/**/*.test.mjs`. |
| **Direction the error ran** | **Toward the investigator's prior, on every branch.** An unverified scorer's most likely silent failures — an inability to fire SUPER-LINEAR at all, a sign error on the calibration subtraction (which biases `b` down), or a degenerate input falling through to the discharge row — all land on **O(N) HOLDS**. This is the same asymmetry AMENDMENT 1 found five times. |
| **Why it was missed** | The registration's own banner is "exactly one decision-bearing test per experiment", and attention went to *defining* that test rather than to verifying the code that would evaluate it. The gate that checks the checker is the easiest one to forget and the most expensive to omit. |

**Process note.** AMENDMENT 1's tally recorded three consecutive review rounds in which the
majority of defects flattered the investigator. This one was self-found rather than
review-found, which is a better sign than the alternative — but it was found while
*explaining the work to someone else*, not while writing it, and that is worth recording as
its own lesson about when these defects actually surface.

#### AMENDMENT 3 — 2026-08-12, pre-run, post-second-adversarial-review

Second adversarial design review commissioned per §6 (Agent tool, model `fable`) against
this section as committed at `8bd17f8`, **before any measurement had occurred**. As with
AMENDMENT 1, no data existed, so the registration above was revised **in place** and this
log is the audit trail. Every code claim the reviewer made was **independently verified
against source before being accepted**; the reviewer has been wrong before.

**The finding about the process, stated first because it is the important one: all three
fatal defects were introduced by AMENDMENT 1's repairs.** They are not in `fd46152`. The
review that was supposed to harden the design broke new ground in it — and two of the three
sat inside passages AMENDMENT 1 explicitly certified as "verified and unchanged." Trigger 1
is the sharpest case: the reviewer checked its arithmetic in round 1 (`p = 1/120 ✓`) and
missed that the trigger contradicts the threshold rationale sitting two paragraphs above it.
**Checking a component in isolation is not checking the design.** This is now the fourth
consecutive round in which the majority of defects flattered the investigator, and the first
in which the *repairs* were the vector.

| # | Finding | Change | Direction the error ran |
|---|---|---|---|
| **FATAL-1** | **Trigger 1 contradicted the threshold's own rationale.** Under the `N log N` model used to justify `b = 1.35`, `ms/chunk ∝ log N` and rises **~41%** across the span (`ln 19056 / ln 1059 = 1.415`). Strict monotone increase in `ms/chunk` is therefore the **expected healthy signature** — and trigger 1 called it AMBIGUOUS. The registered escalation (more reps) tightens tier means and makes the monotone ordering *more* likely: an escalation that increases the chance of the outcome being escalated from. The `p = 1/120` exchangeability argument never applied, because `ms/chunk` is not exchangeable across tiers under the fitted model. | Trigger 1 re-derived onto **departure from the fitted law**: classical lack-of-fit `F(7, 18)` at α = 0.05 on the **adjusted** fit (raw reported as descriptive, since its known omitted constant guarantees curvature), **jointly** with a **5% endpoint-departure floor** — benchmarked against the `N log N` term's own **0.69%** curvature, computed and shown. What it detects is now stated: mixtures, not pure power laws. | **Toward AMBIGUOUS** — i.e. "safe rather than informative": a design that discharges nothing while appearing rigorous. Fix-induced. |
| **FATAL-2** | **The ladder's rungs were cut in one unit and stated in another.** Targets read "≈1k / 2k / 5k / 8k / all indexed **files**"; the cut rule read cumulative **chunk** counts; `scale-build-tiers.mjs:36` cuts on chunk targets. Worse: **every published figure** — span 18.0×, `N log N` exponent 1.120, `Sxx ≈ 16.1`, `SE(b) ≈ σ/4.01`, `σ < 0.47` — was computed on the raw-`find` **file** counts that AMENDMENT 1, in the same document, called "the wrong anchor in both directions." | Rungs are now **geometric fractions of realized `C_total`** (`f_i = 20^{−(9−i)/8}`, 20× span, exactly even in `ln N`). All arithmetic re-derived from **geometry** (`Sxx_cluster = 8.414`, `σ_tier < 0.28`, `σ < 0.56`, `b_eff ≈ 1.10`) and the old figures withdrawn. New **Gate 1b** re-derives the whole power analysis from the frozen manifest's realized counts before any scoring, with a 20% geometry tolerance. | **Free lever, and a live incoherence** — the ladder as written could not be built as specified. Fix-induced. |
| **FATAL-3** | **The tier manifest requires a full n8n index build first** — `scale-build-tiers.mjs:3-5` reads a completed `graph.db` for per-file chunk counts. That build appeared in **no gate, no run count, no cost line**, on a harness that imports `../dist/` directly, i.e. carrying D8's exact exposure while sitting outside the D8 gate. It is also a pre-freeze look at a T9-scale timing. | Promoted to **run P0**: under Gates 0 and 1 in full, own manifest entry, **excluded from every fit**, and **the peek is declared** — with the binding mitigation that this amendment (fractions, seed, threshold, estimator, triggers, gates) is committed **before** P0 runs, so the machinery is immutable by the time anything is seen. | **Free lever plus an ungated build** — the peek is of a duration at the ladder's top rung, the most informative single number in the experiment. Fix-induced. |
| MAT-1 | AMENDMENT 1 replaced 5-cluster BCa with a 5-cluster **Rademacher** wild bootstrap — 2⁵ = **32** atoms. One degenerate method for another. CI construction, restricted-vs-unrestricted residuals and the studentization were all unregistered. Separately, HC3 over 15 runs at 5 x-values treats tier-level lack-of-fit as if it shrank with reps, which it does not, so `σ < 0.47` overstated the design's power. | 9 clusters (owner decision); **Webb 6-point weights** (6⁹ ≈ 10.1 M atoms); restricted residuals for testing, unrestricted for the percentile-t CI; studentized with CR1. **Both** reachability ceilings published, with the **cluster-level one named as the honest number** — and the 5-rung counterfactual (`σ_tier < 0.165`) shown, which is the quantitative case for widening. | **Flatters HOLDS** — an overstated power figure makes the discharge branch look reachable when it may not be. |
| MAT-2 | E2 decides on `n = 1`, and the consequence was a mandate: "§10.3.1 must be rescoped or the figure removed." | **Owner decision: keep `n = 1`, soften the consequence.** Sub-60% now registers as **NOT ATTAINED** — "the band is not attained on the closest available Fastify+DI corpus" — evidence for a spec revisit, recorded as a spec-drift *candidate*, **not** a mandate. | **Toward the prior** (mast's own src = 40% already favours a miss); a single out-of-referent corpus cannot carry a spec change. |
| MAT-3 | R5's payload was Q1/SCALE's frozen probes — **vscode-specific** (`supportsTelemetry` in `src/vs/platform/telemetry/common/telemetryUtils.ts`) — aimed at n8n tiers. Absent terms are the cheapest reads the engine performs: FTS5 returns empty early, ranker D never engages. | Payload **derived from the probed corpus's own `graph.db`** (10 declaration names, seed 811, stratified common/rare), committed as `eval/e1r5-queries-<corpus>.json` before the probe. | **Flatters retirement** — it suppresses exactly the contention R5 exists to find. |
| MAT-4 | Falsification said the stall class is PRESENT on "**either** probed corpus"; the verdict table says a split is INDETERMINATE overall. Direct contradiction, introduced when AMENDMENT 1 added the second corpus to one and not the other. | Resolved **in the table's favour** — the table is what gets scored. Falsification now reads "on both probed corpora." | **Free lever** — an unresolved contradiction is resolved after the data by whoever reads it. Fix-induced. |
| MAT-5 | Nothing required scored R5 calls to **overlap write activity**. 400 calls at K = 4 paced 250 ms ≈ 25 s of reader traffic against a single-digit-second T1 pass, so most scored calls would see no writer — diluting the ≥ 1% criterion by the duty cycle. | A call is **scored only if start and end fall strictly inside a writer run**; the writer repeats non-incremental indexes until the count is reached. (Verified benign: `toIndex = currentFiles`, `index.ts:232`, skip gated on `options.incremental` at `:278` — repeat passes are real write load.) | **Flatters retirement**, by roughly the duty cycle. |
| MAT-6 | The "p99 within **2×** idle baseline" clause was derived nowhere and is **vacuous at T9**: idle p99 ≥ 750 ms makes 2× ≥ 1,500 ms, implied by the row's other condition. | Replaced with an **absolute ≤ 250 ms excess** over the corpus's own idle p99 — an order of magnitude below round 1's smallest observed stall (1,700 ms). Direction noted: absolute is *harder* at T9, which opposes retirement. | **Flatters retirement**, and silently so — the clause reads as a second requirement while adding nothing. |
| MAT-7 | Gate 7 exercised E2's and R5's verdict tables but **not E1's** — the only one carrying the headline verdict, and the only one whose AMBIGUOUS row has three independent feeding mechanisms. A scorer keying verdicts off the point estimate rather than the CI bounds passed all six registered cases. Case (c)'s "visibly lower" had no numeric margin. | New case **(g)**: E1's three rows and all three AMBIGUOUS mechanisms, including the **point-estimate killer** (`b̂ < 1.35`, CI upper > 1.35 ⇒ AMBIGUOUS, never HOLDS). New case **(h)**: trigger 1's lack-of-fit test, including the pair that verifies the 5% floor. Case (c) given numbers: adjusted recovers `b = 1.0` within ±0.05, raw at least 0.10 below adjusted. | **Toward HOLDS on every branch** — a point-estimate scorer fails toward HOLDS on exactly the noisy data where the distinction decides the experiment. |
| MAT-8 | `extractFile` takes **no `onCallSite` parameter** (`ast/extract.ts:44-50`); the seam exists only on `extractEdges` (`typescript.ts:1148-1162`). **E2 cannot ride a Gate-0-verified build** — it is an ungated harness pass self-reporting *both* numerator and denominator. R2, a merely descriptive row, had Gate 2; E2's decision-bearing measurement had no fidelity gate at all. | New **Gate 8**: file/chunk/symbol counts must match the Gate-0 build exactly; `edge_emitted` must be **≥** the build's `POTENTIAL_CALL` row count (≥ because edge rows are lossy and deduped — A1-F2); harness import path and `dist/` timestamp recorded. Mismatch **voids E2**. Adding the seam to `extractFile` is explicitly out of scope — a product change to serve a measurement, same reasoning as `--parse-only`. | **Free lever on both terms of a ratio** — the single largest unchecked surface in the registration. |
| MAT-9 | `n8n` was listed as panel rung **P5** *and* as the tier ladder's source, so the replication panel's top point was the ladder's top point. | **P5 dropped.** T9 *is* the full-n8n measurement. Panel = P1–P4 + `nest`, 15 replication runs. (`nest` still appears in both experiments — benign, because the E1 panel carries no verdict.) | **Flatters HOLDS** — the panel's job is to be external, and its heaviest point was internal. |
| C1–C5 | Cosmetics: "each indexed once from cold" survived from `fd46152` against a 3-rep design; the "one registration, shared build" economy was dead post-A1 and post-MAT-8; the live index cited as both 14,605 and 14,610 chunks; "roughly doubles" understated the cost growth; `eval/make-subset.mjs` miscited as tier tooling. | All corrected: the shared-build rationale rewritten to name what *is* actually shared; the two chunk readings reconciled as the same index five chunks apart on 2026-08-11; cost restated in **n8n-index-equivalents** (≈ 13 t, ≈ 2.4× the original) rather than a minutes figure derived from the disavowed anchor; `scale-build-tiers.mjs` named as the tier constructor. | — |

**Verified and unchanged** (attacked and not broken): the pin SHAs; Gate 0 in full; the
`durationMs` fitted clock and the calibration constant `c`; the 1.35 threshold itself, which
both the old and the re-derived rationale place in the same gap; chunk count as the exposure
variable; log–log as the estimation scale; Gate 2's three-count formulation and the reasoning
that removed edge count; Gate 4's WAL rules; Gate 6's ordering constraint; the E2 denominator
caveat (A1-F8) and the `call_expression` mitigation; the R5 reader-lifecycle limitation;
triggers 2, 4 and 5.

**Registered process note, since it now has four data points.** Rounds 1 and 2 of review, plus
the self-found AMENDMENT 2, plus this round: the majority of defects have flattered the
investigator every time. What is new here is that **the repairs were the vector** — three
fatal defects, none present in the original draft. The operational conclusion is not "review
harder"; it is that **a repaired registration is a new registration and inherits none of the
old one's verification.** Re-certifying a passage as "verified and unchanged" while the
passages around it move is precisely how FATAL-1 survived.

### AMENDMENT 4 (2026-08-12) — round-3 review, before any scored run

Commissioned against the shipped harness (`eval/e1-common.mjs`, `e1-p0-build.mjs`,
`e1-build-tiers.mjs`, `e1-stats.mjs`, `e1-score.mjs`, `e1-schedule.mjs`) and the run driver's
design, **after** P0 and the tier cut had run and **before** the first scored run. Every
mechanical claim below was re-verified against source before being accepted; the reviewer's
one over-read (it took R4's design to be a timed `TRUNCATE` curve rather than a passive
reading) is noted and its underlying point kept.

| id | finding | change | direction the error ran |
|---|---|---|---|
| **A4-FATAL-1** | **The verdict table contradicts its own prose on SUPER-LINEAR.** The table's row 2 fires on the **HC3 primary alone**; three separate unconditional sentences say otherwise — adjusted/raw disagreement ⇒ AMBIGUOUS, primary/sensitivity disagreement ⇒ AMBIGUOUS, and trigger 1 "Fires → AMBIGUOUS" — as does the table's own AMBIGUOUS row. Both texts cannot hold. The conflict is **reachable and expected**: a large `c` biases the *raw* exponent **down**, so "adjusted above 1.35, raw straddling" is the **signature of true super-linearity**, not of instability. `combineE1Verdict` had already resolved this in code, without an amendment. | **The table governs.** SUPER-LINEAR fires on the **adjusted HC3 primary's CI lower bound**. Concordant evidence of *different flavours of "not clean O(N)"* — trigger 1's mixture signal, a raw fit dragged down by the omitted constant — is reported as a **qualifier on the verdict**, never as a downgrade. **AMBIGUOUS is for conflicting evidence, not for concordant evidence of different kinds of bad.** Gate 7 gains the untested case `hc3Adj='above'` ∧ `lackOfFitFires` ∧ raw straddling. | **Toward the prior.** Resolving it the other way makes SUPER-LINEAR nearly unreachable on exactly the data pattern super-linearity produces, and routes it into AMBIGUOUS's "add rungs or reps" escalation — i.e. toward never recording a regression. The code's own (undocumented) choice ran *against* the prior; the defect was leaving a documented contradiction to be settled silently by an implementer. |
| **A4-MAT-1** | **The calibration constant is silently optional.** `eval/e1-score.mjs:113` defaults `c = 0`. A driver that forgets to thread `e1-calibration.json` through produces adjusted ≡ raw with no error, and the adjusted/raw protection self-satisfies trivially. Gate 7 case (c) proves the machinery subtracts correctly — but only when `c` is passed, and the production call site is the one seam no test covers. | `c` is **required**; the raw fit passes an explicit sentinel rather than falling through a default. The calibration artifact's path is recorded in the scored output. | **Toward the prior** — this registration's own words: an omitted additive constant biases `b` **downward**. |
| **A4-MAT-2** | **Gate 0 does not survive a resume.** `assertGate0` compares only `schema_version`. A mid-schedule rebuild of `dist/` at an unchanged `1.3.0` — this is an actively developed branch — passes, and the resumed half of the schedule then measures different code than `c` was calibrated on. `newestDistMtime` is insufficient (tsc rewrites only changed outputs). | A **content hash over every `dist/**/*.js`** is recorded in the schedule artifact and re-asserted at **every** start and restart; a mismatch voids the remainder of the schedule pending an explicit re-decision. | **Unknowable for `b`**; it inflates σ, against Gate 1b's whole reachability argument (`σ_tier < 0.282`). |
| **A4-MAT-3** | **Resume censors exactly the runs the experiment exists to detect.** "Skip completed pairs" leaves incomplete attempts no trace. The likeliest interruption is an operator killing a run that *looks hung* — that is, a pathologically slow large-tier run, which is the super-linear signal itself. On restart it silently re-runs, now warmer, and only the faster second attempt enters the fit. | An **attempt-start line is journaled before the spawn**. On resume, a start with no completion is a logged finding and the re-attempt is flagged and counted against the retake cap. An unparseable trailing JSONL line is treated as an incomplete attempt — never as a completed pair. | **Toward the prior** — selective censoring of slow runs biases `b` down. |
| **A4-MAT-4** | **Gate 1's tier clause had no enforcement anywhere.** "Tier file lists match the frozen tier manifest exactly" was registered, but the design verified pins for *panel* corpora only; the tier trees are built once and reused across 27 runs, unchecked. Compounding it, `materialiseTier` **hardlinks**, so the trees alias the n8n worktree's inodes — any in-place mutation during the ~2.3 h window changes tier content mid-schedule, and no tier run asserted the n8n pin. | Every tier run asserts `SELECT path FROM files` from its own `graph.db` equals the frozen manifest's file set exactly, and `file_count` matches. Every tier run also calls `assertCorpusPinned('n8n')`. | **Unknowable** — a polluted tree moves that rung's realized `N` and its time in the same direction, partially self-masking. Most likely surfaces as the rep-identity check firing, i.e. a **false** nondeterminism finding. |
| **A4-MAT-5** | **The scorer omits four registered supporting outputs.** `scoreE1` consumes `{tier, chunk_count, duration_ms}` only — no `file_count`, no `db_bytes`, no `parse_errors` — though `runColdIndex` records all of them. So `b_file` (registered "Both are reported"), trigger 3 (bytes/chunk at T9 vs T1), trigger 4 (parse-error rate, which "**must** be discussed before the verdict is recorded") and trigger 5 (`b_file` vs `b_chunk`) would all be hand-computed post-hoc. | All four **emitted natively**, with Gate-7-style known-answer cases for triggers 3 and 4. | **Toward the prior.** Every one of these exists to force an anomaly to be *confronted* before HOLDS is recorded; omitting them removes tripwires in one direction only. This is HANDOFF §5's `declex-score.mjs` class verbatim — "fix the scorer to emit this contrast natively before reusing the instrument." |
| **A4-MAT-6** | **Retake semantics were unregistered.** Gate 3 caps retakes at 2, but nothing said which take is fitted, or whether a thrice-failing run's data enters the fit at all. Retakes also run seconds after an identical run of the same tier — maximally warm — so replacements are systematically faster than what they replace. | The take that **passes** Gate 3 enters the fit. If all three attempts fail, **the first attempt's data enters the fit** and the failure is logged as a finding — never dropped. Every discarded take is recorded with both clocks; retake counts persist across resumes. | A1-F5's own analysis: selective retention of fast-boot runs biases the slope **up**. Selection in *either* direction is the defect, so nothing is dropped. |
| **A4-MAT-7** | **VOID had no re-run path.** Trigger 2 says "Diagnose, then re-run", but the driver's design recorded a `write_errors` run VOID and continued — correct for not aborting 2.3 h, incomplete as a protocol. A 2-rep tier also breaks the shape of the "three reps report identical `chunk_count`" check and costs pure-error df. | VOID pairs are **not** "completed" for resume purposes and enter a post-schedule re-run queue. The scorer **refuses to fit** a ladder carrying unadjudicated voids. | Mostly variance (toward AMBIGUOUS, against the prior) — but a lost **T9** rep specifically weakens the top of the ladder, which is unknowable. |
| **A4-MAT-8** | **R2 had no implementation plan** — a measured row with no schedule placement, no statement of which artifact Gate 2 compares against, and no cache discipline. This is the A3-FATAL-3 class that P0's promotion exists to fix. | R2 runs **after** the 42 scored runs, over each corpus's **rep-3 file list**, with Gate 2 against that rep's `graph.db` counts. **Registered limitation:** the parse pass runs page-cache warm against a cold full index, so the ratio **understates** the parse share. R2 is descriptive-only and carries no verdict. | **Free lever**, though a small one given R2 is verdict-free. |
| **A4-C1** | **Gate 3's rationale is wrong about `openDatabase`, and contradicts the calibration paragraph.** `startMs` is `runIndex`'s first statement (`indexer/index.ts:173`); `openDatabase` is at `:188` — **inside** the fitted clock, and therefore inside `c`, exactly as the calibration paragraph says. Process boot, commander and `resolveConfig` *are* correctly outside (they run in `cli/index-cmd.ts` before `runIndex`). Separately, the calibration paragraph names `loadIndexMeta`, which `runIndex` never calls (defined `index.ts:497`, uncalled). | Both texts corrected here. **The fitted clock and `c` are unchanged** — the paragraph that governs `c` was already right; only Gate 3's justification prose was wrong, and it was copied verbatim into `eval/e1-schedule.mjs`, which is corrected too. | ~Neutral. Gate 3's clock is a cross-check and never enters the fit. Recorded because it is a second contradiction internal to the immutable text. |
| **A4-C2** | **Gate 3's "~3.5 s T1" premise is stale by ~9×.** Realized T1 is 3,679 chunks; at P0's rate (73,359 chunks / 635,996 ms) that is ≈ 32 s, so the 5% term is ≥ 1.6 s at every rung and **the 500 ms floor is inert across all 42 runs.** | The floor **stays registered** — removing a gate term because this particular ladder happens not to need it would be tuning — but is recorded as inert, so no later reader mistakes it for load-bearing. | Neutral; a live-but-unnecessary safeguard. |
| **A4-C3** | **R4's boundary reading is structurally zero in this topology.** `graph.db-wal` is 0 bytes after P0: the one-shot CLI drains the WAL at process exit. A per-rung curve of ~0 ms reads as "checkpointing is free at scale". | Readings are recorded and **labelled structurally zero in the artifact itself**, so the R4 curve cannot be quoted as evidence about `mast serve`'s checkpoint behaviour. | **Toward the adjacent prior** — the number the deferred `wal_autocheckpoint` decision (Q6 RESCOPE item 4) is registered to consume is exactly the one this would fake. |
| **A4-C4** | **Instrument hygiene, four items.** The child process inherits the parent environment unpinned and unrecorded (`NODE_OPTIONS` — heap size, `--inspect` — would silently change performance); node version unrecorded; `mast index` never persists the resolved config the way `init` does, so "the resolved config recorded in every run manifest" was unsatisfied; child **stderr is discarded**, though parse-error *file names* go there (`index.ts:286`) while the record keeps only the count — and reps 1–2's state dirs are deleted, so diagnosis would have no file list. | All recorded per run: `process.version`, a stripped-and-recorded `NODE_OPTIONS`, the Gate-0 build's own `resolveConfig` output, a stderr tail. `MAST_STATE_DIR` asserted unset and no `mast.config.json` in any corpus root (verified across all six worktrees). | Unknowable; hygiene, but trigger 4 is undiagnosable without the stderr tail. |
| **A4-C5** | Tier trees contain **only chunk-bearing files**, so their walk/stat cost scales with rung size where a real corpus pays a corpus-constant walk over all entries. | Recorded. Uniform across rungs ⇒ **no slope bias within the ladder**; mildly dilutive toward `b = 1`, and the walk is ≲1% of a run. Extends `e1-tiers.json`'s logged deviation, which covered zero-chunk *indexed* files only, not never-indexed directory entries. | Mildly **toward the prior**, immaterial at this magnitude. |
| **A4-C6** | **Nesting makes every scored run content-warm** — all tiers share inodes with each other and with P0's build. | Recorded, not corrected: the experiment measures warm-cache indexing, **uniformly**, which is a scope statement rather than a defect. Residual: larger tiers' marginal files are touched by fewer prior runs, pointing `b` slightly **up**. | **Against** the prior, immaterial while n8n's sources fit in RAM. |

#### A4-C2 CORRECTED ON FIRST CONTACT (2026-08-12, after scored run 1 of 42)

**A4-C2 is wrong and is withdrawn.** It claimed the `max(5%, 500 ms)` gate's 500 ms floor is
"inert across all 42 runs", on the reasoning that realized T1 is 3,679 chunks and therefore
≈32 s at P0's rate, making the 5% term ≥1.6 s everywhere. The first scored run falsifies it:

| | measured |
|---|---|
| T2 (5,332 chunks) fitted clock | **8,908 ms**, not the ≈28 s the extrapolation implies |
| 5% term at T2 | **445 ms** — *below* the 500 ms floor, so the floor is what binds |
| external − fitted, three attempts | **887 / 794 / 561 ms** — Gate 3 failed all three |
| ms per chunk | **1.671 at T2** vs **8.670 at P0/T9** |

**The error was circular, and worth naming precisely.** I sized the gate by extrapolating T1
from P0's *mean* per-chunk cost — which assumes cost per chunk is constant, i.e. assumes
`b = 1`, i.e. assumes the hypothesis under test. Using the null to calibrate an instrument
meant to test the null is exactly the move this registration exists to prevent, and I made it
in the amendment that was correcting other people's version of the same mistake.

**Gate 3 itself is UNCHANGED**, and that is the point. The floor is load-bearing at the bottom
of the ladder, precisely as A1-F5 argued and contrary to my note; the run's data is retained
(first attempt, per A4-MAT-6), and the failure is logged as a finding rather than retaken away.
Moving a threshold on first contact with the data is tuning, and it is forbidden here whichever
direction it would move.

**A4-MAT-6 is confirmed load-bearing by the same run.** The three attempts came in at 8,908 /
6,861 / 6,264 ms — the third is **30% faster than the first**, purely from page-cache warmth.
Had the rule retained the last (or a passing) attempt rather than the first, small-tier totals
would have been recorded ~30% low, steepening the ladder and biasing `b` **up**. The registered
rule keeps the coldest take.

**Direction of the A4-C2 error:** it would have led a later reader to dismiss a live gate as
decorative. Unknowable for `b` directly; corrosive to the gate's standing.

**Not a result, and not to be read as one.** The two-point ms/chunk contrast above spans P0
(excluded from every fit by construction) and a single unreplicated run, with no calibration
subtraction and no controls. It is recorded because refusing to write down an inconvenient
number one has already seen is its own defect — not because it bears on the verdict. The
verdict comes from 27 scored runs through the committed scorer, or it does not come at all.

**Gate 5 addendum.** `eval/e1-run.mjs`, the run-manifest schema, `eval/results/e1-schedule.json`
and `eval/results/e1-calibration.json` are committed **before scored run 1** — the standard
P0 already met (AMENDMENT 3 committed at `b357071` before the peek).

**Verified and unchanged** (attacked and not broken): the threshold 1.35; seed 811; the rung
fractions and the frozen manifest; Gate 1b's realized arithmetic, independently recomputed
(span 19.94×, `Sxx_cluster = 8.398`, rungs within 0.8% of target); the estimators — OLS, HC3,
CR1, Webb-weight bootstrap with restricted-residual testing and unrestricted percentile-t CI,
and the lack-of-fit F with its 5% floor; every degenerate-input guard, all of which fail *away*
from HOLDS; `chunk_count` as the exposure variable; the fitted clock's identity; Gate 0's
schema-version check (**extended** by A4-MAT-2, not replaced); the hardlink mechanism itself
(fast-glob with `followSymbolicLinks: false`, no `.gitignore` read, sorted deterministic walk,
`--state-dir` outranking every config source so nothing writes into a corpus); tree-sitter
grammar loading, which happens at module require and is therefore in neither the fitted clock
nor `c`; `retainStateDir`'s keying on repetition number; the E2 and R5 verdict tables; Gate 8.

**Registered process note, now five data points.** New this round: **two of the three most
serious findings were contradictions internal to this registration, not defects in the code** —
the verdict table against its own prose, and Gate 3's rationale against the calibration
paragraph. AMENDMENT 3's lesson was that repairs are a vector. This round's is narrower and
sharper: **a document amended three times accumulates internal inconsistency faster than it
accumulates errors, and the code is where those inconsistencies finally have to be resolved.**
Resolving one in code without an amendment — which is precisely what `combineE1Verdict` did,
and it happened to resolve it *correctly* — converts a documented contradiction into an
undocumented choice, and the next reader has no way to tell which it was.

#### E1 RESULT (2026-08-12) — SUPER-LINEAR REGRESSION: `b = 1.75`, and the upper half of the ladder is near-quadratic

**Verdict: SUPER-LINEAR REGRESSION.** The registered table's row 2 fires: the adjusted HC3
primary's 95% CI **lower** bound is 1.660, above the 1.35 threshold. Qualifier:
`lack_of_fit_mixture`.

The verdict is not marginal, and it is not reached through any of the disagreement routes
that would have made it AMBIGUOUS. All four registered classifications land on the same
side:

| fit | `b` | HC3 95% CI | wild-cluster bootstrap-t 95% CI | class |
|---|---|---|---|---|
| adjusted (`durationMs − c`) — **primary** | **1.7529** | **[1.6599, 1.8458]** | [1.5943, 1.9122] | above |
| raw (`durationMs`) | 1.7504 | [1.6573, 1.8435] | [1.5888, 1.9128] | above |

`c = 23.5 ms` (median of 10 empty-corpus runs). n = 27 tier runs over 9 tiers, df = 25,
`t₀.₉₇₅,₂₅ = 2.060`, bootstrap B = 10,000, seed 811, Webb 6-point weights, restricted
residuals for the test and unrestricted for the percentile-t CI. Adjusted and raw agree;
primary and sensitivity agree; `c` is small enough here that it moves `b` by 0.0025, so the
whole adjusted/raw protection is inert on this data rather than load-bearing.

**HOLDS was arithmetically reachable, and it was rejected.** This is the point of Gate 1b's
committed ceilings, and it is the difference between a measurement and an underpowered
shrug:

| level | realized σ | Gate 1b ceiling | |
|---|---|---|---|
| cluster (9 tier means about the line) — **the honest number** | 0.1851 | 0.28188 | within |
| run (27 runs about the line) | 0.2349 | 0.56055 | within |

**The shape, which the single exponent flattens.** Cost per chunk rises **10.2×** end to
end across a 20× corpus — this is the finding, and it is visible without any fit. It is
**not monotone**: T2 (1.167) exceeds T3 (0.926), because T2 was slot 1 of the whole schedule
and its Gate-3-failing first take is the coldest measurement in the ladder. The rise is
monotone from T3 upward.

| tier | chunks | files | reps (ms) | median | ms/chunk |
|---|---|---|---|---|---|
| T1 | 3,679 | 656 | 2,639 / 2,575 / 2,702 | 2,639 | 0.717 |
| T2 | 5,332 | 954 | 8,908 / 4,139 / 6,223 | 6,223 | 1.167 |
| T3 | 7,761 | 1,393 | 7,534 / 7,159 / 7,184 | 7,184 | 0.926 |
| T4 | 11,278 | 1,986 | 12,981 / 13,240 / 14,243 | 13,240 | 1.174 |
| T5 | 16,529 | 2,880 | 26,960 / 37,478 / 26,154 | 26,960 | 1.631 |
| T6 | 23,854 | 4,191 | 55,321 / 59,244 / 104,531 | 59,244 | 2.484 |
| T7 | 34,691 | 5,976 | 104,164 / 116,759 / 109,112 | 109,112 | 3.145 |
| T8 | 50,299 | 8,945 | 271,563 / 241,165 / 222,538 | 241,165 | 4.795 |
| T9 | 73,359 | 13,330 | 538,591 / 540,559 / 493,134 | 538,591 | 7.342 |

The lack-of-fit F fires (`F = 2.804`, `p = 0.0368`, df 7/18, departure **17.4%**, above the
5% practical floor), and the reason is curvature rather than noise: **`b` = 1.362 over
T1–T4 and 1.904 over T3–T9.** The upper half of the ladder is close to quadratic. A single
`b = 1.75` is therefore a *summary of a mixture*, and per A4-FATAL-1 this is reported as a
qualifier on SUPER-LINEAR — concordant evidence of a different flavour of not-clean-O(N) —
never as a downgrade to AMBIGUOUS.

**Supporting outputs.** `b_file = 1.7558`, within 0.003 of `b_chunk`, so trigger 5 does not
fire and the exposure choice is not doing any work here. Trigger 3 does not fire: bytes per
chunk is **flat** (5,863 at T1 vs 5,986 at T9, ratio 1.021) — the regression is in **time,
not space**, which rules out per-row storage bloat as the mechanism. Trigger 4 does not fire
(zero parse errors at every tier).

**Replication panel — supporting only, and it does not reproduce the exponent.** Fitted the
same way over 5 corpora × 3 reps: `b = 1.2790`, HC3 CI [0.9471, 1.6110], straddling 1.35.
It carries no verdict, and the registration said in advance why: content confounds scale
across unrelated repos. This data shows exactly that confound at full strength — P1 costs
**4.712 ms/chunk at 8,413 chunks** where the nested T3 costs **0.926 ms/chunk at 7,761
chunks**, a 5× per-chunk spread between corpora of near-identical size. A cross-corpus fit
is measuring content, which is the whole reason the decision-bearing axis is nested.

**Two Gate 3 findings, handled as registered.** T2#1 and T2#3 failed the clock-agreement
gate on all three attempts (final-attempt deltas 561 ms and 513 ms against a 500 ms floor).
Per A4-MAT-6 the **first** attempt's data enters the fit and the failure is logged, never
retaken away. Both are recorded in `e1-verdict.json` as `driver_findings`. The gate polices
the external cross-check clock, which never enters the fit; the excess is process boot, and
at T2's scale it is ~10% of a small run. Note that `gate3` on a thrice-failing run record is
the **last** attempt's verdict while `duration_ms` is the **first** attempt's value — the
registered combination, with every attempt preserved in `gate3_attempts`, but the two fields
do not correspond and a reader must not divide one by the other.

**A driver-flag discrepancy, resolved toward the registration.** `e1-run.mjs` sets
`scoreable: false` whenever `findings.length > 0`, which is stricter than anything
registered: A4-MAT-6 says a thrice-failing Gate 3 run is *logged and retained*, so this
class of finding was never a scoring blocker. The registered blockers — VOID runs (trigger
2) and chunk-count nondeterminism — did not fire: 42/42 complete, 0 void, and all three
repetitions of all 14 corpora reported identical `chunk_count`. Scoring proceeded on the
registered rule, and the flag is left as-is rather than edited after seeing data.

**A correction to an investigator claim made before this scoring ran.** During the run I
reported that "three corpora exceed Gate 1b's `σ_tier < 0.282` ceiling" (T2 0.384, P1 0.375,
T6 0.349). **That comparison was invalid** — those figures are the *within*-corpus sd of
three repetitions, and the ceiling governs the *between*-tier residual sd of the 9 tier means
about the fitted line. They are different quantities: repetition spread inflates the run
level and, where symmetric about the tier mean, leaves the cluster level untouched entirely.
The realized cluster σ is 0.1851, comfortably inside the ceiling. The mistake is pinned by a
test (`eval/__tests__/e1-report.test.mjs`, "separates within-tier spread from between-tier
departure") so it cannot recur silently. The largest repetition spreads (T6's 55.3 / 59.2 /
104.5 s, T2's 8.9 / 4.1 / 6.2 s) are still worth naming, but against no registered ceiling.

**What this means, stated no more strongly than the data supports.** M1's O(N) claim does
**not** extend from ~5k files to T9. Stage 2's regression proof is a proof at its own scale
and nothing beyond it, and Stage 2 reopens as a scale defect. The mechanism is not
identified here: E1 measures the exponent, not its cause, and flat bytes-per-chunk only
rules out storage bloat. Locating it — FTS5 index maintenance whose cost grows with existing
index size, the graph edge-resolution pass, or the write path — is separate work, and R2
(the parse-only pass) is the registered first cut at splitting parse cost from write cost.

##### E1 RESULTS REVIEW (2026-08-12) — the verdict survives; one registration violation found, running toward HOLDS

An adversarial results review was commissioned per §6 and its claims verified against source
and recomputed from `e1-runs.jsonl` (the ceremony's requirement — the reviewer has been wrong
before, and on the Q1/DECLEX round it over-read a design). **Every load-bearing claim it made
reproduced exactly.** Its judgement: SUPER-LINEAR survives every sensitivity it could
construct. The following amend this RESULT.

**R1 — a registration violation, and it is mine.** A4-MAT-3 requires an orphaned
attempt-start to be *"a logged finding"* whose re-attempt is *"counted against the retake
cap"*. Neither happened. The E1 schedule was interrupted **twice, both times on T9** — an
attempt started `21:38:21Z` and re-started `21:46:52Z`, another started `22:13:43Z` and
re-started `22:15:39Z` — and this RESULT's first version asserted "42/42 complete, 0 void"
with no trace of either. The defect was deeper than a missing `findings.push`: `loadJournal`
deleted a pair's pending start the moment the pair completed, so an interruption followed by
a *successful* re-attempt — exactly what happened — left no orphan to report at all. **This
is the precise scenario A4-MAT-3 was written to catch**, occurring twice, invisible to the
instrument written to catch it.

*Direction of error:* **toward HOLDS.** Warm re-runs censoring slow top-rung evidence biases
`b` down. It did not materialize — the two re-run T9 reps are **538,591 and 540,559 ms
against the uninterrupted rep's 493,134 ms**, i.e. the interrupted reps are the *slowest* of
the three. Fixed at the instrument, not just in prose: `orphanedAttempts` and
`remainingAttempts` in `eval/e1-schedule.mjs` with five tests, wired into `loadJournal`,
`summarise` and the retake budget. `e1-runs-summary.json` and `e1-verdict.json` regenerated
and now carry both `INTERRUPTED` findings.

**R3 — the panel scopes the claim as well as supporting it, and only one direction was
quoted.** The omitted contrast is the more informative one: **P4 indexes 93,518 chunks —
*more than T9* — at 2.97 ms/chunk (median 277,944 ms) against T9's 7.34.** That kills the
machine-artifact family of explanations outright (thermal accumulation, disk fill, hardlink
warmth, schedule position could not produce a slow T9 and a fast, larger P4 on the same box
in the same session), and it simultaneously bounds the finding: **7.34 ms/chunk is not a
universal function of chunk count.** T9 carries 51,551 symbols and 48,497 edges against P4's
17,987 and 11,820 — ~2.9× and ~4.1× — so the cost tracks symbol and edge density, not chunks
alone. "Stage 2 reopens as a scale defect" must not be read as "every 90k-chunk corpus costs
9 minutes."

**R4 — retake-retention sensitivity, quantified.** A4-MAT-6 fits the take that *passes* Gate
3, which on two runs was a warmer retake (T1#1 3,266→2,639; T3#2 7,299→7,159; T3#3 went the
other way). Refitting on **first attempts everywhere gives `b` = 1.7410, CI [1.6415,
1.8404]** — the registered rule contributes +0.012, and the lower bound clears 1.35 either
way.

**R2, R7 — two anomalies named plainly.** The ms/chunk rise is not monotone (corrected
above). **T6#3 = 104,531 ms is a 76% spike** over its siblings (55,321 / 59,244), run warm
immediately after T6#2, so cache warmth cannot explain it and nothing else is offered. It is
unexplained, not merely "spread worth naming". Dropping T6 entirely gives `b` = 1.7478.

**R5 — provenance, stated precisely.** Only the verdict machinery was pre-committed:
`scoreE1` at `4b49bc1`, ~65 minutes before scored run 1. The **reporting seam**
(`eval/e1-report.mjs`) was written after the data existed, at `227cf17`. On this journal it
had no discretion to exercise — 42 unique `(corpus, rep)` records, exactly 27 tier runs, no
voids — and the reviewer reproduced the selection and every downstream number independently.
Recorded anyway, because "it happened not to matter" is a finding about this dataset, not
about the instrument.

**R6 — the lack-of-fit p is nominal.** df 7/18 is correct, but the F pools pure error across
tiers whose within-tier `sd(ln)` spans 0.024 (T1) to 0.384 (T2); under that
heteroscedasticity `p = 0.0368` is approximate. The mixture qualifier does not rest on it —
the split-half slopes (1.362 / 1.904) and the 17.4% departure carry it.

**Sensitivities, all verified by recomputation from the journal.** Drop T2 → **1.8045**
[1.7194, 1.8896]; drop T6 → 1.7478; drop both → 1.7998; first-attempts-everywhere → 1.7410;
`c` ∈ {21, 48.9, 180} → 1.7526 / 1.7555 / 1.7696; cluster-mean fit at df = 7 → [1.602,
1.904]; an independently implemented Webb bootstrap with a different RNG → [1.602, 1.911]
against the harness's [1.594, 1.912]. **`corr(ln chunks, schedule position) = 0.0015`** over
the 27 tier runs, so the shuffle did its job; a real warming drift exists (residual-vs-slot
`r` = −0.36) but is orthogonal to size, and adding slot as a covariate moves `b` by 0.0001.
Symbols scale as `chunks^0.993`, edges `^1.080`, potential calls `^1.116` — near-linear, so
the time exponent is not smuggled in through a structural count.

**The three concrete biases actually present in this data all run toward HOLDS** — T2's
retained coldest first-takes, the warm T9 re-runs after interruption, and T9's exclusion of
the 655 zero-chunk files (logged in the frozen manifest). The verdict cleared 1.35 anyway,
on every estimator and every sensitivity constructed against it.

**Artifacts.** `eval/results/e1-verdict.json` (verdict, both fits, panel, triggers,
reachability), `eval/results/e1-runs.jsonl` (42 runs + 55 attempt records),
`eval/results/e1-runs-summary.json`, `eval/results/e1-calibration.json`,
`eval/results/e1-tiers.json` (frozen manifest + Gate 1b arithmetic). Scored by
`eval/e1-report.mjs` through `scoreE1`, which was committed at `4b49bc1` before scored run 1
and is pinned by 56 known-answer cases.

### E1-PHASE PRE-REGISTRATION (2026-08-12) — which phase carries E1's exponent

**Status: registered, not yet run.** Committed before any scored run, per §6.

**This is a diagnostic, not a verdict experiment.** It cannot confirm, overturn or soften
E1's SUPER-LINEAR verdict, and no result here may be reported as doing so. E1 answered *how
steeply* cost grows; this answers *where the time goes*, which E1 could not, because
`runIndex` recorded only `durationMs` and its 42 runs are therefore undecomposable after the
fact. The output is a localisation, and its consumer is the choice of what to fix.

#### The question

E1 measured `b = 1.7529` over the nested ladder, `1.904` over T3–T9, while the work items
themselves grow near-linearly (symbols `chunks^0.993`, edges `^1.080`, potential calls
`^1.116`). So cost **per work item** grows with accumulated index size. Which phase?

#### Design

**Five rungs from the frozen E1 manifest — T1, T3, T5, T7, T9 — 3 repetitions each, 15
runs.** These are every other rung of the 9-rung ladder, so they remain **exactly evenly
spaced in `ln N`**: `d = ln(19.94)/4 = 0.7482`, `Σ_{k=−2}^{2} k² = 10`, giving
`Sxx_cluster = 5.598` and `Sxx_run = 16.79`. Chunk counts are fixed by the frozen manifest
at 3,679 / 7,761 / 16,529 / 34,691 / 73,359. Estimated machine time from E1's medians:
~11.4 min per repetition, **~35 min total**.

Everything else is inherited from E1 unchanged and must not be re-derived: the frozen tier
manifest, seed 811, the seeded-shuffle run order, cold-start discipline (fresh state dir per
run, never `--incremental`), per-`(corpus, rep)` state dirs, `assertCorpusPinned('n8n')` on
every tier run, `assertTierFileSet`, Gate 3's `max(5%, 500 ms)` clock rule with its retake
cap, and A4-MAT-6's first-attempt retention.

**The measured quantity is the per-phase exponent** `b_phase`, from OLS of
`ln(phase_ms)` on `ln(chunk_count)` across the 15 runs, plus each phase's **share of
`durationMs` at T9**. Both are reported for all five phases. HC3 SEs are reported;
**no threshold is registered and no verdict fires** — this instrument classifies, it does
not adjudicate.

**A free confirmatory signal, registered as such:** these 15 runs also yield a total-clock
exponent on a **different binary** from the one E1 measured (phase timers were added at
`c71d59c`). It is reported as a mini-replication of E1's 1.75. It is **not** a re-test of
the verdict — 5 rungs is a weaker design than 9 — and a discrepancy would be a finding about
the *instrument*, not about `b`.

#### Hypotheses and what each predicts, stated before the data

| | mechanism | prediction |
|---|---|---|
| **H1** | Page-cache cliff: 11 B-tree indices maintained during bulk insert (`graph/db.ts:288–350`) against a database reaching ~440 MB, with SQLite's default ~2 MB page cache and no `cache_size`/`mmap_size` pragma set (`db.ts:370–385`). *(⚠️ the "~2 MB" is WRONG — it is ~16 MB; see CORRECTION 2026-08-13. H1's decision conditions are purely numeric and are unaffected.)* | `b_write ≥ 1.6` **and** `b_parse ≤ 1.25` **and** write's share of `durationMs` at T9 `≥ 60%` |
| **H2** | Call/symbol resolution: pass 2's edge insertion scales with candidate sets that grow with the corpus. | `b_edges ≥ 1.6` **and** edges' share of `durationMs` rises monotonically T1→T9 |
| **H3** | Parse itself: tree-sitter cost growing faster than linearly in content. | `b_parse ≥ 1.6` |
| **H4** | Diffuse — no single phase carries it. | no phase reaches `b ≥ 1.6` |
| **H0** | **Residual, registered so the set is exhaustive:** all of H1–H4 refuted. Reachable — e.g. `b_write = 3.0` at a 45% T9 share refutes H1 on the share condition while write carries the entire exponent, and refutes H4 because a phase did reach 1.6. | outcome is **"localised, unclassified"**: report every exponent and share, adjudicate nothing, escalate exactly as H4 |

H1 and H2 are not exclusive; both may fire, and that is a reportable outcome rather than an
ambiguity to be resolved by choosing one.

**What a confirmed H1 does and does not license.** It confirms **write-localised,
size-coupled super-linearity** and nothing narrower. Chunks and database bytes are perfectly
collinear across this ladder, so this instrument **cannot distinguish** a page-cache cliff
from FTS5 trigram segment merges, per-file transaction overhead, or B-tree depth growth. Any
report calling a confirmed H1 "the page-cache cliff" is over-reading it. The mechanism
discriminator is registered here so it cannot be improvised later: **a `cache_size` /
`mmap_size` A/B at a single rung, run AFTER this diagnostic and BEFORE any shipped fix.**
That is a probe, not a remedy, and so does not breach "no fix before diagnosis".

**A fact that already damages H1's mechanism story, recorded before the run.** T1's database
is **21.6 MB** — already ~10× SQLite's ~2 MB default page cache — while the knee E1 measured
sits at T4/T5 (66 → 95 MB). A 2 MB cache is exhausted before the ladder begins, so it cannot
produce a knee there. *(⚠️ **WITHDRAWN 2026-08-13** — the default is ~16 MB, not ~2 MB, so
T1 is 1.3× the cache and this argument does not hold. See `CORRECTION (2026-08-13)` after the
E1-PHASE RESULTS REVIEW. Left standing as the historical record per §6.)* H1's *location* claim (write-localised) survives; H1's *mechanism*
claim as originally stated does not follow from the evidence I cited for it.

**Direction-of-error statement (mandatory field).** **My prior is H1** — I proposed it and
have not tested it, so every free parameter here leans toward finding it. **The compensation
I first claimed was largely theatre, and is corrected rather than defended.** Because the
phases tile `durationMs`, the total slope is share-weighted: `b_total = Σ share_i · b_i`. Given
E1's T3–T9 slope of 1.904, `b_parse ≤ 1.25` is near-automatic *a priori* (symbols scale
`^0.993`, edges `^1.080`, bytes/chunk flat), and once the share condition holds, `b_write ≥ 1.6`
follows arithmetically — at a 60% share with parse at 1.25 and the rest linear,
`b_write ≈ 2.38`. **Exactly one substantive free condition remains: write's T9 share ≥ 60%.**
The other two are consistency checks, not independent hurdles, and are reported as such.
Condition counts, corrected: H1 needs 3 (one substantive), **H2 needs 2**, H3 and H4 need 1.
The 1.6 bar sits below E1's measured 1.75 so a phase carrying the exponent is not narrowly
missed, and it is the same bar for every hypothesis.

#### Gates

- **Gate 0** — binary identity: `dist` content hash and `schema_version` recorded and
  re-asserted at every start and restart. The binary **has changed** since E1 (`c71d59c`), so
  `c` is re-calibrated from 10 empty-corpus runs; E1's `c = 23.5 ms` is **not** reused.
- **Gate 1** — corpus integrity: n8n pin re-asserted per run; each run's `SELECT path FROM
  files` equals the frozen manifest's file set for its tier, exactly.
- **Gate 3** — both clocks recorded, `max(5%, 500 ms)`, retakes capped at 2 then logged, and
  orphaned attempts charged against that cap (A4-MAT-3, implemented at `3f7b1fa`).
- **Gate P (new)** — **attribution**: on every scored run, `Σ phase_ms ≥ 0.95 × durationMs`.
  A run below that is VOID pending diagnosis, and joins A4-MAT-7's re-run queue.

  *Re-anchored on a measurement (design review P8).* The first draft set 90% on the strength
  of a one-file 22 ms smoke run, whose ~7 `Date.now()` stamps are quantization-dominated and
  could not distinguish 96% attribution from 80%. `eval/e1-phase-attribution.mjs` ran the
  real T1 rung three times: **attribution 99.91 / 99.93 / 99.93%**, remainder 3 / 2 / 2 ms.
  The floor is 95% — beneath the worst observation with ~5 points of headroom — and it stays
  permissive on purpose: the remainder is `db.destroy()`'s WAL close-time checkpoint, which
  is genuinely size-coupled, and a tight floor would VOID T9 for exhibiting the very growth
  the experiment is looking for. **The remainder is therefore policed as a FINDING, not a
  gate: a remainder share above 2% at any rung is reported and discussed** — T1's is 0.09%,
  so 2% is a 20× rise, not a tolerance.
- **Walk-share void condition, re-anchored the same way**: `walk` measured **1.27–1.47%** of
  `durationMs` at T1, so the registered 10%-at-T9 tripwire is generous and correctly aimed
  rather than arbitrary. Unchanged.

**Declared peek (P0 precedent).** The attribution runs above are T1 rung measurements taken
*after* this registration was committed at `36c2f5a` but *before* the scored runs, and they
necessarily revealed T1's phase shares. The mitigation is ordering, and it is already
discharged: every threshold these numbers could tune — the 1.6 exponent bar, `b_parse ≤ 1.25`,
**and the 60% write-share condition** — was committed at `36c2f5a`, before the measurement
existed. The three runs are excluded from every E1-PHASE fit and from the run count; they are
gate calibration, not measurement, and `eval/results/e1-phase-attribution.json` records them
in full so the peek is auditable rather than merely asserted.
- **Gate P2** — **rep identity**: as in E1, a tier's three repetitions must report identical
  `chunk_count`; disagreement voids that tier.

#### Falsification criteria

- **H1 is refuted** if any of: `b_write < 1.6`, `b_parse > 1.25`, or write's T9 share `< 60%`.
- **H2 is refuted** if `b_edges < 1.6` or edges' share does not rise monotonically.
- **H3 is refuted** if `b_parse < 1.6`.
- **The whole instrument is void** if Gate P fails on any scored run, or if `walk` — a fixed
  cost that dominated the one-file smoke run at 11 of 22 ms — exceeds **10%** of `durationMs`
  at T9, which would mean the phase split is mis-drawn and the fit is measuring startup.
- **If H4 or H0 holds**, the next step is *not* another ladder: it is statement-level
  profiling inside the highest-share phase, and this registration says so now so that a
  diffuse or unclassified result is not quietly re-analysed into a localisation.

#### Estimator and aggregation rules, registered so nothing is chosen after the data

Every clause here closes a lever the first draft left open. The precedent is four
consecutive rounds in which the unregistered choice was later resolved toward the prior
(A4-FATAL-1, A4-MAT-1, A4-MAT-6).

- **Comparisons are on HC3 point estimates.** SEs and CIs are reported for context and have
  **no role in any refutation**. At 5 rungs a cluster-level 95% CI is roughly ±0.22 even at
  E1's realized `σ_tier = 0.185`, so permitting "the CI touches 1.6" would make every
  condition negotiable after the fact.
- **"Share at T9" is computed from T9's median run**, by `phase_ms / durationMs`. Not the
  mean, not a pooled ratio-of-sums.
- **H2's monotonicity is strict, on per-tier median shares, across all five rungs.** A tie
  breaks it.
- **`ln(0)` is not permitted:** any scored run with a null `phase_ms` (a binary predating
  `c71d59c`) or any phase `≤ 0` is **VOID**, never silently dropped. `parsePhaseMs` returns
  null by design so the harness can still read E1's own history; on an E1-PHASE scored run
  that null is a defect.
- **A Gate P or Gate P2 VOID joins A4-MAT-7's re-run queue**, whose semantics apply
  unchanged; it is not an excuse to fit around the gap.
- **The unattributed remainder** (`durationMs − Σ phase_ms`) is fitted and reported as a
  sixth series with its T9 share. Its registered reading is **"teardown, including WAL's
  close-time checkpoint"** — `db.destroy()` (`index.ts:445`) runs after the `finalise` stamp
  (`:443`) and before `durationMs` (`:459`), making it the one size-coupled cost outside
  every phase. Reported rather than tolerated as slack, because Gate P's 10% tolerance is
  ~54 s at T9 and unattributed time is exactly where the mechanism could hide.
- **The mini-replication is fitted with E1's own registered estimator** (adjusted clock,
  OLS + HC3) and is **"consistent" iff its 95% CI covers 1.7529**. Anything else is logged as
  an instrument finding and adjudicates nothing in either direction — it may not soften E1
  and may not be claimed as strengthening it.
- **The "no threshold, no verdict" sentence above governs the HYPOTHESIS SET, not the gates.**
  H1–H4 are classifications with registered refutation conditions; none of them is a verdict
  on MAST's scaling, which E1 alone carries.

#### What is deliberately NOT done

No fix is applied and no pragma is changed before this runs. Measuring the current binary is
the point; changing `cache_size` first would confound the diagnosis with the remedy. Any fix
that follows is verified by re-running **E1's full 9-rung registered ladder** against the
committed scorer and the immutable 1.35 threshold — not by re-running this diagnostic, and
never by moving a threshold.

#### ADDENDUM (2026-08-12, written while building the instrument, BEFORE any scored run)

Building `eval/e1-phase-run.mjs` surfaced six choices the registration above does not fix.
Each is an unregistered lever, and this program's own record says an unregistered lever gets
resolved toward the investigator's prior (A4-FATAL-1, A4-MAT-1, A4-MAT-6, four rounds
running). They are therefore closed here, in writing, before the instrument is run — not
defended afterwards. **No threshold in the registration moves; these are readings of it.**

1. **"T9's median run" is the run with the median `duration_ms`** among that rung's three.
   Three repetitions is odd, so the median run is unique and no averaging occurs. Not the
   mean and not a pooled ratio-of-sums, both of which the registration already excludes.
2. **"Per-tier median share" (H2's monotonicity input) is the median of the rung's three
   per-run shares** — a different statistic from item 1, which is why `tierShares` publishes
   **both** readings at every rung (`median_run` and `median_of_shares`). Publishing one
   would leave the choice between them available after the data arrived.
3. **H4 is evaluated over the five phases only.** The remainder is not a phase. If the
   remainder alone reached the 1.6 bar while no phase did, H4 still fires exactly as
   registered, and the remainder's exponent is reported beside it as a finding rather than
   folded into the classification.
4. **A non-positive remainder at any rung makes the sixth series unfittable**, reported as
   `degenerate: non_positive_values` plus a finding. It is neither dropped nor a VOID: the
   registered `ln(0)` VOID governs *phases*, and widening it to the remainder would let
   millisecond rounding at T1 void an entire rung.
5. **Gate P is evaluated on the FITTED attempt**, after `selectFitted` — the run that will
   actually be scored, not the last one spawned. Checking the last attempt would let a
   thrice-failing pair pass Gate P on a decomposition that never enters the fit.
6. **`scoreable` encodes the registered blockers only** — VOID runs and Gate P2
   chunk-count disagreement. A thrice-failing Gate 3 run is logged and retained (A4-MAT-6)
   and is **not** a blocker. E1's driver conflated the two into one stricter flag, which the
   E1 RESULT recorded as a discrepancy resolved toward the registration; it is encoded
   correctly here rather than inherited wrong.

**Binary identity, recorded before the run.** `pnpm -F mast build` at this commit reproduces
`dist` content hash `454894e50ccdf7fc299fe7f5af006217b1bfbed396663e9a1be14c5efe35aa4c` —
**the same hash `eval/results/e1-phase-attribution.json` carries**. Gate P's 95% floor and
the scored runs therefore measure one build, which is what makes the floor's ~5 points of
headroom meaningful rather than a comparison across binaries.

**`c` is re-measured, not inherited.** E1's `c = 23.5 ms` was measured on the pre-`c71d59c`
binary and is not reused; `eval/results/e1-phase-calibration.json` is written by this
instrument's own 10 empty-corpus runs.

**Instrument, committed before any scored run (Gate 5).** `eval/e1-phase-schedule.mjs` (the
5-rung schedule, Gate P, the `ln(0)` guard, and the state-dir namespacing that keeps E1's
retained rep-3 artifacts alive), `eval/e1-phase-score.mjs` (every threshold and the
classification), `eval/e1-phase-run.mjs` (the driver), `eval/e1-phase-report.mjs` (the
journal seam), and 68 known-answer tests across three files — including the registration's
own worked H0 counterexample (`b_write = 3.0` at a 45% T9 share), every boundary at `>=`
/ `<=`, and H2's strict-monotonicity tie. E1's own modules are **not** modified: what
E1-PHASE inherits unchanged it imports.

#### E1-PHASE RESULT (2026-08-12) — H1 FIRES: the exponent is in the WRITE phase, and the mechanism is still unidentified

**Outcome: H1.** All three registered conditions hold, and H2, H3 and H4 are each refuted.
15/15 runs complete, 0 VOID, 0 interrupted, no driver findings, `scoreable: true`.

| condition | registered test | measured | |
|---|---|---|---|
| `b_write` | `>= 1.6` | **1.9685** | pass |
| `b_parse` | `<= 1.25` | **1.0144** | pass |
| write's share of `durationMs` at T9 | `>= 0.60` | **94.01%** | pass |

| series | `b` | HC3 95% (context only) | T9 share |
|---|---|---|---|
| walk | 0.6019 | [0.5446, 0.6591] | 0.05% |
| parse | 1.0144 | [0.9930, 1.0359] | 4.33% |
| **write** | **1.9685** | **[1.8800, 2.0569]** | **94.01%** |
| edges | 1.4360 | [1.2333, 1.6388] | 1.56% |
| finalise | 1.2623 | [1.1189, 1.4057] | 0.05% |
| remainder | 0.5504 | [0.3253, 0.7756] | 0.002% |

| rung | chunks | walk | parse | write | edges | finalise |
|---|---|---|---|---|---|---|
| T1 | 3,679 | 1.40% | 42.80% | 52.18% | 3.39% | 0.15% |
| T3 | 7,761 | 0.72% | 32.54% | 63.69% | 2.87% | 0.11% |
| T5 | 16,529 | 0.30% | 17.93% | 80.02% | 1.64% | 0.09% |
| T7 | 34,691 | 0.11% | 9.55% | 88.88% | 1.39% | 0.06% |
| T9 | 73,359 | 0.05% | 4.33% | **94.01%** | 1.56% | 0.05% |

**Write is near-quadratic and it eats the ladder.** Parse is essentially exactly linear
(1.0144), walk is sub-linear (0.6019), and write's share of the clock climbs monotonically
from 52% to 94% while parse's collapses from 43% to 4%. At T1 the run is a parse/write
split; at T9 it is a write.

**What this licenses, stated at exactly the registered strength: "write-localised, mechanism
unidentified", and nothing narrower.** Chunks and database bytes are perfectly collinear
across this ladder, so this instrument **cannot distinguish** a page-cache cliff from FTS5
trigram segment merges, per-file transaction overhead, or B-tree depth growth. Any report
calling this "the page-cache cliff" is over-reading it. **The fact recorded before the run
still stands and still damages that specific mechanism story:** T1's database is 21.6 MB
against SQLite's ~2 MB default page cache, so the cache is exhausted before the ladder
begins and cannot produce the T4/T5 knee E1 measured. H1's *location* claim is confirmed;
H1's *mechanism* claim is not, and was not tested here.

> ⚠️ **The paragraph above is WITHDRAWN as of 2026-08-13 — see `CORRECTION (2026-08-13)`
> below.** The default page cache is **~16 MB**, not ~2 MB (`better-sqlite3` compiles
> `SQLITE_DEFAULT_CACHE_SIZE=-16000`), so T1 is 1.3× the cache rather than 10× and the
> "exhausted before the ladder begins" argument does not hold. Text left standing as the
> historical record per §6. **The sentence either side of it is unaffected:** H1's location
> claim is still confirmed and its mechanism claim is still untested — withdrawing a piece
> of counter-evidence does not promote the mechanism story, it only removes the grounds for
> dismissing it without measuring.

**Direction of error, revisited against the outcome.** H1 was the previous agent's own
hypothesis and every free parameter leaned toward finding it — that was registered in
advance, and it fired. Two things keep this from being a prior confirming itself. First, the
registration corrected its own compensation claim before the run: because phases tile
`durationMs`, only **one** condition was substantively free — write's T9 share — and the
other two are arithmetic consequences. That one free condition came in at **94.01% against a
60% bar**, clearing it by 34 points rather than narrowly. Second, the registration's own
worked H0 counterexample (`b_write = 3.0` at a 45% share, which refutes H1 while write
carries the whole exponent) is a committed known-answer test in
`eval/__tests__/e1-phase-score.test.mjs` and passes — the scorer demonstrably *can* refuse
H1 on the share condition alone.

**H2 is refuted on both of its conditions, and one of them is a near miss that the
registration's estimator rule refuses to negotiate.** `b_edges = 1.4360` with HC3
[1.2333, **1.6388**] — the interval touches the 1.6 bar. The registration puts every
comparison on HC3 **point estimates** and says CIs "have no role in any refutation",
precisely so a touching interval cannot be argued into a firing. It is recorded here as the
first case where that clause actually bound. Edge share is also **not** monotonic: it falls
T1→T7 and rises again at T9 (3.84 → 2.87 → 1.71 → 1.39 → 1.57% on per-rung median shares;
3.39 → 2.87 → 1.64 → 1.39 → 1.56% on the median run's shares). **Both registered readings of
"median share" give the same refutation**, so the addendum's item-2 choice changes nothing
here.

**A registered prediction that the data refutes — the remainder is NOT size-coupled.** The
registration's reading of the unattributed remainder was "teardown, including WAL's
close-time checkpoint... the one **size-coupled** cost outside every phase", and Gate P was
deliberately left permissive to avoid voiding T9 for exhibiting that growth. Measured:
`b_remainder = 0.5504`, strongly **sub**-linear, with its share falling 0.074% → 0.002% from
T1 to T9 (2 ms → 12 ms absolute, against a 20× corpus). The remainder is real but inert, the
permissiveness it justified was never needed, and the registered *reading* of it is wrong.
Recorded rather than quietly dropped, because it is a prediction this registration made and
lost.

**Gates.** Gate P (attribution ≥ 95%): **99.85–100.00%** on all 15 runs, worst 99.85% at
T1#3. Walk-share void condition (10% at T9): **0.05%**. Gate P2 (rep identity): all three
repetitions of all five rungs reported identical `chunk_count`. Gate 0: `dist`
content hash `454894e5…`, identical to the build
`eval/results/e1-phase-attribution.json` was measured on, so Gate P's floor and the scored
runs share one binary. `c = 15 ms` (median of 10 empty-corpus runs), re-measured — **E1's
23.5 ms was not reused**. Note the direction: the constant **fell**, 23.5 → 15 ms, across a
change that *added* timing stamps. **I have no explanation for that and do not offer one**;
machine and OS-cache state differ between sessions, and `c` is small enough here to be
inert either way (the mini-replication is 1.7768 at `c = 15` and 1.7778 at `c = 23.5`).

**Gate 3 and retake retention, with the bias named and quantified.** Two runs missed the
clock-agreement gate, **both at T3**: T3#3 failed on attempts 1 and 2 (deltas 531 and 505 ms
against a 500 ms floor) and passed on attempt 3; T3#1 failed on attempt 1 (551 ms) and passed
on attempt 2. Both therefore retained a **passing** take, and A4-MAT-6's first-attempt rule
never engaged — there was no thrice-failing run. The journal reconciles exactly: **18
`attempt_start` records against 18 completed attempts across 15 runs, so `orphanedAttempts`
reports zero**, and A4-MAT-3's interruption class did not occur.

*The direction of that retention is unfavourable and is stated rather than left implicit.*
Both retained takes are **faster** than their first attempts (7,185 vs 7,210 ms; 7,350 vs
7,622 ms), and they sit at a **low** rung — retaining faster takes at the bottom of a ladder
biases the slope **upward**, i.e. toward the super-linear write result this experiment
reports. Refitting on **first attempts everywhere** moves nothing that matters:
`b_write` **1.9685 → 1.9683**, `b_parse` 1.0144 → 1.0093, `b_edges` 1.4360 → 1.4392, write's
T9 share unchanged at 94.01%, mini-replication 1.7768 → 1.7750, **outcome H1 either way**.
The bias is real, is in the flattering direction, and is worth −0.0002.

**The mini-replication is consistent, and it adjudicates nothing.** `b = 1.7768`, HC3 95%
[1.6693, 1.8843], which covers E1's 1.7529 — "consistent" by the registered rule, on a
**different binary** and a weaker 5-rung design. It may not be read as strengthening E1's
verdict and could not have softened it. Its wild-cluster bootstrap interval is
[1.0429, 2.5107]: five clusters is very few for Webb weights, and that width is a fact about
this design, not about `b`.

**An arithmetic cross-check that was not registered and is offered as such.** Because the
phases tile the clock, the local slope at a rung is the share-weighted sum of the phase
exponents. Evaluated at T9's shares that gives **1.9178**, against E1's independently
measured T3–T9 slope of **1.904** — two binaries, two experiments, 0.7% apart. This is a
consistency observation, not a test, and no conclusion rests on it.

**What this does NOT do.** It cannot confirm, overturn or soften E1's SUPER-LINEAR verdict,
and nothing here is reported as doing so. E1 answered how steeply cost grows; this answers
where the time goes.

**Next step, as registered and not improvised now:** a `cache_size` / `mmap_size` A/B at a
single rung — a **probe, not a remedy** — run before any shipped fix. No pragma has been
set and no index creation deferred. Any fix that follows is verified by re-running **E1's
full 9-rung ladder** against the committed scorer and the immutable 1.35 threshold, never by
re-running this diagnostic.

**Artifacts.** `eval/results/e1-phase-verdict.json` (exponents, shares under both readings,
the full condition table, mini-replication), `e1-phase-runs.jsonl` (15 runs + 18 attempt
records), `e1-phase-runs-summary.json`, `e1-phase-calibration.json`, `e1-phase-schedule.json`
(schedule + binary pin), `e1-phase-attribution.json` (Gate P's anchor).

##### E1-PHASE RESULTS REVIEW (2026-08-12) — H1 stands; the provenance claims around it do not

An adversarial results review was commissioned per §6, and **every load-bearing claim it made
was verified against source or recomputed before being accepted here**. It reproduced all six
exponents, both HC3 interval sets, both share readings at all five rungs, the mini-replication,
the first-attempts refit and the share-weighted cross-check — exactly — under an independently
written OLS+HC3 and its own wild-cluster bootstrap ([1.037, 2.486] against the harness's
[1.043, 2.511]). It confirmed the scorer is faithful to the registered rules line by line, that
Gate P's VOID path is reachable and evaluated on the fitted attempt, and that the corrective
commit `0ba97ec` moved the record **against** the investigator. **The arithmetic carries no
error running toward H1. The narrative did, in three places.**

**RR1 — the declared peek partially answered the one "free" condition, and the RESULT above
oversold that condition as a risky test.** `e1-phase-attribution.json` (created
`01:06:46Z`) revealed write already at **51.7 / 54.9 / 56.2% of the clock at T1**. Given that,
and E1's already-known convex total curve, write's T9 share falling below 60% would have
required another phase to out-grow write from a ~3.4% base — roughly `b_edges ≈ 2.7`. So
"cleared it by 34 points rather than narrowly" is true arithmetic and **weak epistemics**: the
share condition was close to foreordained once the peek existed. The registration's mitigation
(every threshold committed at `36c2f5a`, verified: `00:12:17Z`, before the peek) protects
against threshold-tuning and **does not** protect against this. What remains genuinely
informative is the localisation itself — parse at exactly 1.0144, write's 52% → 94% climb —
not the fact that a bar was cleared.

**RR2 — the estimator rules were registered later than the RESULT implies, and the
point-estimate clause was never actually outcome-determinative.** Verified: the "Estimator and
aggregation rules" section is **absent from `36c2f5a`** and was added at `ef02ef9`
(`01:08:27Z`) — ~100 seconds *after* the attribution peek, though still ~90 minutes before the
first scored run. The four numeric constants (1.6 / 1.25 / 0.60 / 1.7529) *are* in `36c2f5a`;
the rules built on them are not. Two mitigations verified: a single-rung peek yields no
exponent and no interval, so the point-estimate clause could not have been tuned to `b_edges`'
near-miss; and **H2 was independently refuted by non-monotone edge shares under both registered
readings**, so a CI-based rule would have fired nothing either. Consequence for the RESULT
above: **"the first case where that clause actually bound" is withdrawn.** It did not bind —
H2 died on monotonicity regardless.

**RR3 — Gate 5's margin was 24 seconds, and part of the calibration predates the commit.**
Verified timestamps: `e1-phase-schedule.json` written `01:36:42Z`; commit `6c45422` landed
`01:37:29Z`; calibration completed `01:37:52Z`; first scored `attempt_start` `01:37:53Z`. So
"committed before any scored run" holds **by 24 seconds**, the driver process was loaded from
the working tree before the commit existed, and most of the 10 empty-corpus runs behind
`c = 15` ran pre-commit. Behavioural identity was checked rather than assumed: `git diff
6c45422..HEAD -- eval/` is empty, the committed `buildPhaseSchedule` reproduces the pinned
schedule bit-for-bit, and every Gate 3 decision in the journal matches the committed
`gate3Verdict` arithmetic. Nothing indicates the running code differed from the committed
code — but Gate 5 is a provenance gate, and a 24-second margin is worth disclosing rather
than claiming comfortably.

**RR4 — the remainder refutation is qualitatively sound and quantitatively spurious.**
Remainder values span **1–14 ms** and are millisecond-quantized. A ±1 ms adversarial
perturbation moves `b_remainder` across **0.37–0.79**, wider than its own printed HC3 interval
[0.3253, 0.7756] — so four decimals on 0.5504 are theatre. The qualitative claim survives every
perturbation (sub-linear under all of them; share falls 0.074% → 0.002%), so the registered
"size-coupled" reading is still refuted; the *precision* is withdrawn.

**RR5 — omissions now named.** (a) **T5's repetition spread is 12.5%** (27,105 / 29,649 /
30,498 ms) against ≤2.7% at every other rung; unexplained, and unmentioned above where E1's
RESULT named its own T6 spike. Dropping T5 entirely leaves `b_write` at 1.9685; dropping any
single rung keeps it in 1.90–2.08. (b) **Write itself is a mixture**: split-half `b_write` is
**1.8378** over T1–T5 and **2.0627** over T5–T9, the same convexity E1 carried as a formal
qualifier — so "consistent with E1's 1.7529" compares two mixture summaries. (c) **The
coupling looks DB-wide, not write-exclusive**: `edges` at 1.436 and `finalise` at 1.2623 both
exceed the near-linear growth of the items they process (edge count scales `chunks^1.080`),
and edges' share upticks at T9. At a 1.6% share this changes no fix priority, but a reader
localising to "write" should know the neighbours lean the same way.

**RR6 — a latent instrument defect, unexercised.** A Gate P or Gate P2 VOID that is later
successfully re-run leaves the void in `loadJournal`'s map, so `scoreable` stays false
permanently: A4-MAT-7's "re-run queue" has no dequeue in `e1-phase-run.mjs`. Zero voids
occurred, so it touched nothing here. **Fix before any reuse of this instrument** — it joins
HANDOFF §5's defect list.

**What survives all of it.** H1 — **write-localised, mechanism unidentified** — stands
unchanged, on every estimator and every sensitivity constructed against it. What is amended is
the confidence language around it, in the three places where this RESULT's first version
flattered its own hypothesis.

##### CORRECTION (2026-08-13) — the "~2 MB default page cache" figure is wrong by 8×, and it was load-bearing

Found while building the A/B's lever (`ef8d83e`), before the A/B was designed. A test asserting
that `openDatabase` leaves the page cache at SQLite's own default was written against a bare
`better-sqlite3` connection rather than a hardcoded constant, and it reported **`cache_size =
-16000`** — not the `-2000` the E1-PHASE registration assumed.

**Verified at primary source, not inferred from the observation.** `better-sqlite3@12.11.1`
(SQLite 3.53.2) compiles the amalgamation with `SQLITE_DEFAULT_CACHE_SIZE=-16000`
(`deps/defines.gypi:13`), overriding the `#ifndef` fallback of `-2000` in `sqlite3.c:14850`;
the flag's presence on the shipped object's own compile command line
(`build/Release/.deps/…/sqlite3.o.d`) confirms it reached the binary rather than merely the
build file. Measured on the same install: `page_size = 4096`, and **`mmap_size = 0`** — memory
mapping is OFF by default, so an mmap arm is an on/off contrast, not a resize.

**MAST's effective default page cache is therefore ~16.0 MB (16,000 KiB), not ~2 MB.**

**What this overturns.** The registration recorded, as a pre-run fact damaging H1's mechanism
story: *"T1's database is 21.6 MB — already ~10× SQLite's ~2 MB default page cache — while the
knee E1 measured sits at T4/T5 (66 → 95 MB). A 2 MB cache is exhausted before the ladder
begins, so it cannot produce a knee there."* At the true default, T1's 21.6 MB is **1.3×** the
cache, not 10×. The ladder does not begin with the cache already exhausted — it **crosses** the
cache boundary at roughly its first rung and reaches 4–6× the cache by T4/T5. That is the
regime in which a cache cliff would produce a knee, which is precisely where E1 measured one.

**Direction of error — stated because this one runs the wrong way.** The correction **removes a
piece of counter-evidence against the hypothesis the previous session held**, and so makes the
cache-cliff story more plausible, not less. Under §6 ("a result that flatters the thing you are
testing deserves MORE scrutiny") it is recorded with its own limits attached:

1. **Database size is not working set.** A bulk insert's hot pages are the 11 indices' interior
   B-tree nodes and FTS5's in-flight segment structures, not the whole file. Neither the old
   comparison nor the corrected one is decisive about residency; what changed is only that the
   *ratio degrades ~5× across the ladder* instead of being pinned far past the cliff from the
   start.
2. **The 21.6 MB T1 figure is inherited, not re-measured here.** It is carried forward from the
   previous session on its own authority.
3. **This does not promote H1's mechanism claim.** A confirmed H1 still licenses
   "write-localised, mechanism unidentified" and nothing narrower — FTS5 segment merges,
   per-file transaction overhead and B-tree depth growth remain indistinguishable on the
   E1-PHASE evidence. What the correction changes is that the cache cliff can no longer be
   waved off *a priori*; it has to be measured. That is what the A/B is for.

**Consequence for the A/B's registration:** its arms must be sized against the real **16 MB**
baseline. An arm at, say, 8 MB or 64 MB was going to be described relative to a 2 MB control
that does not exist, and the "control" arm is not a small cache — it is already a moderately
large one.

### E1-AB PRE-REGISTRATION (2026-08-13) — is the page cache the mechanism behind write's super-linearity?

**Status: registered, not yet run.** To be committed before any scored run, per §6.

**This is a probe, not a remedy, and not a verdict experiment.** It cannot confirm, overturn
or soften E1's SUPER-LINEAR verdict, and no result here may be reported as doing so. It also
cannot re-adjudicate E1-PHASE: H1 (write-localised, mechanism unidentified) stands whatever
this returns. It is the mechanism discriminator registered *inside* the E1-PHASE registration
precisely so it could not be improvised after the result. **No pragma is shipped on the
strength of it.** Any fix that eventually follows is verified by re-running **E1's full 9-rung
ladder** against the committed scorer and the immutable 1.35 threshold — never by re-running
E1-PHASE, never by re-running this, and never by moving a threshold.

#### The question

E1-PHASE localised the exponent to the write phase (`b_write = 1.9685`, 94.01% of the clock at
T9) and licensed **"write-localised, mechanism unidentified" and nothing narrower**. Chunks and
database bytes are perfectly collinear across that ladder, so a page-cache cliff, FTS5 trigram
segment merges, per-file transaction overhead and B-tree depth growth are indistinguishable on
that evidence. This experiment breaks the collinearity on exactly one of those candidates, by
varying the page cache **at fixed corpus size** and watching whether write time moves.

#### Facts this design rests on, each measured or read at primary source (not inherited)

| fact | value | source |
|---|---|---|
| default page cache | `cache_size = -16000` → **15.63 MiB** | `better-sqlite3@12.11.1` `deps/defines.gypi:13`, on the shipped object's compile line |
| default memory map | `mmap_size = 0` — **off** | measured on a live connection |
| mmap ceiling on this platform | `SQLITE_MAX_MMAP_SIZE = 0x7fff0000` (~2 GiB) | `sqlite3.c:16129`, `__APPLE__ && __MACH__` branch; no `SQLITE_MAX_MMAP_SIZE` define in `defines.gypi` |
| WAL commit durability | `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` → **NORMAL** | `defines.gypi:15` |
| T1 `graph.db` | **21,569,536 B = 20.57 MiB** = 1.32× the cache | `ls -l ~/.cache/mast-eval/e1/phase-run-T1-r3/graph.db`, re-measured today |
| T9 `graph.db` | **439,140,352 B = 418.8 MiB** = 26.8× the cache | same, `phase-run-T9-r3` |
| write structure | **one transaction per file** (~13,330 at T9) | `src/indexer/index.ts:369` and the `populateFile` loop beneath it |

The T1/T9 sizes discharge limit 2 of the `CORRECTION (2026-08-13)` above — the 21.6 MB figure
was inherited there on the previous session's authority and is now first-hand.

Two of these actively shape the design. `synchronous = NORMAL` means a per-file commit does
**not** fsync, so per-transaction durability cost is not the linear floor one would otherwise
assume. And `mmap_size = 0` means the mmap arm is an **on/off** contrast, not a resize.

#### Design

**Two rungs — T1 and T9 — four arms, three blocks: 24 runs.**

| arm | flags | expected `pragmas:` echo | role |
|---|---|---|---|
| **A** | *(none)* | `{"cache_size":-16000,"mmap_size":0}` | control — the un-pragma'd binary |
| **B** | `--cache-size-mib 1024` | `{"cache_size":-1048576,"mmap_size":0}` | cache exceeds T9's whole database (1024 MiB vs 418.8 MiB, 2.4×), so **no page can ever be evicted** |
| **C** | `--mmap-size-mib 1024` | `{"cache_size":-16000,"mmap_size":1073741824}` | memory mapping ON, cache at default — isolates the read-path syscall/copy cost |
| **D** | `--cache-size-mib 2` | `{"cache_size":-2048,"mmap_size":0}` | **positive control** — an 8× *shrink*, to the figure the E1-PHASE registration wrongly assumed was the default |

Arm B's size is chosen by a rule, not by taste: **≥ 2× T9's final database size**, so that the
arm is "the cliff cannot exist" rather than "a bigger number". Arm D is 2 MiB = `-2048`, near
but not identical to the `-2000` the registration assumed; the difference is 2.4% and is
noted so nobody later reads `-2048` as a transcription error.

**Why two rungs when the E1-PHASE registration said "at a single rung".** This is a deliberate
expansion of the registered scope and is declared as one. A single-rung contrast measures a
**level** effect; the claim under test is about an **exponent**. T1 costs 2.7 s against T9's
8.9 min, so the second rung is **0.5% of the schedule's machine time** and buys the only
statistic that speaks to size-coupling (below). Expanding a registered scope *before* running,
in writing, with the reason, is the opposite of the failure mode §6 guards against.

**Blocked, not shuffled globally.** Each of the 3 blocks contains all 8 `(arm × rung)` cells,
ordered by a seeded shuffle (**seed 4409**, committed here). Blocks run sequentially. Every arm
therefore appears exactly once per block, so a monotone machine drift across a ~2-hour schedule
loads onto all arms roughly equally instead of onto whichever arm ran last.

**State dirs are namespaced `e1ab-run-<arm>-<tier>-r<k>` under `~/.cache/mast-eval/e1/`.**
`runColdIndex` wipes its state dir before every run, and E1's `run-T9-r3` / E1-PHASE's
`phase-run-T9-r3` are retained artifacts that Gate 6 and any future audit read. Note also that
`~/.cache/mast-eval/ab-runs/` and `ab-state/` **already exist** and belong to the unrelated
paraphrase A/B — the `e1ab-` prefix avoids that collision too. Pinned by a test.

Everything else is inherited from E1/E1-PHASE unchanged and must not be re-derived: the frozen
tier manifest, `assertCorpusPinned('n8n')`, `assertTierFileSet`, cold-start discipline (fresh
state dir per run, never `--incremental`), Gate 3's `max(5%, 500 ms)` clock rule with its
retake cap, and A4-MAT-6's first-attempt retention.

#### The estimator, fixed before the data

**Primary statistic — a within-block ratio, so drift cancels by construction:**

```
ρ_X = median over blocks k=1..3 of  write_ms(X, T9, k) / write_ms(A, T9, k)
```

for `X ∈ {B, C, D}`. **Median of the three per-block ratios**, not a ratio of medians and not a
pooled ratio-of-sums. `write_ms` is the primary series because E1-PHASE measured it at 94.01%
of the clock at T9; `duration_ms` is reported alongside under the identical estimator and has
**no role in any decision** — it is there so a divergence between the two is visible rather
than hidden.

**`c` is neither measured nor used.** Every statistic here is a within-rung ratio or a
write-phase quantity, so the empty-corpus constant plays no part. It is not recorded, because
an unused measurement lying in an artifact is an invitation to post-hoc use.

**Three blocks is three numbers.** No CI, no HC3, no bootstrap is computed or reported for
`ρ`: at n=3 any interval would be decoration, and the E1-PHASE record already contains one
case (`b_edges`) where a printed interval invited an argument the registration had to refuse.
The **spread** (min, median, max of the three per-block ratios) is reported instead, and a
spread exceeding **0.15** on any arm is a **reported finding**, not a gate.

#### Hypotheses, thresholds and the outcome set — exhaustive, committed before the data

**Primary classification, on `ρ_B`:**

| `ρ_B` | outcome | what it licenses — and nothing more |
|---|---|---|
| ≤ 0.20 | **CACHE-DOMINANT** | the page cache accounts for ≥80% of write time at T9; the cache-cliff *class* is the leading mechanism at this rung |
| 0.20 < `ρ_B` ≤ 0.80 | **CACHE-PARTIAL** | materially involved; does **not** account for the bulk — other mechanisms carry the majority |
| > 0.80 | **CACHE-NOT-IMPLICATED** | a 64× enlargement buys <20% at the rung where write is 94% of the clock |

The same three-way table is applied to `ρ_C` with `MMAP-` prefixes, independently. **The bands
are graded on purpose**: write's excess over linear is ~94% of write time at T9, so a 20%
reduction retires ~21% of the excess. Without the bands, a `ρ_B` of 0.79 could be narrated as
"the cache cliff is confirmed", which it is not.

**The mechanism story is adjudicated on the pair `(ρ_B, ρ_D)`, and every cell is named:**

| | `ρ_D ≥ 1.10` (shrinking hurts) | `ρ_D < 1.10` (shrinking is free) |
|---|---|---|
| **`ρ_B` ≤ 0.80** | cache implicated per the ρ_B band; corroborated in both directions | **CACHE-ASYMMETRIC** — classification per the ρ_B band **stands**, and the asymmetry is a finding that must be explained before any fix is proposed |
| **`ρ_B` > 0.80** | **CACHE-SATURATED** — the lever demonstrably works, but 15.63 MiB is already past the benefit knee. The *default cache* is not the mechanism. | **CACHE-INERT** — a **512× range** (2 MiB → 1024 MiB) moves write by less than the bands. **The page-cache-cliff story is REFUTED at T9.** |

**CACHE-INERT is a positive result, not a null**, and arm D is what makes it one. Without a
positive control, "we enlarged the cache and nothing happened" is indistinguishable from "our
lever was not connected". With it, the claim becomes "we moved the lever 512× in both
directions and the clock did not care."

**The size-coupling discriminator — interpreted only when `ρ_B ≤ 0.80`:**

```
Δ = ρ_B(T1) − ρ_B(T9)
```

**SIZE-COUPLED iff `Δ ≥ 0.10`** — the enlargement helps at least 10 percentage points more at
26.8× the cache than at 1.32×. Otherwise **CONSTANT-FACTOR**: the arm is a speedup, not an
explanation of the exponent, and may not be reported as bearing on `b_write`. This is a
**conditional discriminator, not an independent hurdle**, and is counted as such below.

**Secondary, descriptive, no threshold:** the two-point write slope per arm,
`b̂_write(X) = ln(w9/w1) / ln(19.94)`. On E1-PHASE's control data this returns **1.961** against
the 5-rung fit's 1.9685, so the two-point form tracks the ladder — but **two points are not a
fit**, no interval exists for it, and no outcome above depends on it. It is reported to make
the arms mutually comparable in the units the program has been reasoning in, and for no other
purpose.

#### Direction-of-error statement (mandatory field)

**My prior now leans toward the cliff, and the reason is uncomfortable: I moved it there
myself, yesterday, by withdrawing the counter-evidence** (`CORRECTION (2026-08-13)`). §6 says a
result that flatters the thing you are testing deserves more scrutiny; the same applies to a
*correction* that flatters it. Four compensations, and I distinguish the real ones from the
decorative:

1. **Arm D is the substantive compensation.** It gives a refutation its own positive evidence,
   so an inert result is publishable rather than a reason to keep hunting for a better arm.
   Nothing else in the design does that work.
2. **Gate A (arm identity) cuts both ways.** A flag that silently failed to reach the
   connection would produce identical arms and a clean, credible-looking null — *or*, on a
   different failure, a spurious difference. The echo makes both visible.
3. **The graded bands** stop a small effect being narrated as vindication. That is a guard on
   *reporting*, not on measurement, and is worth less than (1).
4. **The within-block ratio and seed are fixed here**, so no aggregation or ordering choice
   remains open after the data arrives. This is table stakes, not a compensation.

**Condition counting, honestly.** The cache-cliff story has **exactly one substantively free
test: `ρ_B ≤ 0.80`.** `Δ ≥ 0.10` is conditional on it and only sub-classifies. `ρ_D ≥ 1.10` is
an instrument check that does not test the hypothesis — it decides whether a *refutation* is
informative. Anyone reading three thresholds as three hurdles is over-counting, which is the
error the E1-PHASE registration had to correct in itself before running.

**A prior that runs the other way, recorded now so it cannot be claimed later.** T9's database
is 418.8 MiB on a machine with far more RAM than that, so the OS page cache plausibly holds the
entire file already; a SQLite cache miss may then be a `memcpy` from the OS cache rather than a
disk read. If so, **arm B should do very little**, and the honest expectation for this
experiment is closer to CACHE-INERT than to CACHE-DOMINANT. Arm C exists partly because it
addresses that regime directly: mmap removes the `pread` syscall and copy that a warm-OS-cache
miss still pays.

**One consequence I do not control and will not pretend to.** `wal_autocheckpoint` stays at its
default (1000 pages ≈ 4 MiB) in every arm. Cache size and checkpoint scheduling interact, so
"arm B" is strictly "arm B *at the default checkpoint policy*". It is held constant, not
isolated.

#### Gates

- **Gate 0 — binary identity.** `dist` content hash + `schema_version` recorded pre-run and
  re-asserted at every start and restart; all 24 runs assert one hash. **The hash HAS moved**:
  `ef8d83e` added `OpenDatabaseOptions` and the two CLI flags, so this experiment runs on a
  different binary than E1-PHASE's 15-run ladder. **Registered consequence: no absolute timing
  here is comparable to the ladder's, and nobody may read across the two.** Both arms sharing
  one binary is what keeps the A/B internally valid; the control arm is **re-measured on this
  binary** and E1-PHASE's T9 write times are not reused as a control.
- **Gate 1 — corpus integrity.** `assertCorpusPinned('n8n')` per run; each run's `SELECT path
  FROM files` equals the frozen manifest's file set for its tier, exactly.
- **Gate A (new) — arm identity.** Every run's `pragmas:` line must equal its arm's declared
  pair in the table above, **exactly**. A mismatch **VOIDs the run**. This is the gate that
  makes each run self-describing about which arm produced it; it is the direct analogue of
  Gate 0's content hash, at the level of the lever rather than the binary.
  **Its limit, stated rather than glossed:** the echo proves the pragma was *configured on the
  connection SQLite reported it from*. It does not prove SQLite's pager honoured it internally.
  The only available cross-check on that is behavioural — if **no** arm moves the clock, a
  disconnected lever cannot be fully excluded, and CACHE-INERT is reported with that caveat
  attached rather than as a clean refutation.
- **Gate 3 — clock agreement.** `max(5%, 500 ms)`, retakes capped at 2 then logged, orphaned
  attempts charged against the cap (A4-MAT-3), A4-MAT-6 first-attempt retention. Retentions
  are reconciled (`attempt_start` records vs completed attempts) and the direction of any
  retained bias is stated in the RESULT, as E1-PHASE's was.
- **Gate P — attribution.** `Σ phase_ms ≥ 0.95 × durationMs` on the **fitted** attempt.
  Inherited unchanged; E1-PHASE measured 99.85–100.00% across 15 runs, so the floor is
  ~5 points of real headroom rather than a guess.
- **Gate P2 — work identity, strengthened.** All **twelve** runs at a rung (4 arms × 3 blocks)
  must report an identical `chunk_count`, not merely the three reps of one arm. This is the
  gate that proves the arms did the *same work* and differ only in configuration. Disagreement
  voids the rung.
- **Gate 5 — instrument committed before any scored run.** And this time literally: **commit,
  then launch.** E1-PHASE's margin was 24 seconds with part of its calibration running
  pre-commit (RR3); that is disclosed there and is not repeated here.

**Database size across arms is a reported FINDING, not a gate.** Final `graph.db` bytes are
recorded for every run and compared across arms at each rung. It is *not* a gate because the
run-to-run determinism of that number has not been measured, and Gate P's precedent (re-anchored
on three real T1 runs rather than a smoke test) is that a threshold with no measurement behind
it does not belong in this program.

#### Falsification criteria

- **The cache-cliff mechanism story is REFUTED at T9** iff `ρ_B > 0.80` **and** `ρ_D < 1.10`
  (CACHE-INERT).
- **It is refuted specifically as a story about the DEFAULT** iff `ρ_B > 0.80` and
  `ρ_D ≥ 1.10` (CACHE-SATURATED): the cache matters, and 15.63 MiB is already enough.
- **It is refuted as an explanation of the EXPONENT**, even when `ρ_B ≤ 0.80`, iff
  `Δ < 0.10` (CONSTANT-FACTOR).
- **The mmap story is refuted** iff `ρ_C > 0.80`.
- **The whole instrument is VOID** if Gate A fails on any scored run that cannot be re-run
  clean, if Gate P2 disagrees within a rung, or if any run's `write_ms ≤ 0`.
- **If every arm is inert** (`|ρ_X − 1| < 0.10` for all of B, C, D), the result is reported as
  **CACHE-INERT with the Gate A limit attached** — see above — and the next step is *not*
  another pragma arm: it is statement-level or `sqlite3_stmt_scanstatus` profiling inside the
  write phase. Registered now so an all-inert outcome is not quietly re-analysed.

#### Instrument — to be built and committed before any scored run (Gate 5)

| file | role |
|---|---|
| `eval/e1-ab-schedule.mjs` | arms, rungs, blocks, the seed-4409 within-block shuffle, Gate A's expectation table, state-dir namespacing |
| `eval/e1-ab-score.mjs` | within-block ratios, the ρ bands, the 2×2 outcome cells, Δ, the descriptive two-point slope |
| `eval/e1-ab-run.mjs` | the 24-run driver — resumable, journalled, **with a working VOID dequeue** |
| `eval/e1-ab-report.mjs` | the journal→scorer seam |

**Two inherited defects must be dealt with, because HANDOFF §5 forbids reusing an instrument
without fixing its defects:**

1. **The VOID queue has no dequeue** (RR6). A void that is later re-run clean stays in
   `loadJournal`'s map, pinning `scoreable` false forever. Unexercised in E1-PHASE (0 voids),
   but Gate A makes a void *plausible* here, so the new driver implements the dequeue and a
   test exercises void → re-run → `scoreable: true`.
2. **`fitSeries` reports spurious precision on quantized series** (RR4). **Does not apply** —
   this instrument computes no OLS fit. The one slope it reports is a two-point ratio,
   explicitly labelled descriptive, over values of 1.4 s and 500 s where millisecond
   quantization is ~0.0002%.

**`eval/e1-common.mjs` is touched, and the change is additive.** `runColdIndex` needs to pass
the two flags and parse the `pragmas:` line. It gains an optional extra-args parameter
defaulting to none, plus a `parsePragmas` export. **E1's and E1-PHASE's call paths must be
byte-for-byte unchanged in behaviour**, pinned by a test that calls it with no extra args and
asserts the argv it builds. Neither E1's nor E1-PHASE's scored records are re-scored, re-fitted,
or touched in any way.

#### Declared prior exposure (P0 precedent)

Three things were seen before this registration was written, and none of them tuned a threshold:

1. **E1-PHASE's T9 control write times** (500,885 / 497,485 / 504,941 ms) are published data on
   the **previous** binary. Every statistic here is a ratio against a control **re-measured on
   this binary**, so the old absolutes cannot enter. They did inform the ~8.9 min/run cost
   estimate and hence the block count.
2. **T1 and T9 `graph.db` sizes**, measured today from retained artifacts. These *did* set arm
   B's size, via the pre-stated rule "≥2× T9's database". That is a design input chosen from a
   size, not a threshold chosen from a timing.
3. **A `pragmas:` smoke run** on a one-file corpus while building the lever, which printed
   `{"cache_size":-65536,"mmap_size":268435456}`. It produced no tier timing.

No T1 or T9 timing on the current binary has been observed by anyone at the time of this
commit.

#### Costs

24 runs. 12 at T9 (~8.9 min each on the previous binary) and 12 at T1 (~2.7 s each):
**~2 hours** if the arms are neutral, and materially longer if arm D is slow — a 2× arm-D
penalty adds ~27 min. Peak transient disk is one T9 state dir at a time (~420 MiB), wiped per
run. **Machine must be otherwise idle**, as for E1 and E1-PHASE.

#### Design Reserve (pre-thought, NOT commitments)

Recorded so that if any of these is later promoted, the promotion is visible as a change of
plan rather than as improvisation:

- **A 1 MiB cache arm**, if arm D at 2 MiB proves inert — a stronger positive control.
- **A combined arm** (large cache + mmap). Deliberately excluded: it is fix-shaped, and this
  is a probe.
- **An FTS5 arm** — building the trigram index in a second pass, or `'rebuild'` after bulk
  insert — to attack the mechanism candidate this experiment cannot touch. That is a different
  instrument and would need its own registration.
- **`wal_autocheckpoint` as an arm.** Named because it is the interaction this design holds
  constant rather than isolates.

#### What is deliberately NOT done

No pragma is set in product code, in either direction, on the strength of this. `MAST_SPEC`
documentation of `--cache-size-mib` / `--mmap-size-mib` (and of the still-undocumented
`--phase-timing` / `ENABLE_MAST_PHASE_TIMING`) is a separate, non-measurement item and is not
folded in here. E1-PHASE is not re-run and E1 is not re-scored.

#### AMENDMENT 1 — 2026-08-13, pre-run, post-adversarial-review

The registration above was committed at `7ee03aa` **before** the review was commissioned, so
everything here is provably a response to it rather than absorbed into the original text. Per
§6 and the standing rule that this reviewer has been wrong before, **every load-bearing claim
was verified against source or recomputed before being accepted**. One was rejected on
verification; one was accepted but its severity corrected; and one recommendation was accepted
in its diagnosis and **replaced with a better remedy**, which is recorded as such rather than
passed off as the reviewer's.

**No threshold from the original registration is loosened. One is deleted as degenerate and
replaced by a stricter one; the rest are additions.**

##### A1 — arm C is structurally incapable of reaching the mechanism. VERIFIED at source; arm demoted.

The review's blocking finding reproduces exactly. In `sqlite3.c` (SQLite 3.53.2, vendored):

```c
const int bMmapOk = (pgno>1
 && (pPager->eState==PAGER_READER || (flags & PAGER_GET_READONLY))
);                                                        /* :65261–65263 */
```

and in `btreeCursor`, a **write** cursor gets `pCur->curPagerFlags = 0` (`:77886`) while only a
read-only cursor gets `PAGER_GET_READONLY` (`:77889`). Inside an open write transaction
`eState` is a WRITER state, so **page fetches made through write cursors — which is exactly the
11 indices' B-tree insertion traversals, the hypothesised miss source — can never be served
from the memory map.** A third gate compounds it: `if( bMmapOk && iFrame==0 )` (`:65286`) skips
mmap for any page still resident in the WAL, and a bulk load with 4 MiB autocheckpoints always
has a rolling set of hot pages there.

So `ρ_C ≈ 1` is close to predetermined, and the original registration's claim that arm C
"isolates the read-path syscall/copy cost" of index-maintenance misses is **wrong**. Worse, arm
C was named as the mitigation for the OS-page-cache counter-prior; that mitigation was hollow.

**Change:** arm C is **removed from T1 and T9** and **retained at T5 only** (3 runs, ~90 s).
It is re-registered as what it actually is: **a source-contradiction tripwire, not a mechanism
arm.** Its registered reading is stated in advance and is asymmetric on purpose —

- `ρ_C(T5) > 0.80` — **expected**, predicted by the source reading above. It is **weak
  evidence** and may not be reported as "the mmap story is refuted by measurement"; the
  refutation is analytic, from `:65261` and `:77886`, and the run merely fails to contradict it.
- `ρ_C(T5) ≤ 0.80` — **contradicts the source reading**, is a finding in its own right, and
  triggers a dedicated probe rather than any conclusion here.

Keeping it at the cheap rung preserves an empirical datum against the registered discriminator
that E1-PHASE named ("a `cache_size` / `mmap_size` A/B") for ~1.5 minutes of machine time,
rather than narrowing that discriminator purely on my own reading of a 250k-line amalgamation.
Spending 27 minutes at T9 for a structurally foreordained null is what is refused.

*One reviewer sub-claim died under its own verification and is recorded because it strengthens
Gate A:* a **runtime** mmap failure is not invisible to Gate A. `unixMapfile` sets
`pFd->mmapSizeMax = 0` on `MAP_FAILED` (`:45838–45843`) and `PRAGMA mmap_size` reads back
through that field, so the echo would print `0`, mismatch arm C's expectation, and VOID. Gate A
is blind to the *structural* gating above — but that is not a failure mode, it is physics.

##### A2 — Δ is withdrawn as degenerate. The per-arm slope replaces it, and the replacement is not the one recommended.

**The diagnosis is accepted and verified.** Every candidate mechanism predicts `ρ_B(T1) ≈ 1`,
because T1's database is only 1.32× the default cache and there is almost no miss cost there
for a larger cache to remove. So `Δ = ρ_B(T1) − ρ_B(T9) ≈ 1 − ρ_B(T9)`, and the gate
"`Δ ≥ 0.10` given `ρ_B(T9) ≤ 0.80`" reduces to "`≥ 0.20 − ε ≥ 0.10`" — **SIZE-COUPLED fires
almost automatically whenever it is consulted at all.** The label that flatters the exponent
story was the near-automatic one, and the direction-of-error statement did not name it. That is
the same unregistered-lever-shaped bias this program has now been caught by four times.
Independently: T1's write spread across E1-PHASE's reps is **8.63%** (1,414 / 1,452 / 1,536 ms),
so Δ's T1 leg sits at roughly 2σ of its own noise.

**`Δ` is deleted as a decision statistic.** It is reported descriptively and adjudicates nothing.

**The replacement, and why it is not the reviewer's.** The review recommended adding a middle
rung and deciding on a three-point slope. The middle rung is adopted (A3) — but *not for that
reason*, because the recommendation rests on an arithmetic error of omission. In a three-point
OLS with evenly spaced `ln N`, **the midpoint carries 0.09% of the slope's leverage** against
33.5% at each endpoint (computed on this ladder's actual chunk counts). On E1-PHASE's control
data the three-point slope is **1.9613** against the two-point slope's **1.9614** — identical to
four decimals. Adding T5 buys **no slope precision at all**, and a registration claiming
otherwise would be making a promise the arithmetic does not keep.

**What actually makes the slope a clean size-coupling test is simpler, and it was already in the
design.** A constant-factor speedup multiplies write time by a fixed `ρ` at every rung, which
shifts the intercept of `ln(write) ~ ln(chunks)` and **leaves the slope exactly unchanged**. The
slope moves *if and only if* `ρ` varies with `N`. So the per-arm slope is non-degenerate by
construction, and needs no second statistic beside it. It is hereby **promoted from "descriptive,
no outcome depends on it" to the registered exponent test**:

| `b̂_write(B)` | outcome | licenses |
|---|---|---|
| < **1.35** | **EXPONENT-EXPLAINED** | the enlarged cache removes the super-linearity *by this program's own standing definition* — 1.35 is E1's pre-registered, immutable threshold, not a number invented here |
| 1.35 ≤ `b̂_write(B)` ≤ `b̂_write(A) − 0.20` | **EXPONENT-REDUCED** | materially flattens the growth; write remains super-linear |
| > `b̂_write(A) − 0.20` | **EXPONENT-UNTOUCHED** | whatever the level effect, the cache does not explain the exponent |

**Slopes are computed within each block** (3 per arm), and the **median of the three** is the
statistic; the spread of the three is reported, and a spread above 0.20 is a finding. Computing
within-block preserves the drift cancellation that the ratio estimator was chosen for.

**The 0.20 bar's power, computed rather than asserted.** Propagating E1-PHASE's own within-rung
spreads (T1 8.63%, T9 1.50%) through the endpoint leverages, with a median of three, gives a
slope σ of **≈0.0085**. The bar is therefore ~20σ. It is left deliberately far above σ because
that σ is estimated from *within-session* repetitions and this schedule runs ~90 minutes; I
would rather the test be blunt than have a marginal call decided by a noise model I have not
validated across blocks.

**A number the level test alone cannot deliver, and the reason this promotion matters.** At
`ρ_B(T9) = 0.20` — the CACHE-DOMINANT *floor* — arm B's write at T9 is ~100 s against a
linear extrapolation from T1 of ~28 s, a two-point slope of **1.424**. Still super-linear. So
even the strongest level result the registration can report would **not** have licensed "the
cache explains the exponent", and without this amendment there was no registered statistic that
could have refused that reading.

##### A3 — T5 is added for arms A, B, D. What it actually buys, stated honestly.

Not slope precision (A2). It buys two things:

1. **A dose–response curve on the cache multiple.** T5's `graph.db` is **95,203,328 B = 90.8 MiB
   = 5.81×** the 15.63 MiB cache, against T1's 1.32× and T9's 26.8×. `ρ_B` measured at three
   multiples spanning 20× says *where the effect turns on*, which is the size-coupling evidence
   Δ was supposed to provide and could not.
2. **A curvature reading.** E1-PHASE found write is itself a mixture. On the control's three
   rungs the split halves are **`b_lo` = 1.8770** (T1→T5) and **`b_hi` = 2.0465** (T5→T9). Both
   are reported per arm. **A cache cliff should flatten `b_hi` specifically** — the half where
   the database most exceeds the cache. `b_hi(B) < b_hi(A) − 0.20` is registered as a
   **corroborating** reading of EXPONENT-REDUCED/EXPLAINED; it is not an independent hurdle and
   does not gate any outcome.

Cost: 9 runs at ~30 s ≈ **4.5 minutes**.

##### A4 — arm D's lever-connectivity check moves to T1, where it has power. VERIFIED arithmetic.

The review's computation reproduces. Under a uniform-access model at T9 (107,212 pages), a
15.63 MiB cache holds 3.73% and a 2 MiB cache holds 0.47%, so **miss volume rises only 1.034×**
— even if misses were 100% of write's excess, `ρ_D(T9) ≈ 1.03`, below its own 1.10 bar and
inside noise. Presenting `ρ_D(T9) ≥ 1.10` as a general proof that the lever is connected was
wrong.

At **T1** (5,266 pages) the same model gives 76.0% vs 9.5% residency and a **3.76×** rise in
miss volume. Those three runs are already in the schedule and no registered statistic read them.

**Change:** **`ρ_D(T1) ≥ 1.10` is the lever-connectivity check.** `ρ_D(T9)` is demoted to a
working-set probe and reported without a threshold. The 2×2 outcome table's `ρ_D` axis is
re-keyed to **`ρ_D(T1)`**; every cell's wording is otherwise unchanged.

Note the model's own limit: uniform access is the *wrong* model for B-tree maintenance, where
interior nodes are hot. It is used here only to establish which rung has power, and that
conclusion is robust to the model — T1's cache holds most of the file and T9's holds almost
none of it under any access pattern.

##### A5 — three holes in the outcome set, patched. VERIFIED against the registration's own text.

The set claimed exhaustiveness and did not have it:

- **`ρ_X > 1.10` on any arm (the lever makes things WORSE)** fell into the `ρ_B > 0.80` row and
  would have been labelled CACHE-SATURATED or CACHE-INERT, both false. **Now: INTERFERENCE —
  reported, no mechanism cell claimed, and the RESULT must offer or refuse an explanation.**
- **`ρ_D ≤ 0.90` (shrinking the cache HELPS)** was filed as "shrinking is free", which it is
  not. **Now: reported anomaly; the CACHE-INERT cell may not be claimed while it holds.**
- **The all-inert clause used `|ρ_X − 1| < 0.10`, a third partition inconsistent with the 2×2.**
  `(ρ_B = 0.85, ρ_D = 1.05)` is CACHE-INERT by the cells but not "all inert" by the clause, so
  which caveat attached was ambiguous. **Now restated in the table's own terms: the Gate A
  limit attaches whenever the outcome is CACHE-INERT *and* `ρ_C(T5) > 0.80`** — i.e. when no
  arm anywhere moved the clock.

A fourth hole the review raised — a joint `(CACHE-INERT, MMAP-DOMINANT)` contradiction — is
dissolved rather than patched: under A1 arm C no longer produces a mechanism cell at all.

##### A6 — a VOID re-run breaks the pairing the primary estimator depends on. Rule registered.

The within-block ratio is justified by drift cancellation, which assumes the arm run and its
control run are temporally adjacent. A run VOIDed by Gate A/P/P2 and re-run later — possibly
after the whole schedule — silently violates that for exactly the runs the dequeue exists to
save. E1-PHASE's fits were pairing-free, so RR6's dequeue was bookkeeping; **here the pairing
is the estimator**, and the registration did not say which control a re-run pairs with.

**Rule:** a VOIDed cell is re-run **together with a fresh control run of the same rung**, and
that pair replaces the block's ratio. If the fresh control itself fails a gate, **the block's
ratio is dropped and the median is taken over the remaining blocks**, with the drop recorded as
a finding. A median over fewer than two blocks is a VOID of that arm.

**The journal records the block index and a monotonic run sequence number on every run** — the
registration assumed this and never said it.

##### A7 — Gate A's read-back coalesces a failed evidence read into a passing value. Fix registered; the review's severity corrected.

`src/indexer/index.ts` (from `ef8d83e`):

```ts
cache_size: (await sql`PRAGMA cache_size`.execute(db)).rows[0]?.cache_size ?? 0,
mmap_size:  (await sql`PRAGMA mmap_size`.execute(db)).rows[0]?.mmap_size ?? 0,
```

**Accepted:** in an instrument whose stated role is "the direct analogue of Gate 0's content
hash", a failed evidence read must **throw**, not fall back to a value. `?? 0` reports
`mmap_size: 0`, which is the *expected* value for every retained arm.

**Severity corrected, because the review overstated it.** It claimed this "would pass Gate A on
3 of 4 arms". If the read-back returns no rows the `cache_size` read coalesces to `0` as well,
and `0` matches **no** arm's expectation (`-16000` / `-1048576` / `-2048`), so Gate A VOIDs. The
hole is narrower than claimed: it requires the `mmap_size` read alone to fail while
`cache_size` succeeds. The fix is adopted anyway — the principle does not depend on how narrow
the hole is — as a **red-first** change: a test that forces an empty read-back and asserts a
throw, before the `??` is removed.

##### A8 — `cache_spill` makes any arm-D penalty mechanistically ambiguous. Caveat registered.

VERIFIED: the spill threshold tracks the cache size (`sqlite3.c:57599`, `p->szSpill = mxPage`,
with the `res < p->szSpill` clamp at `:57602`). At 2 MiB (500 pages) a per-file transaction that
dirties more than ~500 pages spills to the WAL mid-transaction. **A `ρ_D ≥ 1.10` result
therefore mixes read-miss cost with spill mechanics and may not be reported as "read-path misses
corroborated".** Both are cache-size mechanisms, so arm D's role in the outcome table survives;
only the narration is constrained.

##### A9 — ordering, strengthened at zero cost.

A seeded shuffle of a block gives no positional balance: an arm can land in the thermally-hot
tail of two blocks out of three. With arm C removed from T9 (A1), the T9 cells are exactly
**3 arms × 3 blocks — a 3×3 Latin square**, which guarantees each arm occupies each position
exactly once. **T9 ordering is the Latin square**; T1 and T5 (2.7 s and 30 s per run) keep the
seed-4409 shuffle, where drift is not a credible confound.

##### A10 — a review claim REJECTED after verification, recorded so it cannot recirculate

The review states that `stdout_tail` will "now drop the `files:` line once `pragmas:` prints".
**False.** `eval/e1-common.mjs:329` is `stdout.trim().split('\n').slice(-3)`, and a phase-timed
run emits exactly three lines (`files:`, `phases:`, `pragmas:`), so all three are retained. This
was also confirmed empirically last session against the real `dist` binary. Nothing is dropped.

Two review nits are accepted as accurate but left unfixed, with reasons: `parseMebibytes` uses
`Number()`, so `0x10` and `1e3` pass the whole-number gate — no arm uses either form, and
tightening the parser is a product change with no bearing on this experiment; and
`--cache-size-mib 0` yields `PRAGMA cache_size = -0`, an untested edge no arm uses.

##### Revised design, superseding the corresponding rows above

| | registered `7ee03aa` | **as amended** |
|---|---|---|
| arms | A, B, C, D at both rungs | **A, B, D** at all rungs; **C at T5 only** |
| rungs | T1, T9 | **T1, T5, T9** |
| runs | 24 | **30** (27 + 3 for arm C) |
| cache multiples probed | 1.32×, 26.8× | **1.32×, 5.81×, 26.8×** |
| exponent test | `Δ ≥ 0.10` (degenerate) | **`b̂_write(B)` vs 1.35 and vs `b̂_write(A) − 0.20`** |
| connectivity check | `ρ_D(T9) ≥ 1.10` (no power) | **`ρ_D(T1) ≥ 1.10`** |
| T9 ordering | seeded shuffle | **3×3 Latin square** |
| machine time | ~2 h | **~87 min** (80 min T9 + 6 min T5 + 0.4 min T1) |

The amended design is **cheaper and answers more**: dropping arm C's two expensive rungs frees
~27 minutes, of which ~4.5 buys the middle rung.

Gate P2 (work identity) now requires identical `chunk_count` across **all runs at a rung** — 9
at T1 and T9, 12 at T5.

##### Direction of error, revisited against the review

The review's audit — that two of four claimed compensations were real, and that the two genuine
leaks were Δ's auto-fire and the inevitable post-hoc promotion of a "descriptive" slope — is
**accepted, and both leaks are now closed by the same change** (A2): the slope is promoted with
a threshold *before* the data, and Δ is deleted rather than demoted, so there is no degenerate
statistic left to reach for.

**What remains uncompensated, stated plainly.** Arm D is a real positive control at T1 and a
weak one at T9 (A4), so a CACHE-INERT verdict rests on a connectivity proof taken at the rung
where the mechanism is *least* likely to be operating. That is the best available design at
this cost, and it is a genuine limit rather than one I can argue away. The RESULT must carry it.

#### AMENDMENT 2 — 2026-08-13, pre-run, found while building the instrument

One change, and it TIGHTENS a rule rather than relaxing one. Found by a test that failed
against `planPending` and turned out to be wrong about the registration rather than about the
code.

**AMENDMENT 1 A6 has a gap: the control run is SHARED.** A6 says a VOIDed cell is re-run
"together with a fresh control run of the same rung, and that pair replaces the block's ratio".
But one control run at a `(tier, block)` is the denominator for **every** arm in that block.
Superseding it to repair one arm silently re-pairs the *untouched* arms against a control
measured at a different time — reintroducing, for them, exactly the drift the repair existed to
remove. A6 as written fixes one ratio by quietly breaking the others.

**Corrected rule: an unresolved VOID at `(tier, block)` re-runs that whole block-pair group** —
the control and every arm at that rung — control first, so each pair is measured adjacently.
This holds A6's actual guarantee (every ratio is a temporally adjacent pair) for every arm
rather than for one. It applies symmetrically when the *control* is the cell that voided.

**Cost:** one extra run per repair at the affected rung — ~9 minutes at T9, seconds at T1/T5.
Zero if nothing voids, which is the expected case.

**Direction of error:** none available. This changes which runs are *collected* after a gate
failure, never which runs are *kept* or how any statistic is computed, and it cannot be steered
toward an outcome because a VOID is not under the investigator's control. Recorded anyway,
because the program's rule is that a deviation from registered text is disclosed rather than
absorbed.

#### AMENDMENT 3 — 2026-08-13, mid-run, DATA-INFORMED — positional balance at T1 and T5

**This amendment was made after seeing data, and every run collected under the previous design
is discarded unscored.** That is the condition under which it is legitimate, and it is stated
first so no reader has to look for it. Seven runs existed when this was written — all of block
1's T1 and T5 cells, all Gate A clean. **None of them enter the score.** The schedule restarts
from zero.

**What was wrong.** AMENDMENT 1 A9 gave T9 a Latin square and left T1 and T5 on a seeded
shuffle, reasoning that "at 2.7 s and 30 s per run, ordering is not a credible confound there".
That rationale addresses **drift** — a slow trend across an ~80-minute stretch. It does not
address **warm-up**: the OS page cache over the tier's 13,330 source files is cold for the first
run at a rung and warm for the rest, and that asymmetry is fully present inside a 30-second
window. A9's argument is sound about the thing it names and silent about the thing that bites.

The seeded shuffle then happened to produce a schedule with almost no positional variance:

```
T1 b1 D A B   b2 D A B   b3 B D A     A:2,2,3  B:3,3,1  D:1,1,2
T5 b1 A C B D b2 D C A B b3 D C A B   A:1,3,3  B:3,4,4  C:2,2,2  D:4,1,1
T9 b1 A B D   b2 B D A   b3 D A B     A:1,3,2  B:2,1,3  D:3,2,1   (balanced)
```

**Arm C holds position 2 in all three blocks.** Arm B is third or fourth in all three.

**Why that is disqualifying rather than untidy.** Arm C is the source-contradiction tripwire
registered in AMENDMENT 1 A1: the source reading says mmap cannot serve write-cursor page
fetches, so arm C must be inert, and a non-inert ρ_C is "a finding in its own right". With C
nailed to one position for every block, a positional effect and the arm-C effect are **perfectly
collinear** — there is no contrast in the design that separates them. A ρ_C of 0.67 would be
unreadable: it would be equally consistent with "the source reading is wrong" and with "position
2 is fast". The tripwire would fire and carry no information. A covariate cannot rescue this;
zero variance means there is nothing to regress against.

**The correction.** T1 and T5 get cyclic Latin squares, the same construction A9 already
registered for T9. T9's ordering is **unchanged**.

- **T1** (3 arms, 3 blocks) balances exactly — each arm holds each position once. Its square is
  **rotated by one relative to T9's** so that an arm's position at T1 is not perfectly correlated
  with its position at T9 within the same block. Without the rotation, a position effect whose
  *magnitude* differs by rung (a cold-cache penalty is larger at T9 than at T1) would fail to
  cancel in the block slope; a constant multiplicative factor cancels in a log-log slope exactly,
  a rung-varying one does not.
- **T5** (4 arms, 3 blocks) **cannot** be balanced exactly, and the reason is arithmetic, not
  effort: the position-sum over 3 blocks is 3·(1+2+3+4) = 30 across 4 arms, so the mean is 7.5
  and no integer assignment reaches it. Further, if every arm is required to hold three
  *distinct* positions, the only available sums are 1+2+3=6, 1+2+4=7, 1+3+4=8 and 2+3+4=9 — so
  the multiset {6,7,8,9} is **forced** for any all-distinct design. The cyclic square attains it
  and is therefore optimal in its class. Residual imbalance is ±1.5 around the mean and, unlike
  the shuffle's, is not concentrated on one arm.

**What this does NOT change.** No threshold, no estimator, no gate, no arm definition, no rung,
no block count, and not T9's order. `e1-ab-score.mjs` is untouched. This changes only the order
in which cells are visited within a block.

**Direction of error.** Balancing removes a confound; it does not push ρ toward or away from any
registered cut. The one honest statement available: under the discarded design, arm B and arm C
both sat in the early-middle positions and the control sat first in the one block that ran, so
if warm-up is real the discarded data would have **flattered** arms B and C — i.e. it would have
made the page-cache lever look more effective than it is. The corrected design should therefore
be expected to produce ρ_B and ρ_C **closer to 1.0**, not further from it. That prediction is
registered here so the re-run can falsify it.

**What is NOT claimed.** That the positional effect is real. It is not demonstrated: block 1's
T5 showed position 1 slow (24.5 s), positions 2–3 fast (16.5 s), and position 4 slow again
(25.7 s), which pure warm-up does not predict — though position 4 was arm D, the starved-cache
arm, where slowness is hypothesis-consistent. n=1 and ambiguous. The justification for this
amendment is **not** that the effect exists; it is that if it exists and the design is
unbalanced, it is unfixable after the fact, while the remedy costs ~2 minutes because every
discarded run is at a cheap rung.

**Cost:** re-running 7 T1/T5 cells, ≈2 minutes of the 87-minute schedule.

---

#### E1-AB RESULT — 2026-08-13, scored, post-adversarial-review

**E1-AB is a probe.** It cannot confirm, overturn or soften E1's SUPER-LINEAR verdict, and it
cannot re-adjudicate E1-PHASE: H1 (write-localised, mechanism unidentified) stands. No pragma
is shipped on the strength of it. That framing is carried from the registration verbatim and is
not weakened by anything below.

**What ran.** 30/30 registered runs, 0 voids, 0 driver findings, `scoreable: true`. Every run
passed **Gate A** with the correct per-arm pragma echo. **Gate P2** is identical within every
rung — T1 3,679 chunks (9 runs), T5 16,529 (12), T9 73,359 (9) — and those counts come from
`readGraphCounts`'s `SELECT COUNT(*)` against `graph.db` (`eval/e1-common.mjs:493`), **not** the
pre-write stdout counter, so the Q1/SCALE trap does not apply to them. `db_bytes` is
byte-identical across arms at every rung. Every number in `eval/results/e1-ab-verdict.json`
reproduces from the raw journal to four decimals; the adversarial reviewer recomputed them
independently and so did the author.

**The registered outcome, as the scorer returned it.**

| statistic | value |
|---|---|
| `MECHANISM` | **CACHE_IMPLICATED**, level **PARTIAL** |
| `EXPONENT` | **EXPONENT_REDUCED** |
| `rho_B(T9)` | 0.5132 |
| `rho_D(T1)` | 1.2123 (lever-connectivity, A4) |
| `rho_C(T5)` | 0.6921 — fires A1's source-contradiction tripwire |

Within-block write-phase ratios (median of three blocks):

| arm | T1 | T5 | T9 |
|---|---|---|---|
| B (cache 1024 MiB) | 0.9774 | 0.6871 | 0.5132 |
| D (cache 2 MiB) | 1.2123 | 1.0085 | **0.8486** |
| C (mmap 1024 MiB) | — | 0.6921 | — |

Per-block write slopes and their split halves (medians):

| arm | b_write | spread | b_lo (T1→T5) | b_hi (T5→T9) |
|---|---|---|---|---|
| A (control) | 1.9331 | 0.0546 | 1.7629 | 2.1197 |
| B | 1.7127 | 0.0224 | 1.5218 | **1.8965** |
| D | 1.8243 | 0.1236 | 1.6557 | 1.9947 |

---

##### The four published claims, as corrected by the adversarial review

**Claim 1 — WEAKENED. Not a page-cache residency signature; a cache-size-coupled pager
mechanism with the channel unresolved.**

`rho_B` rises monotonically with the cache multiple — 0.9774 at 1.32×, 0.6871 at 5.81×, 0.5132
at 26.8× — and that dose–response is exactly what A3 added T5 to obtain. But the residency
reading it invites is refuted by the arm in the same experiment: `rho_D(T9) = 0.8486` means the
T9 response to cache size is **non-monotone**, with the *default* 15.63 MiB cache the slowest of
the three sizes tested. A residency model cannot produce that, and A4's own power arithmetic
predicted `rho_D(T9) ≈ 1.03`.

Two escapes were tested and both fail. "A 2 MiB cache frees RAM for the OS unified buffer cache"
is quantitatively dead: the A−D footprint difference is ≤13.6 MiB on a 16 GiB machine. "A 1 GiB
cache causes memory pressure" is contradicted by B being the *fastest* arm at every rung.

The registered reading is therefore: **the write-phase cost is coupled to SQLite's cache-size
setting, and the channel is unresolved between read-miss volume and spill/eviction policy.**
A8's spill caveat was written for arm D and applies symmetrically to arm B: at 1 GiB, mid-
transaction spill is structurally impossible, so arm B changes *two* things at once, not one.
The instrument carries no WAL, spill or RSS counters, so **this data cannot discriminate the two
channels.** Stated as a limit, not as a hedge.

**Claim 2 — STANDS. The cache does not explain the super-linearity.** This is the strongest
result in the experiment. With eviction physically impossible — arm B's 1 GiB cache is 2.45× the
entire T9 database — the write slope is still 1.7127, and the top segment `b_hi(B) = 1.8965`
remains near-quadratic. Removing eviction entirely removes roughly a fifth of the excess
exponent.

The category-error concern about comparing a three-rung write-phase slope to E1's nine-rung
duration threshold of 1.35 is real and was checked rather than waved off. On E1's *own*
estimand — OLS of `ln(duration_ms)` on `ln(chunk_count)`, median of three blocks — the control
recomputes to **1.7625**, reproducing E1's `b = 1.7529` to 0.01, and arm B recomputes to
**1.5498**, still 0.20 above the threshold. The comparison survives on a like-for-like basis.
Both cross-checks are published here so the claim does not rest on the write-phase basis alone.

**Claim 3 — STRENGTHENED, and it is the most interesting number in the run.** `rho_D(T9) =
0.8486` carries **no registered flag**: A4 demoted `rho_D(T9)` to an unthresholded working-set
probe, and the scorer accordingly keys `D_HELPS_ANOMALY` to T1 only (`eval/e1-ab-score.mjs:224`),
where D correctly hurts at 1.2123. So the verdict JSON reads `findings: []` while the single
most model-breaking observation sits in the level table unflagged. **That is a gap in the
registered rule set, recorded here rather than repaired retroactively.** A5's INTERFERENCE text
says "any arm", which collides with D's positive-control role; the scorer's B-only reading is a
post-hoc resolution and is recorded as such.

**Claim 4 — WITHDRAWN AS DRAFTED. The AMENDMENT 3 prediction was satisfied, not falsified.**
The author's first write-up said the prediction "was not confirmed". That is wrong in direction.
Comparing block 1 to block 1 against the quarantined runs, every comparable statistic moved
**toward** 1.0 exactly as registered: `rho_C` 0.6720 → 0.6921, `rho_B(T5)` 0.6710 → 0.6871,
`rho_B(T1)` 0.9279 → 0.9774. The honest statement is that the prediction was **directionally
satisfied and quantitatively empty** — every move is ≤0.05, inside the blocks' own spread
(B/T1 spread 0.079, B/T5 0.066), so it was too weak to adjudicate the positional question it was
registered to test. A prediction that cannot fail at the effect size available is not a risk.

---

##### The mmap tripwire resolves — and re-points the mechanism

`rho_C(T5) = 0.6921` against `rho_B(T5) = 0.6871`. The two arms land on top of each other.

A1 argued from source that mmap cannot serve write-cursor page fetches. **That reading is
correct and is re-verified here**: `btreeCursor` gives write cursors `curPagerFlags = 0`
(`sqlite3.c:77886`). It was *incomplete*. The immediately following branch gives read cursors
`PAGER_GET_READONLY` (`:77889`), and FTS5 fetches segment blocks through
`sqlite3_blob_open(pConfig->db, ..., 0, &p->pReader)` in `fts5DataRead` (`:251470`) — flags `0`,
a **read-only** blob handle, and therefore mmap-eligible *inside a write transaction*.

So arm C was never inert, and nothing in the source reading was wrong. The traffic mmap
accelerates is read traffic occurring during the write phase, and the coincidence of `rho_C` and
`rho_B` at T5 points both arms at the same population: **FTS5 segment merge reads, not B-tree
insertion traversals.** The tripwire did its job — it caught an incomplete source argument that
three reviews had passed over.

---

##### Residual weaknesses, recorded

1. **EXPONENT_REDUCED fired by 0.0204.** `b_A − b_B = 1.9331 − 1.7127 = 0.2204` against
   `SLOPE_MATERIAL_DELTA = 0.20`. The threshold's own docstring
   (`eval/e1-ab-score.mjs:57-63`) justifies 0.20 as "deliberately blunt … a marginal call
   decided by an unvalidated noise model is worse than a bar that can only fire on an obvious
   effect", citing σ ≈ 0.0085. On that σ the *bar* is ~20σ but the *outcome* is ~2.4σ. This is
   the marginal call the bar existed to refuse. **EXPONENT_REDUCED is reported at its registered
   value and simultaneously flagged as weakly attained.** Claim 2 does not depend on it —
   `b_hi(B) = 1.8965` and the duration-basis 1.5498 carry that claim.
2. **A3's corroborating curvature reading also fires narrowly.** `b_hi(A) − b_hi(B) = 2.1197 −
   1.8965 = 0.2232` against its 0.20 bar, a margin of 0.0232, and it **fails in block 2**
   (0.1609). A3 registered this as corroborating and non-gating; it corroborates weakly.
3. **The connectivity cell is the one the scorer flagged as noisy.** `rho_D(T1)` carries
   `spread_finding: true` (blocks 1.566 / 1.154 / 1.212, spread 0.412). A4 keys the entire
   mechanism classification on this cell. Connectivity is nonetheless robust: the *minimum*
   block ratio, 1.154, still clears the 1.10 bar. The finding is raised in the JSON and printed
   nowhere by the reporter — an instrument defect, logged.
4. **Both Gate 3 retakes retained the warmer passing attempt** (D/T1/b2 and A/T1/b3), and both
   retentions move *toward* connectivity firing: attempt 1 of D/T1/b2 would have given a ratio of
   1.0795, **below** the bar. Recomputed under first-attempt substitution the median is 1.1719 —
   still fires. Reported per the registered Gate 3 reconciliation clause, with the bias direction
   named.
5. **T5 is optimal, not balanced, and the tripwire arm drew the warm end.** The Latin square
   gives arm C positions 4/3/2 — position-sum 9, the maximum of the forced `{6,7,8,9}` multiset —
   so C never ran first at T5. AMENDMENT 3's arithmetic proves the multiset is forced; it says
   nothing about which arm receives the 9, and the amendment should not have described T5 as
   balanced. Empirically bounded at ≲3% against a 31% effect (arm B ran first at T5/b2 and kept
   its full effect), so `rho_C` is not threatened.
6. **AMENDMENT 3 understated prior exposure.** It says seven runs existed. A full diagnostic
   A/T9 run (540,136 ms) had also been observed before the restart, disclosed only in
   `eval/results/discarded-amendment3/README.md`. The ordering flaw was knowable before the run
   and was acted on only after data showed arm C fast. The discard itself is verified complete
   and honest — same Gate 0 hash, clean timestamp partition — but the disclosure belonged in the
   amendment, not only in the quarantine.

---

##### What this licenses, and what it does not

**Licensed:** the write phase's cost is coupled to SQLite's cache-size setting, strongly and
with a monotone dose–response in corpus size; and **that coupling does not account for the
super-linear exponent**, which survives at 1.7127 (write basis) / 1.5498 (duration basis) with
eviction made impossible.

**Not licensed:** any statement that page-cache residency *is* the mechanism; any channel
attribution between read-miss volume and spill policy; any reading of `rho_D(T9)`; any pragma
change shipped to `mast`. H1 stands unchanged — write-localised, mechanism unidentified.

**Successor probe.** The FTS5 finding gives it a target the previous rounds did not have: an
arm that isolates FTS5 segment-merge read traffic, and an instrument that carries WAL, spill and
RSS counters so the two candidate channels can be told apart. `rho_D(T9) < 1.0` is its second
target and needs an explanation before any cache story is published.

Adversarial review in full: `eval/results/e1-ab-results-review.md`. Every source claim above was
re-verified against the amalgamation and the scorer by the author before being recorded here.

---

#### E1-FTS PRE-REGISTRATION — 2026-08-14, pre-run, post-adversarial-design-review

**The question. H-DELETE-SCAN:** is the per-file FTS5 delete-scan at
`src/graph/populate.ts:318-319` the mechanism behind the write phase's super-linear exponent?

This supersedes the merge hypothesis the author drafted first. That draft is recorded here as
withdrawn, not quietly replaced: it proposed that FTS5 segment merging produced the exponent, and
the adversarial design review killed it on the source before a line was written —
`fts5IndexAutomerge` schedules work proportional to leaves-flushed × level-count
(`sqlite3.c:255626-255645`, `FTS5_WORK_UNIT = 64` at `:250651`), which is amortised O(N log N) and
can contribute perhaps +0.05–0.1 to an exponent, never the +0.9 at issue. The same review found
that the author's proposed `fts_ms` timer would have missed FTS5's segment writes entirely, since
those happen at COMMIT via `fts5SyncMethod` (`:262278`; `xCommit` is a documented no-op at
`:262302`) rather than inside the INSERT — a structural bias toward a **false null**.

##### Epistemic status, stated before the design so it cannot be overclaimed afterwards

**This is not a discovery probe. The mechanism is already established statically.** What is not
established is its magnitude *inside a build*, and whether removing it removes the exponent. That
is what this experiment measures, and it is all it measures.

The design was chosen **after** seeing the evidence below. That is legitimate here only because
the evidence is static and observational — it is prior evidence, not a result of this experiment,
and it is published in this registration so a reader can discount it appropriately. No run
collected under this registration informed its design.

**Prior evidence, verified independently by the author before registering:**

1. **The deletes are full table scans.** `EXPLAIN QUERY PLAN` against the retained
   `phase-run-T9-r3/graph.db` (opened plain-readonly, never `?mode=ro&immutable=1`):

   | statement | plan |
   |---|---|
   | `DELETE FROM chunk_fts WHERE file_path = ?` | `SCAN chunk_fts VIRTUAL TABLE INDEX 0:` |
   | `DELETE FROM identifier_fts WHERE file_path = ?` | `SCAN identifier_fts VIRTUAL TABLE INDEX 0:` |
   | `DELETE FROM chunks WHERE file_path = ?` | `SEARCH chunks USING INDEX idx_chunks_file_path` |

   The ordinary table uses its index; FTS5 cannot, because `xBestIndex`
   (`sqlite3.c:260775-260860`) will not consume an equality constraint on an ordinary column.

2. **They run unconditionally on the cold path**, `populate.ts:318-319`, with no guard on whether
   the file was previously indexed. The comment there reads "Delete existing rows by file_path
   (UNINDEXED column, supported by FTS5)" — true about support, silent about cost, and that is
   where this hid through E1, E1-PHASE and E1-AB.

3. **On a cold build every one of those scans matches zero rows**, because nothing for that file
   has ever been written. The work is not merely quadratic; it is quadratic and entirely wasted.

4. **The quadratic model predicts the measured write times.** With `N` = files and `F` = FTS5
   bytes, scan work over a cold run is `SUM_i F*(i-1)/N ≈ N*F/2`. Fitting the single constant `k`
   in `write_ms ≈ k*N*F` on **T9 alone** and predicting the rest:

   | tier | N | measured write_ms | predicted | err |
   |---|---|---|---|---|
   | T1 | 656 | 1,452 | 1,225 | −15.6% |
   | T3 | 1,393 | 4,555 | 5,504 | +20.8% |
   | T5 | 2,880 | 23,725 | 23,695 | **−0.1%** |
   | T7 | 5,976 | 97,660 | 102,015 | +4.5% |
   | T9 | 13,330 | 500,885 | 500,885 | 0.0% (fitted) |

   The linear null model `write_ms ≈ k*chunks` is wrong by **+1630%** at T1. The quadratic model's
   own implied exponent, `ln(N*F ratio)/ln(chunk ratio) = 6.035/2.993 = 2.02`, sits beside
   E1-PHASE's measured `b_write = 1.9685`. T1 and T3 deviate in the direction and roughly the
   magnitude expected, since fixed per-file work still dominates before the quadratic term does.

   **This table is warm, readonly, out-of-transaction prior evidence.** In-build scans run inside
   `BEGIN IMMEDIATE` against a cache that is missing. The shares are order-of-magnitude priors and
   are explicitly **not** registered as thresholds.

5. It retro-explains E1-AB. A scan is read-cursor traffic and therefore mmap-eligible inside a
   write transaction (`sqlite3.c:77889`, `:251470`), which is why arm C was not inert and why the
   cache dose-response tracked database size.

##### The arms

| arm | what it does | role |
|---|---|---|
| **A** | control — the exact production path | every ratio is taken against this arm inside its own block |
| **G** | identical, except the two DELETE statements at `populate.ts:318-319` are skipped under a driver-injected flag | the causal test, and the fix rehearsal |

**Arm F — "skip FTS5 writes entirely" — is registered as CUT, with the reason.** It was the
author's proposed causal arm and it is unusable: it shrinks the database by ~69%, and E1-AB
established that write time is coupled to database size, so arm F would confound "FTS work
removed" with "smaller database" in the direction that **flatters** a positive result. Arm G has
no such confound: skipping deletes that match nothing leaves the finished database
**byte-identical**. The author believed no confound-free causal arm existed; the review found one.

##### Ladder, blocks, and the estimator

**T1/T3/T5/T7/T9 × 3 blocks**, both arms interleaved within a block. Five rungs, not E1-AB's
three: a three-rung slope is determined by three points with no residual freedom and no honest
interval, which E1-AB's own results review named as a weakness. Not E1's nine, because the
marginal rungs cost more than the precision buys here.

Blocks are contiguous and the primary estimator is a **within-block ratio**, so drift cancels by
construction — inherited from E1-AB unchanged. Within-block arm order is a **Latin square**
(AMENDMENT 3's lesson, carried forward: with 2 arms × 3 blocks exact positional balance is not
attainable, so the order alternates and the imbalance is recorded rather than described as
balanced).

##### What is instrumented

Four spans **tiling** the write phase, each **timed directly — none by subtraction**:

- `fts_del_ms` — the two DELETE statements
- `fts_ins_ms` — the two batched INSERT loops
- `commit_ms` — the per-file transaction commit, where FTS5's segment flush actually happens
- `rest_ms` — chunks, symbols, imports

Timed directly because a single blended `fts_ms` would mix a population with `b ≈ 2` (the deletes)
against a roughly linear one (the inserts), and because `rest = write − fts` would silently absorb
any cost the other timers missed — which is exactly how the author's first design would have
produced a false null. The existing `phaseMs` record (`src/indexer/index.ts:81`) is unchanged;
these are additive.

Timer overhead is quantitatively closed, not assumed: 43.5 ns per `Date.now()`, 0.016% of T1's
write and 0.0009% of T9's, slope bias < 0.001. It was worth checking because an overhead that is a
larger fraction of a small rung's time biases the slope, which is the one quantity being measured.

##### Gates

- **Tiling ≥ 0.95** per run — the four spans must account for the write phase. The analogue of
  E1-PHASE's `GATE_P_FLOOR` (`eval/e1-phase-schedule.mjs:32`), same floor and same reason.
- **`db_bytes(G) == db_bytes(A)`** per rung. This is what makes arm G confound-free, so it is a
  gate and not an observation; a mismatch voids the arm.
- **Gate 0 (binary identity) and Gate 3 (dual clocks)** inherited from E1-PHASE unchanged.
- **Fresh binary ⇒ no absolute-time comparison** with E1, E1-PHASE or E1-AB records. Both arms
  share this binary, which is what keeps the comparison internally valid. E1-AB's registered
  consequence applies verbatim.

##### Registered outcomes

**MECHANISM_IDENTIFIED** iff all four hold:

1. `b_fts_del ≥ 1.6`
2. `fts_del/write ≥ 0.50` at T9
3. `write_A/write_G ≥ 2` at T9
4. `b_write(G) ≤ 1.35` — the immutable E1 linearity threshold, reused unchanged

**PARTIAL** iff the decomposition conditions (1-2) hold but `b_rest > 1.35`, or the intervention
conditions (3-4) fail. **PARTIAL is a first-class outcome, not a degraded one**: `chunks` carries a
TEXT primary key whose autoindex is a plausible second super-linear term, and if it is real then
removing the delete-scan will reduce the exponent without flattening it. Registered in advance so
that result cannot be reported as a disappointment or as a null.

**NULL** iff `b_fts_del < 1.6`. This would mean the static model above is wrong about in-build
behaviour, which is a publishable finding in its own right.

**Instrument-validity check, adjudicating nothing:**
`|(write_A − write_G) − fts_del_A| ≤ 0.15 · fts_del_A` at T7 and T9. Two independent measurements
of the same quantity; disagreement condemns the instrument, not the hypothesis.

##### Direction of error, and what this cannot license

**Direction of error.** The author arrives at this experiment already believing the hypothesis, on
the strength of a model that fits four rungs. That is the condition under which a favourable
result is least informative and an unfavourable one most informative. The registered NULL band
exists to be reachable, and the honest expectation is recorded here: **MECHANISM_IDENTIFIED is
expected.** If it is returned, it confirms a prediction made in advance; it is not a discovery
made by the experiment.

**This cannot license:** any statement about the *update* path (arm G's condition is cold-build
only — an incremental reindex genuinely must delete, and for that path the delete-scan is a real
cost needing a different fix); any claim that the exponent is now *explained* if PARTIAL is
returned; any re-adjudication of E1's SUPER-LINEAR verdict, which stands regardless; and any
explanation of E1-AB's `rho_D(T9) = 0.8486`, which the scan mechanism does not obviously produce
and which remains open.

**Not shipped on the strength of this.** The fix — guarding both DELETEs on whether the file's
`files` row previously existed, which the F12 monotonic-guard SELECT at `populate.ts:216-220`
already knows — is a separate change, verified by re-running **E1's full 9-rung ladder** against
the committed scorer and the immutable 1.35 threshold. Arm G is a rehearsal of that guard, not the
guard itself.

**Cost:** 30 runs, ≈ 45–50 minutes.

**Design review:** `eval/results/e1-fts-design-review.md`. It is the reason this registration
exists in this form: it withdrew the author's mechanism, found the real one, caught a false-null
bias in the author's proposed instrument, and replaced an unusable arm with a confound-free one —
all before any code was written.

##### AMENDMENT 1 — 2026-08-14, pre-run, instrument-informed, no data collected

**Four spans become six.** `txn` and `lock` are added. Nothing else in the registration changes:
the arms, the ladder, the blocks, the estimator, the gates, the registered outcomes and every
numeric threshold stand exactly as written above.

**Why.** The registration named four spans and asserted they tile the write phase. Built and run
against a 56-file smoke corpus, they tiled it to **0.746** — against a registered gate of 0.95.
The unattributed remainder was **0.72 ms per file**, and it decomposes into two things the design
simply forgot:

| span | what it is | share of that smoke build's write phase |
|---|---|---|
| `txn` | connection checkout, the two `busy_timeout` pragmas, `BEGIN IMMEDIATE` | 6.8% |
| `lock` | `structure.lock` acquire + release, once per 16-file batch (F1) | 13.2% |

With both added the same build tiles to **0.989**.

**Why this mattered more than a failed gate.** Both are roughly constant per file (`txn`) or per
batch (`lock`), so their share *shrinks* as the ladder climbs — projected at ~33% of T1's write
phase and ~2% of T9's. The registered gate would therefore have voided **T1**, the cheapest rung
and the one that anchors the growth exponent, while passing T9, the rung where the answer is least
in doubt. A gate that fails only where the measurement is hardest is worse than no gate.

The second consequence is the one that would have been invisible. Had the remainder been swept
into `rest` — the obvious repair, and the one a subtraction-based design would have made
automatically — then `b_rest` would have carried a per-file constant. A constant per file is
linear in `N`, which pulls any fitted exponent toward 1.0, so `b_rest > 1.35` — the **PARTIAL**
condition — would have been biased toward not firing. The registration's ban on computing spans by
subtraction is what prevented that, and it prevented it before any data existed.

**No registered statistic changes meaning.** `rest` was already defined as "chunks, symbols,
imports" and timed directly, so `txn` and `lock` were never inside it — they were unattributed,
not misattributed. `fts_del/write` keeps `phaseMs.write` as its denominator. This amendment adds
visibility; it moves nothing between existing buckets.

**Legitimacy.** No run has been collected under the four-span design, scored or otherwise. This is
instrument construction, not a data-informed redesign, and so does not incur E1-AB AMENDMENT 3's
obligation to discard prior runs — there are none to discard.

**Clock: `performance.now()`, not `Date.now()`.** The registration costed the timers against
`Date.now()` at 43.5 ns. Measured on this machine, `Date.now()` costs 65.3 ns/call and yields only
**33 distinct values across a 200,000-call burst** — roughly 1 ms granularity. `performance.now()`
costs **34.8 ns/call** with full sub-microsecond resolution. At T1 a per-file FTS delete runs well
under a millisecond, so `Date.now()` would round each one to 0 or 1 and turn the anchor rung into a
coin flip. The substituted clock is both cheaper and less biased, so the deviation runs in the
direction of a harder test. Overhead with six spans: ~12 timer calls per file ≈ 418 ns, which is
0.019% of T1's write phase and 0.001% of T9's.

**Not evidence of anything.** The smoke build above is 56 files — two orders of magnitude below
T1. Its span shares (`fts_del` at 4.6%) are reported here to justify the amendment and for no
other purpose. They are not a prior, not a prediction, and not comparable to any rung.

##### AMENDMENT 2 — 2026-08-14, pre-run, no data collected

**`b_rest ≤ 1.35` is a fifth blocking condition on MECHANISM_IDENTIFIED.** The registration's two
outcome clauses contradict each other and this resolves the contradiction before any data exists.

The MECHANISM_IDENTIFIED clause reads "iff all four hold" and lists conditions 1-4, which do not
include `b_rest`. The PARTIAL clause reads "iff the decomposition conditions (1-2) hold but
`b_rest > 1.35`, **or** the intervention conditions (3-4) fail." Those disagree about exactly one
case: all four registered conditions hold *and* `b_rest > 1.35`. The first clause returns
MECHANISM_IDENTIFIED; the second returns PARTIAL.

**Resolved in favour of PARTIAL**, because the PARTIAL clause is the one that mentions `b_rest` at
all, and because the substantive reason PARTIAL was registered as first-class says the same thing:
`chunks` carries a TEXT primary key whose autoindex is a plausible second super-linear term, and a
surviving second term means the exponent has been *reduced*, not *explained*. Reporting that as
MECHANISM_IDENTIFIED would claim the stronger of the two.

The resolution is recorded because it is an interpretation of ambiguous registered text, and the
direction it resolves in is the one **less** favourable to the author's expected outcome. It was
found by a test written against the registration's words rather than against the implementation —
`eval/__tests__/e1-fts-score.test.mjs`, "returns PARTIAL when a second super-linear term survives
in rest" — which is why it surfaced before the run rather than during the results review.

**One further reading fixed here, also before data.** The registration names the condition
"`fts_del/write ≥ 0.50` at T9" without saying whether that is the median run's own share or the
median of the three per-run shares. Both are computed and both are reported; the one that
**adjudicates** is the median run's own share, following E1-PHASE's H1 precedent. Fixing it in code
now removes the option of choosing once the two are seen to disagree.

##### AMENDMENT 3 — 2026-08-14, mid-run, instrument defect. No scored run affected.

**The span and the clock in a record must come from the same attempt.** They did not, and the
first schedule produced one false VOID because of it.

**The defect.** Gate 3 retakes a cell up to three times. When every attempt misses,
`selectFitted` (`eval/e1-schedule.mjs:187-191`, E1's, unchanged and unchangeable) retains the
**first** attempt's clock and phases. The driver paired that with `run.write_spans` — the **last**
attempt's. The tiling gate then divided one attempt's spans by another attempt's write phase.

It fired on `G#T3#b1`, the only cell in the schedule that missed Gate 3 on all three attempts.
The gate recorded `tiling 0.7318` and voided the run. Recomputed from that same void record, the
attempt's own spans sum to 2,513.0 ms against its own write phase of 2,527 ms — **0.9945**. The
run was fine; the gate was comparing two different runs. In the opposite direction the same defect
would have produced a false PASS.

**No scored run is affected, and the verification is reproducible rather than asserted.** All 29
retained runs have `gate3.ok === true`, so `selectFitted` returned the current attempt for every
one of them and the fitted spans are the same object either way. Recomputing tiling from each
retained record directly gives a minimum of **0.9937** across all 29. Check both from
`eval/results/e1-fts-runs.jsonl`:

- `runs.filter(r => !r.gate3.ok).length === 0`
- `min(sum(values(r.write_spans)) / r.write_ms) === 0.9937`

**This does not trigger E1-AB AMENDMENT 3's discard obligation.** That obligation exists because a
design changed *after seeing data* can be shaped by it, so the data collected under the old design
must go. Here the change is provably a no-op on every run that was retained — not "we believe it
made no difference", but "the branch it alters was never taken by any scored run". The one cell it
did alter was voided and scored nothing. The voided pair re-runs, which is what the estimator
requires anyway: `G#T3#b1`'s partner `A#T3#b1` is re-run with it so the pair stays temporally
adjacent.

**What it cost to find.** Nothing was lost, but only because the gate failed loudly and the void
record retained the measurement that disproved it. A tiling gate that had silently passed the
inverted case would have put a mis-scaled `fts_del/write` into the record with no trace.

##### AMENDMENT 4 — 2026-08-14, post-run, summary defect. No scored run affected.

**Interruption detection must be repair-aware.** After the voided `T3/b1` pair was repaired, the
summary reported **five INTERRUPTED attempts that never happened**.

`orphanedAttempts` (`eval/e1-schedule.mjs:135-157`, E1's) counts every `attempt_start` for a cell
across the whole journal and subtracts the attempt count of the **last** terminal record. That is
correct for a schedule in which each cell runs once. E1-FTS is the first schedule here to both
repair pairs and resume, so a cell that legitimately ran twice — first pass, then repair — had
both passes' attempts charged against only the second pass's count, and the first pass's attempts
were reported as interruptions.

**Not cosmetic.** Orphan counts feed `remainingAttempts`, which SHRINKS a resumed cell's Gate 3
retake budget; at the limit it reaches zero and the driver voids the cell with
`retake_cap_exhausted_by_interruptions` — a cell voided for interruptions that did not occur. It
did not bite this schedule, because orphans are computed once at the start of an invocation and
the repair ran within the same one. Any subsequent resume would have hit it.

`ftsOrphanedAttempts` applies E1's own rule per SEGMENT instead of per key: each terminal record
closes a segment and consumes the last `n` starts in it; leftovers were genuinely killed, and
starts still pending at the end of the journal were genuinely interrupted. `e1-schedule.mjs` is
E1's scored instrument and is **not** modified — the defect there is recorded here rather than
patched in place, and E1-AB's completed record is unaffected because that schedule was never
resumed after a repair.

**No scored run is affected.** Orphan counts touch only the findings text and the retake budget of
runs not yet taken. The 30 scored records are byte-identical. The corrected summary reads
`0 interrupted`, with the two findings that are real: `VOID RESOLVED G#T3#b1` and
`SUPERSEDED A#T3#b1`.

#### E1-FTS RESULT — 2026-08-16, scored, post-adversarial-review

**MECHANISM_IDENTIFIED.** The per-file FTS5 delete-scan carries the write phase's super-linear
exponent. All five conditions met; the smallest margin is 8x.

##### What ran

30/30 runs, `scoreable: true`. Gate 0 pinned `dist` at `d863c5d5…`; Gate 1, Gate 3 and Gate P
inherited and clean; minimum tiling **0.9937** against the 0.95 floor; chunk counts identical
across both arms at every rung; 15/15 database-identity pairs equal. One cell voided and was
repaired (AMENDMENT 3); interruption reporting was corrected (AMENDMENT 4). Neither touched a
scored record.

##### The registered conditions

| condition | measured | bar | margin |
|---|---|---|---|
| `b_fts_del` | **2.3454** | >= 1.6 | 1.47x |
| T9 `fts_del/write` | **91.7%** | >= 50% | 1.83x |
| T9 `write_A/write_G` | **15.96** | >= 2 | 7.98x |
| `b_write(G)` | **1.0956** | <= 1.35 | |
| `b_rest` | **1.1768** | <= 1.35 | |

Span shares of arm A's write phase, by rung: `fts_del` 27.8% -> 43.4% -> 72.5% -> 84.7% -> 91.7%.
Intervention ratio: 1.368 -> 1.835 -> 4.020 -> 7.620 -> 15.957 (T9 blocks 15.417 / 16.419 / 15.957;
spreads 13.5% / 7.5% / 11.5% / 3.0% / 6.3%). End-to-end at T9: 499.2 s -> 58.8 s, 8.5x — smaller
than the write-phase figure because parse then dominates.

##### Five claims the adversarial review corrected

The review is `eval/results/e1-fts-results-review.md`. It reimplemented the fold, the OLS, the HC3
intervals, every median and all fifteen block ratios independently and matched the verdict exactly.
The verdict survived; five statements about it did not, and every correction below was
re-verified against source and journal before being recorded.

1. **"Byte-identical" was false — it is byte-COUNT identical.** The gate reads
   `statSync(...).size` (`eval/e1-common.mjs:587`). Content was digested only on the 56-file smoke
   corpus (`src/graph/__tests__/write-spans.test.ts`). **No scored run's FTS content was ever
   verified**, and the schedule does not even record a `chunk_fts` row count. Size equality across
   15 pairs spanning five orders of magnitude is strong evidence for arm G's premise; it is not the
   proof the original wording claimed.

2. **"The same quantity by two independent routes" is refuted by this experiment's own journal.**
   Arm G is faster at NON-delete work too. Median non-delete spans, arm A minus arm G: T5 **+64 ms**,
   T7 **+1,925 ms**, T9 **+7,858 ms**; `rest` alone at T9 is 7,090 ms (A) against 4,166 ms (G),
   **+70%**. So `write_A - write_G` is the delete span PLUS a real secondary effect — almost
   certainly page-cache eviction by the scans, which is what E1-AB's cache dose-response predicts.
   The validity check passed honestly at 2.1%, because the spillover is small relative to the span;
   the description of what it demonstrated was wrong, and the spillover itself went unreported.

3. **"Replicates E1-PHASE on a different binary" overstated it.** The chunk counts are
   digit-identical (3679 / 7761 / 16529 / 34691 / 73359): same corpus manifest, same tier trees,
   same machine, same imported estimator. `b_write(A) = 1.9379` against E1-PHASE's `1.9685` is a
   **repeatability check under instrument perturbation** — worth having, since levels moved up to
   11% while the slope held — but not an independent replication.

4. **The interval was quoted for something the scorer disclaims.** The claim "the model's 2.02 lies
   outside [2.303, 2.388]" leans on an HC3 interval that this scorer explicitly registers as
   "context, not a bar", and that is anticonservative here: 15 runs at 5 rungs have residuals
   clustered by rung. **The conclusion survives on better evidence.** Every adjacent local slope of
   `ln(fts_del)` on `ln(chunks)` — 2.270, 2.536, 2.222, 2.253 — exceeds 2.02. The weakest local
   slope beats the model without any interval being invoked.

5. **`b_rest = 1.1768` is the spillover-contaminated number.** It is arm A's, and finding 2 shows
   arm A's `rest` carries eviction cost the deletes caused. Arm G's uncontaminated rest exponent is
   **1.0124** — a materially stronger result, and it was sitting in the journal unreported.

##### What stands

The intervention result is unaffected by finding 2: the spillover is a causal CONSEQUENCE of the
deletes, so `write_A/write_G` remains the honest measure of what removing them buys. What finding 2
costs is the decomposition's precision, not the intervention's validity — `fts_del` slightly
under-states the deletes' full cost rather than over-stating it, which is the safe direction.

The monotone climb of the intervention ratio across five rungs cannot be produced by a constant
factor: a constant shifts a log-log intercept and leaves the slope alone. AMENDMENT 2's
contradiction was real and was resolved toward the stricter reading. AMENDMENT 3's repair is
provably immaterial, and the repaired pair drifted TOGETHER — its ratio, 1.803, sits inside the
range of the blocks it was compared against, which is the within-block design demonstrating itself.

##### What this does and does not license

**Licensed.** The delete-scan is the mechanism. The fix — guarding both DELETEs on whether the
file's `files` row previously existed, which the F12 SELECT at `populate.ts:216-220` already
knows — is worth building.

**NOT licensed.** Any claim about the UPDATE path, where the deletes are real work and need a
different fix. Any re-adjudication of E1's SUPER-LINEAR verdict, which stands. Any explanation of
E1-AB's `rho_D(T9) = 0.8486`, still open. Any statement that arm G's content was verified. And —
the top residual threat — **any extrapolation beyond T9 or to a different size-to-cache ratio.**
The T3->T5 local slope of 2.536 against neighbours near 2.23 indicates a regime change, plausibly
the FTS tables outgrowing the 15.6 MiB page cache, so the fitted 2.35 blends two regimes.

**MECHANISM_IDENTIFIED was registered in advance as the EXPECTED outcome.** This confirms a
prediction; it discovers nothing. The informative content is in the corrections above and in the
magnitude, which exceeded the prediction that motivated the design.

##### Residual weaknesses, ranked by threat to the conclusion

1. **T3->T5 curvature, unexplained.** Limits extrapolation. Does not threaten the mechanism.
2. **Content identity never verified on a scored run.** Size is a proxy. Cheap to close: record
   `chunk_fts` / `identifier_fts` row counts, or a content digest, per run.
3. **Spillover unmeasured as such.** The eviction effect is visible in the spans but was never
   given its own estimate.
4. **The HC3 interval is anticonservative** and should not be quoted for anything. A cluster
   bootstrap over blocks would be the honest interval.
5. **`b_fts_del` exceeds the motivating model by 0.33** and the gap is unexplained. Candidate:
   FTS5 segment-count growth adding per-scan overhead beyond raw bytes. Untested.

##### ADDENDUM — 2026-08-16: two review weaknesses closed, no re-run required

Residual weaknesses 2 and 3 above are now instrumented. Neither changes the verdict.

**3 — the eviction spillover now has its own estimate.** Arm A's non-delete spans minus arm G's,
within a block, medianed:

| rung | spillover | share of the intervention delta | where it lands (top 3) |
|---|---|---|---|
| T1 | **-20 ms** | -5.3% | noise-dominated |
| T3 | 228 ms | 10.3% | commit 133, fts_ins 45, rest 41 |
| T5 | 540 ms | 3.4% | rest 193, fts_ins 157, commit 88 |
| T7 | 2,020 ms | 2.5% | fts_ins 736, rest 677, commit 435 |
| T9 | **7,928 ms** | **1.8%** | rest 2,924, fts_ins 2,251, commit 1,936 |

**This strengthens the decomposition rather than weakening it.** The spillover grows in absolute
terms but SHRINKS as a share of the intervention delta, from 10.3% at T3 to 1.8% at T9 — so at the
rung that adjudicates, **98.2% of `write_A - write_G` is the directly-timed delete span**. The
review's finding 2 stands as a correction to the *description* of the validity check; its
quantitative effect on the T9 result is under two percent.

T1's value is NEGATIVE (-20 ms, -5.3%), which the eviction story does not predict. It is reported
rather than clamped: at 1.5 s of write phase the rung is noise-dominated, and a contradiction that
only appears where the signal is smallest is the expected shape of noise rather than of a rival
mechanism. Recorded so a future reader can check that reading rather than take it.

**2 — FTS content identity is now recorded per run.** `readGraphCounts` captures
`chunk_fts_count` and `identifier_fts_count` (read AFTER the timed run, so the measurement is
untouched), and the database-identity gate compares them. For an arm that differs only by skipping
DELETEs, extra or missing rows are the sole way content can diverge, so these counts are necessary
and sufficient — a full digest would be stronger but answers a question this arm cannot pose.

**The completed schedule is not retroactively graded against it.** Those 30 runs recorded no
counts, and a check added afterwards must not fail an experiment that never ran under it. The gate
reports `content_not_recorded` and `content_checked: false`, and the re-scored verdict states
plainly: **content verified on 0 of 15 pairs.** Weakness 2 is therefore closed for future
schedules and remains open, and openly labelled, for this one.

##### Not shipped on the strength of this

Arm G is a rehearsal of the guard, not the guard. The fix is a separate change, verified by
re-running **E1's full 9-rung ladder** against the committed scorer and the immutable 1.35
threshold.

---

#### E1-VERIFY RESULT — 2026-08-17, the guard against E1's own ladder

**HOLDS.** E1's ladder, re-run against the shipped FTS delete guard and scored by `scoreE1`
untouched at the immutable 1.35 threshold, returns **b = 1.0825**. E1 measured **1.7529** and
returned SUPER_LINEAR.

Note which verdict this is. E1's table is deliberately asymmetric: SUPER_LINEAR needs the HC3
lower bound above the bar, HOLDS needs **all four** intervals below it. All four classify `below`.

##### What ran

27/27 runs (9 rungs x 3 reps), **0 voids**. Gate 0 pinned `dist` at `b77f0ae3…`; **Gate 0b clean**
(`src_newer_by_ms: 0`) — the gate that did not exist when E1, E1-PHASE, E1-AB and E1-FTS ran. `c`
was re-measured on this binary at **15 ms** (n=10, 14–19), because E1's stored `c` was taken on a
different one and a stale additive constant biases `b` *downward*, toward the answer this run
wants.

Scored by `eval/e1-verify-score.mjs`, which computes nothing: it renames `corpus` to `tier` and
calls `scoreE1`. The fit, the HC3 interval, the cluster bootstrap, the lack-of-fit test, the five
triggers and the verdict rule are E1's. Writing a faithful new scorer here would have been marking
my own homework with a ruler I had just made.

##### The fit

| fit | b | HC3 | cluster bootstrap |
|---|---|---|---|
| adjusted (primary) | **1.0825** | [1.0651, 1.0998] | [1.042, 1.122] |
| raw | 1.0806 | [1.0631, 1.0981] | [1.039, 1.122] |
| by file (`b_file`) | 1.0837 | | |

Lack of fit **quiet**: F = 1.9141, p = 0.1264, departure 1.40%. Triggers 3/4/5 **quiet** (t3 ratio
1.0210 against 1.5; t4 all per-tier rates 0; t5 `b_chunk` 1.0825 vs `b_file` 1.0837). No
qualifiers, no reasons.

##### `fts_del` is zero

**0 ms in all 27 runs — max 0, sum 0.** The span E1-FTS measured at 91.7% of T9's write phase, with
its own exponent of 2.3454, does not appear at any rung. The descriptive write-phase log-log slope
falls from E1-PHASE's `b_write = 1.9685` to **1.1136**, and the write phase stops dominating: it
was **94.01%** of T9 and is now **51.3%** (44.8–53.1% across the ladder), with parse at 36.3%.

##### The guard skips work, not rows

`chunk_fts_count === chunk_count` in **27 of 27** runs; 0 parse errors throughout. This is the
check that separates a correct guard from a fast one — skipping the deletes *and* losing rows would
also have produced a flat exponent.

##### One Gate 3 miss, and what it revealed

Five cells needed a retake. One — **T3#r3** — failed on all three attempts (deltas 510, 593,
513 ms against a 500 ms floor) and E1's rule retained the first attempt, `gate3_finding` recorded.

The overshoot is 13 ms, and its cause is worth recording: Gate 3's floor is `max(500 ms, 5% of
fitted)`, and the ~510 ms is fixed process startup that the internal clock correctly excludes. On
the pre-guard binary T3 took 7.2 s and that overhead was invisible under the 5% arm. **The guard's
own speedup shrank the runs until a constant became visible.** The floor is now marginally tight at
the small rungs — a note for any future ladder, not a defect in this one.

##### Sensitivity

The verdict does not depend on any of it:

| perturbation | b | HC3 upper | verdict |
|---|---|---|---|
| all 27 (registered) | 1.0825 | 1.0998 | HOLDS |
| drop T3#r3 | 1.0839 | 1.1013 | HOLDS |
| external clock throughout | 1.0353 | 1.0577 | HOLDS |
| `c = 0` | 1.0806 | 1.0981 | HOLDS |
| `c = 30` | 1.0843 | 1.1015 | HOLDS |

Every upper bound sits below 1.11 against a bar of 1.35.

##### Descriptive, not registered: the wall clock

T9's median build goes **538,591 ms → 62,136 ms**, ~8.7x. This is *not* a registered comparison —
different binary, `c` re-measured — but it lands where the prior work predicted. E1-PHASE put write
at 94.01% of T9 and E1-FTS put the delete-scan at 91.7% of write, making the scan ~86% of T9 and
predicting ~74 s. Observed 62 s, ~16% better, plausibly because a smaller segment churn also
cheapens the commit. Three independently-registered measurements agreeing to within 16% is
coherence that is hard to obtain by accident.

##### What this does NOT establish

- **Ladder only.** E1's 5-corpus PANEL was out of scope, as registered; E1 records it as
  `panel_supporting_only`. No claim is made about it.
- **`ρ_D(T9) = 0.8486` from E1-AB remains unexplained.** The exponent is gone; that correlation was
  never the same question and is not answered here.
- **Absolute timings are not comparable to E1's ladder.** The exponent is what was compared.
- **Linear is not proven, and cannot be.** `b = 1.08` with an upper bound of 1.10 is what was
  measured over 3.7k–73k chunks. It is a statement about this range, not an asymptote.

##### The near-miss that changed the gates

The guard was written, tested, linted and committed at `43eb928` — and `dist/` was never rebuilt.
The first two E1-VERIFY cells measured a two-day-old binary. The only signal was `fts_del 956 ms`
on a cold build, a span the guard makes exactly zero; a subtler effect would have run all 27 cells
against the wrong binary and scored them.

Gate 0 could not see it, and the reason generalises. Its `schema_version` check compares binary to
source but the version had not changed. Its content hash pins the binary across a *resume* — it
detects `dist/` changing mid-schedule and says nothing about whether `dist/` ever corresponded to
`src/`. **A stale build is perfectly self-consistent.** Every experiment in this program ran under
that blind spot.

**GATE 0b** (`eb85738`) compares the newest `.ts` under `src/` to the newest artifact under `dist/`
and throws, naming the offending file. Zero tolerance, because `tsc` rewrites only outputs whose
input changed — a tolerance window is precisely how a one-file edit slips through, and a one-file
edit is what this was. The two invalid runs, the pin carrying the stale hash, and the calibration
taken on it are quarantined under `eval/results/discarded-stale-dist/` with the diagnosis.

##### Commits

`43eb928` guard + tests · `eb85738` Gate 0b + quarantine + rebuild · `62f2322` E1-VERIFY results.

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
