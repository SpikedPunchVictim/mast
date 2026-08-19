<!-- SHARD — do not edit the excerpt below. -->

> **Plan excerpt — ADR 007: Call-graph resolution, and what an unresolved call may claim.**
> Verbatim from `IMPLEMENTATION_PLAN.md` at commit `69a587e`, lines 708–1172, 11397–11459 (concatenated in that order).
> This is the append-only record the ADR was written from; the ADR is the summary, this is the evidence.
> Nothing here has been edited — see `docs/provenance/verify-plan-shards.mjs` for the losslessness proof.

---

## Stage 3: Call-graph correctness
**Goal**: `mast_callers` stops returning confidently-empty answers.
**Status**: Complete (2026-08-09) — F3/F4/F5/F10 all shipped. The corpus
edge-count success criterion below (1,038 → toward 1,124 `this.` + 20
`super.`) remains E2's registered measurement — Stage completion does not
claim it; see each result's "What is explicitly NOT claimed" note.

| # | Task | Status |
|---|---|---|
| F3 | `parseCallee`: unwrap `await_expression` (`typescript.ts:1360`) — one line | **Complete** |
| F4 | Implement `this.` / `super.` resolution (documented in §10.3.1, never built) | **Complete** |
| F5 | `mast_callers` potential set for methods — **design change**, see below | **Complete** |
| F10 | Surface `potential_truncated` (silent cap at 50; real count was 71) | **Complete** |

**Success criteria**: `POTENTIAL_CALL` edges rise from **1,038** toward the
**1,124 `this.` + 20 `super.`** call sites the corpus contains (E2 acceptance
denominators). `mast_callers {"symbol":"Injector.resolveConstructorParams"}` returns
its 3 real call sites (currently 0).
**F5 design note**: preferred fix is indexing **qualified** names into
`identifier_fts` (schema bump + reindex — free under never-shipped), NOT passing the
unqualified leaf name, which widens the set ambiguously across classes.
**Tests**: `ast/extractors/__tests__/call-edges.test.ts` (pure layer) — incl. a
nested-`function` shadowing guard for F4. `tools.test.ts` with a **method** fixture
asserting the *potential set* (the existing method fixture only asserts
`declaration_sites`).

### F3+F4 result (2026-08-09) — await unwrap + this/super resolution

**Design: ride the existing receiver-binding machinery, no parallel mechanism.**
Both tasks extend `LocalTypeEnvironment`'s existing typed-receiver path
(`local-type-env.ts`) rather than adding a second resolution mechanism — F4 in
particular seeds `this`/`super` as ordinary receiver bindings the same way
`field_type`/`parameter_type` already work, so `resolveCall` and
`resolveCallTarget`'s per-rule file-scoping needed no new *kind* of machinery,
only two new resolution-rule branches.

**F3 — await unwrapping, three shapes verified via a tree-sitter S-expression
dump against the current `tree-sitter-typescript` grammar** (a throwaway probe
test, deleted before commit):
- `(await x).m()`: the member_expression's `object` field is
  `parenthesized_expression(await_expression(identifier))` — three levels deep.
  `receiverString` (`typescript.ts`) now unwraps this specific shape via a new
  `unwrapAwaitedReceiver` helper, applied before the existing
  identifier/`this.field`/`this`/`super` dispatch, so `x`'s existing binding
  (parameter, field, etc.) applies unchanged.
- `await x.m()`: `await_expression` wraps the whole `call_expression` directly
  (not the receiver) — `collectCalls`'s recursive visit already reaches the
  inner `call_expression` (it does not skip `await_expression`), and
  `parseCallee` already read its `function` field correctly. This shape needed
  no code change; only a pinning test (`await this.users.create(x)`, asserting
  `field_type`).
- `x.m<T>()`: `call_expression`'s `function` field is unaffected by an
  intervening `type_arguments` node — `childForFieldName('function')` returns
  the `member_expression` regardless. No code change; pinning test only.
- Confirmed unchanged: `const y = await makeFoo(); y.bar()` still produces no
  edge — F3 unwraps syntax around an *already-bound* receiver, it does not run
  type inference through an assignment. §10.3.1's "does NOT catch" list is
  unchanged.

