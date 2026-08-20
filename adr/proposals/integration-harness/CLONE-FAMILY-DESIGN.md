# The `clone` realism family — n8n against the whole tool surface

**Status: design only, nothing built.** Adversarial design pass, 2026-08-20, per the repo's
convention (ADR 015 §6: review briefed to recompute, before anything is built). Where this
document and a future shipped implementation disagree, the implementation and its observed
runs win — this is a design record, not a spec (same stance as
`adr/proposals/integration-harness/PLAN.md`'s preamble).

Confidence labels are used throughout per CLAUDE.md §11.5: **[measured]** = derived this
session from a primary artifact named inline; **[inferred]** = read from code/spec this
session; **[unmeasured]** = a projection or an assumption, flagged as such.

---

## 0. What the request gets right, and where it is wrong-headed

The request is right that the harness's reach is narrow: today's two scenarios
(`integration/scenarios/*.mjs`) exercise `mast_search` (via `search --json`),
`mast_callers` (via `query mast_callers`), and `status` — three of eleven tools
**[measured: both scenario files read in full]**. `mast_signature`, `mast_implementors`,
`mast_exports`, `mast_project_skeleton`, `mast_rename_impact`, `mast_dependencies`,
`mast_efficiency`, and `mast_reindex` have never been run against an installed artifact by
anything. That gap is real and worth closing, and n8n is the right corpus to close part of
it with — it is already pinned, already cached, and already characterised by 400+ committed
runs.

Two parts of the request need pushing back on, directly:

**"We must not ship any bugs/issues with each release" is not a property any suite can
deliver, and designing as if it could would produce the wrong suite.** The repo's own
ledger is the evidence: of 37 rows, the bootstrap table records that **zero of D001–D028
were found by a failing test** (`docs/defects/LEDGER.md`, "where detection actually
lives"), and the 2026-08-20 update adds exactly one counterexample (D033) with the
corrected reading: *a test written to check something you are about to rely on finds
defects; a test written to confirm something you already shipped does not.* This family's
discovery value is therefore front-loaded — its first runs over n8n are an audit (the D030
pattern: the harness's first real scenario found an S0 on run one), and its steady state is
a pin. The achievable release standard, stated honestly, is: **(a)** no recurrence of any
ledgered defect class that has an executable pin, **(b)** no violation of the named
cross-tool invariants over a corpus of natural complexity, **(c)** every tool exercised
end-to-end through the installed artifact at least once, and **(d)** any environment that
could not host a required scenario reported loudly (SKIP, and a release gate that refuses
SKIPs on required tags). §7 says what remains outside that even when all four hold.

**"Stress-test across the entire API landscape with n8n" over-assigns work to one corpus.**
n8n buys *naturalness*, not *extremity* — recomputed rather than assumed:
- n8n at the pin has **13,985 indexed files / 73,359 chunks** [measured:
  `eval/results/e1-p0.json`], which is **below** SQLite's 32,766-parameter ceiling — so the
  D037 class (unbatched `IN` over the scoped path list, `src/search/fts.ts:76`) **cannot go
  red on n8n**; a `language:` filter binds at most ~13,987 params.
- Its largest file yields **404 chunks** [measured: query over
  `~/.cache/mast-eval/e1/p0-n8n-state/graph.db`, top file
  `packages/workflow/src/interfaces.ts`], an order of magnitude under the ~2,978-row
  per-statement ceiling of the D002 whale class.

So the parameter-ceiling and whale classes stay where they already live (unit pins
`in-list-batching.test.ts`, the D002 whale tests). What n8n uniquely offers the harness:
a real **pnpm monorepo** layout (`packages/@n8n/*` workspace paths [measured: chunk table
paths]), mixed-case file and directory names (`NodeDetailsViewPage.ts`), deep re-export
chains, an interface with hundreds of natural implementors (`INodeType` — the natural host
for `mast_implementors` and the truncation flag), a 439 MB state dir
[measured: `db_bytes 439140352`, e1-ladder T9], and a cold-index window (~1 min, §1.4)
long enough to make the two-process race scenario real. That, plus the artifact/transport
layer nothing in-process can see, is the family's charter — **not** re-running the fixture
mutation family at 3,000× the cost (§5.5's budget: each behaviour once, at its natural
layer).

---

## 1. Corpus strategy

### 1.1 Decision: reuse the eval pin; do not build a second corpus producer

The pin is **`PINS.n8n` = `9d9e9bf97e8ae5382a930cd662637a9cf7046ef9`**
(`eval/e1-common.mjs:51`), and the harness imports it from there rather than repeating the
string — S-05's second Ask applied at design time: eval *defines* the canonical pin, and an
import forces agreement rather than letting two literals happen to match today.
(`eval/paths.mjs:55`'s `CORPUS_SHA` is a **different** corpus — kluster — and is not
involved; naming this because the prompt's phrase "cached under ~/.cache/mast-eval/"
conflates two pinning systems that merely share a cache root.)

Importing `e1-common.mjs` pulls its top-level imports, including `better-sqlite3`
[inferred: module header read]; that resolves from this repo's `node_modules`, where the
harness's own `lib/` already runs. If that coupling is judged too heavy, the fallback is a
three-line `eval/pins.mjs` that both sides import — but that is a refactor of eval and
needs its own justification; the direct import is the default.

**Why not a second producer:** the failure it invites is exactly S-05 (two producers of one
value drifting) plus D8's shape (testing bytes other than the ones you think). The eval
machinery has also already paid the characterisation cost: every runtime number in §1.4
attaches to *this* SHA, and a different pin would detach the design from its own evidence.

### 1.2 The cache is not as durable as it looks — verify, then fall back

The existing cache entry `~/.cache/mast-eval/e1-wt/n8n` is at the pin and clean [measured:
`git rev-parse HEAD` = the pin; `git status --porcelain` empty; 26,341 tracked files;
242 MB]. But it is a **git worktree whose parent repository lives at
`~/temp/enterprise-apps/n8n`** [measured: its `.git` file]. A worktree rooted in someone's
`temp` directory is one spring-clean away from every `git` command in it failing. The
harness must not assume it.

`lib/corpus.mjs` therefore resolves the corpus in this order, re-verifying on **every**
run (the PLAN's own rule: "re-check `git rev-parse HEAD` against it on every cache hit"):

1. **Existing eval worktree**, if `git rev-parse HEAD` equals the pin AND
   `git status --porcelain` is empty (the two checks `assertCorpusPinned`
   performs, `eval/e1-common.mjs:332-348` — ported, not imported, because its failure mode
   there is a hard eval-gate error and here it must be a fallthrough).
2. **Harness-owned self-contained clone** at
   `~/.cache/mast-eval/integration-corpus/n8n-<sha12>`: `git init` + `git fetch --depth 1
   origin <sha>` + `git checkout FETCH_HEAD`, then write a completion marker
   `.mast-corpus-ok` containing the SHA. **Partial/corrupt detection:** a cache hit
   requires marker present, marker SHA == pin, `rev-parse HEAD` == pin, porcelain clean;
   any miss deletes the directory and re-clones. A crash mid-clone leaves no marker, so a
   torn cache can never be read as a corpus (S-07). `git fsck` is rejected as the
   integrity check: cost unmeasured but plausibly tens of seconds against a threat (bit
   rot between runs) the marker+rev-parse pair does not meaningfully miss.
3. **No cache, clone fails (offline or otherwise): SKIP**, with the git error verbatim in
   the SKIP reason. Never PASS, never a silent narrowing. And because a release runner
   with no network would otherwise go green minus the whole family, add one flag:
   **`--forbid-skip <tag>`** — the release invocation passes `--forbid-skip realism`, and
   any SKIP carrying that tag fails the run. Without this, SKIP is the new zero-scenario
   hole one level up (the same S-07 the existing filters guard).

`npm pack` and the fixture family need no network today and that stays true; only corpus
resolution can touch the network, and only on a cache miss.

### 1.3 Working copies: hardlinks, and a mutation-safety fix that must land first

Per-scenario working copies are materialised by **hardlink**, the `materialiseTier`
precedent (`eval/e1-common.mjs:368-376`; "hardlinks copy no data — verified: same inode,
nlink 2"). 26k links is seconds, not the 242 MB a copy costs [unmeasured, but bounded by
the same machinery's E1 usage].

**Blocking defect in the current mutation kinds:** `editFile`, `renameSymbol`, and
`restoreFile` write via `writeFileSync` (`integration/lib/mutations.mjs:56-62, 42-53,
72-78`), which writes **through** a hardlink to the shared inode — a scenario "editing its
working copy" would silently corrupt the cached corpus for every later run, and the
corruption survives the run (S-01: damage that leaves the exit code alone, pointed at the
harness itself). Before any clone scenario lands, content-writing mutations must
**unlink-then-write** (`rmSync` + `writeFileSync`), which is correct on the fixture too and
costs nothing. `moveFile`/`caseOnlyRename`/`deleteFile`/`addFile` are already
link-safe [inferred: they rename/remove/create directory entries, never write content].
Belt-and-braces: after each clone scenario, a corpus guard re-runs the two git checks on
the *cache* (not the working copy) and reports ERROR — harness fault, not mast fault — on
drift.

### 1.4 Runtime budget — from journals, not guesses

All from committed artifacts, with the binary generation named, because the numbers moved
10× between generations:

| measurement | value | source | binary |
|---|---|---|---|
| Full-corpus cold index, T9 tier (13,330 chunk-bearing files, 73,359 chunks) | 56.5 / 59.2 / 59.7 s (3 runs) | `eval/results/e1-ladder-runs.jsonl` [measured] | 2026-08-18 |
| Same, under load, 60 runs across two arms | 54.2 – 91.8 s | `eval/results/e1-hoist-runs.jsonl` [measured] | 2026-08-18 |
| Phase split at T9 | parse ~22 s, write ~32–34 s, edges ~2.5 s | e1-ladder `phase_ms` [measured] | 2026-08-18 |
| Full worktree (13,985 files, incl. the 655 zero-chunk tail) | 636.0 s | `eval/results/e1-p0.json` [measured] | 2026-08-12 |
| T9 on that older binary | 493 – 541 s (3 runs) | `eval/results/e1-runs.jsonl` [measured] | 2026-08-12 |
| State dir size | 439 MB (`db_bytes 439140352`) | e1-ladder T9 [measured] | — |

Two honest caveats. First, **no post-optimisation full-worktree number exists**: the ~60 s
figure is the hardlink *tier* (which excludes 655 zero-chunk files — barrel re-exports,
`.d.ts`, configs; `eval/results/e1-tiers.json` `logged_deviation`, quoted in
`e1-build-tiers.mjs:164-183`); the full worktree on the current binary is a projection of
~60–80 s **[unmeasured]** and measuring it is build step 1's exit criterion, not an
assumption. Second, the 2026-08-18 binary is not today's binary (D031–D037 landed
2026-08-20); index-time cost is not expected to have moved materially [inferred: those
fixes touch query paths, glob compilation, and finalise bookkeeping], but "not expected" is
not a measurement.

**Tiering that follows from the numbers:**

- **Per-commit:** unchanged — the unit gate, plus (as today) the fixture family on demand.
  The fixture scenarios are dominated by the one-per-target install (native rebuild of
  `better-sqlite3` + `tree-sitter`; cost asserted dominant by `integration/README.md`,
  wall-clock **[unmeasured]**), not by the scenarios.
- **Nightly (and on a PR label):** the clone **read-only battery** — one shared cold index
  (~1–2 min) amortised across every read-only scenario, each of which is then seconds of
  CLI/MCP calls.
- **Per-release:** the full matrix — both targets (`local` + every pinned breakage),
  mutation-over-clone and concurrency scenarios (each needing a private index build, so
  ~1–2 min *each*), `serve`-at-scale, macOS native **and** the Linux container (ADR 015:
  the container structurally cannot see the case-sensitivity class, so container-only is
  forbidden), with `--forbid-skip realism` on the macOS job.

**Shared-index caveat, stated rather than hidden:** "read-only" is not literally read-only
— `mast_callers`/`mast_rename_impact` JIT-refresh the named file and tool calls append to
the metrics DB [inferred: `jitRefreshFile` / `recordToolCall` call sites in
`src/mcp/tools/`]. Sharing one state dir across scenarios is therefore shared-mutable
state with benign mutations. Rule: scenarios whose assertions concern **staleness,
freshness, metrics, or idempotency get private state dirs**; only agreement/closure/golden
scenarios may share, and the results record notes the sharing so a weird failure can be
re-run isolated.

---

## 2. The assertion strategy, ranked — the core

The hard problem, as measured by this repo already: over a large corpus, absence
assertions (`searchMisses`, `callersExclude`) false-red the moment a name appears anywhere
else — including in a surviving caller's printed body (ADR 015 §6; `lib/assert.mjs`
header). The symbol-level JSON form fixed the *stdout* half; the *name-collision* half is
unfixable by parsing, because over 13,330 files symbol names genuinely recur. The ranking
below is by what each approach catches per unit of maintenance, with the false-red
mechanism named per row.

### R1 — Cross-tool consistency and closure invariants (build first)

Relations between tools over one index, asserted as plain set comparisons over parsed
JSON. No external oracle, no golden data, deterministic by construction (both sides read
the same index in the same process generation):

- **search→signature closure:** every declaration-typed result `mast_search` returns (for
  a frozen query battery) must resolve through `mast_signature` at the same
  `(symbol_name, file_path)`. This is D023's class — the walker and the resolver as two
  producers of one path — asserted at the artifact layer over every path shape n8n
  contains.
- **callers ↔ rename_impact:** `mast_rename_impact` composes `mast_callers`
  [inferred: `src/mcp/tools/rename-impact.ts` imports `queryVerifiedCallers` and the tool
  description says so]; the verified-caller **sets** must be equal for a frozen symbol
  list. Divergence means the composition drifted (S-05).
- **exports ↔ project_skeleton:** a file's `mast_exports` list equals its skeleton entry.
- **dependencies → index membership:** every `resolved_path` `mast_dependencies` returns
  names an indexed file. `queryDependencies` was D023's *fourth* consumer site — the one
  the fix's first write-up missed — so this relation has already caught a real S0 once.
- **status ↔ mast_status:** field-set equality between `mast status --json` and the MCP
  tool — D035's pin re-asserted at the artifact/transport layer, where the unit pin
  (`status-surface-parity.test.ts`) cannot see a packaging or serialization break.
- **Idempotency / determinism:** `captureEquals` (PLAN's normalized query battery) across
  a no-op reindex, and across two fresh state dirs over the same corpus — D003's class at
  73k chunks.

**False-red analysis:** these relations false-red only where the relation is not actually
total — markdown/doc chunks with no `symbol_name`, skeleton truncation
(`potential_truncated`), overloads/declaration-merging giving `mast_signature` multiple
candidates, JIT refresh firing on one side of a comparison. That is precisely why ADR 015
§6's rule binds hardest here: **every relation is established against captured real output
(build step 2) before its assertion kind is written**, and the relation is asserted over
*frozen* input lists, not corpus-wide sweeps. Corpus-wide sweeps run once, as an audit, in
step 2 — a violation found there is a defect to file (the D029 pattern), not a flaky
assertion to ship.

**What R1 cannot catch:** two tools agreeing on the same wrong answer. ADR 015 already
concedes this for the parity assertions; it is R2's job.

### R2 — Frozen goldens for a hand-audited subset (build second)

Ten to fifteen n8n symbols, hand-audited **at the pinned SHA**, answers frozen as data:
declaration file for each, exact verified-caller set for low-fan-in symbols, membership +
exact count for one high-fan-in case (`INodeType` implementors — also the natural host for
the truncation flag). Selection rules, applied at audit time with receipts recorded in the
scenario file: corpus-unique name (ripgrep count captured), fan-in ≤ ~5 for exact-set
rows, and deliberately one each of: barrel-re-exported, type-only, default-export,
mixed-case path, workspace-alias import.

**Why it earns its cost:** it is the only strategy here that anchors *absolute*
correctness; everything in R1 is a divergence detector. **False reds:** near zero at a
pinned SHA *if* the assertions are memberships and sets over parsed fields — never ranks,
never scores, never token counts. The real maintenance cost is legitimate semantic change
in mast (e.g. checker-verdict filtering policy): a golden then encodes yesterday's
semantics. Mitigation: each golden row carries the producing command, audit date, and a
failure message that says "decide whether this is a regression or a semantics change —
do not tweak the golden to green".

### R3 — Metamorphic relations under mutation (build third)

Compare mast-before to mast-after across a mutation whose semantic effect is known,
avoiding absolute expectations entirely:

- **Move a leaf directory** (chosen at build time: a package subtree with few external
  importers, importers updated by sed-style edit): the verified-caller sets for its
  internal symbols are preserved **modulo the path rewrite**; nothing else in the capture
  battery changes.
- **Semantically-null mutation** (touch; or an edit strictly below every declaration —
  note a whitespace edit is *not* null, `chunk_id = sha256(path + start_line)` breaks on
  line drift, `eval/paths.mjs:39-44`): `captureEquals` against the pre-mutation capture.
- **Delete a subtree:** `file_count` drops by exactly the subtree's indexable-file count
  (computed from git, §R4), and a **sentinel** symbol the harness itself added earlier
  (`addFile`) disappears — the one absence assertion that cannot name-collide, because the
  harness invented the name.

**False reds:** ordering/score drift across a reindex → compare normalized sets, never
ordered lists; an incremental-vs-full divergence is not a false red, it is D030's class
and exactly the point.

### R4 — A narrow independent file-set oracle (build with R3)

`git ls-files` intersected with the pinned config's `file_extensions` +
`exclude_patterns`, compiled by **fast-glob** — the engine `walkProject` itself hands
patterns to [inferred: `e1-common.mjs:362-364` records this; D033's row confirms
index-time exclusion is fast-glob's] — compared against the artifact's reported file
count. Same-engine caveat stated: this cannot catch fast-glob's own bugs; it catches
**mast losing files fast-glob would have delivered** (D034's class: parse/write failures
silently deleting files from the index; D002's: a rolled-back transaction) at the layer
where a user meets them. Tolerance: exact equality — any diff is a finding.
**Precondition to check against real output first:** which population `status --json
file_count` reports — walked (13,985) or chunk-bearing (13,330). The 655-file gap between
those two numbers is real and characterised [measured: `e1-tiers.json` logged deviation];
writing this assertion without resolving it would manufacture a permanent false red or,
worse, a tolerance that hides D034.

### R5 — Full differential against tsc / ts-morph: **rejected, with the trigger for revisiting recorded**

Reasons, in order of weight: **(a)** semantic mismatch by design — `verified_callers` is a
graph-edge claim under mast's own resolution policy (checker-verdict filtering,
POTENTIAL_CALL discard — D009 established that unresolved calls leave *no* row), which is
not tsc's find-references; a "documented, principled tolerance" between the two is an
eval-track research artifact (ADR 009/010 territory: gold sets, pre-registration), not a
harness assertion, and an unprincipled tolerance is a false-red generator with a knob.
**(b)** Cost: ts-morph over 13,985 files is minutes of CPU per run **[unmeasured]** plus a
second resolver whose own version drifts. **(c)** The class it would uniquely catch —
systematic resolver misses that R1 cannot see because both sides share the resolver — is
served by R2's goldens at a fraction of the cost, imperfectly but auditably. **Revisit
trigger:** if R2 goldens ever disagree with mast in a *pattern* (two or more goldens, same
shape), that is the moment to spend on an independent oracle for that shape — recorded
here so the decision has a tripwire rather than a vibe.

### Absence assertions over the clone: restricted, not banned

`searchMisses`/`callersExclude` on n8n only for (a) harness-created sentinel symbols, or
(b) audit-time-verified corpus-unique names with the ripgrep receipt in the scenario.
Anything else is the measured false-red replayed at 13,330-file scale.

---

## 3. New assertion kinds — closed vocabulary entries

Each row extends `ASSERT_KINDS` (`integration/lib/assert.mjs:19-32`, currently 12 kinds)
and `spec-validate`'s closed vocabulary. Per ADR 015 §6 — the rule that found D029 and
killed two designed assertions — **each kind names the real output that must be captured
and inspected before the kind is implemented.** None of these outputs has been captured
yet; that is build step 2, and any kind whose capture contradicts its spec gets redefined
there, not patched after.

| kind | required keys | asserts | real output needed before writing it |
|---|---|---|---|
| `signatureResolves` | `symbol`, `file` | `mast_signature` returns ≥1 declaration at `file` | a real n8n `mast_signature` hit; the not-found shape; the multi-candidate (overload/merge) shape; a `ClassName.methodName` qualified lookup |
| `callersMatchRenameImpact` | `symbol` | verified-caller set equality across the two tools | both tools' JSON for one symbol — field names for callers differ across tools today? (`assert.mjs:50` already hedges with three fallbacks — resolve that hedge with a capture, don't inherit it) |
| `exportsMatchSkeleton` | `file` | export-list equality | one `mast_exports` + the skeleton subtree containing that file; the skeleton's `max_depth` and `potential_truncated` behaviour at n8n's depth |
| `dependenciesResolveIndexed` | `file` | every `resolved_path` is indexed | `mast_dependencies` on a workspace-alias import (`@n8n/*`) and on a relative import; and the cheapest artifact-side membership probe (exports on that path? a files query?) — pick from output, not from memory |
| `goldenCallers` / `goldenDeclaration` | `symbol`, `expected…` | audited answer, frozen | the full JSON for every audited symbol, captured at audit time and pasted into the scenario as provenance |
| `implementorsInclude` | `interface`, `implementor`, optional `count` | membership + audited count | `mast_implementors` on `INodeType`: result size, truncation flag, count semantics |
| `statusAgreesAcrossSurfaces` | `fields` | CLI `status --json` == MCP `mast_status` on named fields | both surfaces' JSON post-D035 — verify the unified `measureFreshness` fields actually match on the wire, since the unit pin runs in-process |
| `captureEquals` | `comparedTo` | normalized battery equality | two back-to-back identical runs' batteries, **diffed empirically** to derive the volatile-field mask list (PLAN names `duration_ms`, `last_indexed`, `state_dir`, `efficiency_ratio`, `tokens_*`, chunk ids; the diff is the authority, and every normalizer rule carries `masks:` per the PLAN) |
| `serveMatchesQuery` | `tool`, `args` | serve-over-stdio == fresh `mast query` | `mast serve` against the 439 MB prebuilt state dir: startup-ladder wall time, whether `bootstrapState`'s background `runIndex` can change answers **between two calls in one session** (a race that would make this kind flaky at scale — must be observed before the kind ships) |
| `efficiencyConsistent` | `expectedCallsByTool` | session-scope `calls_total`/`calls_by_tool` match the battery actually issued; `tokens_returned > 0`; never exact token counts | a real session's `mast_efficiency` JSON [field names inferred from `src/mcp/tools/efficiency.ts` this session — D027 is the standing warning that inferred field names must be capture-confirmed] |
| `fileSetMatchesGit` | — | file count == git-derived expectation | `status --json`'s count population (13,985 vs 13,330 — see R4) |

**New machinery, one item:** an **`mcpSession` step** — one `mast serve` process, several
ordered tool calls, then teardown. Required because `callMcpTool` spawns a fresh serve per
call (`integration/lib/mcp-client.mjs:14-19` [measured: read]), which makes every
session-scoped assertion (`mast_efficiency scope:'session'`, `mast_reindex`-then-query)
structurally impossible today. Also the honest way to exercise `serve`'s startup ladder
once and query it repeatedly.

---

## 4. Scenario table — the realism family

`project: 'n8n'`, `tags: ['realism', …]`. "Adds" is stated per ADR 015's discipline: no
scenario is presented as first coverage when it is not. Calibration column: §6 of this
document; **R** = ledger-revert breakage, **C** = constructed fault (weaker, and labelled
as such in the run record).

| id | tools | claim under test | adds over existing coverage | calibration breakage | tier |
|---|---|---|---|---|---|
| `n8n-cold-index-truthful` | index, status | a full pnpm-monorepo index completes, exit 0, and loses no files (`fileSetMatchesGit`) | first artifact-layer index of a real monorepo; D034/D002's *consequence* observable at scale | C: patch installed walker's extension list (drop `.tsx`) — observed red before trusted | nightly |
| `n8n-search-signature-closure` | search, signature | every declaration hit resolves | first coverage of `mast_signature` anywhere in the harness; D023's two-producers class over every natural path shape | R: `d023-miscased-import` **iff** n8n at the pin contains ≥1 mis-cased import on macOS (verify in step 2; else C: resolver patch) | nightly |
| `n8n-callers-rename-impact` | callers, rename_impact | two composers of one answer agree | first coverage of `mast_rename_impact` | C: patch rename-impact's composition in dist | nightly |
| `n8n-exports-skeleton` | exports, project_skeleton | export lists agree | first coverage of both tools | C: patch skeleton's exported-symbol filter | nightly |
| `n8n-dependencies-resolve` | dependencies | `resolved_path` always names an indexed file | first coverage of `mast_dependencies`; D023's fourth consumer site | R: `d023-miscased-import` (same contingency as above, stated per-run) | nightly |
| `n8n-goldens` | callers, signature, implementors | 10–15 audited symbols answer as audited; `INodeType` implementors include audited members at audited count; truncation flag fires where audited | the only absolute-correctness anchor; catches agreed-wrong answers R1 cannot | R: `d030-stability-skip` for the post-move golden variant; C: edge-drop patch for cold-index goldens | nightly |
| `n8n-reindex-idempotent` | index ×2, captureEquals | a second index is semantically a no-op | D003's class at 73k chunks, artifact layer | R: D003 revert (walker sort removal) — **red is probabilistic** (D003's own row: pre-fix order "arbitrary rather than reliably unsorted"), so this is calibrated by an *observed-red calibration run recorded in the scenario comment*, **not** `expectFailOn` — a sometimes-green pin would trip the calibration gate falsely | release |
| `n8n-move-leaf-dir` | index --incremental, callers, search | moving a real subtree rewrites paths and nothing else (metamorphic) | mass-move over a natural import graph; D030's class beyond the fixture | R: `d030-stability-skip` (revert `isFileUnchanged`'s content/imports comparison in dist) | release |
| `n8n-sentinel-lifecycle` | index, search, reindex(MCP) | a harness-created sentinel appears, then disappears on delete — absence with zero collision risk; `mast_reindex` over MCP takes effect | first MCP-session coverage of `mast_reindex`; the only safe `searchMisses` on a big corpus | C: patch deleted-file cleanup call in dist | release |
| `n8n-concurrent-index-refuses` | index ×2 processes | second writer refuses; index uninjured (post-hoc `captureEquals`) | the fixture indexes in ~1 s — no real overlap window; n8n's ~60 s window makes the race real | C: skip-lock patch | release |
| `n8n-serve-at-scale` | serve/mcpSession: status, search, callers, efficiency | handshake + battery over stdio against a 439 MB state dir; `serveMatchesQuery`; `efficiencyConsistent` | `serve`'s startup ladder has never run against a non-toy index; first coverage of `mast_efficiency` | C: patch the status tool's freshness call in dist (D035's shape re-introduced) | release |

Eleven scenarios. Deliberately **not** included, with reasons: wholesale replays of the
fixture mutation family on n8n (§5.5 budget — the fixture already pins the logic; the
clone adds scale and naturalness only where those change the question); D037/D002 ceiling
scenarios (§0 — n8n cannot reach the ceilings, recomputed); crash-mid-index (stays in the
fixture family per the PLAN — SIGKILL timing against a 60 s window is *easier* here, but
the assertion set is identical and the fixture run is 50× cheaper to iterate).

---

## 5. Coverage matrix — 11 tools × mutation classes

**U** = unit/in-process; **F** = fixture-family integration (shipped or in PLAN);
**C** = clone family (this design); **–** = uncovered. A cell marks the *strongest* layer
that exercises the pair; per §5.5 one layer is enough when it is the natural one.

| | cold/none | delete | move | rename-sym | case-rename | edit-stale | add | ext-change | symlink | crash | 2-proc | pkg/transport |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| search | **C** | F/U | **F** | F(plan) | U | F(plan)/U | F(plan) | F(plan) | F(plan) | F(plan) | – | **C**(serve) |
| signature | **C** | – | – | – | – | – | – | – | – | – | – | C |
| callers | **C** | F/U | **F** | F(plan) | **F** | U | – | – | F(plan) | – | – | C |
| implementors | **C** | – | – | – | – | – | – | – | – | – | – | – |
| exports | **C** | – | – | – | – | – | – | – | – | – | – | – |
| skeleton | **C** | – | – | – | – | – | – | – | – | – | – | – |
| rename_impact | **C** | – | – | – | – | – | – | – | – | – | – | – |
| status | **C**/F | F/U | F | – | – | F(plan)/U | U | – | – | F(plan) | – | **C** |
| reindex(MCP) | **C** | **C**(sentinel) | – | – | – | – | C | – | – | – | – | C |
| dependencies | **C** | – | – | – | – | – | – | – | – | – | – | – |
| efficiency | **C** | – | – | – | – | – | – | – | – | – | – | **C** |

The matrix says plainly what a green suite will still not know: **seven tools are
exercised only in the cold/none column** even after this family ships. That is a chosen
budget, not an oversight — the mutation × tool cross-product is 100+ scenarios, and most
cells reduce to "the index changed correctly" (already asserted via search/callers/status)
plus "tool X reads the index correctly" (asserted in the cold column). The cells worth
adding *later*, if the family earns its keep: rename_impact after a real rename
(the tool's whole purpose), exports/skeleton after move (path rewrite in two more
surfaces).

**Per §11.3 — what would belong here that I did not look for:** watch mode (`--watch`)
under any mutation class (the D033 row shows its exclusion regexes were inert for weeks —
nothing here exercises the watcher at all); `git checkout` / branch-switch as a mass
mutation (mtime semantics differ from `mv`); pnpm store changes rewriting `node_modules`
symlinks under a running serve; unicode and space-containing filenames (I did not check
whether n8n at the pin contains any); `.vue` files (n8n's frontend — I did not check
whether they exist at the pin or how the walker treats an excluded-extension file that
*imports* an included one); `mast index --checker` at n8n scale (cost unmeasured, and
rename_impact's checker-verdict filtering path is therefore never exercised end-to-end);
`mast_efficiency` `scope:'global'` and `since_minutes`; Windows and non-glibc Linux (ADR
015 already concedes these); case-sensitive macOS (APFS can be formatted either way — the
`requires` probe handles it per-machine, but no CI leg guarantees the case-sensitive-mac
combination).

---

## 6. Calibration — the load-bearing section

The standing rule (ADR 015 §1, `run.mjs:137-155`): a green means nothing until the
scenario has been observed red, and a pinned-red scenario going green fails the whole run.
Extending it to this family:

**Extend `BREAKAGES`** (`integration/lib/install.mjs:28-36`) with ledger-revert patches
where a one-string (or small multi-string — the table must grow a `patches: []` form,
since D030's fix spans more than one statement) revert exists in the installed `dist/`:

- `d030-stability-skip` — revert `isFileUnchanged`'s content/imports comparison. Pins:
  `n8n-move-leaf-dir`, the post-move golden. (The exact dist-level string must be derived
  from the built output, not assumed from source — step 4's job; `install.mjs:107-112`
  already hard-fails when a breakage's `from` string no longer exists, which keeps these
  from rotting silently.)
- `d023-miscased-import` — already exists; extends to `n8n-search-signature-closure` and
  `n8n-dependencies-resolve` **only if** step 2 finds a mis-cased import in n8n at the pin
  (macOS legs only, `requires: 'case-insensitive-filesystem'` as today). If none exists,
  those scenarios stay pinned on the *fixture* variant and the n8n variant's README row
  says "uncalibrated against d023; calibrated against <constructed fault>" — the
  distinction is recorded, not blurred.
- Constructed faults (**C** rows in §4): each is a named, one-line patch of the installed
  artifact, applied through the same machinery, and each pinned scenario must be observed
  red against it before its green is reported as evidence. A constructed fault proves the
  harness can see *that* fault, not the family — weaker than a ledger revert, and the run
  record labels which kind each pin is, so nobody later reads a strawman pin as a real
  regression pin.
- **The D003 exception is handled honestly:** its revert produces *probabilistic* red
  (the ledger row itself: no guaranteed-red test was constructible). `expectFailOn` would
  make the calibration gate itself flaky. So `n8n-reindex-idempotent` is calibrated by a
  recorded observation (N reverted runs, at least one red, documented with the run
  artifact path in the scenario header) rather than by a per-run pin — and that weaker
  status is stated in the README's status section, not silently equated with the others.

Every run that exercises no pinned pair already says its green is uncalibrated
(`run.mjs:150`); that behaviour extends unchanged to the new breakage names.

---

## 7. What this cannot claim (ADR 015's voice)

**Nothing here is built.** Every runtime number for the family itself is a projection until
step 1's measurement lands; the only measured numbers are the eval track's, produced by a
different binary generation on one machine.

**A green run is not "no bugs shipped", and no extension of this harness will make it so.**
The gap has named parts: the scenario list samples the mutation space, it does not
partition it (§5's un-looked-for list is the honest residue); the agreement assertions
(R1) prove two surfaces agree, and agreeing on a wrong answer passes every one of them;
the goldens (R2) anchor absolute correctness for ~15 symbols out of 51,551
[measured: `symbol_count`, e1-p0.json] — a 0.03% audit; and this repo's own ledger records
that its defects were found overwhelmingly by reading, measuring, and adversarial review,
not by suites — 0 of the first 28 rows by a failing test, 1 of 37 to date. The suite pins
what is known. Releases that ship *unknown* defects will do so through the classes nobody
enumerated, and the instrument for those remains what the LEDGER says it is.

**One corpus, one SHA, one language family.** n8n is TypeScript/JavaScript/Markdown under
one config; nothing here speaks to other-language repos, to corpora above SQLite's
parameter ceilings (n8n cannot reach them — 13,985 files, max 404 chunks/file, both
measured), or to repos with pathologies n8n happens to lack. The pin also ages: n8n at
`9d9e9bf` stops resembling "a modern monorepo" eventually, and re-pinning invalidates every
golden and every audited receipt at once — that cost is deferred, not avoided.

**Retrieval quality stays out of scope** (ADR 015's own boundary): whether a ranked result
is *good* belongs to the eval track's gold sets and pre-registration. This family asserts
answers are structurally true — present, absent, consistent, flagged — never that they are
the answers an agent needed.

**The environment matrix is still two cells.** macOS-native plus one Linux container.
The container cannot see the case-insensitivity class (ADR 015); nothing sees Windows,
non-glibc Linux, or case-sensitive APFS; and the native-module story on any machine but
this one remains exactly as unverified as ADR 014 says.

---

## 8. Build order — machinery before claims

1. **`lib/corpus.mjs` + mutation hardlink-safety + `--forbid-skip`.** Exit: n8n resolves
   from the existing worktree with both checks passing; a deliberately truncated clone
   (marker absent) is detected and rebuilt or SKIPped; `editFile` on a hardlinked copy
   provably leaves the cache inode untouched (assert nlink/content); **and the first
   measured number this design lacks lands: full-worktree cold index on the current
   binary, recorded in the results dir.**
2. **The capture audit.** Run every one of the 11 tools against the built index by hand
   once — CLI and MCP — and record the outputs. Resolve every "real output needed" cell in
   §3, including: `file_count` population, serve's background-index race, n8n mis-cased
   imports (decides two calibration rows), the volatile-field diff for the normalizer.
   Exit: each planned kind is marked writable / redefined / dropped, with its capture
   attached. This is where the next D029 falls out if there is one, **before** any
   assertion encodes a wrong assumption.
3. **Assertion kinds + `mcpSession` + `capture`/`normalize`.** Closed vocabularies
   extended in `assert.mjs` and `spec-validate.mjs` together (a kind without validation is
   a typo-shaped hole). Exit: spec-validate rejects every malformed variant of each new
   kind; the normalizer's every rule carries `masks:`.
4. **Breakages.** `BREAKAGES` grows the multi-patch form and the new entries; each is
   applied to a real install and its target scenario observed red. Exit: the README status
   table lists every pin with its kind (ledger-revert vs constructed) and the date each
   red was observed.
5. **Read-only battery** (scenarios 1–6): shared index, private-state exceptions per
   §1.4's rule. Exit: green on `local`, red on each pinned breakage, run wall-clock
   recorded to validate the nightly budget.
6. **Mutation, concurrency, serve** (scenarios 7–11). Exit: same bar, plus the corpus
   guard has been observed ERRORing on a deliberate cache write (proving the guard is not
   decoration).
7. **CI wiring** per §1.4's tiers; the release job carries `--forbid-skip realism` on the
   macOS leg. Exit: one nightly and one release-shaped run archived.
8. **Amend ADR 015** with what the first green run actually covered — its own standing
   rule.

---

## 9. Findings about the existing harness, in passing

Filed here because an adversarial pass that only reviews its own additions is reviewing
the wrong thing; none of these blocks the design, two shape it:

1. **`writeSet` is accepted and enforced nowhere.** `spec-validate.mjs:15` lists it in
   `KNOWN_SCENARIO_KEYS`; no other line in `integration/` reads it [measured: grep]. A
   declared allowlist nothing checks is decoration (the S-B form), and
   `spec-validate.mjs:72-74`'s own comment leans on the write-set's *absence* to justify
   another guard — the comment is right, the key is a trap for the next author who
   declares one and believes it. Either implement enforcement (the clone family raises
   the stakes: a 242 MB shared cache) or remove the key.
2. **Content-writing mutations write through hardlinks** (§1.3) — latent today (the
   fixture materialises by copy), corrupting tomorrow.
3. **`callMcpTool` spawns one serve per call** (`mcp-client.mjs:14-19`) — fine for the
   shipped scenarios, structurally incompatible with session-scoped assertions; §3's
   `mcpSession` is the fix.
4. **The eval n8n cache's parent repo lives in `~/temp/`** (§1.2) — an eval-track
   fragility the harness must not inherit.

---

## 10. §11.8 — the three most damaging claims, attacked

**Claim 1: "a full n8n cold index costs ~1 minute, so the nightly battery is affordable."**
Attack: the 56–60 s figures are hardlink *tiers* (13,330 files) on the **2026-08-18**
binary; the harness will index the full worktree (13,985+ files, walking 26,341 tracked
paths and whatever `exclude_patterns` must reject) with **today's** binary through an
**installed** package. The only full-worktree number on record is 636 s on the 2026-08-12
binary — a 10× worse generation, but a reminder that this figure has moved 10× once
already. If the true number is 5+ minutes, the nightly tier is mis-designed. Disposition:
the claim is demoted to a projection everywhere it appears, and step 1's exit criterion is
the measurement. Not resolvable in this pass without building dist and writing a state
dir, which the brief forbids.

**Claim 2: "R1's cross-tool relations are deterministic and false-red-free."** Attack:
I verified none of them against real output — the design's own §3 admits every relation
has known partiality candidates (doc chunks, truncation, overloads, JIT refresh, serve's
background index). The claim as stated is false for corpus-wide sweeps and only plausibly
true for frozen input lists filtered at audit time. Disposition: restated throughout as
conditional on step 2's captures; sweeps demoted to one-time audits. The residual risk —
a relation that held on capture day failing later on an input *inside* the frozen list for
a benign reason — is real but bounded, and a failure there is at minimum a documentation
defect in the tool contract, which is a finding.

**Claim 3: "every scenario family gets a meaningful red."** Attack: five of the eleven
pins are constructed faults, which prove the harness can see the fault I built, not the
defect class the scenario claims to guard — a pin against a strawman reads exactly like a
pin against D023 in a green summary. And one (D003) cannot be per-run pinned at all.
Disposition: the kind of every pin (ledger-revert / constructed / observed-once) is made a
first-class, reported attribute (§6, step 4's exit criterion), so the weaker pins are
legible as weaker rather than laundered by the calibration gate's prose.

**What I could not check, and why:** whether n8n at the pin contains a mis-cased import
(needs a resolver-side scan; decides two calibration rows — deferred to step 2); which
population `status --json file_count` reports (needs a run against a built binary);
dist-level revertibility of D030/D031 as string patches (needs the built `dist/`, which I
did not build — the repo's `dist/` is gitignored state I was told not to touch); install
wall-clock including native rebuilds (same constraint); serve's startup behaviour against
the 439 MB state dir (same); whether `.vue` or unicode-named files exist at the pin (cheap,
but I chose to spend the budget on the claims above; it is step 2 work either way). Every
one of these is scheduled rather than assumed.

---

## 11. Independent verification of this document (2026-08-20)

This design was produced by an adversarial design pass (the convention ADR 015 §6 records).
Per CLAUDE.md §11.7 — *verify borrowed citations before adopting them* — the claims this
document's authority rests on were re-derived from the primary artifacts before it was
committed. What was checked, and what it found:

**Confirmed, by opening the artifact:**

| claim | check | result |
|---|---|---|
| `writeSet` is enforced nowhere | `grep -rn writeSet integration/` | one hit, `spec-validate.mjs:15`. Filed as **D041**. |
| `callMcpTool` spawns one `serve` per call | read `lib/mcp-client.mjs:9-28` | confirmed — transport constructed inside the per-call function |
| the eval n8n cache's parent repo is in `~/temp/` | `cat ~/.cache/mast-eval/e1-wt/n8n/.git` | `gitdir: /Users/…/temp/enterprise-apps/n8n/.git/worktrees/n8n` |
| content mutations use `writeFileSync` | read `lib/mutations.mjs:51,61,68,77` | confirmed; latent only because `lib/project.mjs` materialises by copy today |
| `BREAKAGES` is a single `from`/`to` pair and hard-fails when `from` is absent | read `lib/install.mjs:28-36,104-116` | confirmed — so the `patches: []` form §6 asks for is genuinely required for D030 |
| n8n at the pin: 13,985 files / 73,359 chunks; 636.0 s on the 2026-08-12 binary | `eval/results/e1-p0.json` | `measurement.file_count 13985`, `chunk_count 73359`, `duration_ms 635996` — all three reproduce exactly |
| the worktree is at the pin | `git rev-parse HEAD` in `~/.cache/mast-eval/e1-wt/n8n` | `9d9e9bf97e8ae5382a930cd662637a9cf7046ef9`, matching `PINS.n8n` |

**One correction.** §7 gives n8n's symbol count as **51,551** and derives "a 0.03% audit"
from it. `eval/results/e1-p0.json` — the artifact §7 cites — records
`measurement.symbol_count = 56000`. **51,551 is the T9 *tier* figure** (13,330 files), which
appears in five journals (`e1-verify`, `e1-ab`, `e1-scan`, `e1-hoist`, `e1-phase`); 56,000 is
the full worktree the clone family will actually index. This is §11.6's shape — a supporting
figure quoted where the primary belongs. The conclusion is unchanged (15/56,000 = 0.027%),
the denominator is not. Corrected here rather than in place, so the original claim and its
correction both stay legible.

**Not re-checked, and therefore still carrying the document's own labels:** every
`[unmeasured]` projection (full-worktree index time on today's binary, install wall-clock,
ts-morph cost); the field-name inferences in §3, which §3 already schedules for step 2's
capture audit; and the `e1-ladder` / `e1-hoist` runtime rows in §1.4, which were spot-checked
for plausibility against `e1-p0.json`'s 636 s but not re-derived per-run.


---

## 12. RESULT — build step 1, measured 2026-08-20

Appended, not edited in place: §1.4's projection stays visible above so the correction is legible
(the append-only convention `adr/proposals/*/PLAN-EXCERPT.md` uses).

**Step 1 is complete and its exit criterion is met.** `lib/corpus.mjs`, hardlink-safe mutations,
`--forbid-skip`, `projects/n8n.mjs` and the corpus/`materializeCorpus` wiring are in, and the
first scenario over a real corpus — `n8n-cold-index-truthful` — is **PASS on `local`**.

### The number the design was blocked on

| measurement | value | how |
|---|---|---|
| **Full-worktree cold index, today's binary, through the INSTALLED artifact** | **90.4 s** | `files: 13985 indexed, 0 skipped  chunks: +73359 -0  duration: 90410ms` |
| Second index, unchanged tree (incremental) | **0.53 s**, 13,985 skipped | the §7.1 stability skip, at scale |
| State dir after a cold index | **434 MB** | `du -sh` on the working copy's `.mast` |
| Corpus materialisation | **26,321 hardlinked, 0 copied** | `materializeCorpus`, ~instant |

**§1.4's projection was wrong, and in the unsafe direction.** It carried ~60–80 s
`[unmeasured]`, reasoning from the 56–60 s hardlink *tier*. The real full-worktree number is
**90.4 s** — 13% above the top of the projected band. The reasoning that produced the projection
was sound (tier excludes 655 zero-chunk files) and still landed short, which is the argument for
step 1 having a measurement as its exit criterion rather than a sanity check.

Against the 2026-08-12 binary's 636.0 s on the same worktree, today's is **7.0× faster**. §1.4
warned the figure had "moved 10× once already"; it has now moved 7× in the other direction, and
the tiering plan should be re-derived from 90 s rather than 60 s. The nightly shared-index
battery is unaffected (one index amortised); the per-release tier costs ~90 s *per* mutation
scenario needing a private index, so five such scenarios is ~7.5 min of indexing alone.

### An independent confirmation worth naming

`file_count` and `chunk_count` from the installed artifact are **13,985 / 73,359** — matching
`eval/results/e1-p0.json`'s `measurement.file_count 13985` / `chunk_count 73359` **exactly**.
Two binaries seven days and a generation apart, one running in-tree under the eval harness and
one installed from a tarball, indexing the same pinned corpus to the same population. That was
not asserted anywhere and is not a scenario; it is a spot-check that the artifact indexes what
eval thinks it indexes. It also confirms §0's recomputation from the artifact side: 13,985 files
really is below the 32,766-parameter ceiling, so the D037 class genuinely cannot go red here.

### The cache survived, checked rather than assumed

After the run, `~/.cache/mast-eval/e1-wt/n8n` is at `9d9e9bf9…` with `git status --porcelain`
empty. The scenario mutated nothing, so this exercises the guard's happy path only — the
`writeUnlinked` fix was verified separately and in both directions (§9.2): through a hardlink,
`writeFileSync` left the *cache* file reading `MUTATED`; through `writeUnlinked`, `nlink` went
2 → 1, the inodes diverged, and the cache kept its content.

### What step 1 did NOT settle

Everything §3 marks as needing captured output — which is all of step 2, unchanged. This
scenario asserts completion, non-emptiness, both status surfaces answering, and no writes into
source. It asserts **nothing about whether the 13,985 files are the RIGHT 13,985**; that is the
`fileSetMatchesGit` oracle (R4), and it still cannot be written until the `file_count` population
question is resolved against real output. One number matching e1-p0.json is a spot-check, not
the oracle.


---

## 13. RESULT — build step 2, the capture audit, 2026-08-20

**Step 2 is complete.** Every one of the 11 tools was run against the real n8n index
(13,985 files / 73,359 chunks at pin `9d9e9bf9`) through both surfaces — CLI `mast query` and a
real MCP stdio session — and the output read before any assertion kind was written against it.
That sequencing is the whole point of the step: §3 predicted it would be where "the next D029
falls out", and it produced **three defects, one of them the audit's headline**.

### 13.1 The headline: three read tools are unbounded (LEDGER D043)

| call | time | results | `tokens_returned` | truncation flag |
|---|---|---|---|---|
| `mast_signature {"symbol":"execute"}` | **78 s** | **580** | **331,159** | none |
| `mast_implementors {"interface_name":"INodeType"}` | 0.9 s | 625 | 30,213 | none |
| `mast_exports` on `packages/workflow/src/interfaces.ts` | 0.1 s | 370 | 23,127 | none |
| `mast_callers {"symbol":"jsonParse"}` | 1 s | 4 verified + 50 potential | — | **`potential_truncated: 378`** |

The first row is worse over MCP than the table shows: at 78 s it exceeds the SDK's 60 s client
timeout, so an agent calling it gets `MCP error -32001: Request timed out` and **no answer at
all**. Verified at source — `signature.ts`, `implementors.ts` and `exports.ts` contain no limit,
slice or truncation logic; `callers.ts` caps and reports. The concern was understood and applied
to one tool of four.

And the response reports itself as a success: `efficiency_ratio: 0.278` on the 331k-token answer,
i.e. "72% cheaper than reading the 516 files". Filed **OPEN**, not fixed — a cap needs a default,
an override, a wire field on three DTOs, and a decision about what `efficiency_ratio` means once a
response is truncated. That is a contract change, and `potential_truncated` is the precedent.

**This blocks two of §3's planned kinds.** `signatureResolves` and `implementorsInclude` must not
be written against the current unbounded shape — an assertion that calls
`mast_signature{symbol:'execute'}` would itself time out, and one that pins a 625-element
implementor list would pin a number nothing bounds.

### 13.2 The other two defects

- **D044** — `captureCounts` read `status.file_count`. There is no such field; it is
  `indexed_files`. Every `snapshot` step recorded `undefined`, and the first assertion to read it
  would have compared `undefined` with `undefined` and passed. Fixed, and it now throws.
- **D045** — `assert.mjs`'s caller-field fallback chain (`file_path ?? caller_file ??
  symbol_name`) was written against an assumed shape. The real shape is always `file_path`. The
  fallbacks would have made **`callersExclude` return PASS** on a shape change — a silent green on
  the one assertion whose job is catching a phantom caller. Fixed to read `file_path` and throw.

### 13.3 Every open question in §3, resolved

| question | answer |
|---|---|
| Which population is `file_count`? | Neither — **the field is `indexed_files`**, and it reports **13,985**, the walked population (not the 13,330 chunk-bearing tier). `fileSetMatchesGit` is writable against 13,985. |
| Do the two status surfaces agree on the wire? | 10 of 11 fields identical in name and value. **CLI additionally emits `initialised`; MCP does not.** So `statusAgreesAcrossSurfaces` must compare **named fields**, never full sets. |
| Does n8n contain a mis-cased import at the pin? | **No — zero.** `mast index` reported no `miscased_imports`. This **kills the `d023-miscased-import` contingency** in §4 and §6: the two closure scenarios cannot be calibrated by that revert and must use constructed faults, labelled as such. |
| Which fields are volatile across identical runs? | **Only `_stats.duration_ms`.** Four commands run back-to-back differed in nothing else — not scores, not ordering, not `efficiency_ratio`, not `tokens_*`. §3's proposed mask list was **over-broad**: masking `tokens_returned` and `efficiency_ratio`, as the PLAN suggested, would have hidden D043 exactly. |
| Can serve's background index change an answer mid-session? | Not observed. Three `mast_status` and two `mast_search` calls in one session returned byte-identical payloads (modulo `duration_ms`). **Only tested against an already-fresh index** — a stale index at startup exercises the background `runIndex` and remains untested. |
| Do `mast_callers` and `mast_rename_impact` agree, and on which field? | **Yes.** For `jsonParse`: both return 4 verified callers, identical `(file_path, line)` sets, identical element shape `{file_path, line, caller_symbol, context, resolution}`. `callersMatchRenameImpact` is **writable**. |
| `mast_signature` shapes | hit → `results:[…]` one element; miss → `results: []`; ambiguous → 580 elements (D043). |
| `mast_dependencies` shape | `{file_path, imports, _stats}` — 30 imports on `interfaces.ts`, 951 tokens. |
| `mast_efficiency` shape | `{scope, window_started_at, tokens_returned, tokens_full_file_upper_bound, efficiency_ratio, calls_total, calls_by_tool, tokenizer, counterfactual}`; `scope:'session'` works and returns in 2 ms. Session scope requires the `mcpSession` step, as §3 said. |

### 13.4 A false-red source found before it was written into an assertion

§2's R1 proposed a search→signature closure and treated widely-used symbols as safe inputs.
Measured: **`NodeOperationError` has 0 verified callers and 918 truncated potential matches**;
`WorkflowExecute`, 0 and 59; `getNodeParameter`, 0 verified, 0 potential, and `mast_signature`
returns `[]` for it. These are correct under mast's own semantics — `verified_callers` is a
checker-resolved *call* edge, so constructor use and interface-method dispatch do not produce one
(ADR 007 / D009) — and they would each have produced a confident false red. This is the
semantic-mismatch §R5 rejected a tsc differential over, showing up one layer earlier than
expected. **Rule for the goldens: choose low-fan-in symbols with a verified caller set, and
capture the receipt.** `jsonParse` (4 callers, 2 declaration sites) is the worked example, and is
now asserted in `n8n-cold-index-truthful`.

### 13.5 Observed, not filed as defects — with the reason

- **`mast_callers {"symbol":"getNodeParameter"}` takes 18.4 s to return zero callers.** It is
  correct and honest, and it is slow enough to matter for an interactive agent. Not filed because
  "slow" without a stated budget is not a defect, and this package has never registered one for
  query latency. It belongs in a latency budget decision, not the ledger.
- **`index_empty` is emitted only when true** (verified against a genuinely empty index), so
  `indexEmpty: {expected: false}` is satisfied by the field's absence and cannot distinguish
  "non-empty" from "the field stopped being emitted". Not a defect in mast — the field means what
  it says — but a real weakness in the assertion kind, now recorded in the scenario that uses it.

### 13.6 What step 2 did not do

It ran each tool **once**, on **one** corpus, at **one** pin, on macOS. It is an audit, not a
measurement series: no figure here has a repeat count, and the two timings that matter most (78 s
and 18.4 s) are single observations on a warm cache. They are strong enough to file D043, whose
claim is structural — *no cap exists in the source* — and not strong enough to be quoted as
performance characteristics.


---

## 14. D043 fixed, 2026-08-20 — §13.1's block is lifted

§13.1 filed D043 OPEN and recorded that it blocked two of §3's planned assertion kinds. It is
now fixed, so this records what changed for the design rather than leaving the block standing.

**What shipped:** an optional `limit` (default 50, max 500) on `mast_signature`,
`mast_implementors` and `mast_exports`, plus `results_truncated` / `exports_truncated` carrying
the real uncapped total on F10's omitted-when-false convention. The cap is **one exported
constant** shared with `mast_callers`' potential-match cap, not a fourth literal — the defect was
a cap on one tool of four, and copies would have re-created it.

**Measured against the same index §13.1 measured:**

| call | before | after |
|---|---|---|
| `mast_signature {"symbol":"execute"}` | 78 s, 580 results, 331,159 tokens, **MCP: timeout, no answer** | 8 s CLI / **6.7 s MCP**, 50 results, `results_truncated: 580`, **28,547 tokens** |
| `mast_implementors` on `INodeType` | 0.9 s, 625, 30,213 tokens | 0.9 s, 50, `results_truncated: 625`, **2,853 tokens** |
| `mast_exports` on `interfaces.ts` | 0.1 s, 370, 23,127 tokens | 50, `exports_truncated: 370`, **2,379 tokens** |

**Consequences for this design:**

- **`signatureResolves` and `implementorsInclude` are unblocked** and can be written. They must
  read the truncation field: over n8n both tools truncate on the natural inputs, so an assertion
  that ignores `results_truncated` would silently be asserting over a first page.
- **`implementorsInclude`'s `count` key changes meaning.** §3 specified "membership + audited
  count"; the audited count must now be the value of `results_truncated` (625), not
  `results.length` (50), because the latter is just the page size and would pin nothing.
- **A golden's caller set must still be low fan-in** (§13.4) — unchanged, and now for a second
  reason: a high-fan-in golden would pin a truncated page.
- **The truncation flag is itself newly assertable**, and is the natural host for a scenario the
  design did not have: *a capped response says it is capped*. That is cheap, it is the
  distinction between a first page and an answer, and it is exactly the class of signal
  (`potential_truncated`, `index_empty`, `stale`) this package treats as load-bearing.

**Not claimed:** the fix was measured on one corpus at one pin, single observations. The
structural claim — three tools now share one cap and report the real total — is what the unit
tests pin; the timings are supporting figures.
