# Integration harness — design

Supporting document for [ADR 015](../../015-2026-08-19-integration-harness.md). Written
2026-08-19, **before any of it was built**, and revised the same day after an adversarial
review of the first draft. Where this document and the shipped harness disagree, the harness
wins and this file is stale — it is a design record, not a spec.

Reference implementation: `/Users/spikedpunchvictim/projects/align/integration`
(align's ADR 025 and 026). Read it before starting. As measured on 2026-08-19 it is
`run.mjs` (337 lines), **twelve** `lib/` modules (2,604 lines), and 28 scenarios.

## Layout

```
integration/
  run.mjs              — CLI: --scenarios --tags --project --targets --gate-target --out --keep-all
  Dockerfile           — Node 22 + 24, toolchain for better-sqlite3 / tree-sitter
  README.md
  lib/
    exec.mjs           — runMast(); never throws on a non-zero exit, DOES throw on a launch failure.
                         Invokes by ABSOLUTE path into the target's node_modules, never `$PATH`.
                         Sanitises the environment: NO_COLOR=1, drop FORCE_COLOR/CI/NODE_OPTIONS,
                         set ENABLE_MAST_PHASE_TIMING explicitly rather than inheriting it
                         (eval/e1-common.mjs:484-498 already learned all of this — port it)
    install.mjs        — target `local` = pack the working tree, install the tarball, then PROVE it:
                         lockfile entry resolves `file:`, and sha256(installed dist/cli/index.js)
                         == sha256(working tree's). See ADR 015 §3a
    project.mjs        — fixture and clone preparation; cache key includes node + npm version
    mcp-client.mjs     — spawn `mast serve`, real stdio JSON-RPC through the SDK resolved from the
                         WORKING COPY's node_modules (align's rule: exercise the shipped SDK)
    mutations.mjs      — deleteFile, moveFile, renameSymbol, editFile, addFile, touchFile,
                         caseOnlyRename, symlinkDir, killMidIndex, changeExtension
    assert.mjs         — the assertion kinds below
    capture.mjs        — the query battery (below), not raw files
    normalize.mjs      — every rule annotated with what it masks
    write-set.mjs      — declared write-sets
    spec-validate.mjs  — closed vocabularies + duplicate-key detection. NOT optional; see below
    fs-utils.mjs
    scenario-runner.mjs
  scenarios/*.mjs      — one plain data object per file
  projects/*.mjs
  results/             — gitignored
```

**`spec-validate.mjs` is load-bearing and the first draft dropped it.** Its job is not catching
scenarios that break; it is catching scenarios that **keep passing while asserting less than they
claim**. It parses each scenario's source text to reject duplicate property keys (by `import()`
time the first binding is already gone), and enforces closed key vocabularies so `stdoutContian:`
throws instead of silently asserting nothing. mast's vocabulary is *larger* than align's — nine
assertion kinds against six, plus free-form `mutate` arguments — so the need is strictly greater.
Add one guard align itself lacks: **reject a scenario whose steps contain zero `expect` and zero
`assert`.** align gets away without it because its fail-closed write-set is a universal implicit
assertion; mast's write-set is an allowlist over a noisy state dir and will not backstop the same
way.

## Step vocabulary

align's, unchanged: `install` · `run` (+ `expect`) · `mutate` · `mcpCall` (+ `expect`) · `assert`
· `snapshot`. (`mutate` is already first-class in align — `spec-validate.mjs:13` lists it in
`KNOWN_STEP_ACTION_KEYS` and 20 scenarios use it. The first draft said otherwise.)

Plus `expectFailOn` on the scenario object, and the calibration gate that fails the run when a
pinned-red scenario comes back green — ADR 015 §1.

## Assertion kinds

**Every one of these was checked against real command output before being written here.** Two in
the first draft could not be implemented as specified, and one of those checks turned up D029.

| kind | what it asserts | how, precisely |
|---|---|---|
| `exitCode`, `stdoutContains`, `stdoutMatches` | the command surface | plain |
| `exists` | a file is present / absent on disk | plain |
| `searchFinds` / `searchMisses` | a symbol is / is not a RESULT | over `results[].symbol_name` parsed from `--json`, **never over stdout** |
| `callersInclude` / `callersExclude` | the phantom-caller check | over parsed `verified_callers` |
| `cliMatchesMcp` | the two surfaces return the same bytes for one query | ~10 lines; see ADR 015 §2 for why this is a footnote and not the headline |
| `serveMatchesQuery` | `mast serve` over stdio agrees with a fresh `mast query` | the real divergence surface — `serve` climbs a startup ladder `runQuery` does not |
| `statusField` | e.g. `initialised: false`, `stale_files: 0` | over `status --json` |
| `hasFlag` / `noFlag` | an honesty signal fires, or does not | per-result `stale`; top-level `index_empty`; `file_busy_returning_stale_cache` and `potential_truncated` on the tools that emit them |
| `captureEquals` | the index is semantically unchanged | the normalized query battery, below |

**Why `searchMisses` cannot read stdout.** Delete `a.ts`, which declares `alphaFunction`, and
reindex. `mast search alphaFunction` still prints the string `alphaFunction` twice — from the
body of the surviving caller in `b.ts`, which `formatSearchResults` echoes. A substring check
over stdout is a false red here, and a `searchFinds` over stdout would be a false green on stale
content. The symbol either is or is not in `results[].symbol_name`; that is the assertion.