**F4 — this./super. resolution, two new `CallerResolution` values**
(`ast/types.ts`): `'this_method'` and `'super_method'`, additive TEXT values
in the `edges.resolution` column — no schema bump, same precedent as
`'checker'` (MAST_SPEC.md §6.3's comment already documents `'checker'` as
schema-free-additive; grepped `packages/mast/src` and `graph/db.ts`'s schema
DDL for any `CHECK`/enum constraint on the column — none exists, so nothing at
the DB layer needed updating).
1. `receiverString` gained two branches: a bare `this` node (tree-sitter type
   `'this'`) → the literal string `"this"`; a bare `super` node (type
   `'super'`) → `"super"`. Verified via the same S-expression dump: in
   `this.helper()`, the member_expression's `object` field is the `this` node
   itself (not a nested member_expression), so this sits alongside — not
   inside — the pre-existing `this.field` special case (which handles
   `this.repo.findByEmail()`, an unrelated shape where `this` is the *inner*
   node of a nested member_expression).
2. `emitClassEdges` (`typescript.ts`) now builds one `classScopeBindings` array
   per class — the renamed `fieldBindings` plus `{ receiver: 'this', type:
   className, resolution: 'this_method' }`, and, only when the class's
   `extends_clause` named a parent (`baseClassName`, captured at the same site
   that already emits the `EXTENDS` edge, so the binding and the edge can never
   disagree), `{ receiver: 'super', type: baseClassName, resolution:
   'super_method' }`. Passed to `emitCallEdges` for every method in the class,
   which seeds them into that method's `LocalTypeEnvironment` alongside the
   field bindings — `resolveCall('this', 'foo')` then yields
   `{ callee: 'ClassName.foo', resolution: 'this_method' }` through the
   unmodified generic receiver-type path. No extends clause → no `super`
   binding seeded → `super.foo()` calls fall through to `identifier_fts`'s
   `potential_matches` set, exactly as the mandate requires (never guess).
3. **Nested-function shadowing guard.** `collectCalls` already skipped
   `function_declaration`/`method_definition`/`class_declaration`/
   `abstract_class_declaration` (their calls belong to their own scope, per
   the pre-existing comment). Verified via the S-expression dump that this
   list was incomplete for `this`-shadowing purposes: `function_expression`
   (anonymous `function(){}` and named-expression forms) and the two
   generator forms (`generator_function_declaration`,
   `generator_function`) are distinct tree-sitter node types not covered by
   the existing list, and each introduces its own dynamic `this` exactly like
   `function_declaration` does. All three were added to the skip list with a
   WHY-comment. **Arrow functions were confirmed absent from the skip list
   (unchanged)** — they inherit the enclosing scope's `this` by JS semantics,
   confirmed via the dump that `collectCalls`'s visit descends into
   `arrow_function` bodies normally, so a `this.helper()` call inside an arrow
   nested in a method still reaches the same shared `LocalTypeEnvironment` and
   resolves to `this_method`.

**`resolveCallTarget` file-scoping for the two new labels** (`populate.ts`):
- `'this_method'`: resolved by a new `resolveSameFileScoped` helper — the
  identical file-scoped lookup `'same_file'` already used (extracted out, not
  duplicated), keyed on the qualified `ClassName.methodName` toName instead of
  a bare name. Correct because `emitClassEdges` only ever seeds the `this`
  binding from the class node it is currently walking — the class is
  guaranteed declared in the calling file.
