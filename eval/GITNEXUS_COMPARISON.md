# MAST vs GitNexus — Empirical Comparison

> **REVISION 2 (2026-07-25, post adversarial review).** An independent Fable-model
> review re-ran every experiment in this document. All four P0 claims survived, but
> **two were mis-diagnosed**, several supporting numbers were wrong, and **three new
> findings emerged that outrank most of the original list** — including one that
> invalidates §3's framing entirely.
>
> Corrections are marked inline as **[R2]**. Read §13 (Revision 2) first — it is the
> current state of knowledge. Sections 1–12 are preserved as originally written so the
> corrections are auditable, but **§3, §6.2, §6.4, §7.2 and §8 contain claims now known
> to be wrong.** Do not cite them without reading §13.

**Date:** 2026-07-25
**MAST:** `packages/mast` @ v0.1.0 (branch `ui`, working tree)
**GitNexus:** `/Users/spikedpunchvictim/temp/GitNexus` @ v1.6.9, built from source
**Corpus:** `nest` (NestJS framework) — 1,663 `.ts/.tsx` files, 109,853 LOC,
copied to `/Users/spikedpunchvictim/temp/mast-bench/nest` (no `node_modules`, `.git` retained)
**Host:** darwin arm64, Node v24.7.0

Everything below is measured on this machine against this corpus unless explicitly
labelled otherwise. Claims sourced from `MAST_SPEC.md` or the GitNexus README are
labelled as such and separated from measurements.

---

## 0. TL;DR — what the evidence actually says

1. **GitNexus is unusable for kluster on licensing grounds.** PolyForm
   Noncommercial 1.0.0. This is dispositive and independent of every technical
   finding below. MAST is MIT.
2. **MAST's flagship correctness guarantee (JIT staleness, §9.0) does not hold
   in the deployment it was designed for.** During the startup-reindex window
   it silently returns stale line coordinates with no flag. Reproduced
   deterministically. This is the highest-severity finding in this document.
3. **`mast_callers` is structurally broken for methods** — 58% of indexed
   symbols. Not a coverage gap; a name-form mismatch that guarantees an empty
   result. Reproduced with root cause isolated to a single line.
4. **MAST is 11× slower to index and 62× faster to re-index.** The re-index
   number is the one that matters for the agent loop, and it is a genuine,
   large MAST advantage.
5. **The two tools return fundamentally different things.** MAST returns code.
   GitNexus returns pointers to code. This makes most head-to-head "token
   efficiency" comparisons meaningless unless the follow-up read is counted.

---

## 1. Licensing — decisive

| | MAST | GitNexus |
|---|---|---|
| License | MIT | **PolyForm Noncommercial 1.0.0** |

GitNexus source: `/Users/spikedpunchvictim/temp/GitNexus/LICENSE`, and
`gitnexus/package.json` → `"license": "PolyForm-Noncommercial-1.0.0"`.

PolyForm Noncommercial prohibits use for commercial advantage. kluster is a
commercial product. **GitNexus cannot be vendored, forked, embedded, or run as
part of the kluster pipeline.** Its enterprise tier is a separate paid offering
via akonlabs.com.

This does not make the comparison worthless — GitNexus remains a legitimate
source of *design* evidence, and this document treats it that way. But no
"adopt GitNexus" option exists.

---

## 2. Codebase scale

Measured with `find`/`wc -l`, excluding `node_modules`.

| | src LOC | test LOC |
|---|---|---|
| MAST (`packages/mast/src`) | 9,496 | 6,564 |
| GitNexus (monorepo total) | 261,811 | 275,708 |
| └ `gitnexus/` (CLI + core) | 234,504 | — |
| └ `gitnexus-web/` | 21,198 | — |
| └ `gitnexus-shared/` | 6,076 | — |

**~25× more source.** GitNexus supports 14 languages, ships a web UI, an LLM
wiki generator, PDG/taint analysis, and a multi-repo registry. MAST does TS/JS +
Markdown for one project. The scale gap is mostly scope, not bloat — but it is
also 25× more surface to maintain, and GitNexus's own build is fragile (see §9).

---

## 3. Index build — MAST is 11× slower

| | MAST (Phase 1 only, no embeddings) | GitNexus (full default) |
|---|---|---|
| Wall time | **261 s** | **23.4 s** (31 s incl. process start) |
| Files indexed | 1,332 | 2,028 |
| Units produced | 4,994 chunks | 11,745 nodes / 36,953 edges |
| Extras | — | 668 clusters, 687 flows |
| State size on disk | 194 MB | 175 MB |

Commands:
```
mast index . --state-dir <sd> --phase1-only
node <gitnexus>/dist/cli/index.js analyze .
```

Notes and caveats:
- This is **not** apples-to-apples in MAST's favour: MAST ran `--phase1-only`
  (no embeddings), and GitNexus additionally computed clustering and process
  flows in its 23.4 s. MAST's full Phase 1+2 would be substantially slower still.
- MAST indexed *fewer* files (1,332 vs 2,028) because its default
  `exclude_patterns` drop `**/*.test.ts` and `**/*.spec.ts`. Per-file:
  MAST ≈ 196 ms/file, GitNexus ≈ 11.5 ms/file — **~17× per file.**
- MAST's 194 MB is dominated by `lance/` at 180 MB, holding 4,994 chunks with
  *no vectors written*. That is ~37 KB per chunk for what is essentially text +
  metadata. This looks like a LanceDB fragmentation / compaction problem and is
  worth a dedicated investigation.
- `graph.db` is only 14 MB — the SQLite side is efficient.

**Assessment:** MAST's indexer is slow enough that the §13.8 Docker seed-index
strategy is not an optimization, it is load-bearing. A cold container without a
valid seed is a 4+ minute stall on a corpus this size, before embeddings.

---

## 4. Incremental re-index — MAST is 62× faster

One file changed (`packages/core/injector/injector.ts`, one line appended):

| | Time | Work done |
|---|---|---|
| MAST `--incremental` | **379 ms** | 1 file re-indexed, 1,333 skipped, +47/−46 chunks |
| GitNexus `analyze` | **23.4 s** | BFS importer expansion → 1,028/2,030 files (51%) → **full DB wipe + bulk COPY** |

GitNexus's own log:
```
Incremental: +374 importer(s) added to writable set (BFS depth ≤ 4)
Incremental: effective write set covers 1028/2030 files (51%) — switching to a
full DB write (wipe + bulk COPY) for this run
```

A no-op change (`touch`, content identical) in MAST: **388 ms, 0 files
re-indexed** — the §7.1 file-level stability-hash skip works as specified.

**Assessment:** this is MAST's single largest real advantage and it is exactly
the axis that matters in an agent loop, where a file changes every few seconds.
GitNexus's importer-BFS write-set expansion means one edit to a widely-imported
file costs a full rebuild. MAST's per-file delete-and-replace does not degrade
this way. Credit where due: GitNexus is honest about the fallback in its log
rather than silently doing a full rebuild.

---

## 5. What each tool returns — the comparison most likely to mislead

Same query, `limit: 3`, both indexes lexical (no embeddings on either side).

| | MAST `mast_search` | GitNexus `query` |
|---|---|---|
| Response size | 8,161 bytes | 6,376 bytes |
| **Code content included** | **Yes — full method bodies** | **No — pointers only** |
| Latency | 299 ms | 167 ms |
| Self-reported | `efficiency_ratio: 0.733` | `timing.wall: 166.7` |

GitNexus `context <symbol>`: 4,966 bytes, **zero** code content
(`grep -cE '"(content|code|source|snippet|body)"'` → 0).

GitNexus returns `{uid, name, filePath, startLine, endLine}` graph references
grouped by process/community. MAST returns the actual source text of the chunk.

