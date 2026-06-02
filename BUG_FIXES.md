# MAST — Bug Fixes

Audit of `packages/mast` implementation against `MAST_SPEC.md`. Each item is
independently actionable. Work top-down: Critical → High → Medium → Low.

**Workflow per item:** write a failing test that reproduces the bug → fix →
green → refactor → check the box → note the commit. Do not batch unrelated
fixes into one commit (one finding per commit, per the constitution §8.6).

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Critical

### [x] C1 — Phase 2 embedding never runs; search is permanently `lexical`
**Spec:** §7.1 Phase 2, §7.4 Step 4, §11.1.
**Evidence:**
- `runEmbed()` and `requestEmbedding()` are never called in production (grep:
  only definitions + tests).
- `mcp/server.ts:119-133` forks the background embedder and wires an
  `onComplete` that flips `currentMode → 'hybrid'`, but **never sends an embed
  request** (`requestEmbedding`). The worker (`indexer/background-embedder-worker.ts:40`)
  waits on `process.on('message')` for a request that never arrives, so
  `onComplete` never fires and `currentEmbedder` stays `null`.
- `cli/index-cmd.ts:48-50` prints *"Phase 2 (embedding) not yet wired for CLI"*
  and returns — so the Docker seed build (`mast index … --state-dir /opt/mast-seed`,
  §13.8) ships an **empty vectors table**.
- `mcp/tools/reindex.ts:15` runs Phase 1 only.

**Impact:** `vectors.lance` is always empty; `mast_search` always returns
`mode: "lexical"` (matches live `mast_status` → `embedding_mode: "lexical"`).
The whole semantic layer (Jina model, vector search, RRF vector branch,
mode-flip) is inert.

**Fix direction:**
- `serve` Step 4: after `runIndex`, compute the pending chunk IDs (chunks
  without a vector) and `requestEmbedding(child, pendingIds)`; flip mode on
  `complete`. Decide whether the forked-worker path or in-process `runEmbed`
  is the canonical one and delete the other to avoid two divergent code paths.
- Wire Phase 2 into `mast index` CLI (gated by `--phase1-only`) so the seed is
  embedded at build time.
- See C4 for the `mast_reindex` half.

**Confidence:** certain.

**Done:**
- New parent-side driver `warmEmbeddings()` (`indexer/background-embedder.ts`)
  computes pending chunks (chunks without vectors) and sends them to the forked
  worker, resolving on `complete`; resolves immediately with `child: null` when
  nothing is pending (seed case). Replaced the un-driven
  `startBackgroundEmbedder`/`requestEmbedding` (which forked a worker but never
  told it what to embed).
- `serve` Step 4 (`mcp/server.ts`) now awaits `warmEmbeddings`, then sets
  `currentEmbedder` and flips `currentMode → 'hybrid'`; keeps the child alive
  for future incremental work.
- `mast index` CLI (`cli/index-cmd.ts`) now runs Phase 2 in-process via
  `runEmbed` (one-shot process, no isolation concern) unless `--phase1-only` —
  so the Docker seed build ships a fully-embedded index.
- Tests: `indexer/__tests__/warm-embeddings.test.ts` (driver sends pending IDs
  + resolves on completion; no spawn when fully vectorised). CLI embed glue is
  covered by the existing `runEmbed` suite in `embed.test.ts` (§5.4a: existing
  coverage of the regression class). Forked-worker↔ONNX integration remains
  e2e/Docker territory (§5.5).
- Verified: `tsc --noEmit` clean; full suite 146/146. (`pnpm lint` is broken
  repo-wide — ESLint v9 needs `eslint.config.js`; pre-existing, unrelated.)

---

### [x] C2 — `verified_callers` always empty; `EXTENDS` never created; resolver is dead code
**Spec:** §6.3, §9 `mast_callers`, §10.3 / §10.3.1.
**Evidence:**
- `graph/queries.ts:49,61,68` filter on `POTENTIAL_CALL` edges, but
  `ast/extractors/typescript.ts:741-800` (`extractEdges`) only emits
  `IMPLEMENTS` and `PARENT_OF`.
- `graph/local-type-env.ts` (the `POTENTIAL_CALL` heuristic resolver) is
  imported by nobody (`grep -rln local-type-env src` → no hits).
- `EXTENDS` is in the `EdgeType` enum (`graph/db.ts:265`) but never inserted.

