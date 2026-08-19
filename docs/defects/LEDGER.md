# Defect ledger — `packages/mast`

Scope is this package only. Bootstrapped 2026-08-18 per `packages/mast/CLAUDE.md`.

## Severity zero, for this package

> **`mast` returns an answer that is silently incomplete or wrong, and is indistinguishable from a
> correct one — so a caller concludes "it isn't there" and edits or deletes code that is in fact
> referenced.**

Derived, not copied. `mast` never writes to the user's source; its state lives in its own
`graph.db`, and a crash costs a re-index. The irreversible damage is downstream: this package's
whole purpose is to be the thing you consult *instead of* reading files, and `.claude/CLAUDE.md`
instructs agents "Search before opening any file. No file path without a mast result." A consumer
following that instruction cannot distinguish *absent from the codebase* from *absent from the
index*. `mast_rename_impact` and `verified_callers` convert that confusion directly into edits.

This is not hypothetical: **D001** is exactly this, already shipped and already fixed — a whale
file blew the SQLite parameter ceiling, rolled back its own transaction, vanished from the index,
and the run exited 0.

| Sev | Meaning |
|---|---|
| **S0** | A confident answer that is silently incomplete or wrong; or indexing that loses content while reporting success. The caller cannot tell. |
| **S1** | A wrong result or wrong recorded claim that a reader would act on, but which is detectable — wrong file, wrong number, wrong direction of an inference. |
| **S2** | Misleading or degraded output with no data loss and no wrong action implied — cost, noise, weakened evidence. |
| **S3** | Internal inaccuracy: a comment, doc, plan figure, or index entry that is wrong but load-bearing for nobody's edit. |

**Conf** is `measured` only where the row was reproduced with numbers in the session that filed it.
Everything mined from git history on 2026-08-18 is `reconstructed`, and its incidental detail must
not be re-quoted as fact.

---

## Rows

