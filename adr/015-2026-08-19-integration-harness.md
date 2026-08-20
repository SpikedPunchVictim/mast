# ADR 015 — An integration harness, and the mutation axis it exists for

- **Status:** Accepted — **design agreed, nothing built.** No scenario exists at the time of
  writing. Amended 2026-08-19 after an adversarial review of the design; the corrections are
  marked in place and §6 records what the review changed.
- **Decided:** 2026-08-19
- **Evidence:** [`PLAN.md`](proposals/integration-harness/PLAN.md) · reference implementation at
  `align/integration` (align's `docs/adr/025-2026-08-08-cross-version-integration-harness.md`
  and `026-2026-08-11-declared-write-sets.md`)

## Context

This package has 84 files matching vitest's include globs — 59 `src/**/*.test.ts` and 25
`eval/**/*.test.mjs` — of which five are excluded as retired Q1 instruments, leaving **79 that
run**. Every one of them executes in the same process as the build it is testing. Of those 79,
**none spawns a child process**; the one test file that does (`eval/__tests__/declex-cli.test.mjs`,
via `spawnSync`) runs an eval script rather than the binary, and is one of the five excluded.

The eval harness is the exception worth naming, because this design should borrow from it rather
than reinvent it: **`eval/e1-common.mjs` already runs the shipped binary out of process** —
`MAST_BIN` at `:27` resolves `dist/cli/index.js`, `:102` runs `status --json`, `:496` spawns
`index` — with a spawn discipline that strips `NODE_OPTIONS`, sets `ENABLE_MAST_PHASE_TIMING`
explicitly instead of inheriting it, and prefers `spawnSync` because `mast index` sets
`process.exitCode = 1` on partial failure. What it does *not* do is install the package: it runs
`dist/` in place, and only `index` and `status`. Nothing anywhere installs the package, and
nothing speaks to `mast serve` over a real transport.

Three specific gaps follow from that, and the third is the reason to build this now.

**The parity claim is narrower than it reads.** D0 (ADR 009) put the CLI at parity with the
MCP read tools. `src/cli/__tests__/cli.test.ts:509`,
`describe('mast query — dispatch/serialization parity')`, is honest about its own scope in
the comment above it: it asserts that `runQuery` reaches the same registered handler an MCP
client would invoke, and returns its exact response text. Both sides of that comparison are
handlers registered against a capture object inside one process. **Neither crosses a process
boundary or the MCP SDK's stdio transport.** D0's guarantee — that the CLI and an assistant
see the same answer — is asserted at the dispatch layer and unasserted end to end.

**Packaging is unverified by construction.** ADR 014's own "what this does not claim" says
it: the tarball has never been installed into a clean project, and the native-module story
(`better-sqlite3`, `tree-sitter`) is unverified off this machine. `.github/workflows/release.yml:83` checks
that the built binary reports the released version — D8's shape, caught at one layer — but a
missing `files` entry or an ABI failure is invisible to it.

**And the axis the suite reaches only partially: the index is derived state over a mutating
filesystem.** Stating this precisely, because the first draft of this ADR overstated it and an
adversarial review caught that (S-07 — "is it not there, or did we not look?"):

| mutation | covered in-process today |
|---|---|
| delete a file | **yes** — `cli.test.ts:363` `describe('deleted file cleanup')`, four tests across chunk store, graph rows, `chunk_fts`, and a surviving peer |
| delete then restore | **yes** — `fts-delete-guard.test.ts:143` |
| edit without reindexing | **yes** — `cli.test.ts:262` `it('reports stale_files = 1 after modifying a file')` |
| add a file with imports | **partly** — `chunk-store-growth.test.ts:86`, plus the resolver suites |
| **move / rename a file** | **no.** `grep -rn "renameSync" --include='*.test.ts' src` returns nothing — the suite never moves a file |
| **rename a symbol across call sites** | **no** |

So the honest claim is narrower and still sufficient: **move and cross-file rename are untested
at any layer, and no mutation of any kind has ever been run against the installed binary or
across a real transport.** That second half is where this tool's S0 class lives — a confident
answer that is silently wrong, with the caller unable to tell. After a delete, "no results" must
be a true absence rather than a stale hit; after a rename, `mast_callers` must not report a
phantom. The scenarios that duplicate in-process coverage are kept for exactly one reason — they
run the *artifact* — and the PLAN says so per scenario rather than presenting them as first
coverage.

## Decisions

### 1. Build `integration/`, modelled on align's harness

align's is a working answer to a closely related problem, measured on 2026-08-19 at `run.mjs`
(337 lines), twelve `lib/` modules (2,604 lines), and 28 scenarios. Its disciplines are
carried over unchanged, because each one exists to stop a specific way a harness lies:

- **No AI in the loop.** Every assertion is a plain data comparison. A model may read the
  results; it never participates in producing them.