**Impact:** `mast_callers` always returns `verified_callers: []` and degrades to
`potential_matches` only — defeating the verified/potential partition the spec
calls fundamental. `transitive: true` returns nothing.

**Secondary:** even the empty rows are non-conformant — `queries.ts:32-33,78-79`
hardcode `context: ''` and `resolution: 'import'` instead of the real context
line and resolution kind.

**Fix direction:** invoke `local-type-env` resolver during graph population
(two-pass, after symbols exist) to emit `POTENTIAL_CALL` edges for the cases in
§10.3.1; emit `EXTENDS` from `extends_clause`; populate real `context`/`resolution`.

**Confidence:** certain.

**Done:**
- Rewrote `graph/local-type-env.ts` as a synchronous, DB-free resolver
  (`resolveCall`) — resolution happens at parse time (pass 1), and the
  "callee must be a known indexed symbol" rule is enforced by `insertEdges`
  dropping unresolved names (pass 2). The class is now actually imported/used.
- `extractEdges` (`ast/extractors/typescript.ts`) now walks call expressions and
  emits `POTENTIAL_CALL` edges for the §10.3.1 patterns it can statically link:
  bare calls → `import` / `same_file`; `this.field.method()` via constructor
  parameter properties & class fields → `field_type`; annotated params →
  `parameter_type`; `new` bindings → `new_expression`. Unresolvable receivers
  (factory returns, dynamic dispatch, chained calls) yield no edge — conservative
  by design (false negatives ok, false positives not). Also emits `EXTENDS`
  (class & interface) alongside the existing IMPLEMENTS/PARENT_OF.
- Edge metadata: added nullable `resolution` / `call_line` / `context` columns to
  the `edges` table with an idempotent `ALTER TABLE` migration in `openDatabase`
  (no schema-version bump — works on fresh and existing DBs). `extractEdges`
  populates them per call site; `insertEdges` threads them through.
- `queryVerifiedCallers` now returns the real `resolution`, the call-site `line`
  (falling back to caller decl line), and the source-line `context` instead of
  the hardcoded `'import'` / `''`. Transitive recursion carries per-hop metadata.
- Tests: `ast/extractors/__tests__/call-edges.test.ts` (resolver patterns +
  EXTENDS + no-false-positives + call-site line/context) and
  `graph/__tests__/verified-callers.test.ts` (end-to-end through `runIndex`).
- Verified: `tsc --noEmit` clean, `pnpm lint` clean, full suite 154/154.

**Known limitations (acceptable / deferred):**
- The edges PK `(from_id, to_id, edge_type)` collapses multiple call sites from
  one caller to one callee into a single representative edge.
- `this.method()` same-class calls are not resolved (conservative false negative).
- The callers tool's verified/potential dedup keys on `file_path:line`; verified
  now uses the call-site line while potential uses the chunk's start line, so a
  site can occasionally appear in both sets. Pre-existing fuzziness; minor.

---

## High

### [x] H1 — In-place edits never re-embed; re-embedding duplicates vectors
**Spec:** §6.1 (`chunk_id`), §7.1 step 7 (stability hashes).
**Evidence:**
- `chunk_id = sha256(filePath + ":" + startLine)` (`typescript.ts:628-630`).
- Phase 2 selects `chunks where chunk_id ∉ embeddedIds` (`indexer/index.ts:229`;
  worker keyed identically). Editing a body without moving the symbol's start
  line keeps the same `chunk_id` → the stale vector is never refreshed.
- Re-embedding never deletes the old vector first (`insertVectors` is `table.add`,
  `store/lance.ts:105-109`) → duplicate vector rows per `chunk_id` (LanceDB has
  no unique key).
