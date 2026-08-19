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
before the build", which the git record contradicts (D0 `e540c14` committed
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
  and F11 (`b749bc6`, 08-07 **17:08 -0700**) is the only commit that ever touched
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