**This invalidates naive byte-for-byte comparisons.** GitNexus's 6,376 bytes
cannot be acted on without a follow-up `Read` of each file; MAST's 8,161 bytes
can. Conversely, GitNexus's response is a better *map* — it spans multiple files
and attaches process/community structure.

**A real MAST weakness surfaced here:** all three MAST results came from the
*same file* (`packages/core/injector/injector.ts`). There is no result
diversification. GitNexus's process-grouping spread results across
`injector.ts`, `module-ref.ts`, `inject.decorator.ts`. For an agent orienting in
unfamiliar code, MAST's behaviour is worse.

---

## 6. Call-graph density and accuracy

### 6.1 Density

| | MAST | GitNexus |
|---|---|---|
| Total edges | 3,805 | 36,953 |

MAST breakdown (`graph.db`):
```
POTENTIAL_CALL 1038   (field_type 447, import 402, same_file 85,
                       parameter_type 72, new_expression 32)
PARENT_OF      2506
EXTENDS         130
IMPLEMENTS      119
RE_EXPORTS       12
```
Only **1,038** of MAST's 3,805 edges are actual call edges. GitNexus produces
~10× the total edge count.

### 6.2 Accuracy — top-level functions: MAST is good

Symbol `isUndefined` (top-level exported function):

| | Result |
|---|---|
| Ground truth (`grep`, indexed files only) | 107 textual references |
| MAST `mast_callers` | **51 verified + 50 potential = 101** |

Verified entries carry `file_path`, `line`, `caller_symbol`, `context`, and
`resolution` (`import`). This is high-quality output and the verified/potential
partition works as designed.

### 6.3 Accuracy — methods: MAST returns nothing at all

Symbol `Injector.resolveConstructorParams`.

Ground truth (`grep -rn 'resolveConstructorParams'`):
```
packages/core/injector/injector.ts:187      await this.resolveConstructorParams<T>(     ← real call
packages/core/injector/injector.ts:290      public async resolveConstructorParams<T>(   ← declaration
packages/core/injector/module-ref.ts:198    await this.injector.resolveConstructorParams<T>(  ← real call
packages/core/test/injector/injector.spec.ts:737,788                                    ← real calls (file excluded from MAST index)
```

Results:

| | verified | potential |
|---|---|---|
| MAST `{"symbol":"Injector.resolveConstructorParams"}` | **0** | **0** |
| MAST `{"symbol":"resolveConstructorParams"}` | **0** | **0** (early return) |
| GitNexus `context resolveConstructorParams` | found `Injector.loadInstance`, `ModuleRef.instantiateClass`, `injector.spec.ts` ×2 | — |

GitNexus found **all four** real call sites. MAST found **none**.

### 6.4 Root cause — isolated

Two independent defects.

**(a) The potential set can never populate for a method.** The `symbols` table
stores *qualified* method names; `identifier_fts` stores *unqualified*
identifiers. `mast_callers` passes `args.symbol` — which must be qualified to
resolve in `symbols` — straight into the identifier FTS:

```
mcp/tools/callers.ts:73
  collectPotentialMatches(ctx.db, ctx.lance, target.id, args.symbol, verified_callers)
```

Measured directly against the index:
```sql
SELECT COUNT(*) FROM identifier_fts WHERE identifiers MATCH '"Injector.resolveConstructorParams"';  -- 0
SELECT COUNT(*) FROM identifier_fts WHERE identifiers MATCH '"resolveConstructorParams"';           -- 5
```

The result is a catch-22 with no working query form:
- Qualified name → `symbols` lookup succeeds, FTS returns 0 → empty potential set.
- Unqualified name → `symbols` lookup fails → early return at `callers.ts:35`.

**Blast radius:** `SELECT ... GROUP BY (name LIKE '%.%')` →
**2,528 qualified (method) vs 1,797 top-level symbols — 58% of the index.**
Also affects `mast_rename_impact`, which shares `collectPotentialMatches`.

**(b) The verified resolver missed two call sites it claims to catch.** The only
inbound edge to the symbol is `PARENT_OF` from the `Injector` class — no
`POTENTIAL_CALL` edge exists. But:
- `injector.ts:187` is `this.resolveConstructorParams(...)` — a same-class
  `this.` call. §10.3.1 explicitly claims: *"`this.foo()` resolves to the
  enclosing class's `foo` method via the qualified `symbols` row."*
- `module-ref.ts:198` is `this.injector.resolveConstructorParams(...)` where
  `injector` is a typed class field — the `field_type` rule, §10.3.1 case (2).

Both rules are specified, neither fired here. `Injector.loadInstance` *does*
have 3 outbound `POTENTIAL_CALL` edges, so the resolver ran on that method and
simply did not resolve this call. Needs its own investigation — this document
establishes the failure, not the cause.

**Net:** `mast_callers` is trustworthy for top-level functions and silently
returns a confidently-empty answer for methods. An empty result is
indistinguishable from "no callers," which is precisely the false-green class
§10.3.1 says the design exists to prevent.

---

## 7. JIT staleness — MAST's flagship guarantee fails in its own deployment

Spec §9.0: *"The agent must never see a chunk whose line coordinates do not
match the current file on disk... Returning stale line numbers leads directly to
agent-assisted corruption."*

### 7.1 Experiment

Prepend 5 comment lines to `packages/core/injector/injector.ts`, shifting
`resolveConstructorParams` from line 295 → 300. Do **not** re-index. Query via
MCP with `file_path` supplied (the path that triggers `jitRefreshFile`).

| Condition | Reported line | Truth | Correct? |
|---|---|---|---|
| `mast_signature`, call at t=0 after server start | 295 | 300 | **No** |
| `mast_signature`, same call 2 s later | 295 | 300 | **No** |
| `mast_signature`, call at t=45 s | **300** | 300 | Yes |
| `mast_signature`, second call at t=47 s | **300** | 300 | Yes |
| `checkAndRefreshIfStale()` invoked directly (no MCP) | `{refreshed:true}` | — | Yes |
| GitNexus `context` (same stale file) | 290 | 295 | No — labelled `epistemic:"exact"`, no stale warning |

`mast_status` correctly reported `stale_files: 1, index_fresh: false,
freshness_cause: "both"` throughout. **Detection works; correction does not.**

### 7.2 Mechanism

`mast serve` startup (§7.4 Step 4) forks a background reindex that acquires
`structure.lock`. A JIT re-parse from a read tool retries lock acquisition 3× at
100 ms (`mcp/staleness.ts:56`), gives up, and returns `{refreshed:false,
busy:true}`. The stale row is then served as if fresh.

The window is the entire startup-reindex duration — on this corpus, minutes.
That window is *exactly* when the §7.4 ladder invites the agent to start
working ("discovery layer ready in 2–4 s").

### 7.3 The safety valve is specified but not wired

§7.6 says on lock exhaustion, return the stale chunk with
`file_busy_returning_stale_cache: true` "rather than blocking the agent
indefinitely." Measured:

- Every one of the 6 call sites discards the return value:
  `await jitRefreshFile(...)` with no assignment
  (`signature.ts:49,68`, `callers.ts:30`, `exports.ts:21`,
  `dependencies.ts:20`, `rename-impact.ts:45`).
- `grep -rn 'file_busy_returning_stale_cache' --include='*.ts' src/` →
  3 hits in `ast/types.ts` (optional field declarations) and 2 in comments in
  `staleness.ts`. **The flag is never set anywhere in the codebase.**

So the busy signal is computed, discarded, and the dead contract is typed but
never honoured.

### 7.4 Three read tools never check staleness at all

§9.0 requires the check on every read tool and names `mast_search`,
`mast_project_skeleton`, and `mast_implementors` among them. Measured —
`jitRefreshFile` is called only by `signature`, `callers`, `exports`,
`dependencies`, `rename-impact`. **`search.ts`, `project-skeleton.ts`, and
`implementors.ts` do not call it.**