- `'super_method'`: resolved by a new `resolveQualifiedNameScoped` helper —
  the identical two-step lookup `'field_type'`/`'parameter_type'`/
  `'new_expression'` already used (import's `resolved_path` first, following
  the re-export chain; then same-file declaration), also extracted out of
  those three cases rather than duplicated a fourth time. The one behavioral
  difference: `onUnresolved` is a caller-supplied continuation —
  `field_type`/`parameter_type`/`new_expression` still pass
  `legacyGlobalFirstMatch` (unchanged, pre-existing coverage-gap fallback);
  `super_method` passes `async () => null`, so an unresolvable parent class
  name (ambient/global type, or a shape the resolver doesn't track) drops the
  edge instead of guessing across the whole graph — the mandate's "no bare-name
  global fallback for these new rules."

**Red-first evidence.** New tests were written against the unfixed code first
and run via `pnpm exec vitest run` (not a stash/pop — no production file
needed reverting since the F3/F4 code did not exist yet at test-writing time).
First run: **5 failed / 20 passed** (25 total in the two touched files) — all
5 failures were `expected undefined not to be undefined` (assertion-level,
proving each test exercises a real, then-missing behavior, not a broken
import): `(await repo).findById(id)` (F3 receiver unwrap), `this.helper()`
resolution, `super.base()` resolution, and `this.helper()` inside an arrow
(F4, three failures). Four tests in the same red run passed "for free" before
any F3/F4 implementation existed — `await x.m()` and `x.m<T>()` (already-working
shapes, F3 pinning only), no-super-without-extends, and no-`this`-inside-a-
nested-`function_declaration` (the pre-existing skip already covered that one
shadowing case) — confirming those assertions describe already-correct
behavior rather than untested gaps. Implementing `unwrapAwaitedReceiver`, the
`this`/`super` `receiverString` branches, `classScopeBindings` seeding, the
three-form skip-list extension, and the two `resolveCallTarget` branches
turned all 5 green with no regressions elsewhere.

**Test design.** Pure-layer coverage
(`ast/extractors/__tests__/call-edges.test.ts`, +9 tests: 4 F3 + 5 F4) follows
the file's existing `edgesOf`/`potentialCalls` fixture pattern exactly. One
integration test (`graph/__tests__/verified-callers.test.ts`, +1 test) drives
`populateFile` + `insertEdges` directly (the file's established
`populateFixture` helper) and asserts `queryVerifiedCallers` returns a
`this_method`-resolved caller — proving `resolveCallTarget`'s new branch is
actually wired into the real pipeline, not just reachable in the pure
extractor. `super_method` was deliberately NOT given a second full-pipeline
test: `resolveQualifiedNameScoped` is the identical helper `field_type`
already exercises end-to-end via the Q4b/barrel-chain/ambiguity-fallback
tests in the same file, so a second integration test would duplicate coverage
those already provide (§5.5 test budget) — the `super_method`-specific
behavior (the `async () => null` fallback and the binding-seeding condition on
`extends`) is fully covered at the pure layer instead.

**What is explicitly NOT claimed here.** No corpus-level before/after
`POTENTIAL_CALL` edge count was measured against a real external corpus — the
Stage 3 "Success criteria" above (1,038 → toward 1,124 `this.` + 20 `super.`
call sites) is E2's registered measurement, a separate experiment requiring
pre-registration per the project's methodological rules (HANDOFF §6). This
task's evidence is unit-level only: the resolver now produces `this_method`/
`super_method` edges where it previously produced none, proven by the tests
above; whether that closes the corpus-measured gap awaits E2.

**Verification** (from `packages/mast`): `pnpm test` — **538/538 passed, 37
files** (baseline 528/37; +10 net new tests — 9 pure-layer + 1 integration).
`pnpm typecheck` — clean. `pnpm lint` — clean. Repo-root `pnpm align:check` —
`baselined debt: 324 -> 324 (0)`, red only on the 2 pre-existing non-mast
violations (`application/ui/src/views/root-layout.tsx` import cycle;
`application/api/src/domain/spec/fold-build-record-repository.ts` domain→db
import) — unchanged from C1's verification, confirming F3/F4 introduced no
new architecture drift.

**Deviations**: none from the mandated design. **Noticed but not done**: F5
(qualified names in `identifier_fts`) and F10 (`potential_truncated`) remain
unimplemented — explicitly out of scope per the task brief; Stage 3's overall
`Status` is left as "In Progress" rather than "Complete" to reflect this.

### F5 result (2026-08-09) — qualified identifiers indexed

**The defect.** `mast_callers`/`mast_rename_impact` document `'Class.method'` as
the query convention for a method symbol. `searchIdentifiers` (`search/fts.ts`)
phrase-quotes the term before querying `identifier_fts`, and that table's
`unicode61` tokenizer treats `.` as a separator (`graph/db.ts`'s DDL). A phrase
match therefore requires the tokens `Class` and `method` to sit at ADJACENT
positions in the row's `identifiers` column. `identifier_fts` rows were built
purely from `extractIdentifiers` — a regex over raw chunk text that extracts
every BARE `\w+` token, deduplicates, and whitespace-joins — which essentially
never places a class name immediately before a same-chunk method name (the two
tokens are separated by the rest of the chunk's vocabulary between them). The
potential set for any method query was therefore silently empty
(`eval/GITNEXUS_COMPARISON.md` §13.4/§6.4a), independent of whether a real
caller existed — 58% of symbols in the eval corpus are methods.

**The shipped design (as mandated, no relitigation of the choice).** The
extractor now emits QUALIFIED compound strings — literal `"Class.method"` text
— into each chunk's identifier row, appended after the bare bag and
deduplicated. This was chosen over indexing the unqualified leaf name (`method`
alone), which would have widened the potential set ambiguously across classes
(`Foo.close` vs `Bar.close` both firing on a bare `close` query) — exactly the
imprecision `mast_callers`'s "review required, not verified" contract cannot
absorb silently.

Two sources feed the compounds, both riding the SAME `LocalTypeEnvironment`
resolution `extractEdges` already computes for `POTENTIAL_CALL` edges — no
parallel mechanism, same precedent as F3/F4:
1. **Declaration self-discoverability.** Every `method`-chunk's own qualified
   `symbol_name` (already `${className}.${methodName}` at construction —
   constructor/getter/setter forms included, since they share the same naming)
   is appended to its OWN identifier row. This makes `mast_rename_impact`'s
   documented "the declaration typically appears in `potential_matches`" claim
   actually true for methods.
2. **Resolved call-site mentions.** In `TypeScriptExtractor.extract()`, after
   `edges` is built, every `POTENTIAL_CALL` edge whose `toName` contains `.`
   (i.e. `LocalTypeEnvironment.resolveCall` matched a receiver binding —
   `field_type`, `parameter_type`, `new_expression`, `this_method`, or
   `super_method`) is grouped by `fromName` and appended to the matching
   CALLING chunk's identifier row (matched by `chunk.symbol_name === fromName`,
   the same qualified name `emitCallEdges` used as scope). Deriving this from
   the already-computed `edges` array (rather than re-walking the AST or
   threading a new return value through `extractEdges`) meant `extractEdges`'s
   existing signature — and all 16 tests in `call-edges.test.ts` that assert
   against it directly — needed zero changes.

   This also HEALS a case F3/F4's own "noticed but not done" left open:
   extraction and `insertEdges`' DB-layer resolution are independent passes.
   When a receiver's type is imported from an unresolvable specifier (external
   package, broken relative path), `resolveQualifiedNameScoped`
   (`graph/populate.ts`) finds the import row but a `null` `resolvedPath` and
   returns `null` with NO fallback — the edge never reaches `graph.db`, even
   when an unrelated file coincidentally declares a same-named qualified
   symbol. The qualified compound is emitted regardless (extraction never
   looks at import resolution), so the mention still surfaces in
   `potential_matches` instead of vanishing. Proven by the tool-level test
   below.
3. **Genuinely-unresolvable receivers contribute nothing — honestly.** DI
   container lookups, factory return types, chained calls without
   intermediate binding, dynamic dispatch, and generic type parameters
   (§10.3.1's documented "does NOT catch" list) never produce a
   `LocalTypeEnvironment` binding, so `resolveCall` returns `null`, no
   `POTENTIAL_CALL` edge exists, and no qualified compound is ever added for
   that call site — F5 does not guess. This residual gap is real and is
   `mast index --checker` / future-work territory, not this fix's; MAST_SPEC.md
   §10.3.1 now says so explicitly instead of the previous (overstated, for
   qualified queries) blanket claim that an unresolved identifier "still lands
   in `identifier_fts`."
4. **Markdown** contributes no identifier rows at all — unchanged; nothing in
   this task touches `MarkdownExtractor`.

**Mechanism verification — the adjacency claim.** `graph/db.ts`'s
`identifier_fts` DDL tokenizer is
`"unicode61 separators '.-_/()[]{}<>:;,=+*&|!?'"` — `.` is explicitly a
separator, so a stored value like `"... Bar.close"` tokenizes into two
POSITION-ADJACENT tokens (`bar`, `close`), which is exactly what
`searchIdentifiers`'s phrase-quoted `MATCH '"Bar.close"'` requires. Proven at
the real-pipeline level (`search/__tests__/fts-query.test.ts`, new describe
block `searchIdentifiers — qualified compounds (F5)`, 2 tests) rather than
asserted from documentation:
- **Positive match, two independent chunks.** A `UserRepository` class in one
  file (declaration) and an `AuthService` calling `this.repo.findByEmail()` in
  another (field-typed mention) — `searchIdentifiers(db, 'UserRepository.findByEmail')`
  returns chunk ids resolving to BOTH the declaration chunk and the calling
  chunk.
- **Cross-class precision, adversarial single-chunk fixture.** One chunk
  (`Caller.run`) is engineered to contain the qualified compound `Bar.close`
  (a real resolved call) AND the unrelated bare token `Foo` (an unused
  constructor-param-property annotation) in the SAME row, with `Foo` and
  `close` deliberately non-adjacent in the bare bag (three unrelated tokens —
  `this`/`void`/etc. — sit between them in dedup-insertion order).
  `searchIdentifiers(db, 'Foo.close')` returns `[]` (no false adjacency);
  `searchIdentifiers(db, 'Bar.close')` returns that same chunk. This is the
  concrete case the F5 mandate flagged as a theoretical risk ("bag-order
  dedup makes it rare") — demonstrated rare here by construction, not merely
  asserted.

**Tool-level test — which fixture shape lands in `potential_matches`, and
why.** `mcp/tools/__tests__/tools.test.ts`, new describe block `mast_callers —
potential set for methods (F5)`, isolated fixture (own `tmpDir`/`db`, same
pattern as the existing "F2 — file_busy_returning_stale_cache" block): a
`target.ts` declaring `class Repo { findById(): void {} }` and a `caller.ts`
importing `Repo` from `'unresolvable-external-package'` (a specifier that
never resolves) and calling `this.repo.findById()` from a `field_type`
constructor-param-property binding. Two assertions:
1. `verified_callers` does NOT contain `Service.check` — the import's
   `resolvedPath` is `null`, so `resolveQualifiedNameScoped` returns `null`
   with no fallback and `insertEdges` drops the edge (proven, not assumed —
   this is the shape #2 above describes).
2. `potential_matches` IS non-empty and contains `{ file_path: 'caller.ts',
   context: 'Service.check' }` — the qualified compound
   `identifier_fts` row heals exactly the gap the first assertion proves
   exists.

This shape was chosen over a genuinely-unresolvable-receiver shape (e.g. a DI
lookup) specifically because #3 above proves those NEVER produce a qualified
compound at all — they would leave `potential_matches` empty for the qualified
query, which would not exercise F5's fix (it would only re-prove the
already-documented, unhealed residual gap).

**Schema bump.** `store/config.ts`'s `CURRENT_SCHEMA_VERSION` bumped `1.2.0` →
`1.3.0`, with a WHY-comment: this is a CONTENT-format change to an
already-existing `identifier_fts` column (no new column, so a naive
schema-diff would miss it) — an old index's identifier rows lack the qualified
compounds, so a qualified-name query against un-reindexed state would silently
regress to empty, exactly the "confidently wrong, not erroring" hazard §7.4's
migration guard exists to prevent. Verified `mcp/startup.ts` needs no code
change — it keys off the `CURRENT_SCHEMA_VERSION` constant, confirmed by
grepping for direct version-string literals (none found outside the constant
and its doc references) and by `mcp/__tests__/startup.test.ts`'s existing
schema-mismatch coverage passing unmodified. The Docker seed (§7.4) picks up
the new format automatically on its next build/reindex — no seed data exists
to migrate under the never-shipped constraint.

**Red-first evidence.** Three new test files/blocks written against the
unfixed code and run via `pnpm exec vitest run` before any production change:
`src/ast/extractors/__tests__/qualified-identifiers.test.ts` (new file, 4
tests), the new `searchIdentifiers — qualified compounds (F5)` block in
`fts-query.test.ts` (2 tests), and the new `mast_callers — potential set for
methods (F5)` block in `tools.test.ts` (2 tests). First run: **6 failed / 2
passed** across the 8 new tests (109 total in the three touched files after
the additions) — all 6 failures were assertion-level (`expected [...] to
include '...'`, `expected false to be true`, `expected 0 to be greater than
0`), proving each exercises real, then-missing behaviour rather than a broken
import or setup error. The 2 tests that passed "for free" — the DI-style
unresolvable-receiver pure-layer test, and the tool-level "verified_callers
does NOT contain the caller" test — confirmed the negative-space assertions
(no compound for an unresolvable receiver; the edge really is dropped at
`insertEdges`) already held true before any F5 code existed, isolating the red
failures to exactly the intended fix surface.
Implementing `appendQualifiedCompounds` and the `qualifiedMentionsByFromName`
grouping in `TypeScriptExtractor.extract()` turned all 6 red assertions green
with zero regressions elsewhere; one test assertion (the DI-unresolvable pure
test) needed a follow-up correction — it initially failed AFTER the fix
because it hadn't accounted for the chunk's own declaration-self-discoverable
compound (`Bootstrap.start`) always being present, conflating "no compound
from the unresolvable call" with "no compound at all" — corrected to exclude
the chunk's own name before asserting.

**Verification** (from `packages/mast`): `pnpm test` — **546/546 passed, 38
files** (baseline 538/37; +8 net new tests — 4 pure-layer + 2 FTS-integration +
2 tool-level). `pnpm typecheck` — clean. `pnpm lint` — clean. Repo-root
`pnpm align:check` — `baselined debt: 324 -> 324 (0)`, red only on the 2
pre-existing non-mast violations (`application/ui/src/views/root-layout.tsx`
import cycle; `application/api/src/domain/spec/fold-build-record-repository.ts`
domain→db import) — unchanged from F3/F4's verification, confirming F5
introduced no new architecture drift.

**Deviations**: none from the mandated design — no changes to `fused.ts`,
`declex.ts`, `eval/`, `vitest.config.ts` exclusions, or
`searchIdentifierNearMiss` semantics; `collectPotentialMatchCandidates` and the
tools were untouched except doc comments. **Noticed but not done**: F10
(`potential_truncated`) remains unimplemented, unchanged from F3/F4's note —
out of scope for this task. Also noticed but out of scope: the
`extractEdges`-derived compound grouping only covers `TypeScriptExtractor`
(the only extractor that emits `POTENTIAL_CALL` edges); `MarkdownExtractor`
correctly contributes no identifier rows at all, so this is not a gap, just
worth naming as a boundary. No corpus-level before/after `potential_matches`
count was measured against a real external corpus — same E2 scope boundary
F3/F4 recorded; this task's evidence is unit/integration-level, proving the
mechanism works, not corpus-scale recall improvement.

### F10 result (2026-08-09) — potential_truncated shipped

**The defect.** `collectPotentialMatchCandidates` (`search/potential-matches.ts`)
fetched `identifier_fts` hits with `limit = 50` and nothing surfaced that the cap
was hit — `eval/GITNEXUS_COMPARISON.md` M4: the `isUndefined` query reported 50
candidates when the real `identifier_fts` match count was 71, silently dropping 21
candidates and invalidating a recall claim built on the output. `CallersResponse`/
`RenameImpactResponse` had no truncation field. MAST_SPEC.md §9.0's Confidence
signals (C1) table had already reserved the vocabulary — `potential_truncated` —
against exactly this task (F5's result, above, and C1's result both name it as
deliberately out of scope).

**Design: count-only-when-full, share the match-expression construction.**
`fts.ts` gained `countIdentifierMatches(db, symbolName)` — same phrase-quoted FTS5
MATCH expression as `searchIdentifiers`, `count(*)`, no `LIMIT` — built via a new
private `buildIdentifierMatchExpr` helper both functions call, so the two can never
disagree about which rows count as a match (duplicating the quoting logic was
rejected: a drift between the two would make the "real count" lie in the opposite
direction of the original bug). `collectPotentialMatchCandidates` now runs
`countIdentifierMatches` ONLY when the capped fetch came back full
(`identRows.length === limit`) — under the cap, the fetch count already IS the real
count, and the extra query would be pure waste on the overwhelming majority of
calls (most symbols have far fewer than 50 identifier mentions). The function's
return type changed from `PotentialMatchCandidate[]` to
`{ candidates, truncatedMatchCount? }` — `truncatedMatchCount` is set only when the
fetch was full AND the real count exceeds `limit` (an exactly-full fetch with no
more real matches is not truncation). `collectPotentialMatches` passes the field
through unchanged to its own `PotentialMatchesResult`; `mast_callers`/
`mast_rename_impact` surface it as `summary.potential_truncated` (omitted-when-false,
same convention as `file_busy_returning_stale_cache`/`index_empty`).

**Raw-truncation vs. filtering — the precision the task brief called out
explicitly.** `potential_truncated` is computed at the RAW `identifier_fts` fetch,
before verified-overlap exclusion and checker-verdict filtering (both of which run
afterward, inside `collectPotentialMatches`/the tool handlers). So
`potential_matches`/`summary.potential_count` can still be smaller than the fetch
cap even when `potential_truncated` is present — that is filtering doing its job
(already visible via `checker_classified_non_call_site`/
`checker_classified_different_declaration`), not evidence the truncation signal is
wrong. Documented in the TSDoc on `CallersResponse.summary.potential_truncated`
(`ast/types.ts`), in `PotentialMatchCandidatesResult.truncatedMatchCount`'s TSDoc, and
in MAST_SPEC.md's C1 table row and §9 `mast_callers` prose.

**Checker pass consumes the collector unchanged.** `graph/checker-resolver.ts`'s
Phase A calls `collectPotentialMatchCandidates` for every indexed symbol and only
ever used the candidates array, never a truncation count — its call site needed
exactly the one-line destructuring touch the task brief anticipated
(`const candidates = await ...` → `const { candidates } = await ...`), with a
WHY-comment noting Phase A has no summary surface to carry the field to and
deliberately ignores it. `checker-resolver.test.ts`'s existing 16 tests pass
unchanged, confirming Phase A's classification semantics were not touched.

**Test budget call (§5.5).** The positive (cap-hit) case is covered at the collector
layer with an injected `limit = 5` against 7 real matching chunks
(`search/__tests__/potential-matches.test.ts`, new file, 3 tests: capped +
truncation-count-reported; under-cap + no signal; zero-match + no signal) — the
single shared definition every consumer (`mast_callers`, `mast_rename_impact`, the
checker pass) goes through. A production-cap-exceeded (51+ mention chunks) fixture
at the tool layer was judged disproportionate for one field's coverage: `tools.test.ts`
gets one negative test instead (`add`'s potential set, nowhere near the cap ⇒
`summary` must NOT carry `potential_truncated`) plus a comment stating the budget
call explicitly, per the task brief's own guidance. `fts.ts`'s new
`countIdentifierMatches` also got 2 direct unit tests in `fts-query.test.ts` (uncapped
count for a real identifier; 0 for an empty/unmatched term) — the natural home for a
new exported function in the file that already tests its sibling `searchIdentifiers`.

**Red-first evidence.** All 5 new positive/shape-asserting tests were written and run
against the unfixed code first (`pnpm exec vitest run` on the two touched test
files). Result: **5 failed / 8 passed** (13 total across the two files) — the 5
failures were `TypeError: countIdentifierMatches is not a function` (2, proving the
export didn't exist yet) and `AssertionError: Target cannot be null or undefined`
(3, `result.candidates` on what was then a bare array — proving the collector's
return shape hadn't changed yet), all assertion/type-level failures, not import or
syntax breaks. The tool-layer negative test (`tools.test.ts`) was NOT expected to be
red — it asserts the ABSENCE of a property that also doesn't exist pre-fix, so it
passes trivially both before and after; it is a regression guard, not evidence of
the fix, and is called out as such rather than mis-described as a red test.
Implementing `buildIdentifierMatchExpr`/`countIdentifierMatches` (`fts.ts`) and the
`{ candidates, truncatedMatchCount? }` return shape + count-only-when-full gating
(`potential-matches.ts`) turned all 5 green with no regressions elsewhere.

**Verification** (from `packages/mast`): `pnpm test` — **552/552 passed, 39 files**
(baseline 546/38; +6 net new tests — 3 collector-level + 2 `countIdentifierMatches`
unit tests + 1 tool-level negative test; +1 file — the new
`potential-matches.test.ts`). `pnpm typecheck` — clean. `pnpm lint` — clean.
Repo-root `pnpm align:check` — `baselined debt: 324 -> 324 (0)`, red only on the 2
pre-existing non-mast violations (`application/ui/src/views/root-layout.tsx` import
cycle; `application/api/src/domain/spec/fold-build-record-repository.ts` domain→db
import) — unchanged from F5's verification, confirming F10 introduced no new
architecture drift.

**Deviations**: none from the mandated design — the 50 cap itself was not changed
or made configurable; `fused.ts`, `declex.ts`, `eval/`, `vitest.config.ts`
exclusions, and `checker-resolver.ts`'s Phase A classification semantics are
untouched (only the one destructuring touch its collector call site needed).
**Noticed but not done**: no corpus-level measurement of how often the 50-entry cap
is actually hit in a real external corpus — same E2 scope boundary F3/F4/F5
recorded; this task's evidence is unit/integration-level, proving the signal fires
correctly on a controlled fixture, not how often it fires in practice.

---

## Stage 4.7 — the mis-cased import, closed at the resolver (2026-08-19)

**Status**: Complete. Ledger row **D023** (S0, `measured`).

`FINDINGS.md` §2.3 had carried a named residual risk since the D004 range-query fix: on a
case-insensitive filesystem a mis-cased import resolves, `statSync` cannot report that the match was
inexact, and the resolver returns the *specifier's* casing while the walker records the *on-disk*
casing. The registered plan was a case-folded lookup on the resolution-miss path. It was not built,
for two reasons found while building it.

**1. The site count was wrong.** The risk was written as if one join consumed `resolvedPath`. Four
sites consume it. Three are joins against `files.path` that match nothing when the casing disagrees —
`resolveInFileOrReExportChain` (`populate.ts:1105`), `insertReExportFiles` (`populate.ts:1240`), and
`resolveTypeContext` (`queries.ts:486`). The fourth, `queryDependencies` (`queries.ts:334`, the
`mast_dependencies` tool), does not join at all: it hands `resolved_path` back to the caller, so a
mis-cased import made it emit a path that matches no indexed file — wrong output rather than absent
output. Two of the four run at *query* time and have no populate-side file map to fold against, so the
registered mechanism could not have covered them. Fixing some of four is S-05's "fixed one arm" in a
package whose severity zero is a silently incomplete answer.

**2. A cheaper mechanism exists, and it cannot guess.** `realpathSync.native` calls the platform
`realpath(3)`, which reports the name as spelled on disk; the JS `realpathSync` echoes the casing it
was handed. Measured directly:

```
statSync isFile      : true
realpathSync         : .../src/utils/foo.ts      <- specifier casing
realpathSync.native  : .../src/Utils/Foo.ts      <- on-disk casing
```

`safeRealpath` already existed, already sat on the path of every resolution, and already had to
resolve symlinks. Switching its implementation corrects the casing *before* `imports.resolved_path`
is written, so all four consumers are right by construction and no consumer needs a guard. That the
fourth was found only by enumerating every read of `resolved_path` — after the write-up already
asserted "three" — is itself the argument for fixing at the source: a per-site guard is only ever as
complete as the site list, and this site list was wrong twice.

It also retires the ambiguity the registered design carried. A case-folded map must choose when
`Foo.ts` and `foo.ts` both exist — a guess, and D004 exactly. Asking the OS never chooses: on a
case-insensitive filesystem the two files cannot coexist, and on a case-sensitive one `statSync`
already matched the literal name, so at most one candidate is ever in play.

**Reported, not silently corrected.** A mis-cased import is a defect in the *indexed repository* —
it fails to compile on Linux — so the run counts them and names them:
`IndexResult.miscasedImports` (count plus up to 20 samples), a stderr warning from `mast index`, and
`miscased_imports` on the MCP `mast_reindex` wire. Detection costs no extra syscall: the specifier's
own spelling is compared against the canonical one, and a difference of *more than* case is a symlink
collapse and is not reported. The stated price of that shortcut is that a mis-casing reached through
a symlinked directory resolves correctly but goes unnamed.

**Pins.** 6 resolver tests and one end-to-end test that indexes `src/Handler.ts`, imports it as
`./handler`, and asserts `verified_callers` is non-empty. **5 fail under the one-word mutation**
(`.native` removed), which was run and recorded rather than assumed.

**The coverage limit, stated plainly.** CI is ubuntu/ext4, where a mis-cased import does not resolve
at all. Every one of these tests branches on a runtime probe of the filesystem's case sensitivity, so
on CI they assert the complementary branch (no resolution, no edge — the correct answer there) and
the canonicalising path is exercised only on case-insensitive developer machines. There is no way to
close that from a Linux runner without a disk image, and it is recorded rather than papered over.

Suite **1,108 passing** across 71 files (was 1,097 / 70). `pnpm typecheck` — both halves — clean,
`pnpm lint` clean, `pnpm build` emits. `pnpm align:check` remains red at its pre-existing baseline,
**unchanged: 324 → 324 (0)**.
