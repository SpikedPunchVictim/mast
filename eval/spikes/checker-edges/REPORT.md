# Stage 1.1 Spike Report — Type-Checker-Verified Call Edges

**Plan:** `packages/mast/IMPLEMENTATION_PLAN_VEXP.md`, Feature 1 / Stage 1.1 (throwaway spike).
**Run date:** 2026-07-15. **All spike code:** `packages/mast/eval/spikes/checker-edges/` (plain `.mjs`, imports compiled `dist/`, never shipped).
**All raw numbers:** `results.json` in this directory (assembled from `q1-…` through `q5-…` per-question JSON).

## Provenance

- **TypeScript version: 5.9.3**, resolved from the workspace root hoist
  (`node_modules/.pnpm/typescript@5.9.3/…/typescript/lib/typescript.js` via
  `require.resolve('typescript')` from the repo root). No dependency was added;
  this is the single installed compiler the whole workspace shares. (Research
  protocol §6: version checked against the actual install, not memory.)
- **Monorepo index state (Q1/Q3/Q4): reused** the centrality spike's freshly
  rebuilt corpus at
  `/private/tmp/claude-501/-Users-spikedpunchvictim-projects-kluster/c4f25db4-b26f-4eb7-94d3-6a2eef5c6b2c/scratchpad/base-state`
  (graph.db 61.5 MB, built 2026-07-15 11:35; verified before trusting: 1,696
  `files` rows, 10,733 `symbols`, 7,193 `edges`, 11,361 `identifier_fts` rows).
  Opened **READ-ONLY** (`better-sqlite3 { readonly: true }`), never written.
  No rebuild was needed.
- **`dist/` was rebuilt** (`pnpm -F @kluster/mast build`, clean) before any
  measurement so the harness exercised current shipped code (`src/graph` had
  edits newer than the stale `dist`).
- **Foreign corpus (Q5 addendum):**
  `/Users/spikedpunchvictim/projects/kluster-workbench/apps/align-kimik27-02/.fold/.mast`
  — see Q5 section for selection and staleness verification.
- **Seed for all sampling: 20260715** (literal constant; mulberry32 +
  Fisher-Yates in `rng.mjs`). The exact 50-item sample is recorded in
  `results.json` → `q3_payoff_monorepo.sample_records`.

---

## Q1 — Baseline verified:potential ratio

**Methodology.**
(a) `SELECT resolution, COUNT(*) FROM edges WHERE edge_type='POTENTIAL_CALL' GROUP BY resolution` on the frozen graph.db.
(b) Top-50 most-called **exported** symbols ranked by incoming POTENTIAL_CALL
edge count (barrel marker rows `kind='export'` excluded; ties broken by name
asc → file_path asc → id asc, fully deterministic). For each, the
potential-match count uses the **shipped semantics** — a read-only mirror of
`src/mcp/tools/_helpers.ts:collectPotentialMatches`: exact-phrase
`identifier_fts` MATCH on the symbol name (shipped limit 50), chunks fetched
from `chunks.lance`, minus chunks whose `(file_path, start_line)` equals a
verified caller's `(file_path, line)` for that symbol. Verified counts come
from the shipped `queryVerifiedCallers` (direct, non-transitive — the
`mast_callers` default), imported from `dist/`, not reimplemented.

**(a) POTENTIAL_CALL edges by resolution (total 3,311):**

| resolution | count | share |
|---|---|---|
| same_file | 1,789 | 54.0% |
| import | 1,321 | 39.9% |
| new_expression | 110 | 3.3% |
| parameter_type | 49 | 1.5% |
| field_type | 42 | 1.3% |

**(b) Top-50 aggregate: verified 661 : potential 1,021 → ratio 0.647**
(verified per potential; i.e. for every verified edge on a hot exported symbol
there are ~1.54 potential matches an agent must review by hand). Per-symbol
rows are in `q1-results.json`. The 1,021 potential matches form Q3's sampling
frame (`q1-potential-pool.json`).

**Caveat on the ratio's meaning:** `identifier_fts` hits are per-chunk, not
per-call-site, and the shipped limit caps each symbol at 50 hits — the ratio
is the *agent-visible review burden* exactly as `mast_callers` reports it, not
a call-graph completeness measure. That is the correct baseline for this
feature (its value proposition is deleting review round-trips), and it is the
number every later claim must cite.

---

## Q2 — Compiler cost at monorepo scale

**Methodology.** `ts.createProgram` per workspace tsconfig project, sequential
in one child process; full `getSemanticDiagnostics` per project. **API choice
justification:** createProgram is the batch API — a background enrichment pass
walks the workspace once per index run, which is createProgram's use case, not
the editor-oriented incremental use case `ts.LanguageService` is built for.
Warm pass = second `createProgram` per project passing `oldProgram` (no file
changes) + diagnostics again — the incremental-reuse path this API supports.
**RSS measured externally**: the driver (`q2-run.mjs`) spawns the worker and
polls `ps -o rss= -p <pid>` every 300 ms (Darwin has no /proc); 216 samples
collected. Wall clock measured by the driver around the child's full lifetime.

