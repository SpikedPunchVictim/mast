# Bug Hunt — mast, full codebase

**Date:** 2026-08-20 · **Commit:** `d43fd31` (clean tree) · **Scope:** full codebase, prioritised by consequence
**Lenses:** all 9 · **Runtime context:** Node LTS server/CLI, container/CI, macOS **and** Linux, Node 22 **and** 24
**Accelerator packs:** `accelerators-typescript.md`, `accelerators-sql.md` (schema lives in Kysely DDL, not `.sql`)

**Read in full this session:** `src/graph/db.ts`, `src/graph/populate.ts`, `src/graph/sqliteBatch.ts`,
`src/indexer/index.ts`, `src/indexer/walker.ts`, `src/store/config.ts`, `src/store/sqliteChunkStore.ts`,
`src/store/lock.ts`, `src/search/fts.ts`, `src/search/fused.ts`, `src/search/declex.ts`,
`src/mcp/staleness.ts`, `src/mcp/tools/_helpers.ts`, `src/mcp/tools/status.ts`, `src/mcp/tools/search.ts`,
`src/cli/status.ts`, `src/ast/extract.ts`, plus `node_modules/proper-lockfile/lib/lockfile.js` (lines 100–215)
and the `file_pattern` tests in `tools.test.ts` / `search.test.ts`.

---

## Guard Map

Located and greped before any finding was confirmed.

| Guard class | Files |
|---|---|
| Schema / DDL | `src/graph/db.ts` (`SCHEMA_DDL`, additive `ALTER TABLE` migrations, `CURRENT_SCHEMA_VERSION` gate) |
| Input schemas (zod) | `src/mcp/tools/{search,callers,exports,signature,implementors,dependencies,project-skeleton,reindex,rename-impact,efficiency}.ts`, `src/env.ts`, `src/cli/query.ts` |
| Validation / normalisation | `src/store/config.ts` (`pickStateConfigCustomization`), `src/indexer/import-resolver.ts`, `src/graph/path-range.ts` (`pathPrefixUpperBound`) |
| Config defaults & limits | `src/store/config.ts` `DEFAULTS`, `src/graph/sqliteBatch.ts` `SQLITE_MAX_VARIABLES` |
| Locks / concurrency | `src/store/lock.ts`, `src/store/lockMetrics.ts`, `populateFile`'s `BEGIN IMMEDIATE` + monotonic write-guard |
| Sibling implementations | `globToRegex` (walker) ↔ `globToLike` (fts) · `buildStatus` (CLI) ↔ `countStaleFiles` (MCP) · `replaceChunksInline` ↔ `SqliteChunkStore.replaceChunksForFile` · `TypeScriptExtractor` ↔ `MarkdownExtractor` |
| Tests that may assert intent | `src/mcp/tools/__tests__/tools.test.ts`, `src/search/__tests__/{search,declex,fused-declex}.test.ts`, `src/cli/__tests__/status-honesty.test.ts`, `src/graph/__tests__/fts-delete-guard.test.ts`, `src/indexer/__tests__/stability.test.ts` |

---

## Summary

| | |
|---|---|
| **BUG** | 5 |
| **FRAGILE** | 1 |
| **OK (cleared by verification)** | 4 |
| **REVIEW** | 3 |

Five of the six are `Confirmed (empirical)` — reproduced this session against the built `dist/`.

---

## Issue Rating Table