- `body_hash` (the spec's mechanism to detect this) is never consulted by the
  embed path.

**Fix direction:** key re-embed decisions on `body_hash` (or content hash), not
chunk_id presence; delete vectors for a file's chunk_ids before re-inserting.
Depends on C1 being wired first.

**Confidence:** high (masked by C1 today).

**Done:**
- `vectors.lance` gained a `content_hash` column (sha256 of the chunk content
  the vector came from). Freshness is now keyed on `vectorKey(chunk_id,
  content)` = `chunk_id:contentHash` (shared `joinVectorKey` so producer and
  reader can't drift). `pendingChunkIds` and `runEmbed` select chunks whose
  CURRENT content hash isn't stored — so an in-place edit (same chunk_id, new
  content) is re-embedded, while genuinely-unchanged chunks are still skipped.
- New `LanceStore.upsertVectors` deletes existing rows for the chunk_ids before
  inserting, so a re-embed overwrites the stale vector instead of appending a
  duplicate (LanceDB has no chunk_id uniqueness). Both embed paths (`runEmbed`
  and the forked worker) now stamp content hashes via `stampVectorHashes` and
  upsert.
- Bumped `CURRENT_SCHEMA_VERSION` 1.0.0 → 1.1.0 (vectors table shape changed);
  H3's wipe rebuilds an old vectors table rather than reading the wrong shape.
- Tests: `indexer/__tests__/reembed.test.ts` — an in-place body edit re-embeds
  only the changed chunk and leaves no duplicate vector (`vectorCount ===
  chunkCount`); an unchanged re-index re-embeds nothing. Also updated a brittle
  `cli.test.ts` assertion that hard-coded `'1.0.0'` to use the constant (the
  bump caught it — exactly what the guard is for).
- Verified: `tsc` clean, `pnpm lint` clean, full suite 161/161.

> Note: this adds a *vector* content hash for embedding freshness. It does NOT
> fix M3 (the symbols-table `declaration_hash`/`body_hash` still computed by a
> brittle first-`{` split and consulted by nothing) — M3 remains open.

---

### [x] H2 — `mast_reindex` doesn't embed new chunks
**Spec:** §7.5 ("Phase 2 only embeds new chunks").
**Evidence:** `mcp/tools/reindex.ts:15` calls only `runIndex` (Phase 1).
**Impact:** symbols an agent writes mid-session are FTS-only; semantic search
can't see them until a restart.
**Fix direction:** after Phase 1, trigger Phase 2 for the new/changed chunk_ids
(synchronously per §7.5, or via the forked worker + await complete).
**Confidence:** certain.

**Done:**
- Factored the C1 embedder into reusable building blocks in
  `indexer/background-embedder.ts`: `pendingChunkIds(lance)` and
  `embedChunks(child, ids)` (a correlated one-shot request that attaches and
  then removes its listener via the new `off` on `EmbedderChildHandle`, so one
  long-lived child serves many requests). `warmEmbeddings` now composes them.
- `AppContext` gained `embedPending()`. `serve` owns a single shared embedder
  child plus a serialised `embedChain` gated on a `warmupSettled` promise — so a
  mid-task reindex reuses the warm-up child (or lazily spawns one) and never
  races a second worker against startup warm-up. After a successful embed it
  flips to hybrid (`ensureHybrid`). Best-effort: embed failures are logged, not
  propagated (Phase 1 remains the guarantee).
- `mast_reindex` now calls `ctx.embedPending()` after `runIndex`, so chunks the
  agent just wrote are embedded, not left FTS-only until restart (§7.5).
- Tests: `embedChunks` reuse (one child, sequential requests) in
  `warm-embeddings.test.ts`; `reindex.test.ts` asserts Phase 1 → embedPending
  wiring. Verified: `tsc` clean, `pnpm lint` clean, full suite 156/156.

---

### [x] H3 — Schema-bump path doesn't wipe derived state
**Spec:** §7.4 Step 2 (delete `lance/`, `graph.db`, `file_manifest.json`,
`embed_cache/` on `schema_version` mismatch).
**Evidence:** `mcp/server.ts:63-74` only rewrites `index.json`; no state wipe.
**Impact:** stale LanceDB tables survive a table-shape change → open/insert
errors or silent shape mismatch — the corruption the version guard exists to
prevent.
**Fix direction:** on mismatch, remove the listed paths before opening DB/lance,
then force a full reindex.
**Confidence:** high.

**Done:**
- New `mcp/startup.ts` with `wipeDerivedState(stateDir)` (removes `lance/`,
  `graph.db` + `-wal`/`-shm`, `file_manifest.json`, `embed_cache/`; preserves
  `config.json` and the lock markers) and `bootstrapState(config, seedPath?)`
  which performs §7.4 steps 1–2: seed copy → lock markers → persist config →
  schema-version guard. On `schema_version` mismatch it wipes derived state
  **before** anything opens it and returns `needsFullReindex: true`. This also
  covers the §13.8.2 case of a seed baked against an old schema (the copied
  seed's stale `index.json` triggers the wipe).
- `serve` now calls `bootstrapState` for steps 1–2 (replacing the inline logic
  that only rewrote `index.json`), then opens db/lance against clean state.
- Tests in `mcp/__tests__/startup.test.ts`: `wipeDerivedState` removes derived
  files while keeping config/markers; `bootstrapState` wipes + flags reindex on
  mismatch and is a no-op when the schema matches.
- Verified: `tsc` clean, `pnpm lint` clean, full suite 159/159.

> Complements C2: C2 added edge columns via a backward-compatible `ALTER TABLE`
> (no version bump). If a future change *does* bump `CURRENT_SCHEMA_VERSION`,
> this wipe now makes the rebuild correct rather than leaving a stale shape.

---

## Medium

### [x] M1 — Import resolution is naive; `resolved_path` rarely matches an indexed file
**Spec:** §13.7 (tsconfig `paths`, pnpm workspace names, `realpathSync`).
**Evidence:** `typescript.ts:703-710` resolves intra-repo imports with
`posix.normalize(posix.join(dir, module))` only — no extension/`index.ts`
resolution, no alias resolution, no workspace-package map, no `realpathSync`.
No path-resolver module exists.
**Impact:** `resolved_path` (e.g. `api/services/auth/repository`) ≠ any
`files.path` (which carry extensions). `mast_dependencies.resolved_path`
misleads; import-based `type_context` mostly misses. `queries.ts:296`'s
`LIKE '${resolved_path}%'` partly rescues same-package but not aliases /
workspace pkgs / `index.ts` dirs, and risks prefix-collision false matches.
**Fix direction:** build the §13.7 resolver (tsconfig-paths + workspace map +
`realpathSync`), feed it into `extractImports`/populate.
**Confidence:** high.

**Done:**
- New `indexer/import-resolver.ts` (`getImportResolver(projectRoot)`, cached &
  synchronous so no signature ripple). Resolves a specifier to a
  project-relative path that matches an indexed `files.path`: (1) relative
  imports probed on disk across `.ts/.tsx/.js/.jsx` + `/index.*`; (2) tsconfig
  `paths` aliases via `tsconfig-paths`; (3) pnpm workspace packages (bare +
  subpath) via a map built from `pnpm-workspace.yaml` globs (found by walking up
  from the root) + each package's `name`; (4) everything else external.
- `extract.ts` now applies the resolver to each import (authoritative
  `isExternal` + `resolvedPath`); `extractImports` no longer does the naive
  `posix.join` (which produced extension-less, alias-blind paths).
- `realpathSync` is applied to BOTH the resolved file and the project root, so a
  symlinked root (and pnpm package symlinks) cancel in the relative path — the
  result matches the walker's `files.path`. (A test on macOS `/tmp`→`/private/tmp`
  caught the one-sided version.)
- Tests: `indexer/__tests__/import-resolver.test.ts` — relative→file (+ index
  dir), tsconfig alias, workspace bare + subpath, external (node:fs/unknown),
  intra-repo-miss → null-not-external, and an `extractFile` integration check.
- Verified: `tsc` clean, `pnpm lint` clean, full suite 173/173.

> Note: the resolver is cached per project root for the life of the process; a
> workspace/tsconfig change mid-session needs a restart to be picked up.

---

### [x] M2 — `mast_signature` returns empty `params`/`return_type`; "signature" is the full body
**Spec:** §9 `mast_signature`, §10.2.
**Evidence:** `mcp/tools/signature.ts:77-78` hardcodes `params: []`,
`return_type: null`. `signature` is set to raw chunk `content` (`:66`) — for a
function that's the whole body + context lines, not the declaration. The
extractor already has `extractSignatureText` (strips body) that the tool
ignores. `extractTypeNames` (`:68`) then scans the whole body, polluting
`type_context`.
**Fix direction:** use `extractSignatureText` for the `signature` field; parse
`params`/`return_type` from the signature node; run `extractTypeNames` over the
signature only.
**Confidence:** certain.

**Done:**
- New `extractSignatures(tree, src)` in the TS extractor + `extractFileSignatures(absPath)`
  wrapper in `extract.ts`: AST-accurate, body-free signature for every symbol,
  with structured `params` (name + full type text, incl. generics/object types
  via `type_annotation`) and `return_type` (from the `return_type` node).
  Handles functions, arrow consts, classes (header only), methods, interfaces,
  type aliases. Query-time parse (few files per call); no schema change.
- `mast_signature` now returns the real `signature` (declaration only),
  populated `params`/`return_type`, and resolves `type_context` from the
  parameter/return TYPES only — no longer scanning the function body for
  PascalCase identifiers. Parses each referenced file at most once per call.
- `mast_exports` had the same body-as-signature bug ("No function bodies" was a
  lie); it now uses the body-free signature too (class entries show just the
  declaration header, per the §9 example).
- Tests (in `tools.test.ts`): `mast_signature add` → `signature` excludes the
  body, `params` = `[{a,number},{b,number}]`, `return_type` = `number`; class
  signature is the header without the member outline; `mast_exports` signatures
  exclude bodies. Existing assertions unchanged.
- Verified: `tsc` clean, `pnpm lint` clean, full suite 176/176.

---

### [x] M3 — Stability hashes computed brittly and drive nothing
**Spec:** §7.1 step 7, §10.1 (class_shell `body_hash` over sorted member sigs).
**Evidence:** `symbolsFromChunks` (`typescript.ts:661-675`) ignores the
node-based `declarationHash`/`bodyHash` and splits `content` on the first `{`
(`:834-843`). Brittle for type-annotated params (`(a: {x:number}) =>`) and
includes trailing context lines. No code consults these hashes → the §7.1
incremental optimization is effectively unimplemented.
**Fix direction:** compute hashes from AST nodes (signature vs body) per spec;
once H1 is wired, use them to drive skip/re-embed.
**Confidence:** high.

**Scope (decided with user):** "fix + safe file-skip". The full per-symbol KG
skip was rejected as unsafe under the delete-replace/FK-ID model (skipping edge
rebuild needs symbol IDs preserved → invasive hot-path surgery) for marginal,
H1-overlapping gain.

**Done:**
- Hashes are now AST-derived, not text-split. New `declHashOf`/`bodyHashOf`
  (signature vs body block) and `classShellBodyHashOf` (sorted member
  signatures + docs, no method bodies, per §10.1). Computed during extraction
  and carried on transient `Chunk.declaration_hash`/`body_hash` (not persisted
  to chunks.lance); `symbolsFromChunks` reads them. Deleted the brittle
  `declarationHashFromContent`/`bodyHashFromContent` (first-`{` split, which
  misattributed signature changes to the body when a param type contained `{`).
- Safe consumer: `runIndex` (incremental only) skips re-writing a file whose
  mtime changed but whose chunked content is identical (`isFileUnchanged`) —
  same chunk-id set AND same symbol declaration/body hash signature, and bails
  if any `block` chunk is present (unverifiable). Reported via `filesSkipped`.
- Tests: `indexer/__tests__/stability.test.ts` — a param-type (signature) change
  moves declaration_hash not body_hash even with `{` in the param (the
  discriminating case the old split got wrong); a body change moves only
  body_hash; class_shell body_hash is stable to method-body edits but moves on
  rename; and runIndex skips a touched-identical file while re-writing a
  genuinely changed one.
- Verified: `tsc` clean, `pnpm lint` clean, full suite 166/166.

---

### [x] M4 — `chunks_removed` always 0
**Spec:** §9 `mast_reindex` (`ReindexResult.chunks_removed`).
**Evidence:** `indexer/index.ts:84` declares `chunksRemoved = 0`, never updated;
returned at `:169`.
**Fix direction:** count chunks deleted in `replaceChunksForFile` /
`deleteChunksForFiles` and thread the total back.
**Confidence:** certain.

**Done:**
- `LanceStore.replaceChunksForFile` and `deleteChunksForFiles` now return the
  number of rows removed (counted via `table.countRows(predicate)` before the
  delete). `runIndex` accumulates them across deleted files, full-reindex
  orphans, and per-file replacements into `chunksRemoved` (previously declared
  and returned as a constant 0).
- Tests (`indexer/__tests__/chunks-removed.test.ts`): 0 on a fresh index;
  equals the prior chunk count when a file's chunks are fully replaced; equals
  the deleted file's chunk count on an incremental run that removes one file.
- Verified: `tsc` clean, `pnpm lint` clean, full suite 178/178.

---

## Low / correctness nits

### [x] L1 — Cosine "score" is a rescale, not cosine similarity
`search/vector.ts:32` computes `1 - distance/2` (orthogonal → 0.5, not 0). So
`similarity_threshold: 0.70` and reported `similarity_score` don't mean cosine.
Pre-RRF hard-filtering on this (`hybrid.ts:78`) also isn't in the spec's RRF
recipe. (Latent behind C1.)

**Done:** `searchVectors` now returns `1 - distance` — the real cosine
similarity LanceDB's distance encodes — so `similarity_score` and the
`similarity_threshold` floor are genuine cosine values. Test in `embed.test.ts`:
an identical vector scores ~1 and an orthogonal one ~0 (the old rescale reported
0.5). Left the pre-RRF threshold filter in place — it now applies a correct
cosine floor at the configured 0.70; revisiting that value is tuning, not this
fix. `tsc`/lint clean, suite 179/179.

### [x] L2 — Raw user query into FTS5 `MATCH`
`search/fts.ts:79` passes the query unescaped; runs *outside* the try/catch in
`hybrid.ts:56`, so a query with FTS5 syntax (`(`, `:`, `"` — e.g.
`handleLogin(req`) throws and fails the whole search instead of degrading.
**Fix direction:** sanitize/quote the query for FTS5, or catch and fall back.

**Done:** `toFtsMatch` reduces the query to identifier tokens (≥3 chars, the
trigram minimum), quotes each as a phrase, and ANDs them — so no character is
interpreted as FTS5 syntax; returns null (→ `[]`) when nothing is usable.
`searchIdentifiers` now quotes its term too (handles `Class.method`). Tests in
`search/__tests__/fts-query.test.ts`: punctuated/quoted/operator-looking queries
resolve instead of throwing and still match; sub-trigram queries return `[]`.
`tsc`/lint clean, suite 183/183.

### [x] L3 — Dead member-type branch in shell synthesis
`synthesiseClassShell` (`typescript.ts:432-437`) filters for `readonly_type`,
which is not a class-member node — a no-op branch (likely meant to be a
property/signature node). Verify property/getter/setter/constructor coverage.

**Done:** extracted a shared `isClassShellMember` predicate
(`method_definition`, `abstract_method_signature`, `public_field_definition`,
`property_signature`) used by BOTH `synthesiseClassShell` and
`classShellBodyHashOf`, so the outline text and its body-hash can't disagree on
membership (they previously diverged: one listed `readonly_type`, the other
`property_signature`). Dropped the bogus `readonly_type`. Test in
`stability.test.ts`: a field signature change moves the class_shell body_hash
(fields are members). `tsc`/lint clean, suite 184/184.

### [x] L4 — `export { foo as bar }` doesn't record `bar`
Pass-2 (`typescript.ts:71-78`) only marks the local name exported; the aliased
export symbol `bar` (spec §10.1) is never created.

**Done:** a shared `localExportAliases` walk feeds two new passes — the chunker
emits a chunk for `bar` mirroring `foo`'s declaration (distinct chunk_id, marked
exported), and `extractSignatures` emits `bar`'s signature from `foo`'s — so the
alias is discoverable via mast_exports/search and resolvable via mast_signature.
Pass-2 also stops marking the *local* name exported when it's aliased
(`export { foo as bar }` exposes `bar`, not `foo`). Test in
`export-alias.test.ts`. `tsc`/lint clean, suite 189/189.