- **PASS / FAIL / ERROR are three outcomes, not two.** FAIL is an assertion that came back
  false. ERROR is the harness failing to run the check at all — and it must never be reported
  as anything else.
- **A zero-scenario run is a hard error.** A typo'd `--tags` filter matching nothing is the
  cheapest possible way to turn a suite green (S-07: absence read as evidence).
- **Declared write-sets.** A scenario names the paths it may touch; an undeclared write fails
  it.
- **Real child processes, real stdio.** No in-process shortcut, ever — the shortcut is what
  the existing 84 files already do, and the reason this harness exists.
- **Working copies are deleted on PASS and preserved on FAIL**, so a failure can be examined
  rather than re-run.
- **A harness that cannot go red is indistinguishable from one that always passes** (align's ADR
  025, decision 5). This is the discipline the first draft dropped, and it is the most important
  one. align pins scenarios to fail against known-broken versions via `expectFailOn`, and
  `run.mjs:314-331` fails the whole run — independently of which target is being gated — when a
  pinned-red scenario comes back green. mast has no second published version to pin against, so
  the red target is a **deliberately broken local build**: reverting `safeRealpath`'s
  `realpathSync.native` to `realpathSync` re-introduces D023, whose ledger row records that five
  tests fail under exactly that one-word mutation. Until a scenario has been observed red against
  it, that scenario's green means nothing.
- **Every filter guards against matching nothing.** align has four (`run.mjs:82`, `:138`, `:144`,
  `:190`); the zero-scenario rule above is only the first. `--gate-target` gets the same guard —
  *"a gate target matching no results would silently report success"* is S-07 one level down.

### 2. The axis is mutation, not version

align's harness answers a cross-version question: install 0.1.4, upgrade, assert the
behaviour changed as the release notes claim. mast's driving question is different, and the
design follows it: **mutate the filesystem, then ask whether the index still tells the
truth.** Delete, move, rename, refactor, restore — the scenario families in
[`PLAN.md`](proposals/integration-harness/PLAN.md).

Two assertion kinds have no analogue in align's harness:

- **`callersExclude`** — assert a caller is *gone* after the code that called it was deleted.
  The S0 shape, expressed as a test.
- **`serveMatchesQuery`** — spawn `mast serve`, handshake, call a tool over stdio, and compare
  against `mast query` in a fresh process.

**The second one is a correction.** The first draft nominated `cliMatchesMcp` — CLI output
versus MCP output for one query — as "the single highest-value thing the harness will do."
That claim contradicts ADR 014 §5, which concludes from the same code that the two *cannot*
diverge on content: `search-cmd.ts:162` calls `runQuery('mast_search', …)`, which registers
the real tools and returns `result.content[0].text` unchanged. Four of the five surfaces the
PLAN listed for it (`callers`, `exports`, `signature`, `skeleton`) have **no CLI command at
all** — `buildProgram()` registers eleven commands and none of them is `mast callers` — so
their only CLI route is `mast query <tool>`, and comparing that against an MCP call compares a
string to itself.

Content parity is structural. What is *not* structural is the divergence in **freshness and
session state**: `mast serve` (`src/mcp/server.ts`) runs `bootstrapState` — the schema-version
wipe and full-reindex request — plus `assertServableIndex`, a background `runIndex`, and
optionally `--watch`. `runQuery` runs none of that and mints a fresh `sessionId` per
invocation. Two surfaces, one startup ladder, and only one of them climbs it. That is the real
question, and `serveMatchesQuery` is the assertion that asks it. `cliMatchesMcp` survives as a
ten-line byte-equality check that catches transport-framing and SDK-serialization regressions,
which is worth having and is not the headline.

### 3. The first *scenario* is a calibration pair, not the tarball

The first draft put `tarball-install-works` first, reasoning that it proves the harness works
while it is still simple to debug. The review pushed back and is right: that scenario asserts
`exitCode` and `stdoutContains`, the two weakest kinds in the vocabulary, so a green proves only
that the harness can spawn a process — not that it can *detect* anything. And it front-loads the
least controllable machinery there is (`npm pack`, an install, two native module builds) against
an artifact ADR 014 records as never having been installed anywhere. When it goes red on day one
you cannot tell whether the harness or the tarball is at fault, which is the opposite of easy to
debug.

So: **machinery first, claiming nothing. Then a calibration pair** — `move-file-preserves-symbols`
(a genuine gap, per the table above) run against both a good build and the D023-reverted build,
green on one and red on the other. Only after a scenario has been *observed* going red does any
of its green mean anything. `tarball-install-works` lands third, where it is a result rather than
a self-certification.

### 3a. The install must prove it installed what it packed

ADR 014 records that `dist/` is gitignored, and D022 records that `pnpm build` can exit 0 without
emitting. A tarball packed from a stale `dist/`, or an install that quietly falls back to the
registry, would produce a green run about the wrong bytes — D8's shape, and the exact thing this
harness exists to catch one layer out. align enforces three checks and all three port directly:
invoke by absolute path rather than `$PATH`; assert every `@spikedpunch/*` entry in the lockfile
resolves `file:`; and assert the `sha256` of the installed `dist/cli/index.js` equals the working
tree's. The version string is not sufficient evidence — between a publish and the next bump,
local and registry report the same number, which is precisely mast's situation the day v0.1.0
ships.