**Why `fileUnchanged` cannot hash `graph.db`.** Measured: the same logical index over identical
content produced three different digests — after a first run, after a delete-and-restore round
trip, and in a fresh state dir. `index.json` carries `last_indexed`; `lock-metrics.jsonl` grows
monotonically; SQLite has a WAL. align's `fileUnchanged` works because `.align/*` is deterministic
JSON. Idempotency here is **`captureEquals`**: a fixed battery of `mast query` calls whose JSON is
normalized and compared.

**The capture battery** (what `capture.mjs` records for mast): `status --json`; `mast_search` for
a fixed query set; `mast_callers` and `mast_exports` for a fixed symbol set; `mast_project_skeleton`.
**The normalizer must blank** absolute paths, `duration_ms`, `last_indexed`, `state_dir`,
`efficiency_ratio`, `tokens_*`, and chunk ids — and must **not** blanket-normalize `match_score`,
because a ranking regression is exactly what that would hide. align's F7 lesson applies directly:
a substring version-replace once collapsed `10.1.1` and `10.1.4` into one placeholder and made a
real difference invisible. Every rule carries a `masks:` annotation saying what it deliberately
blinds the harness to.

## Projects: a fixture by default, one clone for realism

The first draft said "a pinned OSS TypeScript repo" for everything. Wrong for the mutation family:
every mutation assertion needs a *known* symbol set, and over a large clone `searchMisses` and
`callersExclude` break the moment a name appears anywhere else — which is exactly the failure the
`searchMisses` note above describes.

- **`fixture`** — small, purpose-built, the default for the mutation family. Fully controlled
  symbol set, fast, no network.
- **`clone`** — one pinned OSS repo for a separate *realism* family: tsconfig path aliases,
  re-export chains, `node_modules` symlinks, whale files, mixed-case directories. Pin the commit
  and re-check `git rev-parse HEAD` against it on every cache hit.

Cache under `~/.cache/mast-eval/`, matching `eval/paths.mjs`'s existing convention rather than
inventing `results/.cache` as a second producer of "the pinned corpus".

## Scenario families

**Lifecycle.** `init-fresh` · `init-custom-state-dir-not-persisted` (D028's producing case, now
across processes) · `index-incremental` · `status-honest-when-absent` · `reindex-after-schema-bump`.

**Filesystem mutation — the core family.** The `adds` column is what each scenario contributes
beyond in-process coverage, so that no scenario is presented as first coverage when it is not.

| scenario | the claim under test | adds over the unit suite |
|---|---|---|
| `move-file-preserves-symbols` | `git mv a.ts b.ts` → the symbol is found at the NEW path, and the old path returns nothing | **everything — untested at any layer** |
| `rename-symbol-updates-callers` | rename `alpha`→`beta` across files → callers of `beta` are the updated sites, callers of `alpha` is empty | **everything — untested at any layer** |
| `case-only-rename` | `git mv Foo.ts foo.ts` on a case-insensitive filesystem → callers survive | D023's class; **macOS only, invisible in the container** |
| `symlinked-directory` | a symlinked source dir → the walker skips it, the resolver realpaths through it; no phantom, no silent empty | the walker/resolver disagreement `import-resolver.ts:130` already names |
| `crash-mid-index` | SIGKILL during index → a stale lock clears, no partial state reported as complete | D002's class — damage that leaves the exit code alone (S-01); only testable out of process |
| `extension-change` | `a.ts` → `a.txt` → the symbol leaves the index rather than lingering | untested; silent if wrong |
| `two-processes-one-state-dir` | a `serve` and a concurrent `index` → refuse rather than lose | lock tests are in-process only |
| `delete-file-removes-symbols` | delete → search misses the symbol; no phantom caller; chunk count drops | the artifact and the transport (`cli.test.ts:363` covers the logic) |
| `delete-then-restore` | `captureEquals` across the round trip | the artifact (`fts-delete-guard.test.ts:143` covers the logic) |
| `edit-in-place-flags-staleness` | the staleness flag fires — F7, ADR 005 — on **both** surfaces | the artifact; and this scenario found D029 before it was written |
| `mass-refactor` | move a whole directory → no orphaned edges, no phantom callers | scale of the above |
| `add-file-with-imports` | cross-file resolution appears after an incremental index | the artifact |

**Surface parity.** `serve-matches-query` (the real one) · `cli-mcp-parity` (the cheap byte check).

**Packaging.** `tarball-install-works` · `docs-topics-readable` · `skill-install-idempotent`.

**Honest surfaces.** `empty-result-is-not-absence` — now assertable, because D029's fix made
`mast search` distinguish an empty index from a genuine miss and name the three indexed
languages on the miss · `truncation-flag-fires`.

## Build order

1. **`lib/`** — exec, install (with both authenticity checks), project, spec-validate, assert,
   scenario-runner, and the filter guards including `--gate-target`. Machinery only; claims
   nothing.
2. **The calibration pair.** `case-only-rename-keeps-callers` against a good build and against the
   D023-reverted build: green on one, red on the other. It has to be *this* scenario and not
   `move-file-preserves-symbols` — the breakage is a mis-casing defect and would leave a plain move
   green, pinning nothing. Observed 2026-08-19: PASS on `local`, FAIL on
   `local-broken-d023-miscased-import`, pin held, exit 0.
3. **`tarball-install-works`** — now a result rather than a self-certification.
4. The rest of the mutation family, including the five the review added.
5. `capture` + `normalize` + `captureEquals`, then `serve-matches-query`.
6. Dockerfile and the CI matrix — **in addition to a native macOS run, not instead of it.** The
   container cannot see `case-only-rename`.
7. Amend ADR 015 with what the first green run actually covered.