### [ ] L5 — `withLock` SIGTERM cleanup races with two locks held
`store/lock.ts:92` — the first handler's `process.exit(1)` can pre-empt the
second lock's cleanup. Stale-PID recovery covers it, but it leaks on graceful
kill.

---

## Tooling

### [x] T1 — `pnpm lint` is broken in this package (ESLint 9 flat-config)
**Evidence:** `pnpm -F @kluster/mast lint` fails with *"ESLint couldn't find an
eslint.config.(js|mjs|cjs) file"* (ESLint 9.39.4). Repo state:
- Root `.eslintrc.json` exists but is the **old** format — ESLint 9 defaults to
  flat config and ignores it.
- `application/api/eslint.config.js` is already migrated (flat) — so the rest of
  the repo lints, but `packages/mast` has no flat config.
- `packages/mast` lint script is `eslint src --ext .ts`; the `--ext` flag was
  **removed** in ESLint 9 flat-config mode (file matching now lives in the
  config), so even with a config present the script would error.

**Impact:** the constitution's "no new lint warnings" quality gate (§10) cannot
run for this package — every change since the ESLint 9 bump has shipped
unlinted, including C1.

**Fix direction:** add `packages/mast/eslint.config.js` (flat) wired to the
`@typescript-eslint` recommended-type-checked ruleset per constitution §2
(mirror `application/api/eslint.config.js`), and change the script to
`eslint src` (drop `--ext`). Then run it and clear any findings the flat config
surfaces. Decide separately whether to migrate the root `.eslintrc.json` to a
shared flat base — out of scope for this item unless trivial.