**Project scope (25 tsconfigs — full list in `projects.mjs` / `results.json`):**
every pnpm-workspace.yaml member (`packages/*`, `packages/kluster-bt/*`,
`packages/workbench/foldv2/*`, `application/*`) that has both package.json and
tsconfig.json. **Skipped, with reasons:** `packages/kluster-bt/` container dir
(no package.json); `packages/workbench/fold/*` (v1) and
`packages/workbench/sdd/apps/*` (not matched by any workspace glob — generated
output trees, incl. `.build/**` scratch tsconfigs); `foldv2/.example/**` and
`archetypes/templates/*` (template `tsconfig.base.json` files meant to be
extended, not built); root `tsconfig.json` and `packages/tsconfig.base.json`
(base configs with no `include` — createProgram over them sees zero files).
Total: **762 source files across the 25 programs.**

**Measured numbers:**

| metric | value |
|---|---|
| Cold (create + full semantic check, 25 projects) | **21.77 s** (0.36 min) |
| Warm (`oldProgram` reuse + re-check) | **42.59 s** — *slower* than cold; see anomaly below |
| Peak RSS (external ps, 216 samples) | **2,512 MB = 2.45 GB** |
| Driver wall clock (child lifetime) | 65.25 s |
| Largest projects (cold) | application/api 7.07 s (320 files), application/ui 4.58 s (133 files), packages/mast 2.31 s (50 files) |

**Anomaly (verbatim numbers, not softened):** the warm pass was ~2× *slower*
than cold (42,590 ms vs 21,770 ms). Cause: the worker holds all 25 cold
Programs alive in a Map to serve as `oldProgram`, so the warm pass runs under
~2.4 GB of retained heap with heavy GC pressure; `oldProgram` reuse also only
skips re-parsing of unchanged files, while type-checking is re-done. A real
Stage-1.2 worker would hold one project at a time. No error text was emitted;
zero semantic diagnostics across all 25 projects in both passes.

**Mechanical threshold verdict (pre-decided: >5 min cold OR >2 GB RSS kills always-on):**
cold 0.36 min < 5 min → pass; **peak RSS 2.45 GB > 2 GB → FAIL.**
**→ The always-on background design is dead. The feature's shape, if built, is
an opt-in `mast index --checker` pass** (exactly the §R reserve row
"Opt-in `--checker` CLI mode — trigger: Stage 1.1 Q2 shows >5 min / >2 GB").
Applied mechanically from the number; the RSS overage is real even granting
the hold-all-programs artifact — a sequential one-project-at-a-time pass would
still spike toward application/api's single-program footprint, which dominated
the peak (the 2.5 GB plateau coincided with the api/ui programs), and the
threshold is on the measured process as specified.

---

## Q3 — Payoff rate on real potential matches

**Methodology.** Seeded sample (seed 20260715) of 50 from Q1(b)'s 1,021-item
pool; exact sample recorded in `results.json`. Per item: find the call site in
the chunk's `[start_line − 5, end_line + 5]` window (chunk `content` is
context_lines-expanded — default 3 — beyond strict AST boundaries, so hits can
sit just outside; the pad exceeds that default with margin), preferring the
occurrence nearest the original range; take the first **call-shaped** AST
occurrence of the queried symbol's bare name (CallExpression / NewExpression
callee, direct or via property access); resolve with
`checker.getSymbolAtLocation`, **following alias chains via
`getAliasedSymbol`** (bounded at 8 hops) so an import binding resolves to its
real target; compare the declaration's `(file, line)` to the queried symbol's
recorded `(file, line)` with ±3-line tolerance.

**Three-way split (n = 50):**

| outcome | count | share |
|---|---|---|
| **Resolves to the queried declaration (definite edge)** | **19** | **38%** |
| Resolves to a DIFFERENT declaration | 5 | 10% |
| Cannot resolve | 11 | 22% |
| Non-call-site hits (separate bucket, per plan) | 15 | 30% |

- **Non-call-site share: 30%** — 6 comment/string, 7 type-or-reference
  position, 2 with no textual occurrence in the padded window. These are
  unresolvable by definition and bound the feature's ceiling: at most ~70% of
  the shipped potential set is even addressable by any checker.
- **Cannot-resolve breakdown: all 11 are `file_outside_ts_project_scope`** —
  call sites in `packages/workbench/sdd/apps/**` / `fold/**`, which mast
  indexes but no workspace tsconfig covers. The checker returned
  "no symbol / dynamic" for **zero** in-scope call sites.
