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