| # | Finding | Lens | Confidence | Urgency | Risk: Fix | Risk: No Fix | ROI | Blast Radius | Fix Effort |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `mast_search` returns results that violate `file_pattern` / `language` whenever ranker D fires | 9, 1 | Confirmed (empirical) | High | Low | High — the primary tool silently breaks an explicit restriction | Very high | 2 files, no migration, single service | S |
| 2 | A file that fails to index is never retried, and every surface then reports the index complete and fresh | 4, 5 | Confirmed (empirical) | High | Low | High — silent permanent hole in the index | Very high | 1 file, no migration (existing holes need one full reindex) | S |
| 3 | `mast_status` reports `index_fresh: true` when files exist that were never indexed | 8 | Confirmed (empirical) | High | Low | High — the agent-facing freshness signal is wrong | High | 2 files, no migration, single service | S |
| 4 | `file_pattern` glob `*` crosses `/`; a literal `_` or `%` in a path acts as a wildcard | 8, 3 | Confirmed (empirical) | Medium | Low | Medium — over-broad result sets, documented as "glob" | High | 1 file, no migration, single service | S |
| 5 | A compromised `structure.lock` kills the process with an uncaught exception | 5, 6 | Confirmed (empirical) | Medium | Low | Medium — `mast serve` dies; partial fix only (see below) | Medium | 1 file, no migration, single service | S |
| 6 | `removeDeletedFiles`' final `IN` list is the one unbatched site in a class of nine | 3, 8 | Traced (ceiling confirmed empirically) | Low | Very low | Low today, hard failure past 32,766 paths | Medium | 1 file, no migration, single service | XS |

---

## Fix Plan & Interactions

**Order:** #1 → #4 (shared code path) · #2 → #3 (shared freshness story) · #5 · #6 independent.

