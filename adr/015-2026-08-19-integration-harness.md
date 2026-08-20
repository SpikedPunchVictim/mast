# ADR 015 — An integration harness, and the mutation axis it exists for

- **Status:** Accepted — **design agreed, nothing built.** No scenario exists at the time of writing.
- **Decided:** 2026-08-19
- **Evidence:** [`PLAN.md`](proposals/integration-harness/PLAN.md) · reference implementation at
  `align/integration` (align's `docs/adr/025-2026-08-08-cross-version-integration-harness.md`
  and `026-2026-08-11-declared-write-sets.md`)

## Context

This package has 84 files matching vitest's include globs — 59 `src/**/*.test.ts` and 25
`eval/**/*.test.mjs` — of which five are excluded as retired Q1 instruments, leaving **79 that
run**. Every one of them executes in the same process as the build it is testing. Exactly one
file in the tree spawns a child process at all (`eval/__tests__/declex-cli.test.mjs`, via
`spawnSync`), what it spawns is an eval script rather than the shipped binary, and it is one of
the five that do not run. Nothing in the suite installs the package, and nothing speaks to
`mast serve` over a real transport.

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

**And the axis nothing tests at all: the index is derived state over a mutating filesystem.**
Unit tests write fixtures and index them. They do not `git mv` a file, delete a directory,
rename a symbol across call sites, and then ask the *shipped* binary what it now believes.
That is where this tool's S0 class lives — a confident answer that is silently wrong, with
the caller unable to tell. After a delete, "no results" must be a true absence rather than a
stale hit; after a rename, `mast_callers` must not report a phantom.

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

### 2. The axis is mutation, not version — and `cliMatchesMcp` is the kind that earns it

align's harness answers a cross-version question: install 0.1.4, upgrade, assert the
behaviour changed as the release notes claim. mast's driving question is different, and the
design follows it: **mutate the filesystem, then ask whether the index still tells the
truth.** Delete, move, rename, refactor, restore — the scenario families in
[`PLAN.md`](proposals/integration-harness/PLAN.md).

Two assertion kinds have no analogue in align's harness:

- **`cliMatchesMcp`** — run `mast search X` and `mast_search {query: X}` against one project
  and assert the result sets are identical. This is the D0 guarantee stated end to end, over
  a real transport, and it is the single highest-value thing the harness will do.
- **`callersExclude`** — assert a caller is *gone* after the code that called it was deleted.
  The S0 shape, expressed as a test.

### 3. `tarball-install-works` is the first scenario, deliberately

`npm pack` the working tree, install into a bare project, `init`, `search`. It retires ADR
014's admitted gap on day one, and — the actual reason for the ordering — it proves the
harness itself works while it is still simple enough to debug.

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

## Consequences

- The failure classes this harness can see are ones the entire existing suite structurally
  cannot: a packaging omission, a native-module ABI failure, a stdio handshake regression, a
  CLI/MCP divergence, and a stale or phantom answer after a filesystem mutation.
- It is slow and it needs a network (a pinned OSS clone, an `npm pack`, an install). It
  belongs on a separate CI job from the unit gate, not inside it.
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

The container gives a **Linux / Node-version matrix and nothing more**. Windows and non-glibc
Linux stay unverified after it is green, and the first publish is still the first real test
of the native-module story on any machine but this one.

The scenario list in `PLAN.md` is a **sample of the mutation space, not a partition of it**
(§11.3). It covers delete, move, rename, edit-without-reindex, mass-move, and add — chosen
because each maps to a known defect shape. Nothing enumerates what a filesystem can do to an
index, so a green harness is evidence about the mutations listed and silence about the rest.

The `cliMatchesMcp` assertion proves the two surfaces **agree**, not that either is correct.
Agreeing on a wrong answer passes it. It is a divergence detector, and the per-tool
correctness it rests on comes from the unit suite.