- The 5 "different declaration" cases are same-name collisions where the FTS
  hit's call site genuinely invokes a *different* symbol with the same name
  (e.g. a local `resolvePathWithTemplates` re-declared per package, `cx`
  resolving through a package-local d.ts) — correct checker behaviour, and
  exactly the noise class the potential set makes agents review today.

**Mechanical threshold verdict (pre-decided: <20% definite → demote to reserve):**
**38% ≥ 20% → the payoff gate does NOT block promotion.**

**Bug found and fixed during authoring (affects methodology honesty):** the
first implementation classified every imported callee as "different
declaration" because `getSymbolAtLocation` returns the local import binding;
without `getAliasedSymbol` the split read 1/19/11/19. The alias-following fix
is the difference between 2% and 38% — recorded here because it is exactly the
class of mistake a Stage-1.2 implementation must not repeat.

---

## Q4 — Checker vs heuristic agreement (false-green hunt)

**Scope note (limitation, stated plainly):**
`src/graph/__tests__/verified-callers.test.ts` contains exactly **one**
scenario — cross-file `import` resolution (`handleLogin` imported into
`routes.ts`, called bare). There are no field_type / parameter_type /
new_expression / same_file fixtures in that file to recreate. The fixture was
recreated standalone (source strings copied verbatim; the test file was not
modified), indexed through the real pipeline (`runIndex` from `dist/`), and
the same call site resolved independently with the checker.

**Result: zero contradictions on the covered scenario.** Heuristic edge:
`registerRoutes → handleLogin`, `resolution='import'`, line 3, context
`handleLogin();`. Checker: resolves to `handler.ts:1`. Agreement.

### Q4b (bonus, beyond the plan's strict scope) — SEVERITY-ZERO FALSE-GREEN CONFIRMED

Reading `src/graph/populate.ts:insertEdges` during Q4 prompted an adversarial
fixture the plan's Stage-1.2 gate explicitly names (same method name, two
unrelated declarations). Finding, verbatim from `q4b-results.json`:

> SEVERITY-ZERO FALSE-GREEN CONFIRMED: import resolved_path AND the TypeScript
> checker both say moduleB/handler.ts, but the heuristic verified an edge into
> moduleA/handler.ts instead — a wrong "verified" edge. Root cause:
> src/graph/populate.ts insertEdges resolves POTENTIAL_CALL edge targets by
> bare symbol name across the ENTIRE graph.db (`toRows`, no
> resolved_path/file filter), ignoring the imports table it already has
> resolved_path for. Reproducible: importing from the FIRST-inserted
> same-named file "works" by insertion-order coincidence, not by correct
> resolution — importing from the SECOND (or later) fails, as shown here. This
> bug is PRE-EXISTING in the shipped resolver and is INDEPENDENT of the
> checker-edges feature under evaluation; it affects the current
> `verified_callers` contract today whenever two files export a same-named
> symbol.

Fixture: `moduleA/handler.ts` and `moduleB/handler.ts` both export
`handleLogin`; `routes.ts` imports explicitly from `./moduleB/handler`. The
heuristic emitted a verified edge into **moduleA**'s declaration. Both import
directions were tried; the moduleA-import direction passing is
insertion-order luck, not correctness. The local-type-env resolver (§10.3.1)
is not at fault — the collision happens at `insertEdges`' name→id resolution,
one step later. **This is a today-bug in the shipped `verified_callers`
contract and, per the plan's false-green gate language, "fixing it jumps every
queue and gets an invariant test" — regardless of what happens to Feature 1.**

---

## Q5 (addendum) — n≥2 generalization check on a foreign corpus

**Corpus selection.** align-kimik27-03 was rejected mid-spike: `ps` showed a
live `foldv2 build` process actively writing to it (a moving target).
**align-kimik27-02** was used instead: its `build.log` ends
`exit: 2 at 2026-07-14T15:48:56Z` (build finished — exit 2 is gate failures,
not a crash) and no process references it.

**Staleness verified before trusting the index** (required by the addendum):
all **23/23** `files`-table mtimes match on-disk mtimes exactly (0
mismatches) — fresh, no re-index needed. Path note: the run's config.json
`project_root` is the container bind-mount `/workspace`; matching recorded
mtimes to disk established the host equivalent is
`align-kimik27-02/packages/core` (the run indexed only that one workspace
package: 23 files, 205 symbols, 172 edges).

**Result (pool 65, sample 25, seed 20260715, same methodology as Q3):**

| outcome | count | share |
|---|---|---|
| Resolves to queried declaration | 14 | **56%** |
| Resolves to different declaration | 0 | 0% |
| Cannot resolve | 0 | 0% |
| Non-call-site | 11 | 44% |

