# mast integration harness

[ADR 015](../adr/015-2026-08-19-integration-harness.md). Installs the packed working tree into a
real project, mutates the filesystem underneath it, and asserts on what the **installed binary**
then believes. No AI in the loop: every assertion is a plain data comparison.

## Status: green, and calibrated

Three scenarios pass against a correct build. Two calibration pins hold, and they are **not of
equal strength** — the distinction is recorded rather than blurred, because a pin against a
constructed fault reads exactly like a pin against a real defect in a green summary:

| pin | kind | proves |
|---|---|---|
| `case-only-rename-keeps-callers` → `local-broken-d023-miscased-import` | **ledger revert** — D023's exact one-word regression | the harness can see a defect that really shipped |
| `index-does-not-write-into-source` → `local-broken-writes-into-source` | **constructed** | the write-set guard can see the fault built for it. No shipped defect ever made mast write to source, so there is nothing real to revert. |

A run that exercises no pinned-red pair says so explicitly and calls its own green uncalibrated.

`move-file-preserves-symbols` was red from its first run until 2026-08-19. That was never a
harness bug: it was **LEDGER D030**, an S0 this scenario found on run one — after a file move,
`mast index --incremental` skipped the importer, kept its pre-edit body forever, and
`mast_callers` returned an empty `verified_callers` for a function with a live caller. It is now
the pin on that fix.

## The two project kinds

- **`fixture`** — files defined inline in `projects/fixture.mjs`. Small, fully known symbol set,
  no network. The default, and the right home for the mutation family: over a large repo an
  absence assertion false-reds the moment a name appears anywhere else.
- **`n8n`** — a pinned corpus, resolved at run time from `~/.cache/mast-eval/` and materialised
  by hardlink (26,321 links, no data copied). The SHA comes from `eval/pins.mjs`, which is where
  the E1 registration committed it — the harness never writes a corpus SHA of its own.
  A corpus that cannot be resolved is **SKIP, never PASS**; `--forbid-skip realism` is what makes
  a release job refuse that outcome instead of reporting a green that excludes the family.

  Measured 2026-08-20 on this machine: cold index **90.4 s** for 13,985 files / 73,359 chunks
  through the installed artifact, 434 MB of state, 0.53 s for a second incremental index.

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
| `--no-prewarm` | skip the corpus warm-up pass, restoring the D051 confound |
| `--forbid-skip` | a SKIP on a scenario carrying one of these tags fails the run |

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
- **Declared write-sets, enforced.** Every scenario declares `writeSet` — required, with `[]`
  the strongest form — and the working copy is diffed after *every step*, so a failure names the
  step that caused it. The state dir is never walked (mast rewrites it by design), so what is
  checked is writes to **source**. The two causes are kept apart: an undeclared write after a
  `mutate` is the scenario mis-declaring itself (ERROR); after a mast command it is mast writing
  into the indexed project (FAIL). That second branch asserts the premise this package's
  severity-zero definition is derived from, and which nothing checked until D041.
- **A scenario that cannot fail is rejected at load.** `spec-validate.mjs` enforces closed key
  vocabularies, rejects empty `expect` blocks and empty-string matchers, rejects duplicate
  top-level keys by reading the source text, and refuses any scenario with no `assert` and no
  `expect`.
- **Red/green calibration.** `case-only-rename-keeps-callers` is pinned via `expectFailOn` to fail
  against `local-broken-d023-miscased-import` — a build with `realpathSync.native` reverted to
  `realpathSync`, D023's exact one-word regression. If that pin ever passes, the run fails: the
  harness can no longer demonstrate the defect it exists to catch. A run that does not exercise a
  pinned pair says so, because an uncalibrated green is not a green.
- **Corpora are resolved and read once, before the first install.** The corpus is hardlinked into
  every working copy, so all targets share the cache's inodes and the first one would otherwise
  absorb the entire cost of faulting it in from disk — inside a step governed by a timeout. That
  made target order part of what the gate measured: the same scenario ERRORed on a timeout in
  position one and passed in 83s in position three (D051). The warm-up pays that cost outside any
  timed step, so every target starts from the same cache state. It reads bytes; it deliberately
  does not run `mast index`, because the harness's own preparation must not depend on the artifact
  it is judging. `--no-prewarm` puts the confound back, so the warm-up can be observed doing
  something.
- **Working copies survive a failure** and are deleted on a pass.

## Testing `mast serve` as a session

Most steps here spawn a process per action: `run` shells out to the CLI, and a bare `mcpCall`
starts a `mast serve`, asks one question, and kills it. That is the right shape for asserting on a
tool's answer, and it cannot see `serve` itself — everything `serve` owns is a property of a
process that outlives one request: the file watcher (§11.4), the startup reindex's effect on a
later query, and the freshness probe's cached `unindexed_files` count.

Three step keys cover it:

| step | does |
|---|---|
| `{ serve: { args: [...], waitForWatcher } }` | Opens ONE long-lived `mast serve`. Every later `mcpCall` routes through it until it is closed. `args` is passed verbatim and nothing is defaulted — including `--no-watch`, so a scenario testing the watcher can leave it on. `waitForWatcher: true` blocks until the server reports its watcher ready. |
| `{ serveStop: {} }` | Closes it. The runner also closes any open session in a `finally`, so a scenario that throws cannot leak a watcher-holding process into the next working copy. |
| `retry: { timeoutMs, intervalMs }` | On an `mcpCall`, polls its `expect` to a deadline. |

`waitForWatcher` exists because `mast serve` accepts MCP calls *before* it is watching: chokidar's
initial scan runs after the transport connects, and with `ignoreInitial: true` a file created
inside that window is treated as pre-existing and fires no event at all. A scenario that mutates
too early therefore tests nothing and reports FAIL — this one passed run alone and failed when it
ran after the 26k-file n8n scenario, purely because the scan was slower under load (D061). It
waits on the server's own readiness line, so the wait is as long as the scan takes and no longer,
and a watcher that never comes up is an explicit timeout rather than a silent pass.

Waiting on a log line is normally the wrong move (CLAUDE.md §5.6), and the exception here is
exact: that line **is** the readiness contract for an out-of-process observer, because there is
nothing else to observe. The literal lives in `lib/mcp-client.mjs`, not in scenarios.

`retry` exists because a watcher's effect is asynchronous **by design** — chokidar debounces, the
batch takes `structure.lock`, and the reindex takes as long as it takes. A fixed sleep would be
either flaky or slow, and a sleep long enough to be safe would hide a watcher that had regressed
to "eventually, after 30 seconds". Polling to a deadline states the real contract: *this becomes
true, within this long*. `spec-validate` rejects a `retry` with no `expect`, which would poll for
nothing and then report a pass.

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
lib/project.mjs          materialize a project definition into a working copy; the corpus
                         file-set walk, shared by materialize and prewarm
lib/mutations.mjs        delete / move / caseOnlyRename / renameSymbol / edit / add / symlink / …
lib/assert.mjs           the assertion kinds, all over parsed JSON — never stdout scraping
lib/spec-validate.mjs    the module that stops a scenario passing while asserting nothing
lib/requirements.mjs     environment probes behind `requires`
lib/mcp-client.mjs       real stdio JSON-RPC, SDK resolved from the INSTALLED package
lib/scenario-runner.mjs  step walker
projects/                project definitions
scenarios/               one plain data object per file; filename must match `id`
__tests__/               unit tests for the harness's own pure logic (run by `pnpm test`)
results/                 gitignored
```