| ID | Date | Sev | Discovery instrument | What was wrong | Shape | Which check should have caught it | Fix + pin | Conf |
|---|---|---|---|---|---|---|---|---|
| D022 | 2026-08-19 | S1 | Simulating the CI gate locally and noticing `build` exit 0 with no output | `pnpm build` is `tsc` under `composite: true`. With `tsconfig.tsbuildinfo` present and `dist/` deleted, tsc concludes the project is up to date and **emits nothing, exiting 0**. Reproduced: dist absent → `build` exit 0 → `dist/graph/db.js` still absent → the two eval tests that import it fail to load. | S-01, S-10 | Nothing. `tsconfig.tsbuildinfo` is gitignored, so a fresh CI checkout always emits and structurally cannot see this. It bites only local developers — which is exactly where this package's empirical record is produced. | **OPEN.** Not fixed here; the CI gate is unaffected. Gate 0b (`eval/__tests__/e1-dist-staleness.test.mjs`) pins the *consequence* — and its header records that a stale dist already ran two E1-VERIFY cells against a two-day-old binary — but nothing pins this *cause*. | measured |
| D021 | 2026-08-19 | S2 | Building a CI gate, and running the package's own `typecheck` script for the first time | `src/graph/__tests__/import-index-hoist.test.ts` carried two type errors from the day it was added (`08b0cd8`, task #6): TS2307 `Cannot find module '../types.js'` — that module does not exist, `EdgeRecord` lives in `src/ast/types.ts` — and TS2684 on a `.bind()` whose `readonly never[]` rest parameter matches no `strictBindCallApply` overload. | S-10 | `tsconfig.test.json` was never run. I ran `tsc --noEmit`, the **first half** of the package's two-command `typecheck` script, and reported "tsc clean" from it more than once. The suite stayed green throughout because `import type` is erased before runtime, so the broken import was never resolved by anything. `6b6a126` had deliberately added test typechecking, and it was green until `08b0cd8`. | Both fixed. Pinned by the new CI gate's Typecheck step, which invokes the package script rather than a hand-typed subset of it. | measured |
| D020 | 2026-08-18 | S1 | Measuring a mechanism before implementing the design chosen from it | The query plan `SCAN chunk_fts VIRTUAL TABLE INDEX 0:=` was read as "constraint consumed, not a scan", and that reading was put into a design option the user then selected. FTS5 cannot use a rowid *range*; the operative word is `SCAN`. Measured T9: `BETWEEN` 75.96 ms vs unconstrained scan 75.01 ms — no saving. Exact `rowid = ?` is a seek: 0.0293 ms for the same 11 rows. | S-04 | Nothing. The plan string was read as if it were a verdict; no check existed between "read a query plan" and "recommend a design". | Design amended to per-rowid equality deletes before any code was written. Pinned by `fts-rowid-block.test.ts` + the measurement recorded in Stage 4.6. | measured |
| D019 | 2026-08-18 | S1 | Reading FINDINGS §2.4's own "unmeasured" label and then measuring it | The FTS delete guard (Stage 4.5) skips the delete-scan only when a file was **never** indexed, so every *changed* file paid two full FTS5 scans costing O(corpus). Measured 3.0 ms at T1 → **151.6 ms at T9**, b = 1.32, R² = 0.9975; 384 ms projected at 150k chunks. | S-02 | `fts-delete-guard.test.ts:93` asserted `spans.fts_del > 0` for a previously-indexed file — it pinned that the scan *happens*, never what it costs. A passing test documented the defect. | Rowid block on `files`; scan arm b = 0.97 → block arm b = **−0.09**. Pinned by 6 tests in `fts-rowid-block.test.ts` (4 fail under a one-rowid widening mutation). `bebcce8` | measured |
| D018 | 2026-08-18 | S3 | Measuring a claim while documenting it | Stage 4.5 asserted "379 ms for one file **at any corpus size**", uncited anywhere in the plan. The magnitude is plausible (measurement projects 384 ms at 150k); the *invariance* is false and was the load-bearing half — it is what made the incremental path look already-solved. | S-03 | Nothing. No rule required a performance figure in the plan to carry a citation or a corpus size. | Killed in FINDINGS §3; replaced by the measured curve in §2.4. `bebcce8` | measured |
| D017 | 2026-08-18 | S3 | Asking the completeness question (§11.3) rather than re-checking the last answer | FINDINGS §1's register of unread data said 114 rows; the true count was **138**, then the whole table proved stale (144 → 255, `phase_ms` 87 → 213, `write_spans` 27 → 168). Each re-count had asked "does the new journal add a series?" and incremented, instead of re-deriving from all eight journals. | S-07, S-03 | The §6 maintenance rule said to "re-run the §1 diff" but did not say *re-derive from scratch*, so incrementing satisfied it. | §6 amended to require re-derivation from all journals. Cross-validated: 144 = 42+30+30+15+27; 144+27+24+60 = 255. `a677831`, `8cb7e0e` | measured |
| D016 | 2026-08-18 | S2 | Cross-checking two implementations of one statistic | E1-HOIST's runner reported arm N's T9 edges median as 2623 ms, the scorer as 2617 ms. n = 30 is even: the runner takes `element[n/2]`, the scorer averages `element[14]` and `element[15]`. Gate L reads 18.31% vs 18.04%. | S-05 | Nothing — two independent median implementations with no cross-check between them. Contrast `e1-hoist-score.mjs`'s `selfCheck()`, which *is* this check for a different statistic and caught nothing only because it was correct. | Recorded as a defect in the E1-HOIST RESULT; no verdict moves (both outside the ±15% band). **Unpinned** — no test compares the two implementations. | measured |
| D015 | 2026-08-18 | S2 | Simulating the registered decision rule instead of trusting the closed form | E1-HOIST was registered at 20 blocks using `n = 7.849(CV/effect)²`, which sizes a **mean**. The registered primary is a **median** (~64% as efficient). Simulation of the actual rule gave **72% power against a claimed 80%**. | S-06 | Nothing. No step required the power calculation's estimator to match the registration's primary estimator. | Raised to 30 blocks (87% median / 94% geomean) before any run; geometric-mean secondary pre-registered so it could not become a second chance. Recorded as a CORRECTION and a §3 corollary. `8346ebf` | measured |
| D014 | 2026-08-18 | S3 | The same finding as D015, applied to the scorer after it had already run | `e1-hoist-score.mjs`'s **post-hoc** power uses the same mean-based formula it was corrected for in the design. At realised parameters, simulation gives 85% at n=19 and 91% at n=30, against the scorer's implied n=19. | S-05, S-06 | The D015 correction fixed the design and never asked what else used that formula. | **OPEN and deliberately unfixed** — editing an analysis instrument after seeing its output is what pre-registration exists to prevent. Correction recorded in the RESULT instead. | measured |
| D013 | 2026-08-18 | S2 | An arm's result being implausibly large, plus a look at load average | The import-index micro-benchmark ran arm N then arm H every rep, so N warmed the cache for H, on a host at load average 15. It reported **194 ms at T8 and 289 ms at T9 — ~6× wrong** (true: 31.0 / 87.1). | S-08 | Nothing. The harness had no rule about arm ordering; the E1 drivers' Latin-square discipline had not been carried across to micro-benchmarks. | Both arms warmed unmeasured, arm order alternated per rep, CPU time measured alongside wall. Recorded in the registration as "a benchmark that does not alternate arm order is measuring its own schedule." | measured |
| D012 | 2026-08-18 | S3 | Unexpected output appearing in an unrelated test run | `eval/e1-fts-invariant.mjs` executed `main()` on import, so importing it for tests ran the whole check as a side effect. | S-01 | Nothing. No lint rule or test forbids top-level side effects in `eval/*.mjs`, though CLAUDE.md §8.3 forbids them in prose. | `realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)` guard. Pinned by the 11 tests in `e1-fts-invariant.test.mjs`, which could not have been written without it. `8cb7e0e` | measured |
| D011 | 2026-08-18 | S2 | Gate L's own cross-experiment measurement | E1-HOIST's H2 registered an **absolute** band of [40, 350] ms on a rig whose own Gate L then measured **+18% session drift**. It fired, but block 1 alone read 380 ms. | S-06 | Nothing. No rule required a registered band to be scale-free on a rig with known drift. | Scored as registered; the design flaw recorded rather than reinterpreted after the fact. §3 corollary added. `a677831` | measured |
| D010 | 2026-08-17 | S2 | Reading the findings index before writing a registration | E1-EDGES was registered and retired the same day, before any measurement, once it emerged that E1-AB had already answered the question on the same corpus with a stronger arm — and that data had been sitting committed and **unread for four days**. | S-07 | Nothing existed. This defect is the reason the check now exists. | `.claude/CLAUDE.md` now requires reading FINDINGS §1 and §3 before any pre-registration, and stating what was checked. **Promoted to a process gate.** `29d359d`, `707cf9c` | reconstructed |
| D009 | 2026-08-18 | S1 | Characterising code for an unrelated task (#6) | FINDINGS §1.1 and E1-SCAN's RESULT both described `POTENTIAL_CALL` as "what the resolver emits when it cannot pin a call" and inferred that resolution failure grows with scale. **Both halves inverted**: `populate.ts` drops the edge when `to_id` is undefined, so an unresolved call leaves *no* row. A stored row is a success, and the rising trend means resolution is getting *better*. | S-04 | Nothing. Two documents asserted a behaviour of a third file that neither had opened. | Corrected at both sites; §1.1's warning survives and is sharper — the count omits every failed attempt, so it understates work. `cc4332f` | reconstructed |
| D008 | 2026-08-13 | S1 | Verifying a cited figure against its primary source | The E1-PHASE registration recorded "SQLite's ~2 MB default page cache" and drew a conclusion from it (T1's 21.6 MB DB exceeds cache ~10×, so no cache cliff). better-sqlite3@12.11.1 ships `SQLITE_DEFAULT_CACHE_SIZE=-16000` (`deps/defines.gypi:13`) — **~16 MB, wrong by 8×**. T1 is 1.3× the cache, not 10×. | S-03 | Nothing. The figure was a remembered default, never traced to the shipped build. | Corrected at all three sites that made the claim, with the direction of error stated because it *removes* counter-evidence. Three limits attached so it cannot be read as promoting H1. `b1164a4`, `90f957e` | reconstructed |
| D007 | 2026-08-14 | S1 | Reading a run summary that reported an impossible count | After a voided pair was repaired, E1-FTS reported **five INTERRUPTED attempts that never happened**. `orphanedAttempts` counts every `attempt_start` for a cell across the whole journal but subtracts only the last terminal record's attempts, so a cell that legitimately ran twice had both passes charged against the second. | S-02 | Nothing. Correct for every prior schedule — E1-FTS was the first to both repair and resume. Not cosmetic: orphan counts shrink a resumed cell's Gate 3 budget and can void it for interruptions that did not occur. | `ftsOrphanedAttempts` applies the rule per *segment* rather than per key. `d2c197b` | reconstructed |
| D006 | 2026-08-13 | S1 | Watching the first four seconds of a real run disagree with `--dry-run` | `planPending` hoisted the control arm to the front of **every** group, not just repair groups, overriding the registered order on the initial pass. At T9 that order is a Latin square chosen so no arm holds the same position in every block — the expensive rung's only drift protection. | S-02, S-08 | The existing tests could not see it: **every one of them exercised a repair**, the case where control-first is correct. A full green suite over the wrong half of the input space. | Control-first restricted to repair groups; new test asserts the cold-start plan equals the schedule exactly. No scored run was affected. `9107f05` | reconstructed |
| D005 | 2026-08-17 | S1 | An adversarial review pass (Fable) on `057236d`, reproduced independently before adoption | A commit claimed its refactor was "provably behaviour-preserving". It was not — see D004. Separately, the same commit explained a mis-derived exponent as "miscomputed by hand"; in fact **two systematic faults reproduce the old figures to 4 dp** (dropping rung T6 → 1.111717; reading `measurement.duration_ms` → 1.079053). A simultaneous double match is not chance. | S-04 | Nothing. "Hand error" is unfalsifiable and closes inquiry; no rule required a proposed etiology to *reproduce* the wrong number. | Both corrected; the systematic-fold diagnosis forced re-derivation of every number from that session. `60f1ced` | reconstructed |
| D004 | 2026-08-17 | **S0** | The same adversarial review pass | `path LIKE p \|\| '%'` was wrong two independent ways at four sites: the prefix is interpolated **unescaped**, so `_` in a real path is a single-character wildcard; and default LIKE is case-insensitive while the index sorts BINARY. With `ORDER BY path ASC` the resolver returns a file the caller never named — `src/my_util.ts` yields `src/my.util.ts`, `src/Foo.ts` yields `src/FOO.ts`. Those rows feed `verified_callers`, which the tool documents as safe to act on. | S-04, S-09 | Nothing. Four sites, no test used a path containing `_` or differing only by case — i.e. no test used a *realistic* path. snake_case makes the first case routine. | Range query (`path > ? AND path < ?`) at all four sites; each counterexample became a test that failed against the shipped code first. `c4b4816` | reconstructed |
| D003 | 2026-08-10 | S2 | Measurement (§15.5), not a test | `walkProject` returned `fast-glob`'s filesystem order, which varies between identical runs. Edge insertion order feeds `insertEdges`' bare-name fallback, so two identical index runs produced edge sets differing by **±4 / 3,940**. | S-01 | Nothing. Every test asserted on sets or sorted output, so none could see order-dependence — and the pre-fix order was arbitrary rather than reliably unsorted, so no guaranteed-red test was even constructible. | Sort by `relativePath` at the source (code-unit compare, not `localeCompare`). Two new tests are the executable spec of the ordering contract (§5.4a). `73da94e` | reconstructed |
| D002 | 2026-08-07 | **S0** | A discrepancy between two counts recorded in the plan (152,969 vs 138,440 chunks) | A single Kysely multi-row INSERT binds `columns × rows` parameters; SQLite's 32,766 ceiling caps the 11-column `chunks` insert at ~2,978 rows. A whale file (vscode's 146,620-line fixture) threw "too many SQL variables", **rolled back its whole per-file transaction, and vanished from the index — while the run exited 0.** | S-01, S-07, S-09 | Nothing. Orchestration gated on exit code only; no per-file integrity check compared chunk count to manifest. The plan named *one* site; a survey found **8**. | Shared batching helper (`graph/sqliteBatch.ts`) at all 8 sites, batching the statement never the transaction. Red-first whale tests (3,000 chunks + 5,000 symbols) through `populateFile`. `7578d71` | reconstructed |
| D001 | 2026-08-18 | S3 | Bootstrapping this ledger | `packages/mast` records defects only inside `IMPLEMENTATION_PLAN.md` prose. A survey of `src/` and `eval/` for `BUG`/`FIXME`/`HACK`/`XXX`/`FRAGILE`/`WORKAROUND` returns **zero hits** — so there is no in-code record of known-weak ground at all, and the 53 fix/correct commits are the only trace. | S-07 | N/A — this is the gap the ledger exists to close. | This directory. | measured |

---

## Bootstrap step 3 — where detection actually lives

Sorted by discovery instrument, the uncomfortable table the operating manual predicts:

| Discovery instrument | Rows | |
|---|---:|---|
| A human or agent reading code, output, or a document with intent | 10 | D002, D006, D007, D009, D010, D012, D013, D016, D017, D019 |
| Measuring a claim or a mechanism while documenting it | 4 | D003, D008, D018, D020 |
| An adversarial review pass by a second model | 2 | D004, D005 |
| Simulating the registered decision rule instead of trusting a closed form | 2 | D014, D015 |
| Cross-experiment drift measurement (Gate L) | 1 | D011 |
| Building a CI gate, and running the package's own scripts | 2 | D021, D022 |
| Bootstrapping this ledger | 1 | D001 |
| **A failing test** | **0** | — |

(22 rows, each counted once.)

One row is arguable and is called out rather than buried: **D012** surfaced as unexpected output
during a test run, so a test *run* was the occasion even though no assertion failed. Counting it
the other way makes the tally 1, not 0. It does not move the conclusion.

**Zero defects in this ledger were found by a test.** Every one was found by reading, measuring, or
reviewing; tests appear only in the *Fix + pin* column. That is the expected shape — a regression
test is built to stop a *known* defect returning — but it means this package's real detection
capability is reading and measurement, and any plan that budgets for quality by adding tests is
funding the wrong instrument.

Two rows sharpen it. **D006**'s existing tests were all green and every one of them exercised the
single half of the input space where the bug was invisible. **D019**'s test asserted the defect's
*presence* (`fts_del > 0`) and passed from the day it was written (`43eb928`, 2026-08-16) until the defect was measured two days later. A green suite is not evidence of absence.

Second observation: **8 of the 22 rows are a wrong number or a wrong claim in a document rather
than wrong code** — D005, D008, D009, D011, D015, D017, D018, D020. (D001 is the *absence* of a
record, not a wrong one, and is deliberately excluded from this count.) For a package whose
output is an empirical record that others act on without re-deriving, prose is a first-class
failure surface, and constitution §11 is the guard rail that keeps earning its cost.

---

## Review milestone

Next review at the close of the E1 track (task #4, CI for `packages/mast`, is the last open item
before it). Judge against the three criteria in `packages/mast/CLAUDE.md`: did a `SHAPES.md`-briefed
review find something a generic review did not; did any shape earn promotion to an executable
invariant; are rows still being written unprompted. If the third fails, delete this directory.