Confirmed live: with the file stale, `mast_search` returned
`Injector.applySettlementSignal` at lines 278–288 (stale coordinates) with no
flag.

`mast_search` is the primary discovery tool and the one the §12 prompt tells the
agent to call first.

### 7.5 Correction to prior analysis

My earlier written comparison claimed MAST was "straightforwardly ahead" of
GitNexus on freshness because MAST checks per-read and GitNexus only at commit
granularity. **That claim was based on the spec and is not supported by
measurement.** In the tested configuration both tools returned stale line
numbers. MAST's mechanism is better designed and demonstrably works when the
lock is free — but as shipped, in the startup window, on the three most-used
tools, it does not protect the agent.

---

## 8. Config drift in `mast serve`

`cli/serve.ts:17` calls `resolveConfig({ stateDirOverride: opts.stateDir })`.
`resolveConfig` (`store/config.ts:82`) reads `mast.config.json` from
`process.cwd()` and otherwise falls back to `DEFAULTS`. **It never reads the
persisted `<state_dir>/config.json`** written at `mast init`.

Consequence: any option set at init time via CLI flag (`--extensions`,
`--exclude`) or written into the state config is silently discarded at serve
time, and `resolved_project_root` becomes whatever the server's cwd happens to
be. In this benchmark the values coincided with `DEFAULTS`, so nothing broke —
but a project that customised exclusions would index one set of files and serve
a different config. Latent, not yet biting.

---

## 9. Operational observations

**GitNexus**
- Build from source is fragile. `npm install` fails because `postinstall` runs
  the build before `tsc` is linked; the build then fails again because
  `gitnexus-shared` has no `node_modules` (root `package.json` declares no
  workspaces). Required manual `npm install` in `gitnexus-shared/` then a
  re-run. A published-npm install path presumably avoids this.
- Emits **hundreds of duplicate warnings to stdout** during analyze
  (`callable-value-flow: candidate set exceeded the cap` repeated verbatim,
  same file:line, many times). Drowns real signal.
- Logged `FTS extension unavailable; continuing without FTS features` and then
  reported `Repository indexed successfully`. **This turned out to be a partial
  degradation, not a full one** — GitNexus ships its own
  `core/search/bm25-index.ts` independent of LadybugDB's FTS extension, and
  measured `bm25: 151.5 ms` in query timing, so lexical search still worked.
  Worth recording that the alarming message overstated the impact.
- Has a `epistemic` confidence field on results — a good idea MAST lacks.
- Duplicate entries in `incoming.calls` (same file listed twice) — dedup gap.

**MAST**
- **No CLI query surface.** `mast --help` exposes only `init`, `index`, `serve`,
  `status`, `install-hooks`, `metrics`. Every query capability is MCP-only, so
  testing/debugging requires writing an MCP client (this benchmark needed one:
  `/Users/spikedpunchvictim/temp/mast-bench/mcp-call.mjs`). GitNexus has full
  CLI parity — `query`, `context`, `impact`, `trace`, `cypher`, `rename`.
  This is a real developer-experience gap and it materially slowed this
  investigation.
- `_stats` telemetry is genuinely useful and present on every read tool —
  `efficiency_ratio` was populated (0.733) and non-degenerate.

---

## 10. Where each tool actually wins

**MAST wins**
- Incremental re-index: 379 ms vs 23.4 s (**62×**) — the axis that matters most
  in an agent edit loop.
- Returns executable context (code) rather than pointers.
- Verified/potential partition on top-level functions is high quality
  (101/107 recall with correct file/line/resolution metadata).
- MIT licensed.
- Per-tool token telemetry with an honest upper-bound counterfactual.
- 25× smaller codebase to own.

**GitNexus wins**
- Full index 11× faster; ~17× faster per file.
- 10× denser call graph; found 4/4 method call sites where MAST found 0/4.
- Result diversification and process/community grouping.
- 14 languages vs 2.
- Full CLI parity with the MCP surface.
- Honest, legible degradation logging (write-set expansion, cap overflows).

**Neither wins**
- Both returned stale line coordinates for an edited, un-reindexed file.

---

## 11. Recommended actions, in severity order

1. **P0 — Fix JIT staleness under lock contention (§7).** Either have the
   startup reindex yield `structure.lock` per-file, or make JIT wait longer, or
   at minimum surface `file_busy_returning_stale_cache` so the agent can tell.
   Currently the agent cannot distinguish fresh from stale.
2. **P0 — Wire staleness into `mast_search`, `mast_project_skeleton`,
   `mast_implementors` (§7.4).** `mast_search` is the tool the prompt tells the
   agent to call first and it has no staleness check at all.
3. **P0 — Fix `mast_callers` for methods (§6.4a).** Pass the unqualified leaf
   name to `identifier_fts` while keeping the qualified name for the `symbols`
   lookup. Affects 58% of symbols and silently returns empty.
4. **P1 — Investigate the missed `this.`/`field_type` call edges (§6.4b).**
   Two documented resolver rules did not fire on a textbook case.
5. **P1 — Investigate the 180 MB `lance/` directory for 4,994 vector-less
   chunks (§3).** ~37 KB/chunk suggests a compaction problem.
6. **P2 — Add a CLI query surface (§9).** Parity with the MCP tools. This is a
   testability problem as much as a DX one — none of §6/§7 could be tested
   without hand-writing an MCP client.
7. **P2 — Make `mast serve` read the persisted state config (§8).**
8. **P2 — Add result diversification to `mast_search` (§5).** Three hits from
   one file is a poor orientation answer.
9. **Consider adopting (design only, not code — §1):** an `epistemic`/confidence
   field on results; process-flow grouping; a `maxTokens` response budget.

---

## 12. Reproduction

```
Corpus:   /Users/spikedpunchvictim/temp/mast-bench/nest        (copy of enterprise-apps/nest)
MAST:     /Users/spikedpunchvictim/temp/mast-bench/mast-state  (state dir)
Harness:  /Users/spikedpunchvictim/temp/mast-bench/mcp-call.mjs   (single MCP tool call)
          /Users/spikedpunchvictim/temp/mast-bench/mcp-call2.mjs  (delayed / repeated call)
          /Users/spikedpunchvictim/temp/mast-bench/jit-probe.mjs  (direct staleness probe)
GitNexus: /Users/spikedpunchvictim/temp/GitNexus/gitnexus/dist/cli/index.js
```

Note: `packages/core/injector/injector.ts` in the bench corpus was mutated
during testing (10 prepended comment lines + one appended export). Backup of the
original at `/tmp/injector.ts.bak`. The corpus is a disposable copy.

**Not yet tested:** MAST Phase 2 (embeddings) end-to-end; hybrid vs lexical
ranking quality; `mast index --checker`; GitNexus `impact`/`trace`/`rename`;
multi-language corpora; any corpus other than `nest`.

---

# 13. Revision 2 — Adversarial Review Results

Independent Fable-model review, 2026-07-25. Re-ran every experiment with new
instrumentation (`probe.mjs` with 50 ms `structure.lock` polling, `hold-lock.mjs`,
`tok-bench.mjs`, `parse-bench.mjs` under `/Users/spikedpunchvictim/temp/mast-bench/`).
Two claims below were spot-verified independently before acceptance (§13.6).

## 13.1 Verdicts on the original four claims

| Claim | Verdict | Correction |
|---|---|---|
| 1 — JIT staleness fails under lock contention | **CONFIRMED (P0)** | Causal story right, **mechanism wrong** |
| 2 — `busy` discarded, flag never set | **CONFIRMED** | Severity **P1**, not P0 |
| 3 — three tools skip staleness | **PARTIALLY CONFIRMED** | P0 / P1 / **P3**, not uniform P0 |
| 4 — `mast_callers` broken for methods | **PARTIALLY CONFIRMED** | **Headline REFUTED**; root causes now isolated |