### 4. Cross-version targets are designed for and not used yet

`install.mjs` takes a target; `local` (the packed working tree) is the only one that can
exist until a second version is on the registry. The seam is worth keeping because
`CURRENT_SCHEMA_VERSION` changes force a full reindex on upgrade (ADR 014 §3), and that is a
cross-version behaviour no single build can assert.

### 5. VS Code in a container is declined

Verifying that mast registers as an MCP server inside VS Code means driving an Electron GUI,
which tests VS Code far more than it tests mast. The mast-side contract is narrower and fully
assertable without it: **`mast serve` speaks MCP over stdio and completes a handshake.** The
harness spawns it and does exactly that. The configuration snippets for Cursor, Windsurf, and
Zed remain unexecuted, as ADR 014 already records. Also recorded in ADR 013.

### 6. The design was reviewed adversarially before it was built, and it found a live S0

An independent pass over this ADR and its PLAN, briefed to recompute rather than confirm, is what
produced §1's calibration discipline, §2's correction, §3's resequencing, and the completeness
enumeration. It also checked the `edit-in-place-flags-staleness` scenario against real output
before accepting it as writable — and found the scenario had **nothing to assert against**,
because `mast search`'s human surface printed a stale file's pre-edit body as an ordinary
confident hit while the JSON on the same call carried `"stale": true`. That is **D029**, filed and
fixed in `d1117c6`, and it is the second-strongest argument for building this harness at all: the
scenario found the defect before a line of harness code existed.

The general lesson is recorded because it will recur: **every assertion kind must be checked
against the real output of the command it asserts on, before it is written into a design.** Two
more in the PLAN failed that check — `searchMisses` over stdout (a deleted symbol still appears in
a surviving caller's printed body, so the assertion is a false red) and `fileUnchanged` over
`graph.db` (three runs over identical content produce three different hashes — WAL, `last_indexed`,
and a growing `lock-metrics.jsonl`). Both are redefined in the PLAN over parsed JSON rather than
bytes.

## Consequences

- The failure classes this harness can see are ones the entire existing suite structurally
  cannot: a packaging omission, a native-module ABI failure, a stdio handshake regression, a
  CLI/MCP divergence, and a stale or phantom answer after a filesystem mutation.
- It is slow, and parts of it need a network — the pinned clone and the dependency install do;
  `npm pack` does not. It belongs on a separate CI job from the unit gate, not inside it.
- Every scenario runs the *installed* artifact rather than the working tree's `dist/`, which
  makes D8's shape — the artifact drifting from its source — visible at the layer where it
  actually bites a user.

## What this does not claim

**Nothing is built.** This ADR records a decision and a design; the harness does not exist,
and no claim here has been verified by running it. When the first green run lands, this
section is where its real coverage gets written down.

The harness cannot speak to **retrieval quality**. Whether a ranked result is *good* is the
eval track's question (ADR 009, ADR 010), measured against gold sets with pre-registration.
This harness only asserts that answers are structurally true — present, absent, consistent
across surfaces, correctly flagged.

The container gives a **Linux / Node-version matrix and nothing more**, and there is one class
it structurally cannot see. D023 — this package's most recent S0, where `verified_callers`
returned empty for a function that has a caller — only reproduces on a **case-insensitive**
filesystem; its ledger row records that on CI's ext4 a mis-cased import does not resolve at all,
so the canonicalising branch is asserted only on developer machines. A harness that runs solely
in a Linux container is built away from the one environment that can see it. **The harness must
therefore run natively on macOS as well as in the container**, and a case-only-rename scenario is
in the mutation family for that reason. Windows and non-glibc Linux stay unverified either way,
and the first publish is still the first real test of the native-module story on any machine but
this one.

The scenario list in `PLAN.md` is a **sample of the mutation space, not a partition of it**
(§11.3). It covers delete, move, rename, edit-without-reindex, mass-move, and add — chosen
because each maps to a known defect shape. Nothing enumerates what a filesystem can do to an
index, so a green harness is evidence about the mutations listed and silence about the rest.

Both parity assertions prove the two surfaces **agree**, not that either is correct. Agreeing on
a wrong answer passes them. They are divergence detectors, and the per-tool correctness they
rest on comes from the unit suite.

**The scenario list is not the enumeration.** The review that produced these corrections did the
enumeration this ADR had skipped and found five mutation classes with a credible S0 that the
design would never have noticed: case-only rename, symlinked directories, a crash mid-index, a
file whose extension leaves the include set, and two processes on one state dir. They are in the
PLAN now. That the list grew by five on first inspection is the honest measure of how complete
the original was.
