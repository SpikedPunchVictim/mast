# mast integration harness

[ADR 015](../adr/015-2026-08-19-integration-harness.md). Installs the packed working tree into a
real project, mutates the filesystem underneath it, and asserts on what the **installed binary**
then believes. No AI in the loop: every assertion is a plain data comparison.

## Status: RED, on purpose

`move-file-preserves-symbols` fails against a correct build. That is not a harness bug — it is
**LEDGER D030**, an S0 found by this scenario on its first run: after a file move,
`mast index --incremental` skips the importer, keeps its pre-edit body forever, and
`mast_callers` returns an empty `verified_callers` for a function that has a live caller. The
scenario stays red until D030 is fixed, and it is the pin that proves the fix.

## Running

```sh
node integration/run.mjs                                    # every scenario, target: local
node integration/run.mjs --scenarios move-file-preserves-symbols
node integration/run.mjs --tags mutation --keep-all
node integration/run.mjs --targets local,local-broken-d023-miscased-import   # the calibration pair
```

| flag | meaning |
|---|---|
| `--targets` | `local` (the packed working tree) or `local-broken-<name>` |
| `--scenarios` | ids to run; an unknown id is a hard error |
| `--tags` | run scenarios carrying at least one tag; matching nothing is a hard error |
| `--gate-target` | which target decides the exit code; must be one of `--targets` |
| `--out` | results directory (default `integration/results/<timestamp>`) |
| `--keep-all` | keep working copies even for scenarios that passed |

## The rules this harness keeps

- **PASS / FAIL / ERROR / SKIP are four outcomes.** FAIL is an assertion that came back false — a
  statement about mast. ERROR is the harness failing to run the check — a statement about the
  harness. SKIP is an environment that cannot host the test. Collapsing any of them into PASS is
  how a suite quietly stops testing anything.
- **A run that selects zero scenarios is a hard error.** So is a `--gate-target` matching no
  results, and an unknown `--scenarios` id. "Nothing ran" and "everything passed" produce the same
  output otherwise.
- **The installed artifact is proved, not assumed.** The lockfile entry must resolve `file:`, and
  the installed `dist/cli/index.js` must hash-match the working tree's. A version string is not
  evidence: between a publish and the next bump, the registry and the working tree report the
  same number.
- **A scenario that cannot fail is rejected at load.** `spec-validate.mjs` enforces closed key
  vocabularies, rejects empty `expect` blocks and empty-string matchers, rejects duplicate
  top-level keys by reading the source text, and refuses any scenario with no `assert` and no
  `expect`.
- **Red/green calibration.** `case-only-rename-keeps-callers` is pinned via `expectFailOn` to fail
  against `local-broken-d023-miscased-import` — a build with `realpathSync.native` reverted to
  `realpathSync`, D023's exact one-word regression. If that pin ever passes, the run fails: the
  harness can no longer demonstrate the defect it exists to catch. A run that does not exercise a
  pinned pair says so, because an uncalibrated green is not a green.
- **Working copies survive a failure** and are deleted on a pass.

## Deliberate differences from align's harness

- **One install per target per run**, shared across scenarios, rather than align's per-working-copy
  install. mast's tree carries two native addons (`better-sqlite3`, `tree-sitter`) whose rebuild
  dominates wall clock. Each scenario still gets its own project directory and state dir.
- **A purpose-built fixture is the default project**, not a pinned OSS clone. Mutation assertions
  need a known symbol set; over a large repo `searchMisses` breaks the moment a name appears
  somewhere else — including inside a surviving caller's printed body.
- **`requires`** — a scenario can declare an environment it needs. `case-only-rename-keeps-callers`
  needs a case-insensitive filesystem, because on ext4 a mis-cased import does not resolve at all
  and the branch under test never runs. On Linux it reports SKIP, never PASS.

## Layout

```
run.mjs                  entry point, filters, calibration gate, summary
lib/exec.mjs             capture-everything process execution; env allowlist; absolute-path invocation
lib/install.mjs          pack + install + three authenticity checks; the named breakages
lib/project.mjs          materialize a project definition into a working copy
lib/mutations.mjs        delete / move / caseOnlyRename / renameSymbol / edit / add / symlink / …
lib/assert.mjs           the assertion kinds, all over parsed JSON — never stdout scraping
lib/spec-validate.mjs    the module that stops a scenario passing while asserting nothing
lib/requirements.mjs     environment probes behind `requires`
lib/mcp-client.mjs       real stdio JSON-RPC, SDK resolved from the INSTALLED package
lib/scenario-runner.mjs  step walker
projects/                project definitions
scenarios/               one plain data object per file; filename must match `id`
results/                 gitignored
```
