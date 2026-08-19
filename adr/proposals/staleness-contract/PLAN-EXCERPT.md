<!-- SHARD — do not edit the excerpt below. -->

> **Plan excerpt — ADR 005: Staleness is a contract, not a best effort.**
> Verbatim from `IMPLEMENTATION_PLAN.md` at commit `69a587e`, lines 22–587.
> This is the append-only record the ADR was written from; the ADR is the summary, this is the evidence.
> Nothing here has been edited — see `docs/provenance/verify-plan-shards.mjs` for the losslessness proof.

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