## 13.2 Claim 1 — confirmed, but the fix changes

The competing explanation ("the reindex just fixed the row; JIT never works") is
**refuted** by a decisive experiment: with `--no-startup-reindex` (no reindex exists
anywhere) and an *external* process holding `structure.lock` for 12 s, queries at
t=0/3/6/9 s all returned stale line 318 (truth 331), and t=14 s — after release —
returned 331. Lock availability was the only variable. Separately, with
`--no-startup-reindex` and no external holder, JIT fired correctly and *was* the lock
holder for 868–1171 ms. **JIT works; contention defeats it.**

**[R2] The mechanism in §7.2 is wrong.** The problem is not the 3×100 ms retry budget
(`staleness.ts:56`) — it is the **holder**. `runIndex` wraps the *entire* index run in
`withLock(...'structure'...)` at `src/indexer/index.ts:46` (independently verified).
`MAST_SPEC.md:822–826` explicitly assumes the opposite: *"lock holding is
per-file-parse (10–50 ms), not per-tool-call."* This is a spec-vs-implementation
contradiction; **no retry budget can fix it.**

**[R2] Measured window durations** (§7.2 guessed "minutes" without measuring):

| scenario | `structure.lock` held | stale answers |
|---|---|---|
| 1 file changed | ~460 ms | 1 call |
| 300 files touched | **~34 s** | t=0, 2, 5, 10 s all stale |
| cold full reindex | **245 s** | entire window |

**[R2] §7.2's "forked startup reindex" is wrong.** `src/mcp/server.ts:177` runs
`void (async () => { await runIndex(...) })()` **in-process**. Only the *embedder*
forks. `MAST_SPEC.md` §7.4 STEP 4 says "in forked child process" — spec and
implementation disagree. Any fix must not assume a child process exists to signal.

## 13.3 Claims 2 and 3 — severity corrections

**Claim 2 → P1.** Confirmed exactly as written (6/6 sites discard; flag never
assigned; the three declaring types are `SearchResult`, `SignatureResult`,
`VerifiedCaller`). But it is a missing *observability* signal subordinate to Claim 1 —
with Claim 1 fixed it would rarely fire. It is nonetheless the **cheapest mitigation**
and should ship first regardless of label.

**Claim 3 → split.** The three tools are not equivalent:
- **`mast_search` — P0, confirmed live.** With `module-ref.ts` 20 lines stale it
  returned `start_line: 161` against a ground truth of 181. No flag.
- **`mast_implementors` — P1.** Returns `line`, so harm is real but the tool is narrow.
- **`mast_project_skeleton` — P3, not P0.** Response shape is
  `{"files":[{"file_path":…,"exports":[…]}]}` — **no line coordinates at all**, so
  §9.0's stated harm is structurally impossible. Calling it P0 diluted the list.

**[R2] A larger gap was missed.** §9.0 requires the check *"for every result a tool is
about to return."* The five "compliant" tools only refresh the file passed **as an
argument** — never their *result* files. So the real violation is "**no tool refreshes
its result set**," with `mast_rename_impact` the worst case: a rename checklist whose
line numbers are unverified.

## 13.4 Claim 4 — headline refuted, root causes isolated

**[R2] "Structurally cannot find method callers" is REFUTED.** The verified path
resolves by `target.id`, not name form, and works for methods:
`mast_callers {"symbol":"NestContainer.getModules"}` → **25 verified callers** with
correct `resolution: "field_type"`.

**4(a) potential set — confirmed harder than claimed.** Every one of the 2,528
qualified symbols is a method; `identifier_fts` contains **zero** dotted text. But the
stated cause (tokenizer separators) is only half: the tokenizer *does* split on `.`, so
a phrase query could in principle match. It cannot, because the `identifiers` column is
**deduplicated by first occurrence**, destroying adjacency. There is **no** working
phrase form.

**[R2] Blast radius restated.** 58% (2,528/4,325) is arithmetically right but measures
"methods with an always-empty potential set." The operationally important number —
*both* sets empty, i.e. a confidently-wrong "no callers" — is **2,200 of 2,528 methods
(87%) = 51% of the entire index**. Constructors (358) do not materially inflate it.

**[R2] §6.4(b) is wrong about which rules failed.** `field_type` is **healthy** — in
the *same method* `ModuleRef.instantiateClass` it fired for `resolveProperties` (line
207) and `applyProperties` (line 215), missing only line 218. Two distinct causes:

1. **Bare `this.foo()` / `super.foo()` were never implemented.** §10.3.1 documents
   both; neither exists. `receiverString` (`typescript.ts:1379–1388`) handles
   `identifier` and `this.prop` only — bare `this` returns `null`; `super` appears
   nowhere in the file. **Scale: 1,135 `this.` call sites in the corpus against a
   whole-index total of 1,038 `POTENTIAL_CALL` edges — implementing this rule would
   roughly double MAST's call graph.**
2. **`await recv.m<T>(…)` is silently dropped.** With type arguments present, `await`
   binds *inside* the `call_expression`'s `function` field; `parseCallee`
   (`typescript.ts:1360–1376`) matches only `identifier`/`member_expression`, hits
   `await_expression`, returns `null`. Isolated by minimal repro: `this.dep.a3<T>()`
   → edge; `await this.dep.a4<T>()` → no edge. Corpus incidence: 14 sites.

`injector.ts:187` is a double-miss (both causes); `module-ref.ts:198` is cause 2.

## 13.5 New findings — three outrank most of the original list

**M1 (P0) — the indexer is O(n²), and 99.2% of its time is storage overhead.**
**This invalidates §3.** Pure `extractFile` over all 1,335 files: **1,997 ms (1.5
ms/file)**. Full `mast index --phase1-only`: **245,238 ms**. Tree-sitter is not the
bottleneck — **MAST's parser is ~8× faster per file than GitNexus's entire pipeline.**

| corpus | files | wall | ms/file | `_versions` |
|---|---|---|---|---|
| `nest/packages/common` | 188 | 9.7 s | 51.5 | 3.5 MB |
| `nest/integration` | 369 | 34.5 s | 93.4 | 15 MB |
| `nest` | 1,335 | 245.2 s | 183.7 | 155 MB |
| `directus` | 2,085 | 759.1 s | 364.1 | 344 MB |

`ms/file` rises monotonically; `_versions` fits n² tightly. Cause:
`lance.replaceChunksForFile` runs **once per file** (`indexer/index.ts:126`), doing
`countRows`+`delete`+`add` (`store/lance.ts:98–107`) — up to 3 LanceDB commits/file,
each writing a manifest enumerating *every* fragment.

**[R2] §3's lance diagnosis was wrong.** Not fragmentation. Independently verified:
**9.4 MB of actual fragment data against 176 MB of un-pruned version manifests**
(2,756 manifests, 1,328 fragments) with **no `optimize`/`cleanup`/`compact` call
anywhere in `store/lance.ts`**. `compact_files` would not fix it; version pruning +
batched writes would.

**[R2] §3's state-size comparison was backwards.** "MAST 194 MB vs GitNexus 175 MB"
misleads *against* MAST: MAST's *useful* state is ~9.4 MB lance + 13 MB graph.db ≈
**21 MB**, roughly **8× smaller** than GitNexus.

Untested extrapolation: at n², n8n (12,641 files) → ~7.7 h and ~12 GB of manifests.

**M2 (P1) — `mast_project_skeleton` costs ~28 s per call, permanently.** Isolated to
telemetry, not the query: `estimateFullFileBound` takes ~31.9 s per pass with 0% cache
hits, because `FULL_FILE_BOUND_CACHE_LIMIT = 200` (`telemetry/tokenizer.ts:68`) while
the tool references all 1,334 files — textbook LRU thrash. A directory-scoped call is
665 ms. **~99% of the orientation tool's latency computes a counterfactual metric.**