**Read-through:** the monorepo's 38% is not a home-field best case — the
foreign, machine-generated codebase resolved *better* (56%), with zero
out-of-scope files (single tsconfig covers everything mast indexed) and zero
wrong-name collisions (small codebase, no name reuse). Both corpora agree the
definite-edge rate clears the 20% gate comfortably, and both show the same
dominant residue: non-call-site FTS hits (30% / 44%).

---

## Go/No-Go recommendation for Stage 1.2

**GO — but as an opt-in `mast index --checker` CLI pass, not the always-on
background enrichment worker Stage 1.2's pre-decided design describes.**

- **Payoff (Q3/Q5):** 38% (monorepo) and 56% (foreign corpus) of sampled
  potential matches upgrade to definite verified edges — roughly 2–3× the 20%
  demotion floor, on both corpora. Against the Q1 baseline (661:1,021), an
  upgrade wave of this size would move the hot-symbol ratio from 0.65 to
  roughly 1.6–2.3 verified per remaining potential (extrapolation from the
  sample, stated as such — not a measured post-build number; Stage 1.2's
  shipping evidence must re-run the Q1 query).
- **Cost (Q2):** the 2.45 GB peak RSS mechanically kills always-on (threshold
  2 GB), exactly the contingency the plan's §R reserve row pre-authorized. The
  21.8 s cold time is comfortably fine for an explicit CLI pass.
- **Design consequences for Stage 1.2, from the evidence:**
  1. Shape: `mast index --checker` (opt-in flag), per §R. One project at a
     time, program released between projects (the Q2 warm-pass anomaly is the
     cautionary tale).
  2. `getAliasedSymbol` alias-chain following is mandatory (the 2%→38% bug).
  3. ~30–44% of potential matches are non-call-site FTS noise the checker
     cannot touch — the feature should also record "checked, not a call site"
     so `mast_callers` can partition rather than re-surface them forever.
  4. Files outside tsconfig scope (22% of the monorepo sample) stay potential;
     the tool description must say so.
- **Blocking side-finding:** the Q4b insertEdges false-green is a shipped-today
  bug in the `verified_callers` contract, independent of this feature. Per the
  plan's own severity-zero language it should be fixed (filter `toRows` by the
  importing file's `resolved_path` when resolution='import') with an invariant
  test **before or alongside** Stage 1.2 — a checker pass built on top of
  wrong-target edges would inherit and legitimize them.

## Limitations

- Q3/Q5 samples are 50 and 25 items; rates carry sampling error of roughly
  ±13pp / ±19pp at 95% (binomial) — both stay above the 20% floor even at the
  pessimistic edge, but the point estimates should not be quoted to the digit.
- Q3's "resolves to queried" match is `(file, ±3 lines)` — declaration-hash
  matching would be stricter; not measured.
- Q2's warm number is contaminated by the hold-all-programs artifact (stated
  above); a true one-project-at-a-time warm cost was **not measured**.
- Q4 covers exactly one heuristic scenario (the only one the named test file
  contains); the other four resolution rules were not cross-checked against
  the checker in this spike (Q4b covers the insertEdges layer instead).
- Non-call-site subtype counts rely on a text-based comment/string fallback,
  not token-level classification; subtype boundaries (not the bucket total)
  are approximate.
- The Q1 ratio inherits the shipped 50-hit `identifier_fts` limit per symbol;
  symbols with >50 textual hits are undercounted in the potential column.

## Anomalies (verbatim)

- Warm pass slower than cold: `cold_total_ms: 21770.4`, `warm_total_ms:
  42589.6` (q2-results.json). Explanation above; no error text was produced.
- `getSemanticDiagnostics` returned 0 diagnostics for all 25 projects — no
  compile errors interfered with any measurement.
- No other errors occurred; every script exited 0.

## Suggested Promotion Log row (for human review — plan file NOT edited)

| Date | Mechanism | Decision | Evidence |
|---|---|---|---|
| 2026-07-15 | Checker-verified call edges (Stage 1.1 spike) | **PROMOTE as opt-in `mast index --checker`** (always-on killed by Q2 RSS gate); **prerequisite: fix insertEdges same-name false-green (severity zero)** | Q1 baseline 661:1021 (0.647) verified:potential on top-50 exported symbols; 3,311 POTENTIAL_CALL edges (54% same_file, 40% import). Q2: cold 21.8 s / peak RSS 2.45 GB > 2 GB gate → always-on dead. Q3: 38% of 50 sampled potentials resolve definite (gate ≥20% passes), 30% non-call-site ceiling. n≥2: align-kimik27-02 56% (25 samples, 0 unresolvable). Q4: 0 contradictions on the import fixture; Q4b: confirmed shipped false-green in insertEdges name-collision (edge → wrong file's decl). `eval/spikes/checker-edges/results.json` |
