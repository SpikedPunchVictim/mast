# CLAUDE.md

This file is the operating manual for Claude in this repository. Read it fully before
responding to any request. The rules below are non-negotiable and override default
behaviour, conversational shortcuts, or pattern-matched assumptions.

MAST was developed inside the `kluster` monorepo and split out on 2026-08-19. This file
merges what were two documents there — kluster's `.claude/CLAUDE.md` (§1–§11, of which the
Fastify conventions, the `packages/kluster-bt` rules and the `/propose` `/dispatch`
`/review` agent framework did not travel) and `packages/mast/CLAUDE.md` (the defect-ledger
manual, now the last section here). Both were loaded together when working in
`packages/mast`, so nothing that governed this code has been dropped except what named
kluster packages that no longer exist alongside it. See `docs/provenance/`.

---

# Instructions

## Decisions live in `adr/`

Every architectural and empirical decision is recorded as an ADR: `adr/NNN-YYYY-MM-DD-<feature>.md`,
with supporting material under `adr/proposals/<feature>/`. **Start at `adr/README.md`** — it carries
the index and a reading order, which is not the numeric order. `adr/010-2026-08-11-empirical-method.md`
governs all empirical work and is the one to read first.

`IMPLEMENTATION_PLAN.md` is **no longer the plan** — it is a routing stub mapping every heading of
the former 11,459-line document to its shard. Do not append to it. New work appends to the relevant
ADR, or opens a new one (next number, today's date).

## Empirical work in this repo — the findings index

`FINDINGS.md` is the consolidated index of every settled empirical claim, every refuted
hypothesis, and every measurement that is recorded in a committed journal but read by no
scorer. It is derived from the `adr/proposals/*/PLAN-EXCERPT.md` shards and the
`eval/results/` artifacts, and it is maintained in place.

* **Before writing any pre-registration, you MUST read `FINDINGS.md` §1 (unread data) and
  §3 (dead hypotheses), and state in the registration what you checked and what you
  found.** A registration that does not do this is incomplete.
* **When a RESULT block lands in a `PLAN-EXCERPT.md` shard, update `FINDINGS.md` in the same
  commit.** Headline verdict to §2; any refuted hypothesis to §3, with the number that
  killed it.
* When a new journal is committed, re-run the §1 diff — enumerate the keys in every
  `eval/results/*-runs.jsonl`, grep the scorers for each — and update the register of
  unread data.
* The `PLAN-EXCERPT.md` shards remain authoritative and append-only. `FINDINGS.md` is a
  derived index and is edited in place. If the two disagree, the shards and the scored
  artifacts win.
* **Eval scripts stay in `eval/`.** They are not moved into proposal directories — see ADR 001.
  Each decision's instruments are listed in `adr/proposals/<feature>/EVAL.md`.

This rule exists because E1-EDGES was registered and then retired the same day, before any
measurement, once it emerged that E1-AB had already answered the question on the same
corpus with a stronger arm — and its data had been sitting committed and unread for four
days.

## Before re-running anything under `eval/`

Most scripts in `eval/` write into `eval/results/`, which holds committed, published
artifacts. Never decide by grep whether one is safe to re-run — that is D025. Ask the tool:

```
node eval/results-writers.mjs [script...]
```

## Using mast on this codebase

- Call `mast_status` at session start to confirm the index is fresh.
- Search before opening any file. No file path without a mast result.
- Use code tokens in queries — function names, type names, column names.
  `createTable uuid primaryKey` beats "migration pattern". An exact symbol name in the
  query anchors its declaration to the top (ranker D).
- Pick the right tool:
    `mast_search`           lexical BM25 + declaration-exact discovery
    `mast_signature`        symbol declaration + resolved parameter types
    `mast_callers`          who calls a function (before any refactor)
    `mast_implementors`     which classes implement an interface
    `mast_exports`          a module's public API without reading the file
    `mast_project_skeleton` directory map of all exported symbols
    `mast_rename_impact`    rename checklist: verified callers + review sites + barrel exports
- Call `mast_reindex` after writing files to keep the index current.
- When a query returns nothing, change vocabulary — don't repeat it.

---

## 1. Operating Principles

These principles are absolute. If a request appears to conflict with them, surface the conflict explicitly before acting.

1. **Rigour over speed.** Producing code that compiles is not the goal. Producing code that is correct, tested, and justified is the goal.
2. **No silent assumptions.** When a requirement is ambiguous, stop and ask. Do not invent intent, do not guess at types, do not assume a library's behaviour.
3. **No fabrication.** Do not invent APIs, functions, type signatures, package names, or behaviour. If you are not certain something exists, verify it (see §6 Research Protocol) or refuse to claim it.
4. **Tests come first.** No production code is written without a failing test that justifies it (see §5 TDD).
5. **Program against contracts.** Depend on interfaces, not implementations. Construct concretes at the boundary; consume abstractions everywhere else (see §4).
6. **Every block of code earns its place.** If you cannot articulate *why* a block exists, it does not belong in the codebase (see §7 Comments).
7. **Best practices are not aspirational.** They are the floor, not the ceiling. Deviation requires an explicit, written justification.

---

## 2. Stack & Tooling

This is a TypeScript project managed with pnpm. The following are mandatory unless explicitly overridden in writing:

- **Language:** TypeScript with `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `exactOptionalPropertyTypes: true`.
- **Module system:** ESM (`"module": "NodeNext"` or equivalent). No CommonJS in new code.
- **Runtime:** Node.js LTS. Pin the version in `.nvmrc` or `package.json#engines`.
- **Package manager:** **pnpm**, exclusively. Do not run `npm install` or `yarn add`. Use `pnpm add` and `pnpm add -D`. The lockfile is `pnpm-lock.yaml` and is always committed.
- **Linter:** ESLint with `@typescript-eslint` recommended-type-checked ruleset.
- **Formatter:** Prettier. Never hand-format what the formatter owns.
- **Test runner:** **Vitest**, configured in `vitest.config.ts`. Run it with `pnpm test`. Do not add `jest` or `node:test`-based suites.

When you encounter an unfamiliar tool or framework already in the project, treat it with suspicion until you have read its documentation (see §6).

## 3. TypeScript Standards

The following are not stylistic preferences. They are correctness requirements.

### 3.1 Type discipline

- **No `any`.** Ever. If you genuinely need an escape hatch, use `unknown` and narrow it. If you reach for `any`, stop and ask why the type system is failing you.
- **No `as` casts** unless narrowing from `unknown` after a runtime check, or asserting a brand on a validated value. Never use `as` to silence a compiler error.
- **No non-null assertions (`!`)** outside of test code where the invariant is obvious from setup.
- **Prefer `readonly`** for arrays, object properties, and tuples that are not mutated.
- **Prefer `type`** for unions and aliases; **prefer `interface`** for object shapes that may be extended or implemented (see §4).
- **Discriminated unions** over optional fields when modelling state with multiple shapes.
- **Branded types** for primitives that carry domain meaning (e.g. `UserId`, `Email`).

### 3.2 Boundaries

- **Validate at the edge.** Any data crossing a trust boundary (HTTP request, file system, database, environment variables, third-party API) must be parsed and validated with `zod`, `valibot`, or an equivalent schema library. Inside the boundary, types are trusted.
- **Errors are values where it matters.** For domain logic with predictable failure modes, return a `Result<T, E>`-style discriminated union rather than throwing. Reserve thrown exceptions for genuinely exceptional conditions.
- **No floating promises.** Every promise is awaited, returned, or explicitly handled with `.catch`. Enable `@typescript-eslint/no-floating-promises`.

### 3.3 Structure

- Functions do one thing. If you find yourself writing "and" in the function name or its description, split it.
- Public exports are minimal. Anything not exported cannot be misused.
- File names match exports. Side-effectful modules (those that *do* something on import) are flagged in a comment at the top.

---

## 4. Programming Against Contracts

Code depends on abstractions, not concretions. Where multiple implementations exist or could exist, the contract — an `interface` or abstract class — is defined first; implementations come second. This is the line between code that is testable and replaceable, and code that is not.

### 4.1 When to reach for OOP

Classes and interfaces earn their place when:

- There are (or plausibly will be) **multiple implementations** of the same behaviour — different storage backends, transport mechanisms, notification channels, LLM providers.
- A component holds **non-trivial state with a lifecycle** — connections, sessions, in-flight work, caches that must be invalidated.
- A boundary needs to be **mocked or replaced in tests** without monkey-patching modules.
- A subsystem exposes a **plugin or extension point** for callers to implement.

### 4.2 When NOT to reach for OOP

- A pure function does not need a class. `formatCurrency(amount, locale)` is a function.
- A single-implementation utility does not need an interface. Premature abstraction is as expensive as no abstraction.
- Anaemic classes (a constructor and a few getters) are data, not behaviour. Use a `type` or `interface` for the shape.
- Inheritance hierarchies are a last resort. Prefer composition; reach for `extends` only when the "is-a" relationship is strict and stable.

### 4.3 Interface design

- **Define interfaces from the consumer's perspective.** The shape is dictated by what callers need, not by what the implementer happens to have.
- **Interface Segregation.** A consumer that only needs `findById` must not be coupled to an interface that also has `delete`, `bulkInsert`, and `migrate`. Split fat interfaces into role interfaces.
- **Methods name intent, not mechanism.** `notify(user, event)` over `sendEmail(user, subject, body)`. The mechanism is an implementation detail of the implementer.
- **Document the contract, not the implementation.** TSDoc on the interface specifies the invariants every implementer must uphold: what is guaranteed, what may throw, what is idempotent, what is ordered.
- **Errors are part of the contract.** Document them in the interface — what failure modes can occur, and whether they are returned as `Result` values or thrown.

### 4.4 Dependency injection

- Constructors take dependencies typed as **interfaces**, never as concrete classes.
- No `new ConcreteThing()` inside business logic. Construction happens at the **composition root** — `main.ts`, plugin registration, or a DI container — at the application boundary.
- Tests construct the unit under test with **fake or stub implementations** of its interfaces. If you find yourself reaching for `vi.mock` to replace a module, the dependency was not injected — fix the design.

### 4.5 Example pattern

```ts
// Contract — defined first, owned by the consumer.
export interface UserRepository {
  /** Returns null if no user with this id exists. Never throws on missing. */
  findById(id: UserId): Promise<User | null>;
  /** @throws DuplicateEmailError if the email is already in use. */
  create(input: NewUser): Promise<User>;
}

// Consumer depends on the interface, not the implementation.
export class RegistrationService {
  constructor(private readonly users: UserRepository) {}
  // ...
}

// Implementation lives elsewhere and is wired at the composition root.
export class PostgresUserRepository implements UserRepository { /* ... */ }
```

The `RegistrationService` knows nothing about Postgres, and is testable with an in-memory `UserRepository` whose construction takes a single line.

---

## 5. Test-Driven Development

TDD is the workflow, not a phase that happens after coding. The cycle is **Red → Green → Refactor**, and it is followed for every behavioural change.

### 5.1 The cycle

1. **Red.** Write the smallest failing test that expresses the next increment of behaviour. Run it. Confirm it fails for the *right reason* (assertion failure, not a syntax error or missing import).
2. **Green.** Write the minimum production code required to make the test pass. Resist the urge to add anything not demanded by a test. Run the full test suite.
3. **Refactor.** With tests passing, improve the code's structure, names, and clarity. Run tests after each refactor step. Do not change behaviour during refactor.

Each step is a discrete commit-worthy moment. When working on a non-trivial feature, narrate which phase you are in.

### 5.2 What gets a test

- All public functions and exported modules.
- All branches of conditional logic, including error paths.
- All bug fixes — write the failing test that reproduces the bug *before* fixing it. The test is the proof the bug existed.
- All boundary conditions: empty inputs, single-element inputs, maximum sizes, nulls, unicode edge cases, timezone edges where dates are involved.

### 5.3 What good tests look like

- **Behaviour, not implementation.** Tests describe what the unit does, not how. A refactor that preserves behaviour must not break tests.
- **Arrange–Act–Assert** structure, with whitespace separating the three.
- **One logical assertion per test.** Multiple `expect` calls are fine if they all verify one behaviour; do not bundle unrelated assertions.
- **Deterministic.** No real network, no real clock (`vi.useFakeTimers` / equivalent), no real randomness. Inject these as dependencies (see §4.4).
- **Named for behaviour.** `it("returns null when the user has no active subscription")`, not `it("test1")` or `it("works")`.
- **Fakes over mocks.** Where an interface has a hand-rolled in-memory implementation, prefer it to a mock. Fakes verify the contract; mocks verify the call.

### 5.4 Coverage

Coverage percentage is a lagging indicator, not a goal. The goal is that every behaviour is verified by a test that would fail if the behaviour broke. Mutation testing (e.g. `stryker`) is the honest measure; aim to introduce it once the suite is stable.

### 5.4a Layer-aware TDD and the "no new test" criterion

TDD (§5.1) and the test budget (§5.5) appear to be in tension: TDD says
every behavioural change starts with a failing test; the budget says don't
duplicate coverage across layers. They reconcile cleanly: **the failing test
exists at the layer where it naturally lives**, per §5.5. It is not skipped;
it is not duplicated; it is placed.

A change is allowed to ship without adding a **new** test only when one of
the following is true and explicitly documented in the plan:

1. **An existing test already covers the regression class.** The test is
   named (file + test name) and would fail if the new behaviour broke. The
   plan cites it; a reviewer verifies the citation holds.
2. **The protection is structural.** A TypeScript type, Zod schema, or
   runtime validator makes the regression impossible to introduce without
   a compile or schema error. The structural mechanism is named.

Anything else requires a new test. **Silently omitting a test on the
assumption that coverage exists elsewhere is forbidden** — the assumption
must be named and verifiable.

This is constitutionally binding (see Principle IV).

### 5.5 Test budget per layer

> Written for a Fastify/Postgres service, and kept because the *shape* transfers even
> though the layers do not: mast has no routes, no repositories and no database of its
> own beyond the index it builds. Read "repository integration test" as "a test against a
> real SQLite graph", "route test" as "an MCP tool-handler test", and apply the principle —
> each behaviour verified once, at the layer where it naturally lives.

Tests are an asset and a liability. Duplicative tests slow CI, slow refactors, and produce false confidence. Every layer of the stack has a natural place where a behaviour is best verified — write the test there, and trust the layer above. The shape that scales:

- **Pure functions / type-level invariants.** Cheap, fast, high signal — write freely. Most behavioural correctness lives here.
- **Repository integration tests (real Postgres).** One test per UNIQUE / CHECK constraint, ordering invariant, and concurrency race. Skip per-method happy-path tests when the SQL is trivial — the constraint test already proves the row was inserted correctly.
- **Service unit tests with fakes.** Cover branching logic, error paths, idempotency, AbortSignal pre-flight. This is where most service-level coverage belongs.
- **Service integration tests against DB.** One per state machine, one per cross-service cascade. Skip when a service unit test + a repo integration test already cover the path.
- **Route integration tests.** One happy-path + one assertion per documented 4xx, in a single file per route family. Permission/role-gate coverage lives in a single matrix test (see 5.6 below), not duplicated per route.
- **End-to-end tests.** One per critical user flow — happy path, primary failure mode, primary recovery path. Aim for 3–5 e2e tests per phase, not one per acceptance criterion. e2es are expensive to write and run; reserve them for catching wiring failures across the stack.
- **Cross-cutting matrix / AST tests.** One file, N assertions, automatic coverage as new code ships. Use these for closed-union enforcement, "no forbidden import" guarantees, and "every state-changing route writes one audit row" — they replace dozens of per-call-site duplicates.

When a phase's plan is sized, the tech-lead applies this budget. A reviewer challenging "is this test pulling its weight?" is doing the suite a favour.

### 5.6 Test anti-patterns

These patterns appeared during early phases and are now actively avoided:

- **Per-route 403 tests when an iterating matrix already covers it.** Once `permissions-403-every-state-change.test.ts` (or its equivalent) iterates every state-changing route and asserts the documented permission gate, individual per-route 403 tests are redundant. Add the route to the matrix, not a new file.
- **Mid-flight AbortSignal tests against Kysely / pg.** The pg dialect does not propagate `AbortSignal` to in-flight queries, so any "abort fires mid-tx" assertion is a race that proves little. Pre-aborted-signal coverage is the real contract.
- **One integration test file per HTTP error code.** A single integration suite per service with a `describe.each` over `(input → expected status, code)` rows compresses ten files into one and stays just as readable.
- **e2e-per-acceptance-criterion.** Each AC gets a unit/integration test at its natural layer. e2e tests verify the wired stack, not individual ACs — fold related ACs into one e2e per critical flow.
- **Per-method repo "happy path" tests for trivial SQL.** A `findById` that issues `SELECT * WHERE id = $1` is verified by any other test that round-trips through the repo. Reserve repo tests for the constraints, ordering invariants, and races the repo enforces.
- **"Emits exactly one audit row" duplicated per emit site.** A closed-union AST test plus one assertion at the service layer covers it. Per-route audit assertions add boilerplate, not coverage.
- **Plugin-order assertions per plugin.** One plugin-order test per phase asserting the registered chain is enough; skip per-plugin variants.
- **Asserting on log lines.** Logs are operational signal, not API contract. Tests that grep for log strings break under benign refactors and offer no real coverage.

When in doubt, ask: *would this test fail if a real bug were introduced, in a way no other test would catch?* If not, it doesn't belong.

---

## 6. Research Protocol

Before using any library, framework, API, or pattern that is not already established in this codebase — or that you are not certain is current — you must research it. This applies even when you "remember" how it works; library APIs change, and your memory is not a primary source.

### 6.1 When to research

- Adopting a new dependency.
- Using an API you have not used in this codebase before.
- A library has had a major version bump since you last used it.
- The user references a tool, technique, or product that you do not have direct, recent knowledge of.
- Anything where being wrong would cost real time to debug.

### 6.2 The protocol

1. **State what you need to know.** Write a one-line research question: *"What is the correct way to configure Vitest's coverage reporter for an ESM monorepo as of [current version]?"*
2. **Identify primary sources.** Official documentation first, then the project's GitHub (README, CHANGELOG, recent issues), then the source code. **Use the context7 MCP server as the canonical retrieval mechanism for library and API documentation** (per the Instructions block) — it ensures version-matched, citation-friendly results. Blog posts and Stack Overflow are tertiary and frequently stale.
3. **Verify version.** Check the installed version in `package.json` / `pnpm-lock.yaml`. Match documentation to that version. Behaviour from a different major version is not evidence.
4. **Read, do not skim.** If the answer hinges on a config flag's behaviour, read the flag's documentation in full, not the summary.
5. **Record the finding.** Inline in the response or in a code comment, cite the source: *"Per Vitest docs v1.6 (link), `coverage.provider: 'v8'` is required for native ESM."* This makes the reasoning auditable and the assumption falsifiable.
6. **State uncertainty plainly.** If after research you are still unsure, say so. Do not paper over a gap with confident-sounding prose.

### 6.3 What this is not

This is not "do a search and paste the first result." It is the disciplined construction of a justified belief about how a tool actually behaves in the version this project is using.

---

## 7. Comments: Why, Not What

Code shows *what* it does. Comments exist to explain *why* it does it that way.

### 7.1 Comments that earn their place

- **Why this approach over the obvious alternative.** *"Using a Map here instead of a plain object because keys may be arbitrary user-supplied strings, including `__proto__`."*
- **Why a constraint exists.** *"Capped at 100 because the upstream API rate-limits at 120/min and we share the budget with the sync job."*
- **Why something looks wrong but is correct.** *"This loop intentionally mutates `acc` for performance; the function is internal and the mutation does not escape."*
- **Why we accepted a tradeoff.** *"Polling rather than webhooks because the third-party does not guarantee delivery; revisit when they ship the v2 events API."*
- **Why a workaround exists, with an exit condition.** *"Workaround for nodejs/node#12345 — remove once we drop Node 18 support."*

### 7.2 Comments that do not

- Restating the code: `// increment counter` above `counter++`.
- Describing what a well-named function does (rename the function instead).
- Commented-out code (delete it; git remembers).
- Tutorial-style explanations of language features.

### 7.3 Form

- Use TSDoc (`/** ... */`) for public exports and on every interface (see §4.3). Document parameters, return values, thrown errors, and — most importantly — the *contract*: what the caller can rely on.
- Use line comments (`//`) for inline *why*-comments adjacent to the code they explain.
- Reference issues, RFCs, specs, and external docs by URL where relevant. Future readers (including future you) will thank you.

---

## 8. Best Practices

Adhere rigidly. These are not preferences.

### 8.1 Naming

- Names reveal intent. `isEligibleForRefund` over `check`. `pendingInvoices` over `data`.
- Booleans read as predicates: `isX`, `hasX`, `canX`, `shouldX`.
- No abbreviations except the universally understood ones (`id`, `url`, `http`).

### 8.2 Errors

- Throw `Error` subclasses, never strings or plain objects.
- Error messages name the operation that failed and the relevant identifiers, without leaking secrets.
- Catch narrowly. `try` blocks wrap the smallest possible region.
- Never swallow errors. Logging is not handling.

### 8.3 Side effects

- Pure functions wherever possible.
- Side effects (I/O, mutation, randomness, time) are pushed to the edges of the system and injected as dependencies (see §4.4), not imported directly into business logic.
- No top-level side effects in modules.

### 8.4 Concurrency

- `Promise.all` for independent work, sequential `await` for dependent work. Do not serialise what could run in parallel.
- Always consider cancellation. Long-running operations accept an `AbortSignal`.
- Never `await` inside a tight loop when the iterations are independent.

### 8.5 Dependencies

- Every new dependency is a liability. Justify it. Prefer the standard library and existing dependencies.
- Pin exact versions for applications, use ranges for libraries.
- Audit transitive dependencies for the operation you are adding (`pnpm why <pkg>`, `pnpm list <pkg>`).

### 8.6 Git hygiene

- Commits are small and atomic. One logical change per commit.
- Commit messages follow the Conventional Commits spec (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`). The body explains *why*, not *what*.
- Never commit secrets, generated files, or commented-out code.

---

## 9. Workflow Expectations for Claude

1. **Understand.** Restate the task in your own words. Identify ambiguities and ask before proceeding.
2. **Research.** If anything is unfamiliar or version-dependent, complete §6 before writing code.
3. **Design contracts.** For any non-trivial behaviour, define or identify the interfaces involved (§4) before reaching for an implementation.
4. **Plan.** State the files you will change, the tests you will add, and the order. Get confirmation for non-trivial changes.
5. **Test first.** Write the failing test (§5.1).
6. **Implement minimally.** Make the test pass with the smallest viable change.
7. **Refactor.** With green tests, improve the design.
8. **Verify.** Run the full test suite, the linter, and the type-checker. Report the results explicitly.
9. **Document.** Add *why*-comments where the code's intent is non-obvious. Update README/docs if public behaviour changed.
10. **Summarise.** State what changed, what tests cover it, and what was deliberately left out of scope.

If at any step you find the task as specified is impossible, contradicts an existing constraint, or would require violating these rules — stop and say so. Do not produce a half-correct workaround and hope it goes unnoticed.

---

## 10. Definition of Done

A change is done when, and only when, all of the following are true:

- [ ] Tests are written, fail without the change, and pass with it.
- [ ] The full test suite passes.
- [ ] `tsc --noEmit` passes with no errors and no new warnings.
- [ ] The linter passes with no errors and no new warnings.
- [ ] New behaviour is consumed via an interface where §4 applies; no concrete classes leaked into business logic.
- [ ] Every non-obvious decision is justified in a *why*-comment or commit message.
- [ ] No `any`, no unjustified `as`, no `@ts-ignore`, no commented-out code.
- [ ] Public API changes are reflected in TSDoc and any relevant docs.
- [ ] The change has been described in a clear summary, including what was *not* done and why.

If any box is unchecked, the change is not done.

---

## 11. Rigour on load-bearing claims

**Applies to** any artifact someone will act on without re-deriving it: findings, reviews,
measurements, corrections, benchmark results, architecture decisions, migration plans. **Does not
apply** to exploratory work, throwaway analysis, or a first pass you are about to throw away — if
which mode you are in is unclear, say so in one line and continue.

The failure this prevents is not sloppiness, which is easy to spot. It is **plausible work**:
internally consistent, confidently written, correct in the places you checked, and wrong in the two
or three you did not. Plausible work is more dangerous than obviously bad work, because it is
adopted.

### 11.1 Derive, don't recall

- A number you assert must be derived **in this session, from the primary artifact**. Copying a
  figure out of your own earlier message is the most common way an error propagates — **your
  earlier self is not a source.**
- If a number originates in prose (a plan, a comment, a summary, a README), recompute it before
  repeating it. If it does not reproduce, that is a finding. Do not round it into agreement.
- Name the estimator whenever one exists. "Median per rung, OLS over nine points" is a claim that
  can be checked; "the exponent" is not.

### 11.2 Read your own tool output

- Search results are evidence, not a lookup. If a grep prints a file that contradicts the claim you
  are about to write, **that line is the most important thing in the output.** Do not summarise
  past it.
- Before writing "X is unused / unread / uncalled / absent", grep for X and read **every** hit,
  including hits in files you did not expect. Most false negatives of this form are visible in
  output the author already generated.

### 11.3 Ask the completeness question

- "Is X true?" and "what else is like X?" are different questions, and only the second produces a
  complete list. Enumerate the space first, then subtract what you have verified.
- A register of exceptions that is actually a *sample* of exceptions is worse than none — it will
  be read as exhaustive.
- After any list, ask explicitly: what would belong here that I never looked for?

### 11.4 Count precisely

Every count must state what it counts. Lines, records, rows, and *valid* rows are four different
numbers. Cross-check any `n` against an independent source — a scored artifact, a test count, a
second query — before quoting it.

### 11.5 Keep confidence classes separate

Label each claim **measured**, **inferred from code/spec**, or **unmeasured**, and never blur them
inside one sentence. A mechanism measured in one context and asserted in another is *inference*,
however strong the mechanism. Report the classes separately even when they point the same way.

### 11.6 Primary vs supporting figures

When a source defines a primary statistic, quote the primary. Read what the source calls its own
headline before adopting a number from it. Pairing one experiment's primary with another's
supporting output is not a comparison, even when both are correct in isolation.

### 11.7 Verify every citation you write

`file:line`, commit SHAs, section numbers, test names, URLs. Cite it, then open it and confirm it
says what you claim. Citations decay, and a confidently wrong one costs a future reader more than
no citation at all. This applies to citations handed to you by a tool, a subagent, or a reviewer —
**verify borrowed citations before adopting them.**

### 11.8 Switch stance before you finish, not after

The highest-leverage item in this section. Authoring and checking are different jobs, and the
author is the worst available checker, because they check the parts they thought about.

Before committing a load-bearing artifact:

1. **Name the three claims that would be most damaging if wrong.** Usually the ones the artifact's
   authority rests on — not the ones that were hardest to produce.
2. **Attack those three as someone who believes they are false.** Recompute; do not re-read.
3. **Write down what you could not check, and why.** An acknowledged gap is worth more than a
   confident guess, and omitting the gap *is* the error.
4. **Distinguish factual errors from judgment disagreements** in whatever you report.

For anything durable, prefer a **separate adversarial pass** — a subagent given a review brief
works well precisely because it cannot see what you meant, only what you wrote. Brief it to
recompute rather than confirm, to test the list for completeness, to verify cited line numbers,
and to report what it could not check. Run it **before** the commit: a review that arrives after
publication is a correction, not a check.

### 11.9 Budget it deliberately

This section is expensive and is meant to be. Spend it on artifacts that will be trusted without
re-derivation, and say plainly when you are choosing not to — "spot-checked, not exhaustively
verified" is an honest and often correct thing to write. Silence about depth reads as a claim of
depth.

---

# The defect ledger

## What you are maintaining, and why it is not an issue tracker

`docs/defects/` is a record of **how we were wrong**, kept to sharpen the next review rather than to
archive the last one. The issue tracker records work to be done. This records the *shape* of our
mistakes, so that the next review knows what to hunt for.

If it ever becomes a filing cabinet, it has failed. Delete it rather than let it lie by omission — a
ledger nobody updates is worse than none, because it will be read as complete.

Three files:

| File | Role |
|---|---|
| `LEDGER.md` | One row per defect, newest first. The index. |
| `SHAPES.md` | The derived catalogue of recurring failure *shapes*. **The source of every review brief.** |
| `<ID>-<slug>.md` | A detail page, only where one is earned. Most defects are a row and nothing more. |

**The governing principle: tests pin, reading discovers.** Expecting a regression suite to find an
unknown severity-zero is asking a seatbelt to prevent the crash. A test suite is excellent at stopping
a fixed defect from returning and poor at finding a new one — that is what a regression test *is*. So
the leverage is not "write more tests afterwards". It is: make the *discovering* instrument better
each time it is used. That is the whole purpose of this directory.

---

## First run: bootstrap before you file anything

Do these four things once, in order, and show the user the result before continuing.

**1. Define this project's severity zero in one line.** Do not copy someone else's. Derive it from
what this software can do to a user that cannot be undone. Write it at the top of `LEDGER.md`.
Examples of the reasoning, not the answer: a tool that writes into repositories it does not own has a
severity zero of *destroys data and exits 0*; a billing system's is *charges the wrong account and
reconciles clean*; a read-only dashboard may have no S0 at all, and saying so plainly is a real
finding about where the risk actually lives.

Then define the rest by descending consequence, e.g. `S1` wrong result a user would act on, `S2`
misleading output with no data loss, `S3` internal or documentation inaccuracy.

**2. Mine the existing history for reconstructed rows.** A ledger that starts empty gets abandoned,
because its first rows have nothing to compare against. Sweep for defects already known:

- `git log --grep='fix:' --grep='bug' --grep='revert' -i --oneline`
- code comments matching `BUG`, `FIXME`, `HACK`, `XXX`, `FRAGILE`, `WORKAROUND`
- postmortems, incident docs, closed issues labelled bug/regression
- any commit that reverted another

File the best five to fifteen. Mark every one `reconstructed` (see Confidence below). Do not inflate
the count — a small honest ledger beats a padded one.

**3. Sort those rows by discovery instrument and show the user the table.** This is the finding that
motivates the whole exercise, and it is usually uncomfortable. Count how many were found by a human
reading code, by review, by a failing test, by a user report, by production telemetry, by the act of
writing a test. Whatever dominates is where the project's real detection capability lives, and
whatever is near zero is a capability you should stop assuming you have.

**4. Seed `SHAPES.md` from those rows, not from the starter list at the bottom of this document.**
Two rows sharing a shape is enough to name it. The starter shapes are there to show the *form* a
shape takes; a shape your project has never exhibited is noise in a review brief.

---

## When to write a row

**Write one when:**

- you find a defect, of any severity, in existing code — file it *while the reproduction is still in
  front of you*, not after the fix. The fields that matter are the ones you cannot reconstruct later.
- a reviewer, user, or another agent reports one and you confirm it.
- you discover that something believed fixed was not, or was fixed in one arm only.
- you find a comment, doc, or test asserting a property nothing implements. That is a defect.

**Do not write one when:**

- you introduced it and caught it inside the same edit, before it ran. The ledger records what got
  *past* you, not every typo.
- it is a feature request, a refactor you would like, or a known limitation already documented as a
  deliberate trade-off.

**A row with no fix yet is fine and useful. A fix with no row is not** — it loses the only evidence of
how the defect was found, which is the part that transfers.

---

## The nine columns

```
| ID | Date | Sev | Discovery instrument | What was wrong | Shape | Which check should have caught it | Fix + pin | Conf |
```

Three of them carry the value, and they are the three most likely to be filled in lazily.

**Discovery instrument** — *load-bearing.* What actually found it. Never "testing" or "review". Name
the thing: *a human reading code*, *an adversarial review pass*, *the act of writing a test*, *a
user report*, *a production alert*, *an assertion firing in staging*, *measuring a claim while
documenting it*. This column is how the project learns which instruments are worth investing in, and
it only works if the values are specific enough to be counted.

**Shape** — *load-bearing.* The reusable abstraction, referencing a `SHAPES.md` id. If no existing
shape fits, add one. "The retry loop missed the timeout path" is an instance; *a guard placed at a
different granularity than the damage it prevents* is a shape. Only the second transfers to code you
have not looked at yet.

**Which check should have caught it, and did not** — *load-bearing, and the engine of the whole
system.* A ledger of what went wrong is a diary. A ledger of which guard failed to fire is a to-do
list for the guards. Name the specific test, type, lint rule, review step, or monitor that had the
opportunity and missed. Often the honest answer is "nothing" — that is a finding, not a blank. When
one check accumulates misses, that is a *measured* signal to strengthen it rather than a hunch.

The remaining six:

- **ID** — `D001`, `D002`, … monotonic, never reused.
- **Date** — absolute (`2026-08-18`), never "last week".
- **Sev** — from the scale you defined in bootstrap.
- **What was wrong** — the defect and its reproduction. Include the actual observed output: exact
  strings, exit codes, counts. "Reports the wrong total" is unusable a month later; `debt: 2 → 0
  (-2), exit 0, both entries still on disk` is reproducible.
- **Fix + pin** — what changed, and *what now prevents recurrence*. `OPEN` is a valid value. A fix
  with no pin should say so explicitly: "fixed, unpinned — no test covers this path".
- **Conf** — `measured` only if you reproduced it yourself in this session with numbers from a real
  run. Anything reconstructed from a doc comment, a commit message, or a memory is `reconstructed`,
  and its incidental detail must never be quoted as fact later.

---

## Shapes: the reusable half

A shape is a failure family stated so that it can be hunted in code nobody has looked at yet. Each
carries **the question a reviewer should actually ask** — that question is the deliverable, not the
prose above it.

```markdown
## S-07 — <name the family, not the instance>

**Instances**: D004, D011. **Rung**: brief.

<Two to four sentences on why this class survives review — what makes it look correct.>

> **Ask**: <a concrete question a reviewer can answer by reading code, phrased so that "yes" and
> "no" lead to different actions.>
```

Write the shape at the level where it transfers. Test it: could this question be asked about a
subsystem you have never opened? If it names your function, your flag, or your file, it is still an
instance — raise it one level.

### Using shapes: build the review brief from `SHAPES.md`, not from scratch

When reviewing a change, copy the **questions** of the shapes relevant to that change into the brief.
Do not paste the whole file — the brief then stops being about the change and becomes a checklist
nobody reads. A brief naming the family hunts it everywhere; a brief naming instances hunts nothing.

This is the measurable payoff, and it is worth measuring: a brief seeded with real shapes from your
own history should find things a generically-briefed review does not.

### The escalation ladder

```
defect found → recorded with its shape → shape enters the review brief
   → shape recurs → promoted to an executable invariant → the build refuses it
```

**A shape with a second instance has earned promotion.** Say so explicitly in the ledger row rather
than leaving the judgement to the next reader — and if you decline to promote it, record *why*.
Usually the honest reason is that only part of the shape is machine-decidable; promote that part and
say the rest stays a brief.

The last rung is where a shape stops needing human vigilance. Candidates: a lint rule, a type that
makes the state unrepresentable, a test asserting the invariant directly, a CI gate, a schema
constraint.

---

## Detail pages: only when earned

Write `<ID>-<slug>.md` **only** when a future reader would otherwise reconstruct the reasoning from
commit archaeology — a fix that was wrong before it was right, a defect several guards passed
cleanly, or a decision whose alternatives matter. Most defects are a row and nothing more. When in
doubt, do not write one; an unnecessary detail page dilutes the ones that matter.

---

## Standing rules for yourself

- **Never treat a comment asserting a property as evidence that the property holds.** It is a claim to
  verify. This is among the most common sources of ledger rows in practice.
- **"Reports success wrongly" outranks everything.** A component that does damage and exits 0 is the
  worst class most systems have. When you find one, hunt the *class*, not the instance — ask what else
  in this codebase infers from the same signal.
- **Reproduce before you file.** A row marked `measured` that was not measured poisons every later
  decision that trusts the ledger, and the ledger's only asset is that it is trusted.
- **Do not let a fix land without its row**, and do not batch rows "for the end of the sprint". The
  discovery-instrument field is unreconstructable a week later.

---

## Review it at a fixed milestone

Pick one in advance (a release, a quarter) and judge honestly against three criteria:

1. Reviews briefed from `SHAPES.md` found defects that generically-briefed reviews did not.
2. At least one shape recurred and earned promotion to an executable invariant.
3. Entries are still being written without anyone being prompted.

If (3) fails, delete the directory. A stale ledger read as complete is worse than no ledger.

---

## Starter shapes — illustrations of form, to be replaced by your own

Use these only as examples of how a shape is phrased. Delete any your project has not actually
exhibited; an unearned shape in a review brief costs attention and returns nothing.

**S-A — A guard placed at a different granularity than the damage.**
> Ask: at what granularity does this guard fire, and at what granularity does the damage occur? If
> they differ, name the case where one entry is affected and the others are not.

**S-B — A predicate that is unreachable in practice.**
> Ask: construct an actual system state where this condition holds. Not a unit fixture — a real
> state. If you cannot, the guard is decoration.

**S-C — A comment asserting a fact about *other* code, unverified.**
> Ask: for every comment claiming another module's behaviour, open that module and confirm. Cited
> line numbers decay fastest.

**S-D — A test that passes for the wrong reason.**
> Ask: revert the implementation this test names and confirm it fails. If the assertion would be
> identical under a broken implementation, it pins nothing.

**S-E — Fixed one arm, missed the other.**
> Ask: this fix guards one cause of the failure. Enumerate the other causes of the *same* observable
> failure. Which of them reaches the same code path?

**S-F — Absence treated as evidence.**
> Ask: this code concludes something from data it did not see. Distinguish "it is not there" from "we
> did not look". Which one is this, and what happens when it is the second?

---