**M3 (P1) — `mast init --extensions` / `--exclude` are parsed and ignored.** `init.ts:15–26`
declares both and never reads them (verified: `--extensions .py --exclude '**/skipme.ts'`
→ defaults persisted, excluded file indexed). `loadStateConfig` has **zero callers**
outside `config.ts` — `<state_dir>/config.json` is write-only dead state. `serve`
**overwrites** it via `bootstrapState`→`writeStateConfig`.
**[R2] §8's conclusion was wrong in the specific:** nothing can *diverge* because
nothing reads it. The real bug is that customisation is impossible except via
`mast.config.json` in cwd.

**M4 (P1) — `potential_matches` silently truncates at 50, invalidating §6.2's recall
figure.** `collectPotentialMatches(..., limit = 50)`; `CallersResponse` has no
truncation field. For `isUndefined`: reported 50, actual `identifier_fts` matches
**71**. **[R2] §6.2's "51+50 = 101 of 107 references" is a coincidence** — 21
candidates were silently dropped. "101/107 recall, high-quality output" is not
supported by the data.

**M5 — ~~(P2) `edges` PK drops repeat call sites~~ — [R3] NOT A DEFECT. Withdrawn.**
`PRIMARY KEY (from_id, to_id, edge_type)` + `onConflict.doNothing()` ⇒ at most one edge
per (caller, callee) pair — but this is **specified and tested intent**, not a bug:
`src/graph/__tests__/verified-callers.test.ts:413–444` asserts *"dedupes on (from_id,
to_id, edge_type) — a repeat write for the same pair does not duplicate the row"* with
`countRows() === 1`. Changing it breaks a green test and is a **contract decision**,
not a patch. `verified_callers` does under-report call *sites* — that remains true —
but it is by design.

**M6 (P2) — `mast serve` silently bootstraps an empty state dir**, answering every
query with `{"results":[]}` — indistinguishable from "symbol doesn't exist."

## 13.6 Other corrections to Revision 1

| § | Original | Corrected |
|---|---|---|
| §3 | "11× slower" | **9.6×** wall / 14.6× per-file — and **not constant**; it grows with `n` (M1), so any single figure is the real error |
| §3 | GitNexus 23.4 s | 25.5 s on a verified **cold** run — confirmed cold, not warm |
| §5 | "no result diversification — 3 hits, one file" | n=1 anecdote; a re-run returned 2 results from 2 files. The *mechanism* claim (no diversification pass) holds; "worse than GitNexus" is not established |
| §5 | search-quality comparison | Both indexes were **lexical** (`pending_embeddings: 4495`). §5 tests MAST's *fallback* path, not its design premise. Label accordingly |
| §9 | "no CLI query surface" | Confirmed — and `mast --help` advertises *"over an MCP **or CLI** surface"* |

**Spot-verified independently before acceptance:** the `withLock` scope at
`indexer/index.ts:46` (whole-run, confirmed) and the M1 manifest ratio (9.4 MB data
vs 176 MB `_versions`, 2,756 manifests, no compaction call — confirmed).

## 13.7 Revised action list

TDD per `.claude/CLAUDE.md` §5 — each fix names the failing test to write **first**
and its §5.5 layer. Ordered by severity × leverage.

| # | Fix | Where | Test first (layer) |
|---|---|---|---|
| **F2** | Wire the `busy` signal — capture `jitRefreshFile`'s result, set `file_busy_returning_stale_cache` | 6 sites | `mcp/tools/__tests__/tools.test.ts` (tool) |
| **F1** | `withLock` per **batch**, not per run — matches `MAST_SPEC.md:822` | `indexer/index.ts:46` | `indexer/__tests__/` (integration) |
| **F6** | Batch Lance writes + `optimize({cleanupOlderThan})` once per run | `indexer/index.ts:120–135`, `store/lance.ts:98` | `store/__tests__/lance.test.ts` — assert `_versions` count is O(N) |
| **F5** | Pass the **leaf** name to identifier FTS — *design change, see below* | `callers.ts:73`, `rename-impact.ts` | `tools.test.ts` with a **method** fixture |
| **F3** | `parseCallee`: unwrap `await_expression` (one line) | `typescript.ts:1360` | `ast/extractors/__tests__/call-edges.test.ts` (pure) |
| **F4** | Implement `this.` / `super.` resolution (§10.3.1) + new `resolution` label | `typescript.ts:1379`, `1213` | `call-edges.test.ts` ×3 incl. nested-`function` guard |
| **F8** | Cap the *work*, not the cache, in `estimateFullFileBound` | `telemetry/tokenizer.ts:97` | `telemetry/__tests__/tokenizer.test.ts` (pure, DI seam exists) |
| **F7** | Staleness for `mast_search`/`mast_implementors` — *design change* | — | `tools.test.ts` ×1 (shared helper) |
| **F9** | Honour or **delete** `--extensions`/`--exclude` | `cli/init.ts:20–23` | `cli/__tests__/cli.test.ts` (CLI) |
| **F10** | Surface `potential_truncated` | `ast/types.ts` summary | fold into F5's file |

**[R3] Ship order revised.** F6 and "move chunks to SQLite" are **competing fixes for
the same defect, not sequential steps** — doing F6 first throws it away if the store
moves. Corrected order:

0. **Instrument `withLock` hold-duration** (~3 lines at one chokepoint,
   `store/lock.ts:100–118`, which has a `finally`). This is the missing canary for the
   flagship P0 *and* F1's acceptance criterion — nothing downstream is measurable
   without it. It is also directly falsifiable against `MAST_SPEC.md:824`
   ("per-file-parse (10–50 ms)"), making it a **conformance assertion**, not just a number.
1. **F2** — wire the `busy` flag. Unchanged; cheapest conversion of silent corruption
   into visible.
2. **Decide the chunks store — BEFORE F6.** Prototype `chunks` as a plain SQLite table
   and re-run the M1 corpus ladder (§13.5). If SQLite wins, F6 is deleted outright and
   Lance retains only `vectors` (2.7 MB, no ANN index).
3. **F1**, verified against step 0's metric.
4. **F3 + F4**, with the source-side denominators as acceptance criteria (§13.9 E2).

**Two are design changes, not patches.**
- **F5:** the leaf name is ambiguous across classes (`Foo.close` vs `Bar.close`), so
  the potential set gets noisier by construction. Recommended alternative: **index
  qualified forms into `identifier_fts`** — cleaner, needs a schema-version bump and
  full reindex, which per the *Never shipped* memory is **free right now**.
- **F7:** naively refreshing every result file means up to 50 lock acquisitions *and*
  invalidates the ranking that selected them. Recommended: `statSync` each result
  (cheap, no lock) and flag rather than refresh. Costs one `stat` per result and would
  have caught the live §7.4 failure.

**~~Why the existing test suite missed all of this: `tools.test.ts` only ever queries
`add`/`multiply` — top-level functions. No method fixture exists.~~ [R3] FALSE —
retracted.** Independently verified: a method fixture **does** exist
(`tools.test.ts:59–75`, `class Circle implements Shape` with `area()`/`perimeter()`),
and a qualified-method query **does** exist (`:655`, `mast_rename_impact {symbol:
'Circle.area'}`). **Adding a method fixture would not have caught F5** — the existing
method test asserts only `declaration_sites`, the id-resolved path that works, and
never touches the potential set.

**The real gap is that tests assert *shape*, not *value*.** `tools.test.ts:437–446`
checks `typeof res.summary.potential_count === 'number'` — which passes identically at
0, at 50, and at 50-silently-truncated-from-71 (M4). Measured: 65 of 694 `expect()`
calls suite-wide are shape-only, concentrated 12/117 in `tools.test.ts`. The
enforceable rule that closes this class: **no `unknown[]` in a test's response type
annotation; every returned array gets a content assertion.** That covers more defect
surface than any number of new fixture categories.