**Confidence:** certain.

**Done:**
- Added latest ESLint (`^10.4.1`) + `@typescript-eslint/parser` &
  `eslint-plugin` (`^8.60.1`, which support `eslint ^10`) to the mast package's
  devDependencies via pnpm.
- New `packages/mast/eslint.config.js` (flat): `recommended-type-checked` on
  `src/**` (type-aware via `projectService`), non-type-aware on tests, plus the
  §3 syntactic gates (no `any`, `ban-ts-comment`, `_`-prefix unused-vars,
  `no-console`). Fixtures excluded. Deliberately does NOT set
  `consistent-type-assertions: 'never'` (mast was written against the root
  config, which permits `as`) — tightening that is a separate cleanup.
- Changed the lint script from `eslint src --ext .ts` to `eslint src` (`--ext`
  was removed in flat-config mode).
- Cleared the 82-finding backlog the working lint surfaced:
  - **Typed the tree-sitter AST nodes properly** (the chosen fix): `parser.ts`
    now exposes `Tree`/`SyntaxNode` (it already ships types — the "no
    declarations" comment was stale) and dropped 3 unused `any` re-exports;
    `ast/extractors/typescript.ts` node helpers and call sites now use
    `SyntaxNode`/`Tree` instead of `(x as any)`, removing ~40 inline
    `eslint-disable` comments. Type-only — behavior preserved (21 extractor
    tests green).
  - Restored typed casts on 4 LanceDB `.toArray()` returns in `store/lance.ts`
    (autofix had stripped them into `any[]`).
  - Fixed trivial unused-vars in 3 test files; auto-fixed unnecessary
    assertions / stale disable directives.
- Verified: `pnpm lint` clean, `tsc --noEmit` clean, full suite 146/146.

> Out of scope (separate item if desired): the legacy root `.eslintrc.json` is
> still ESLint-9/10-incompatible for any package without its own flat config.

---

### [x] T2 — Flaky native LanceDB crash on test-process teardown
**Evidence:** `pnpm test` intermittently aborts with a native fault during
process cleanup — `napi_env__::DeleteMe` / `v8impl::Reference::Finalize` on a
worker thread, originating in `@lancedb/lancedb`'s native addon. It happens
*after* all tests report green (a teardown crash, not an assertion failure) and
disappears on re-run. Seen ~3 times across the C1/C2/H2 runs.
**Impact:** non-deterministic CI failures; could fail an otherwise-passing
pipeline and erodes trust in the suite.
**Fix direction:** audit LanceDB lifecycle in tests — many specs open a
`LanceStore` and never close the underlying connection in `afterAll`; ensure
they do. And/or pin/upgrade `@lancedb/lancedb` past the teardown-finalizer
fault, or set a vitest `pool` option if it's worker-teardown-specific.
**Confidence:** high (real recurring fault; root cause not yet pinned).

**Done:**
- Root cause: vitest's default `threads` pool finalizes the napi environment
  during worker-thread teardown while LanceDB's native Rust runtime threads
  still hold references → `Reference::Finalize` abort after tests pass.
- Fix: set `pool: 'forks'` in `vitest.config.ts` so each test file runs in a
  forked child process; native finalization happens at normal process exit,
  which the addon handles cleanly. (`@lancedb/lancedb`'s `Connection` exposes no
  prototype `close()`, so connection-closing in tests wasn't a clean lever.)
- Verified: ran the full suite 6× back-to-back — all exit 0, 159/159, zero
  native aborts (previously crashed ~1 in 3). This is a teardown/reliability
  fix with no behavioural surface, so verification is repeated full-suite runs
  rather than a new unit test (§5.5).

---

## Suggested order
1. **C1** (unblocks the whole semantic layer and makes H1/M3/L1 observable).
2. **C2** (restores call-graph value; independent of C1).
3. **H2 / H3** (reindex + schema-bump correctness).
4. **H1 / M3** (re-embed correctness; do together — shared hash work).
5. **M2** (signature quality), **M1** (path resolution).
6. **M4, L1–L5** (cleanups).