- **#1 and #4 are a ships-with set.** Both live in the `file_pattern` path. Fixing #4 alone leaves the D leg
  unfiltered (#1 still returns out-of-pattern files); fixing #1 alone means the now-enforced filter is enforced
  with the *wrong* glob semantics. Land them together.
- **#2 and #3 should ship together.** They are two halves of one question — "is the index complete?" #2 creates
  holes that #3's surface cannot see. Fixing #3 alone makes `mast_status` honest about *added* files but still
  blind to files that failed; fixing #2 alone stops new holes but leaves the surface unable to report old ones.
- **#1/#4 interact with #6's bug class.** `searchFts` builds `allowedPaths` and binds it as an `IN` list with no
  batching (`fts.ts:87`) — the same unbounded-`IN` shape as #6, on the read path. Fix #4 does not introduce it
  (it is there today) but it does not remove it either. Recorded in **Needs Review** rather than fixed here,
  because the correct remedy is a different query strategy, not a batch loop.
- **No shared migration.** No fix here tightens an invariant over stored rows. #2 has an existing-data caveat
  (below) that is remedied by one full `mast index`, not by a schema change.

---

## Detailed Findings

### #1 — BUG: `mast_search` ignores `file_pattern` and `language` for ranker D's results

**Lens:** 9 (write/read asymmetry — a filter applied on one leg of a fusion and not the other), 1
**Confidence:** Confirmed (empirical)

**Assumption:** that the two SQL-level filters `fusedSearch` documents at `src/search/fused.ts:102-104` —
*"SQL-level filters (`file_pattern`, `language`) are pushed into the FTS query"* — cover every candidate source.

**Violation:** they cover exactly one. `searchFts` (`fts.ts:51-73`) applies both. `searchRankerD`
(`declex.ts:200`) takes `{ limit }` and nothing else, and its SQL (`matchToken`, `declex.ts:113-122`) queries
`chunks` with no path or language predicate. Its rows are unioned into the fused candidate set at
`fused.ts:159` and survive to the response — the only post-filters are `chunk_type` and `only_exported`
(`fused.ts:238-242`).

`declaration_exact_ranker` defaults to **`true`** (`store/config.ts:58`), so this is the shipped default path.

**Consequence:** an agent that restricts a search to a subtree or a language receives results from outside it,
with no signal. `mast_search`'s own schema calls `file_pattern` a *"Glob pattern to restrict results to matching
files"* (`mcp/tools/search.ts:19`).

**Evidence — reproduced against `dist/` at `d43fd31`:**

```
$ node scratchpad/repro-filter-leak.mjs
config.declaration_exact_ranker = true
A) file_pattern "alpha/**", D ON   -> ["alpha/a.ts","beta/b.ts","beta/nested/c.ts","beta/plain.js"]
B) file_pattern "alpha/**", D OFF  -> ["alpha/a.ts"]
C) language "typescript", D ON     -> ["alpha/a.ts","beta/b.ts","beta/nested/c.ts","beta/plain.js"]
D) language "typescript", D OFF    -> ["alpha/a.ts","beta/b.ts","beta/nested/c.ts"]
```

Three of four results in (A) violate the pattern. In (C) the `language: 'typescript'` filter returns
`beta/plain.js` — a JavaScript file.

**Why no test caught it.** The single end-to-end `file_pattern` assertion is
`tools.test.ts:197`, `{ query: 'function', file_pattern: 'math.ts' }`. Ranker D's eligibility gate
(`isEligiblePrimaryTerm` — requires an uppercase letter, `_`, `$`, or a digit adjacent to a letter) rejects
`function`, so D never fires and the test passes without exercising the leak:

```
$ node -e "…deriveEligiblePrimaryTerms…"
function       eligible terms = []
add            eligible terms = []
computeTotal   eligible terms = ["computeTotal"]
```

Confirmed by the same harness: `F) query "function" (D ineligible), file_pattern "alpha/**" -> ["alpha/a.ts"]`.

**Verified fix.** Give `searchRankerD` an optional allowed-path set and apply it **in memory**, after
`matchToken` and before the sort/cap:

- add `file_path` to `matchToken`'s `.select(...)` and carry it on `ChunkMatchCandidate`;
- add `readonly allowedPaths?: ReadonlySet<string>` to `DeclexSearchOptions`;
- filter `candidates` by membership before `candidates.sort(...)` and `slice(0, options.limit)`;
- in `fusedSearch`, resolve the allowed-path set **once** (extracted from `searchFts`'s existing
  `filePattern`/`language` resolution) and pass it to both legs.

*Fix checks:* (1) no new index/offset/length arithmetic — set membership only. (2) Mirror path: the write side
stores `chunks.file_path` verbatim from `data.filePath`, the same string `files.path` holds, so the two sides
already agree — no write-side change needed. (3) Existing data: none — this is a read-path filter. (4)
Constraint values unchanged; the cap stays `options.limit` and now applies *after* filtering, so an in-pattern
candidate can no longer be displaced out of the pool by an out-of-pattern one. (5) Malformed input: an absent
`allowedPaths` means "no restriction", identical to today. (6) Interaction: ships with #4. (7) Caller contract:
`searchRankerD` has exactly one production caller (`fused.ts:151`) and 17 test calls
(`search/__tests__/declex.test.ts`), all of which omit the new optional field and keep today's behaviour;
`eval/declex-ranker.mjs` exports a *separate* function of the same name and is untouched. (8) Re-test: rerun the
harness above and require (A) ≡ (B) and (C) ≡ (D).

**Note on `candidate_count`.** `DeclexDiagnostics.candidate_count` is documented as the pre-cap pool size. With
a filter applied it becomes the pre-cap *post-filter* size. This changes the meaning of a telemetry field the
F18 kill-switch reads (`metrics.declex_json`). Keep the option absent-by-default so the eval reconstruction's
parity claim (`fused.ts:143-144`) still holds, and state the changed denominator wherever D-fire telemetry is
interpreted.

---

### #2 — BUG: a file that fails to index is never retried, and every surface then calls the index fresh

**Lens:** 4 (lifecycle), 5 (error paths)
**Confidence:** Confirmed (empirical)

**Assumption:** that `file_manifest.json` records what was *indexed*.

**Violation:** it records what was *walked*. `runIndex`'s finalise phase builds the manifest from
`currentFiles.map(...)` (`indexer/index.ts:494-499`) — every file the walk found, whether it was written,
failed to parse (`parseErrors`), or failed to write (`writeErrors`). On the next incremental run `diffManifest`
sees an unchanged mtime and classifies the file as neither `stale` nor `added`, so it is never re-attempted.

**Consequence:** a *transient* failure — a disk hiccup, a `SQLITE_BUSY` the retry budget did not absorb, a file
being written while the walk read it — permanently removes a file from the index. Nothing retries it and
nothing reports it. Worse, the one visible trace is erased by the very next run: `index.json`'s `parse_errors`
is written as `parseErrors > 0 ? parseErrors : undefined` (`index.ts:505`), so a clean subsequent run resets it
to absent, which both status surfaces read back as `0`.

**Evidence — reproduced against `dist/` at `d43fd31`** (one injected transient extract failure, then the
condition is removed):

```
$ node scratchpad/repro-sticky.mjs
run 1 (full, doomed.ts fails): { filesIndexed: 1, parseErrors: 1 }
run 2 (incremental, nothing wrong any more): { filesIndexed: 0, filesSkipped: 2 }
manifest contains src/doomed.ts ? true
files table                    : ["src/good.ts"]
CLI  mast status : stale_files=0 index_fresh=true parse_errors=0
MCP  mast_status : stale_files=0 index_fresh=true
```

`src/doomed.ts` is absent from the index, is never retried, and both surfaces report a complete, fresh index
with zero parse errors.

**Verified fix.** Track the paths that did not land and omit them from the manifest:

- collect a `failedPaths: Set<string>` in the pass-1 loop — the `catch` that increments `parseErrors`
  (`index.ts:389`) and the `catch` that increments `writeErrors` (`index.ts:466`);
- in the finalise phase, build `freshEntries` from `currentFiles.filter((e) => !failedPaths.has(e.relativePath))`.

Do **not** include `staleWriteRejections` — a monotonic-guard rejection means the stored row is already
*fresher* than this parse, so its manifest entry is correct.

*Fix checks:* (1) no arithmetic. (2) Mirror path: the read side is `diffManifest`, which treats a missing
manifest key as `added` (`walker.ts:111-112`) — so an omitted file is retried next run. Confirmed by reading
that branch. (3) **Existing data:** manifests already on disk contain entries for previously-failed files; the
fix is not retroactive, so files already lost stay lost until one non-incremental `mast index`. This must be
stated in the changelog — it is a documented remedy, not a migration. (4) No thresholds introduced. (5) Failure
mode: a *permanently* broken file is now re-parsed every run and reported as stale forever. That is the honest
outcome — it genuinely is not indexed — and it costs one parse per run. (6) Interaction: ships with #3.
(7) Caller contract: `runIndex`'s return shape is unchanged. (8) Re-test: rerun the harness and require run 2 to
report `filesIndexed: 1` and the `files` table to contain both paths.

---

### #3 — BUG: `mast_status` cannot see a file that was never indexed

**Lens:** 8 (cross-implementation divergence)
**Confidence:** Confirmed (empirical)

**Two implementations of one invariant — "is the index up to date?"**

| Implementation | Method | Counts changed files | Counts deleted files | Counts **never-indexed** files |
|---|---|---|---|---|
| CLI `buildStatus` — `cli/status.ts:64-66` | walk the project, diff against `file_manifest.json` | yes | yes | **yes** (`added`) |
| MCP `countStaleFiles` — `mcp/tools/_helpers.ts:75-89` | iterate `files` table rows, stat each | yes | yes (stat throws) | **no** |

`countStaleFiles` starts from `SELECT path, mtime FROM files`. A file with no row cannot be counted, by
construction. The guarded sibling is the specification here, and the unguarded one is the surface an agent
consults.

**Consequence:** create a file, ask `mast_status`, and be told `index_fresh: true`. Every subsequent
`mast_search` is then trusted against an index that does not contain it. `mast_search`'s `stale` flag does not
close the gap — it is computed by `findStaleFiles` (`staleness.ts:95-104`), which also starts from the `files`
table and only annotates files that were *returned*.

**Evidence — reproduced against `dist/` at `d43fd31`:**

```
$ node scratchpad/repro-status.mjs
1) right after a full index (baseline):
   CLI  mast status : stale_files=0 index_fresh=true  cause=null
   MCP  mast_status : stale_files=0 index_fresh=true  cause=null
2) after adding ONE brand-new, never-indexed file:
   CLI  mast status : stale_files=1 index_fresh=false cause=phase1_stale
   MCP  mast_status : stale_files=0 index_fresh=true  cause=null
```

**Verified fix.** Change `countStaleFiles(db, projectRoot)` to `countStaleFiles(db, config: ResolvedConfig)` and
compute over the union of both populations:

```
walked      = await walkProject(config)              // honours file_extensions + exclude_patterns
indexed     = Map(path -> mtime) from the files table
stale       = walked with no `indexed` entry                       // never indexed  (the missing case)
            + walked whose disk mtime  >  indexed mtime            // changed
            + indexed paths absent from `walked`                   // deleted
```

*Fix checks:* (1) no arithmetic beyond the existing `mtimeMs / 1_000` comparison, unchanged. (2) Mirror path:
the sibling `buildStatus` already computes this population; this fix converges the two rather than inventing a
third rule. (3) Existing data: none — pure read. (4) Constraint values: `walkProject`'s allowlist/denylist is
the authoritative definition of "a file mast should have indexed" (`walker.ts:46-55`); using it is what makes
the two surfaces agree. (5) Failure mode: a walk failure throws where today a stat failure counted as stale —
`walkProject` already swallows per-file stat failures (`walker.ts:69-71`), so the only new throw is a
catastrophic glob failure, which should be loud. (6) Interaction: ships with #2 — after #2, a file that failed
to index has no manifest entry *and* no `files` row, and this fix is what makes it visible on the MCP surface.
(7) Caller contract: `countStaleFiles` has exactly one caller, `mcp/tools/status.ts:16`, which already holds
`ctx.config`. (8) Re-test: rerun the harness and require the two surfaces to agree in both scenarios.

**Cost note.** This adds a project walk to every `mast_status` call. The CLI already pays it, and `mast_status`
is not on a hot path. Stated rather than assumed.

---

### #4 — BUG: `file_pattern`'s glob is translated to `LIKE` with the wrong semantics

**Lens:** 8 (cross-implementation divergence), 3 (boundaries)
**Confidence:** Confirmed (empirical)

**Two translations of one `file_pattern` parameter:**

| Consumer | Translator | `*` crosses `/` | literal `_` / `%` |
|---|---|---|---|
| `mast_project_skeleton` — `mcp/tools/project-skeleton.ts:37` | `globToRegex` (`walker.ts:23`) | no — `[^/]*` | escaped/inert |
| `mast_search` — `search/fts.ts:55` | `globToLike` (`fts.ts:207`) | **yes** — `%` | **wildcards** |

`globToLike` is `pattern.replace(/\*/g, '%').replace(/\?/g, '_')`. `walker.ts:20-21` states that `globToRegex`
lives where it does precisely so *"both watch mode and the MCP tools' `file_pattern` filters need the same glob
semantics"* — `mast_search` is the tool that does not use it.

**Consequence:** `file_pattern: 'src/*.ts'` also matches `src/a/b/c.ts`. A path containing a literal `_` — very
common — matches any character in that position.

**Evidence:**

```
$ node -e "…sqlite LIKE table…"
glob src/*.ts        -> LIKE src/%.ts       => ["src/a.ts","src/sub/deep.ts","src/my_file.ts","src/myXfile.ts"]
literal src/my_file.ts -> LIKE src/my_file.ts => ["src/my_file.ts","src/myXfile.ts"]
```

and end-to-end through the real pipeline, with ranker D off so #1 is not confounding it:

```
E) file_pattern "beta/*.ts", D OFF -> ["beta/b.ts","beta/nested/c.ts"]
```

`beta/nested/c.ts` is two segments deep and should not match `beta/*.ts`.

**Verified fix.** Delete `globToLike` and filter in JS with the guarded sibling: `SELECT path FROM files`, then
`paths.filter((p) => globToRegex(pattern).test(p))`. `searchFts` already materialises the full path list for
the `language` branch (`fts.ts:62-68`), so this introduces no new query shape.

*Fix checks:* (1) no arithmetic. (2) Mirror path: `files.path` is written by `populateFile` from
`entry.relativePath` (`walker.ts:61-63`) — the same normalised, forward-slash relative form `globToRegex` is
written against, and the same form `project-skeleton.ts` already matches successfully. (3) Existing data: none.
(4) Constraint values: `globToRegex`'s semantics are specified at `walker.ts:14-21` and pinned by
`cli/__tests__/cli.test.ts:896`. (5) Failure mode: an invalid pattern now throws from `new RegExp` where it
previously produced a silent over-match — loud beats silent, but the throw should be caught and surfaced as an
input error rather than a 500. (6) Interaction: ships with #1. (7) Caller contract: `globToLike` is
module-private with one call site (`fts.ts:55`); `searchFts`'s signature is unchanged. (8) Re-test: rerun the
harness and require (E) to return `["beta/b.ts"]`.

---

### #5 — BUG: a compromised `structure.lock` kills the process with an uncaught exception

**Lens:** 5 (error paths), 6 (concurrency)
**Confidence:** Confirmed (empirical)

**Mechanism.** `store/lock.ts:91` calls `lockfile.lock(marker, { stale: STALE_MS, retries: 0 })` and never
supplies `onCompromised`. proper-lockfile 4.1.2's default is `onCompromised: (err) => { throw err; }`
(`lib/lockfile.js:213`), invoked from `setLockAsCompromised` (`:200`) inside the lock-refresh timer's `fs.stat`
callback (`:113-139`). A throw from that callback is an **uncaught exception**, not a rejected promise — no
`try`/`catch` around `withLock` can see it. `src` installs no `uncaughtException` handler (greped: zero hits in
`src/**/*.ts` excluding tests).

The compromise fires when the lock directory is gone (`ENOENT`) or its mtime is no longer ours — i.e. whenever
another process deemed the lock stale past `STALE_MS = 10_000` and took it.

**Evidence — reproduced against `dist/` at `d43fd31`:**

```
$ node scratchpad/repro-lock.mjs
acquiring structure.lock, then simulating another process stealing it...
lock dir removed by "other process"; waiting for the update timer (update = stale/2 = 5s)...
UNCAUGHT EXCEPTION reached the process: ECOMPROMISED ENOENT: no such file or directory, stat '…/structure.lock'
exit=7
```

The `withLock` callback never ran to completion and `withLock` never returned — the process died mid-body.

**Fix: partial — the rest requires design work.** The handler itself is straightforward and strictly better than
a process kill:

- pass an explicit `onCompromised` to `lockfile.lock` that writes an ERROR line to stderr and records a
  `{ kind: 'compromised' }` event on the existing `LockMetricsSink`, instead of throwing.

*Fix checks:* (1) no arithmetic. (2) Mirror path: n/a. (3) Existing data: none. (4) `STALE_MS` and
proper-lockfile's derived `update = stale/2` are cited at `lock.ts:12` and `lockfile.js:220-221`. (5) Failure
mode: converts a crash into a loud, logged signal. (7) Caller contract: `acquireLock`'s signature is unchanged;
`LockMetricsSink`'s event union gains a variant, which is a closed union — every consumer
(`telemetry/lockMetricsSummary.ts`) must be updated in the same commit. (8) Re-test: rerun the harness and
require exit 0 with the ERROR line present.

**Check 6 fails, and that is why this is partial.** Swallowing the compromise does not stop the
*race* — mutual exclusion has genuinely been lost, and the in-flight `fn()` keeps writing. There is no
cancellation token to abort it. Doing this properly means giving `withLock` an `AbortSignal` that the callback
honours between statements, which is a design change, not a patch. **Recommendation:** land the handler now to
stop the crash, and open a separate ticket for the abort path. Do not describe the handler as closing the race.

---

## Fragile Code

### #6 — FRAGILE: `removeDeletedFiles`' final `IN` list is the one unbatched site in a class of nine

**Lens:** 3, 8 · **Confidence:** Traced (parameter ceiling confirmed empirically)

`graph/populate.ts:1300` — `await trx.deleteFrom('files').where('path', 'in', deletedPaths).execute();`

Every other multi-value statement in this codebase routes through `chunkRowsForSqlite` / `chunkValuesForSqlite`
(`graph/sqliteBatch.ts`), with a WHY-comment citing Stage 4.5 S1's "class survey" — symbols, imports, chunks,
both FTS inserts, edges, `fromNames`, `structuralToNames`, and `SqliteChunkStore.replaceChunksForFile`. This
site was missed. `sqliteChunkStore.ts:125-137`'s `getChunksByIds` is the one *deliberate* exemption and says so
("largest id set any call site passes is 50").

The ceiling is real and exact:

```
$ node -e "…delete from files where path in (n × ?)…"
32765 OK
32766 OK
32767 THROWS: too many SQL variables
SQLITE_VERSION 3.53.2
```

matching `SQLITE_MAX_VARIABLES = 32_766` (`sqliteBatch.ts:25`).

**Foreseeable change that breaks it:** any single run that removes more than 32,766 indexed paths — a large
vendored subtree deleted, a branch switch, or the full-reindex orphan purge (`indexer/index.ts:322-329`) after
an `exclude_patterns` change on a big monorepo. Classified FRAGILE rather than BUG because it is a loud throw
inside a transaction that rolls back cleanly — no data loss, but `mast index` then fails on every subsequent
run until the condition clears.

**Verified fix:** `for (const batch of chunkValuesForSqlite(deletedPaths)) { await trx.deleteFrom('files').where('path','in', batch).execute(); }`
All eight checks pass trivially: no new arithmetic (the helper's batch sizing is already pinned by
`graph/__tests__/sqliteBatch.test.ts`), same transaction so atomicity is unchanged, no signature change, no
data implications, and the helper is already imported in this file (`populate.ts:4`).

---

## Already Guarded — candidates verification cleared

| Candidate | Why it is OK | Guard |
|---|---|---|
| `chunks` / `chunk_fts` / `identifier_fts` orphaned when a `files` row is deleted (no FK cascade to virtual tables) | Deliberate and explicitly maintained — both writers delete them in the same transaction | `populate.ts:1266-1303` (`removeDeletedFiles`), pinned by `graph/__tests__/fts-delete-guard.test.ts` |
| FTS rowid-block reuse colliding with live rows | `reserveFtsBlock` reads `max(rowid)+1` **before** the old block is deleted, so a reserved range can never overlap rows still present | `populate.ts` `reserveFtsBlock` WHY-comment; `graph/__tests__/fts-rowid-block.test.ts` |
| Ranker D's `LIKE` segment match treating `_` as a wildcard | Explicitly escaped with `ESCAPE '\'` | `declex.ts:84-86` (`escapeLikeToken`), `:121` |
| Reindex racing a JIT refresh and regressing a row to older content | Monotonic write-guard inside the same `BEGIN IMMEDIATE` as the write | `populate.ts:439-453`; `indexer/index.ts` invariants 1 and 2 |

---

## Refutation Log — killed in Step 5

| Claim | Verdict | What killed it |
|---|---|---|
| "`index.json`'s `parse_errors` still tells the operator a file is missing, so #2 is only half-silent" | **Refuted** | `index.ts:505` writes `parseErrors > 0 ? parseErrors : undefined`, so the next clean run erases the count. The harness confirms `parse_errors=0` after run 2. #2's severity went **up**, not down. |
| "#5 is triggered by a >10 s event-loop block during a synchronous better-sqlite3 write" | **Refuted as the mechanism** | `lockfile.js:113-118` re-stats and *recovers* from a busy event loop as long as the mtime is still ours; the refresh timer fires between `await`s, and a single SQLite statement taking >10 s is not demonstrated. The surviving mechanism is narrower — another process stealing a lock it deemed stale — and the finding is reported on that mechanism, not the original one. |
| "`mast_search`'s `stale` flag mitigates #3" | **Refuted** | `findStaleFiles` (`staleness.ts:95-104`) also starts from `SELECT … FROM files` and only annotates files that were returned. A never-indexed file is invisible to it for the same reason. |
| "`extractFile`'s `filePath.startsWith(projectRoot)` mis-relativises a sibling directory (`/a/b` vs `/a/bc/…`)" | **Unverified → downgraded to REVIEW** | The prefix test is genuinely unsound, but no caller path reaches it with a non-child: `walkProject` globs under the root and `checkAndRefreshIfStale` builds `join(root, relPath)`. No reachable violating input found, so per Step 4.4 this is REVIEW, not BUG. |

---

## Needs Human Review

> **DISPOSITION 2026-08-20 — all three resolved; see the ledger.** Recorded here so this section
> is not read later as still-open. Item 1 was already fixed *before* this section was written and
> the hunt did not notice; items 2 and 3 were settled by measurement, not by the owner ruling on a
> contract question.
>
> | item | verdict | where |
> |---|---|---|
> | 1 — `searchFts`'s unbounded `IN` list | **Already fixed.** D037's fix re-derived the class and found *three* unbounded sites, not one; `fts.ts:74` was among them and routes through `chunkValuesForSqlite`, pinned by `graph/__tests__/in-list-batching.test.ts`. This section's claim that it was "not classified as a BUG" was stale the moment D037 landed two commits later. | LEDGER D037 |
> | 2 — `filesIndexed` counts queued, not written | **Confirmed defect, fixed.** Not the contract question it was filed as: no doc comment claimed "attempted", and both surfaces print the word *indexed*. Reproduced — `filesIndexed: 2, writeErrors: 1` with one file in the index. | LEDGER D038 (+ D039, found by fixing it) |
> | 3 — `remapIdentifierRows`' FIFO | **Invariant holds; made structural anyway.** Measured across n8n at its pinned SHA (19,056 files, 4 collision groups) and mast's `src` (130 files): zero violations. The defect was that it rested on an argument about a file this hunt records as never read in full. | LEDGER D040 |
>
> The hunt's own note that `ast/extractors/typescript.ts` "was not read in full" is the reason
> item 3 was filed as `Suspected` rather than resolved. It was resolved by running the invariant
> over two real corpora instead — cheaper than reading 1,637 lines, and it produces a number.



1. **`searchFts`'s `allowedPaths` `IN` list is unbounded** (`fts.ts:87`). `language: 'typescript'` with no
   `file_pattern` materialises **every** TypeScript path in the repo into an `IN` list — one bound parameter
   each, against the 32,766 ceiling confirmed above. Not classified as a BUG because 32,766 files of a single
   language in one repo is beyond anything measured here, and the right remedy is a different query strategy
   (a temp table, or a post-filter on the FTS result window) rather than a batch loop — that is a design call.
   Same bug class as #6, opposite path.

2. **`IndexResult.filesIndexed` counts files queued for write, not files written.** `index.ts:381-382`
   increments `filesIndexed` and `chunksAdded` in the parse loop, before `populateFile` runs; a subsequent
   `writeErrors` or `staleWriteRejections` does not decrement them. So `mast index` can report
   `filesIndexed: 100, writeErrors: 3` where only 97 landed. Whether that is a defect or the intended
   "attempted" semantics is a contract question for the owner — the field has no doc comment stating either.
   `Suspected`, by rule 6.

3. **`remapIdentifierRows`' FIFO assumption** (`ast/extract.ts:113-147`). The doc comment concedes the
   invariant it rests on — *"exact as long as every chunk sharing a colliding id also produced an identifier
   row"* — and argues it holds because `dedupeChunkIds` only renames chunks with substantive content. I did not
   verify that the TypeScript extractor can never emit a chunk with an empty identifier bag, so I cannot say
   whether the queue can misalign and attribute identifiers to the wrong chunk. `Suspected`; needs someone who
   knows `typescript.ts`'s identifier emission to confirm or refute.

---

## What I could not check

- **Linux and the Node 22/24 matrix.** Everything above was reproduced on macOS/APFS with the repo's installed
  Node. The three case-sensitivity-adjacent surfaces (`realpathSync.native`, `files.path`'s BINARY-collated
  `UNIQUE`, the miscased-import report) behave differently on a case-sensitive filesystem, and none of the six
  findings depends on that — but none was *re-run* under Linux either. CI covers the matrix; this hunt did not.
- **Coarse-mtime filesystems** (the container/CI target). `runIndex`'s own WHY-comment names mtime-granularity
  blindness as a known unsolved limitation; I took that at its word rather than re-deriving it, and looked for
  bugs *around* it instead.
- **`ast/extractors/typescript.ts` (1,637 lines) was not read in full.** It is the largest file in the
  codebase and was sampled at the sites the findings above reach into (`matchToken`'s `symbol_name` shape,
  identifier emission, `sha256`). Lenses 1–3 were not applied to its tree-walking body. That is the single
  largest coverage gap in this hunt.
- **`graph/checker-resolver.ts` and `graph/queries.ts`** were read only at the sites the `IN`-list sweep
  reached. `checker-resolver.ts:506`'s `IN` list is bounded by one project's candidate bucket, which I did not
  bound numerically.