## 13.8 Betterments, re-prioritized

1. **Fix the O(n²) write path (F6)** — absent from Revision 1's list; highest leverage
   in the document. Makes MAST viable on kluster's target corpora and shrinks the
   §13.8 Docker seed ~9×, removing the load-bearing dependency §3 concluded with.
2. **Fix `mast_project_skeleton`'s 28 s telemetry (F8)** — absent from Revision 1;
   larger practical cost than the CLI gap ranked P2 there.
3. **CLI query surface — raise P2 → P1**, as an *architecture* observation: every read
   tool is a thin wrapper over a pure function, so `mast query <tool> <json>` is ~40
   lines. **Both this review and the original benchmark found bugs unit tests missed
   precisely because the tools are only reachable over stdio.** It is a testability fix
   that pays for every future finding.
4. **Fail fast on an un-indexed state dir** (M6).
5. **Unify confidence signals** — MAST already computes `resolution` and `reason`;
   what's missing is a uniform field plus the two signals this review found:
   `stale`/`file_busy` (F2/F7) and `truncated` (F10). Frame as unification, not a new
   feature.
6. **Promote `mast_status` to a startup handshake** — until F1 lands, the cheapest real
   mitigation: require it before the first read tool and include `index_fresh` in `_stats`.
7. Result diversification — hold at P2; evidence is n=1 and confounded by lexical mode.

## 13.9 Proposed experiments

Ordered by what they would falsify.

- **~~E3 — Phase 2 end-to-end~~ — [R3] DROP. Already answered, zero information.**
  Its own falsifier is satisfied by disk state plus one line of source: the embed path
  **already batches** (`batchSize = 32`, `indexer/index.ts:281`; one `upsertVectors`
  per batch, `:318–323`). Verified: `vectors.lance` has **55 `_versions` / 256 KB**
  against `chunks.lance`'s **2,756 / 176 MB**. So the O(n²) is confined to the chunks
  write path, and the batching fix F6 needs already exists in-repo to copy.
- **E1 — Scaling ceiling.** `--phase1-only` on otel (902), langchainjs (2,047), strapi
  (3,600), backstage (7,021). *Hypothesis:* wall ∝ n^~1.8, `_versions` ∝ n².
  *Falsified if:* ms/file plateaus — meaning the four points reflect corpus
  differences, not a growth law. **Run before F6; re-run after as regression proof.**
  n8n (12,641) only after F6.
- **E2 — Does the call graph double?** Count `POTENTIAL_CALL` before/after F3+F4.
  *Hypothesis:* ~1,038 → ~2,000+. *Falsified if:* gain <20%, implying `insertEdges`
  name→id resolution drops most new edges (a second, unexamined bottleneck).
- **E4 — Hybrid vs lexical ranking quality.** Every §5 conclusion rests on lexical.
  *Falsified if:* hybrid is no better — **the highest-stakes untested assumption in
  MAST**, calling the whole embedding subsystem's cost/benefit into question.
- **E5 — `mast index --checker`.** *Hypothesis:* converts many of the 50 truncated
  potentials into verified edges, partially masking F5/F10. *Falsified if:* few
  verdicts — then §10.3.2 isn't carrying its complexity.
- **E6 — Cross-language.** Index `vscode`/`pulumi`. *Hypothesis:* non-TS files are
  dropped silently, so `mast_project_skeleton` presents a partial map as complete —
  the same false-green class as Claim 4.
- **E7 — JIT under real agent concurrency** (4 concurrent MCP clients + reindex).
  *Falsified if:* contention degrades non-linearly — meaning F1's per-batch locking
  makes it *worse* and the right design is a single-writer queue.
- **E8 — GitNexus `impact`/`trace`/`rename`.** Design evidence only, per §1 licence.

## 13.10 Corpus state

Bench corpus further mutated (disposable): `injector.ts` +40 pad lines (baseline
`/tmp/injector.baseline.ts`), `module-ref.ts` +20, new `nest/probe-lab/{lab,lab2,lab3}.ts`
minimal repro fixtures (**worth keeping — they are the F3/F4 test cases**), stray
`nest/mast-state/` (safe to delete), `.gitnexus` regenerated (original at
`/tmp/gitnexus-state-bak`). New state dirs: `mast-bench/mast-state2`,
`/tmp/mst-directus`, `/tmp/mst-packages-common`, `/tmp/mst-integration`, `/tmp/initlab`.
Nothing under `packages/mast/src` was modified by either review.

---

# 14. Revision 3 — Strategy Review

Second independent Fable review, this time of the *strategy* recommendations rather
than the findings. It disagreed on 4 of 5 and **refuted the largest one**. Claims
below were spot-verified before acceptance.

## 14.1 `chunks.lance` is NOT redundant — deletion recommendation refuted

The Revision-2-era proposal to delete `chunks.lance` (on the grounds that `chunk_fts`
already stores content) is **wrong**. Verified directly:

```sql
CREATE VIRTUAL TABLE chunk_fts USING fts5(
  content, symbol_name UNINDEXED, chunk_id UNINDEXED, file_path UNINDEXED,
  tokenize = 'trigram')
```

**Four columns.** `chunks.lance` has eleven (`store/lance.ts:12–26`). The seven with
no SQLite home: `start_line`, `end_line`, `chunk_type`, `parent_symbol`,
`is_exported`, `language`, `file_mtime`. There is no other candidate table —
`symbols` is keyed by symbol, and `block`/markdown chunks have no symbol row.

Hard consumers: `search/hybrid.ts:119–123` (`chunk_type` / `only_exported`
post-filters), `:135–154` (**every** `SearchResult` field but `match_score` /
`match_snippet`, including line numbers), `search/potential-matches.ts:69`,
`mcp/tools/exports.ts:23`, `graph/checker-resolver.ts:442`, `mcp/staleness.ts:80`.
**Delete the table and `mast_search` cannot report a line number.**

Two sub-points that *did* hold, both verified:
- **Vectors need no colocation.** `searchVectors` (`store/lance.ts:181–190`) touches
  only `VECTOR_TABLE`, returns `{chunk_id, model_version, _distance}`, no join.
- **There is no ANN index.** `grep -rn 'createIndex|IvfPq|create_index' src/` →
  **zero hits** (confirmed). At ~5,030 chunks `table.search()` is a brute-force scan,
  so LanceDB's actual differentiator is unused.

**Also wrong: the duplication cost.** `SUM(length(content))` = 1.98 MB is the *logical*
size; storage is `chunk_fts_data` 7.2 MB + `chunk_fts_content` 3.2 MB ≈ **10.4 MB of
the 15 MB `graph.db`** (via `dbstat`) — most of the SQLite file.

**Substituted recommendation: replacement, not deletion.** Move chunks to a plain
SQLite `chunks` table (11 columns, ~2 MB content), optionally making `chunk_fts` an
external-content table over it to reclaim the 3.2 MB copy. This fixes M1 **at the
root** — SQLite has no versioned manifests to prune. Corroborating in-repo evidence:
`search/potential-matches.ts:25–33` records that per-symbol Lance round-trips measured
*"50+ CPU-minutes on the kluster monorepo (10,733 symbols) without completing"* —
Lance point lookup is already known to be the wrong shape for this access pattern.

**Survives unchanged:** swapping stores *before* fixing the write pattern would
reproduce the bug elsewhere and burn a migration. That reasoning was sound; it points
at "move to SQLite," not "delete."

## 14.2 The `eval/` harness cannot serve as a regression suite as-is

Advice to "extend `eval/`" needs a prerequisite. Two defects:
- `eval/paths.mjs` pins `SCRATCH` to a **dead session directory**; `model-cache/` and
  `model-states/` are now empty.
