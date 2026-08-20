# Integration harness — design

Supporting document for [ADR 015](../../015-2026-08-19-integration-harness.md). Written
2026-08-19, **before any of it was built**. Where this document and the shipped harness
disagree, the harness wins and this file is stale — it is a design record, not a spec.

Reference implementation: `/Users/spikedpunchvictim/projects/align/integration`
(align's ADR 025 and 026). Read it before starting. As measured on 2026-08-19 it is
`run.mjs` (337 lines), twelve `lib/` modules (2,604 lines), and 28 scenarios.

## Layout

```
integration/
  run.mjs              — CLI: --scenarios --tags --project --targets --out --keep-all
  Dockerfile           — Node 22 + 24, toolchain for better-sqlite3 / tree-sitter
  README.md
  lib/
    exec.mjs           — runMast(); never throws on a non-zero exit, DOES throw on a launch failure
    mcp-client.mjs     — spawn `mast serve`, real stdio JSON-RPC through the SDK resolved from the
                         WORKING COPY's node_modules (align's rule: exercise the shipped SDK)
    install.mjs        — target `local` = pack the working tree, install the tarball
    project.mjs        — clone + pin an OSS TypeScript repo; cache under results/.cache
    mutations.mjs      — deleteFile, moveFile, renameSymbol, editFile, addFile, touchFile
    assert.mjs         — the assertion kinds below
    capture.mjs        — read back the state a scenario is allowed to assert on
    normalize.mjs      — strip absolute paths, timings, durations, chunk ids
    write-set.mjs      — declared write-sets; mast's should be small (`.mast/**` and little else)
    scenario-runner.mjs
  scenarios/*.mjs      — one plain data object per file
  projects/*.mjs
  results/             — gitignored
```

## Step vocabulary

align's, unchanged: `install` · `run` (+ `expect`) · `mcpCall` (+ `expect`) · `assert` ·
`snapshot`. Plus `mutate`, which align has as a lib helper and mast needs as a first-class
step because mutation *is* the axis under test.

## Assertion kinds

align's harness needs one kind of file assertion. mast needs a vocabulary, because the
question is never "was a file written" but "does the index still tell the truth".

| kind | what it asserts |
|---|---|
| `exitCode`, `stdoutContains`, `stdoutMatches` | the command surface |
| `exists` | a file is present / absent on disk |
| `searchFinds` / `searchMisses` | a symbol is / is not in `mast search` output |
| `callersInclude` / `callersExclude` | the phantom-caller check after a delete or a rename |
| `cliMatchesMcp` | run both surfaces for one query; assert identical result sets |
| `statusField` | e.g. `initialised: false`, `stale_files: 0` |
| `hasFlag` / `noFlag` | a staleness or truncation flag fires, or does not |
| `fileUnchanged` (since a snapshot) | idempotency |

`cliMatchesMcp` is the kind that earns the harness. See ADR 015 §2.

## Scenario families

**Lifecycle.** `init-fresh` · `init-custom-state-dir-not-persisted` (D028's producing case)
· `index-incremental` · `status-honest-when-absent` · `reindex-after-schema-bump`.

**Filesystem mutation — the core family.**

| scenario | the claim under test |
|---|---|
| `delete-file-removes-symbols` | delete `a.ts` → search misses `alpha`; callers of `alpha` report no phantom; chunk count drops |
| `move-file-preserves-symbols` | `git mv a.ts b.ts` → the symbol is found at the NEW path, and the old path returns nothing |
| `rename-symbol-updates-callers` | rename `alpha`→`beta` across files → callers of `beta` are the updated sites; callers of `alpha` is empty |
| `delete-then-restore` | the index returns to its original state — idempotency across a round trip |
| `edit-in-place-flags-staleness` | edit without reindexing → the staleness flag fires — F7, ADR 005 |
| `mass-refactor` | move a whole directory → no orphaned edges, no phantom callers |
| `add-file-with-imports` | cross-file resolution appears after an incremental index |

**Surface parity.** `cli-mcp-parity` over search / callers / exports / signature / skeleton.

**Packaging.** `tarball-install-works` · `docs-topics-readable` · `skill-install-idempotent`.

**Honest surfaces.** `empty-result-is-not-absence` — query a symbol in a language mast does
not index and assert the answer does not read as "this repo does not contain it" ·
`truncation-flag-fires`.

## Build order

1. `lib/` (exec, install, project, mcp-client, assert, runner) and **`tarball-install-works`**
   as the first scenario. It retires ADR 014's admitted gap immediately, and it proves the
   harness works before any complexity lands on it.
2. The filesystem-mutation family — the payload.
3. `cli-mcp-parity`.
4. Dockerfile and a CI job (Node 22 / 24 matrix).
5. Amend ADR 015 with what the first green run actually covered.