- `PROJECT_ROOT` is the **live, drifting kluster repo**, and `corpus-subset.json`
  freezes 3,000 chunk ids, so ids from files touched since 2026-07-09 no longer
  resolve. Cross-time comparability is broken.
  **[R4] Mechanism corrected:** an earlier revision of this section said
  `chunk_id = sha256 of content`. That is **wrong** — `ast/types.ts:28` and
  `extractors/typescript.ts:288` define it as `sha256(file_path + ":" + start_line)`.
  So ids break on **line drift** (any edit shifting a declaration's start line),
  not on content change. The conclusion — broken comparability — survives unchanged;
  the mechanism does not.

**Fix first:** pin the corpus (git SHA or vendored tree) and move state out of the
session scratchpad. **`nest` is the better regression corpus** — external and pinnable.

## 14.3 E4 is one-directional and cannot justify vectors

`eval/gold-set.json`'s own `provenance_note` states the 28 queries are *"deliberately
worded to minimize lexical overlap"* so that *"trigram FTS ranks the true chunk low and
the vector model must carry it."*

So E4 as scoped can **kill** vectors (if lexical still wins) but can **never justify**
them (a hybrid win proves nothing about real queries). Treating it as a two-way gate
is an error. Either add ~15 lexically-normal queries first, or state the asymmetry.

Cheaper than assumed, though: there is no lexical arm today (`run-model.mjs:161–163`
scores `pure_vector`, `hybrid_shipped`, `hybrid_thresh0`), and adding one is **a single
argument** — `hybridSearch(db, lance, null, …)` falls to lexical at `hybrid.ts:72`;
call site `score-only.mjs:52`. Cost is a 644 MB model re-download plus ~8.5 min of
embedding at the harness's own measured 5.88 chunks/s (~30–45 min total, not hours).

## 14.4 Metrics: numerators without denominators

Accepted from Revision 2: `_versions` canary, ms/file ladder, parse-only ratio,
per-tool p50, baseline-before-fix. Four gaps:

1. **No lock-hold metric — the flagship P0 has no canary.** The defect is a *duration*
   and no duration was tracked. See §13.7 step 0.
2. **Denominators.** "POTENTIAL_CALL by resolution" reads 0 for the `this`-family today
   and looks unremarkable. Paired with a source-side denominator it is unmissable:
   **1,124 `this.x(` + 20 `super.x(` sites against 0 edges.** Same for M4
   (identifier_fts matches ÷ returned = 71 vs 50) and chunk coverage.
3. **Config-honoured invariants** (catches M3): assert `indexed extensions ⊆
   config.file_extensions` and `no indexed path matches config.exclude_patterns`.
4. **`chunk_count > 0` / zero-result rate** (catches M6).

## 14.5 Spec drift: quarantine and execute, don't annotate

The three spec-vs-impl contradictions are re-confirmed. But per-claim conformance
markers across 2,593 lines are **hand-maintained metadata with no enforcement** — they
rot exactly as the claims did. Cheaper mechanism, in two parts:

1. **All three false claims are *mechanism* claims** (lock granularity, process model,
   resolution algorithm) — not contract claims. Quarantine mechanism prose into a
   labelled "Design intent — not a contract" appendix. That is deletion, not annotation.
2. **Every claim that must stay normative is testable.** One
   `spec-conformance.test.ts`, each assertion carrying a `// MAST_SPEC.md:824`
   citation. "Normative" then *means* "cited there," CI enforces it, and it grows one
   line per finding. It subsumes the lock-hold metric: the same instrument that
   measures hold duration asserts `< 50 ms`.

Minor: the on-disk `.history` format is `MM.DD.YY` (`06.02.26`, `07.21.26`), not
`2026.7.22`. Zero-padding still applies — `06.02.27` sorts before `07.21.26`.

## 14.6 Testing: the gap is sampling and assertion strength, not oracles

"Structurally impossible for unit tests to have oracle independence" is **too strong**.
`graph/__tests__/verified-callers.test.ts:51–53` asserts hand-derived values, and
`:127–185` / `:233–243` are deliberate adversarial decoys (same-named symbol in another
file; barrel re-export chain). Independence exists.

What the suite lacks is **input distribution**. `await this.dep.a4<T>()` never appeared
in a fixture because nobody thought of the shape. Grep didn't out-*oracle* the tests —
the 1,335-file corpus out-*sampled* them.

**Cheaper substitute for a differential harness:** run the extractor over the real
corpus and assert **self-oracle invariants** needing no external truth — e.g. *every
`call_expression` the walker visits produces either an edge or a recorded drop-reason*.
That catches F3 directly. Property-based generation over call shapes (`recv.m()`,
`this.m()`, `await x.m<T>()`, `super.m()`, `(await x).m()`) is a pure-layer test per
§5.5 and cheaper still. Reserve grep-as-oracle for recall questions with no internal
invariant.

## 14.7 Flagged unverified

LanceDB auto-index behaviour above some row threshold; the §13.5 ms/file ladder (not
re-run); symbol/line-level drift of the gold set (only file-level existence checked).

---

# 15. Revision 4 — Store Decision: Result + Audit

Spike executed, then independently audited (which rebuilt every arm from scratch —
the spike's own state dirs had been deleted, making `store-spike.json` unverifiable
as delivered). All headline numbers reproduced within 5%.

## 15.1 DECISION: MOVE chunks to SQLite

| corpus | files | Lance | SQLite | speedup |
|---|---|---|---|---|
| nest/common | 188 | 12 s | 1 s | 12× |
| nest | 1,337 | 269–284 s | 4.4 s | **61–67×** |
| directus | 2,085 | 619–642 s | 9.1 s | **68–73×** |

State (nest): **194 MB → 17 MB**. Reads 2.6×–10.3× faster at p50. Prediction was
≤70 s; actual 4.4 s.

**Fairness check — the speedup is NOT inflated by skipped work.** Row counts between
arms: nest 5,030 vs 5,022 (delta = exactly one fixture file's 8 rows); directus 7,214
vs 7,174 (delta = exactly `shims.d.ts`'s 40 rows). The SQLite arm still parsed the
failing files and attempted the write — skipped work ≈ 2.2 ms of a 9,060 ms run
(**0.02%**). Normalized speedup: unchanged.

## 15.2 [R4] My R1 explanation was FALSE — recorded in full

I claimed R1's superlinear growth belonged to Pass-2 cross-file edge resolution. That
was asserted **without measurement and is wrong.** Phase-instrumented replica,
SQLite arm, 188 → 2,085 files:

| phase | 188 ms/file | 2,085 ms/file | growth | share of growth |
|---|---|---|---|---|
| parse | 0.73–0.82 | 1.27–1.29 | 1.6× | ~25% (corpus composition) |
| **chunkStore** | **0.14–0.19** | **0.20–0.21** | **1.1–1.4×** | **~4%** |
| **populateFile** (graph+FTS) | **0.58–0.65** | **1.91–2.00** | **3.1×** | **~70%** |
| pass2Edges | 0.11–0.12 | 0.21–0.22 | 1.7× | ~5% |

The superlinear term is `populateFile` (`graph/populate.ts:38–125`) — per-content-KB
cost climbs 0.37→1.35 ms/KB *within a single run* and **still climbs with file order
shuffled**, so it is genuinely index-size-dependent (almost certainly FTS5 trigram
insert cost). That layer is byte-identical in both arms and survives the migration.

**Process finding, recorded deliberately:** this is the rule-fires-then-author-
explains-away pattern the pre-commitment existed to prevent. The structural claim
(a whole-pipeline metric conflates the backend with shared layers) was correct and
checkable; the *mechanism* I named was not, and the instrumentation that settles it
took ~20 minutes. The conclusion survives, but by luck rather than rigor. **Rule:
when a pre-committed trigger fires, measure the attribution before writing the
interpretation.**

## 15.3 [R4] The `chunk_id` fix — a disambiguator alone is the WRONG fix

The two observed collisions have **different mechanisms**:

- **`probe-lab/lab3.ts`** (synthetic): 4 genuinely distinct methods on one line →
  4 real chunks, 1 id. Disambiguator territory. Note the composite key
  `(file, start, end, type)` **still collides** here — all four are `[2,2,method]`.
- **`directus/app/src/shims.d.ts`** (the only real-world case): the same bodyless
  `declare module 'x';` emitted **twice**. tree-sitter parses it as
  `ambient_declaration` + `empty_statement` (the bare `;`), and both fall into
  `emitChunksForNode`'s default block branch (`typescript.ts:379–397`);
  `expandContent` then makes the `;` chunk byte-identical to the real one.

Verified independently from a 2-line fixture: **4 chunks, 2 unique ids.** A
disambiguator applied here would legitimize 16 junk chunks per file and mask the
extractor bug.

**Correct fix set:**
1. **Skip `empty_statement`** (and other zero-content nodes) in the default branch —
   kills the real-world collision class at source.
2. **Namespaced ordinal** for genuine same-line siblings, at **one chokepoint** in
   `extract.ts` (covers typescript + markdown). Do **not** use the raw preimage
   `file:start:n` — it can collide with existing sub-chunk ids
   `sha256(file:startLine:subIndex)` (`typescript.ts:460`); namespace it
   (e.g. `file:start#dup:n`). **Reject content-hash ids** — they break the documented
   "content edit keeps the chunk_id" contract that `vectorKey` (`embedder.ts:148`)
   and `isFileUnchanged` (`indexer/index.ts:223–248`) depend on.
3. **Decide write-failure blast radius before migrating.** Today one bad chunk
   amputates the entire file from search *and* graph, with only a WARN and a
   `parse_errors` increment — silent at query time.

## 15.4 [R4] R3 adjudication — the instrument was amended mid-experiment

The 3/30 content diffs are real, one root cause, verified end-to-end (`mast_search
{"query":"Dep3"}` → Lance returns hits, SQLite returns `[]`). And Lance's "pass" is a
demonstrated false green: it returns two results with *identical colliding content*.

But `store-spike.json`'s own `_note` records that those 3 probes were **added after**
the collision was discovered, aimed at the broken file. **Under the pre-committed
fixed read set, content diffs = 0/27.** Amending a trigger's instrument mid-experiment
is the same category of error as renegotiating the threshold — here it ran *against*
the preferred outcome, which is honest, but "R3 FIRED" is an engineered diagnostic,
not a pre-committed alarm that tripped.

## 15.5 [R4] New defects found by the audit

- **Pass-2 edge resolution is run-to-run nondeterministic.** `walkProject`
  (`indexer/walker.ts:43–49`) never sorts — `fast-glob` returns readdir order, and
  barrel/star re-export machinery is built *during* Pass 2 in walk order. Measured:
  ±4 edges of 3,940 across identical rebuilds. Puts a ~0.1% nondeterminism floor
  under any between-arm content diff. **Fix: sort the walk output.**
- **`populateFile` FTS cost grows with index size** (§15.2) — survives the migration,
  matters at n8n scale.
- **The live index is 83% unembedded** — `pending_embeddings: 4166` of 5,030
  (verified). `--phase1-only` never embeds and the background embedder never caught
  up, so the deployment's "hybrid" search is lexical-only in practice.

## 15.6 Revised next steps

1. **Extractor fixes** with fixtures from both real cases: skip `empty_statement`;
   namespaced ordinal at the `extract.ts` chokepoint. Pure-layer tests (§5.5).
2. **Re-run the arm diff post-fix** — expect 0 parse errors, 0 duplicate rows,
   0 content diffs. Then execute the §14.1 migration.
3. **Sort `walkProject`** — makes all future read-path diffs trustworthy.
4. **Ticket the real R1 finding** (`populateFile` FTS growth).
5. **Decide per-file write-failure semantics** before the migration ships — loud
   failure or per-chunk quarantine, not silent amputation.
6. **Separately:** wire the background embedder's completion, or stop reporting
   `mode: "hybrid"` until `pending_embeddings ≈ 0`.

Audit artifacts (rebuilt state dirs, edge diffs, `phase-timing.mjs`,
`lance-counts.mjs`, `shims-dups.mjs`, `parse-probe.mjs`):
`/Users/spikedpunchvictim/temp/mast-bench/audit2/`.

---

# 16. Revision 5 — chunk_id collision fix (SHIPPED)

Prerequisite for the §14.1 SQLite migration. Independently re-verified.

**Changes:**
- `ast/extractors/typescript.ts:379–402` — default block branch skips `empty_statement`
  and any node whose own source text is empty/whitespace-only. Removes the junk chunk
  at source rather than giving it a unique id.
- `ast/extract.ts:56–150` — `dedupeChunkIds` + `remapIdentifierRows` at the single
  dispatch chokepoint (covers typescript *and* markdown). First chunk at a colliding
  id **keeps its id**; 2nd+ gets `sha256("${file_path}:${start_line}#dup:${n}")`.
  `#dup` namespaces the preimage away from the pre-existing sub-chunk scheme
  `sha256(file:startLine:subIndex)` (`typescript.ts:460`).
- `identifier_fts` rows are re-keyed to post-dedup ids (they are produced against
  pre-dedup ids) — otherwise `mast_callers`' potential set would point at ids that
  no longer exist.
- New: `ast/extractors/__tests__/chunkIdCollisions.test.ts` (14 tests).

**`chunkId()` itself is unchanged** — ids stay position-based, preserving the
"content edit keeps the chunk_id" contract that `vectorKey` (`embedder.ts:148`) and
`isFileUnchanged` (`indexer/index.ts:223–248`) depend on. Content-hash ids were
rejected for that reason; a `(file,start,end,type)` composite was rejected because it
still collides on same-line siblings.

**Corpus scan, independently re-run (before → after):**

| corpus | files | colliding files | duplicate rows | chunks |
|---|---|---|---|---|
| nest | 1,337 | 1 → **0** | 3 → **0** | 5,030 → 5,030 (renamed) |
| directus | 2,086 | 1 → **0** | 16 → **0** | 7,221 → 7,205 (−16 junk) |
| langchainjs | 1,619 | 0 → 0 | 0 → 0 | 12,314 (unchanged) |
| opentelemetry-js | 831 | 1 → **0** | 231 → **0** | 8,203 → 8,202 (−1 junk) |

Specific cases: otel `generated/validator.js` **232 chunks / 1 unique id → 232 / 232**;
directus `shims.d.ts` **40 / 24 → 24 / 24**; `probe-lab/lab3.ts` **8 / 5 → 8 / 8**
(renamed, none lost). Chunk-count deltas reconcile exactly to junk removal.

**Verification:** 360 tests / 28 files pass; `tsc --noEmit` clean; `eslint` clean;
`align check` unchanged from the pre-existing 2-violation baseline, neither naming
`mast`.

**Incidental (correct, not a defect):** `otel/scripts/extract-latest-release-notes.js`
dropped 7→6 chunks — a stray `};` whose `empty_statement` sat on a *different* line
than its sibling, so it never collided but was still a zero-content junk chunk. Part 1
filters by node type/emptiness, not by whether a collision occurs.

**Flagged, not acted on:** indexing a 451 KB single-line generated file as 232
near-meaningless `block` chunks is arguably wrong regardless of ids. The
declaration-based chunker assumes human-authored line structure. A size/line-density
skip — or one whole-file chunk — for generated/minified sources is an indexing-policy
decision worth taking separately.

**Still open before the migration ships:** per-file write-failure blast radius. A
rejected chunk currently amputates the file's chunks, symbols, edges, and FTS rows
with only a WARN and a `parse_errors` increment — silent at query time (§15.3 item 3).
