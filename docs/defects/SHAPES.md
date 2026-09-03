# Failure shapes — `packages/mast`

Derived from `LEDGER.md` on 2026-08-18. Every shape here has **at least two real instances in this
package**; the starter shapes in `packages/mast/CLAUDE.md` were deliberately not copied across —
one that this package has never exhibited would cost attention in a review brief and return
nothing.

**How to use this file:** when reviewing a change, copy the **Ask** lines of the shapes that touch
it into the review brief. Copy the questions, not the prose, and not the whole file.

---

## S-01 — Damage that leaves the exit code alone

**Instances**: D002, D003, D012, D022, D038. **Rung**: brief, with one instance promoted (below).

The package's own operating manual calls this the worst class most systems have, and it is the one
`mast` is structurally most exposed to: an index is a *derived* artifact, so nothing downstream can
tell "this symbol is not in the codebase" from "this file failed to index". D002 lost an entire
whale file to a rolled-back transaction and exited 0. D003 produced a different edge set on every
identical run and no signal at all. D012 ran a full check as an import side effect, which is the
same shape pointed the other way — work happening where no caller asked for it.

What makes this class survive review is that the happy path is genuinely correct, and the failure
lives in a path with no observer.

> **Ask**: when this code fails partway, what does the caller receive? Trace one concrete partial
> failure to the process exit code and to the artifact on disk. If the two disagree — the artifact
> is short and the exit code is 0 — name the check that would notice, and if there is none, say so.

### Promotion (2026-08-19)

**D022's half is promoted; the family stays a brief.** `src/__tests__/build-emit.test.ts` asserts
the build config enables neither `composite` nor `incremental`, which is what made "delete `dist/`,
run build, get nothing, exit 0" representable. That specific state is now unrepresentable without a
red test.

The general shape is **declined for promotion, deliberately**: "does this code report success while
leaving the artifact short?" is not mechanically decidable across a package — D002 was a rolled-back
transaction, D003 a nondeterministic ordering, D012 an import side effect. They share a consequence,
not a syntax. Promoting the consequence would mean an integrity assertion at every write site, which
is the per-emit-site duplication CLAUDE.md §5.6 explicitly rejects. It stays a review question.

---

## S-02 — A guard whose condition is right for the case it was written for

**Instances**: D006, D007, D019, D047, D048. **Rung**: brief — declined for promotion 2026-09-01, reason below.

Not a guard in the wrong *place* — a guard whose predicate is correct for the situation its author
had in mind and silently wrong for the general one. D019's FTS guard fires on *was this file ever
indexed*, which is exactly right for cold builds and exactly wrong for the incremental path it was
credited with fixing. D007's orphan counter is correct for a schedule where each cell runs once.
D006's control-first ordering is correct for repair groups and destroyed the Latin square
everywhere else. D047's probe order is correct for an extensionless `./routes` and wrong for the
slash-terminated `./routes/`, where it hands back a sibling file instead of the directory the
author explicitly asked for. D048's `initialised` guard is correct for "no index here" and blind to
"an index for a different tree", which produces the same user confusion the guard was written to
end.

All of them shipped green. In D006 every existing test exercised the half of the input space where
the guard was correct — the suite was not weak, it was *aimed* at the author's case, because the
author wrote both.

> **Ask**: state the case this condition was written for, then state the complementary case. Which
> tests cover the complement? If the answer is "none", the guard is untested exactly where it is
> most likely to be wrong.

> **Ask**: this guard is credited with fixing a problem. Is the credited fix in the same case as
> the guard's condition, or is it in the complement?

> **Ask**: does this predicate compare two counts for exact equality? Both sides move with the
> input; name the input where they differ by one for a reason that has nothing to do with the
> property being tested.

### Declined for promotion (2026-09-01), and the reason

**Declined.** "Is this predicate right for the general case as well as the author's?" requires
knowing what the general case *is*, which is not mechanically decidable — the same reasoning that
kept S-01 a brief. The narrow decidable sliver, an exact-equality comparison between two
input-varying counts, is real but would fire on far more correct code than incorrect, so it is
posed as the third Ask above rather than as a lint rule.

What this shape gained instead is a better **instrument**, and it is worth more than a rule.
D048's *fix* exhibited D048's own shape while being written: the first predicate,
`unindexed === walked`, passed a clean three-file fixture and did not fire on the 1822-file index
the defect came from, because one walked path coincidentally matched an indexed one. No test caught
that — re-running the finished fix against the production-scale artifact did, before the commit.

> **Ask**: this fix was verified against a fixture. Re-run it against the largest real artifact
> available and read the output. A guard tuned on a clean fixture meets its first accidental
> collision in production.

*(Housekeeping, same date: this Rung line previously read "one clause has earned promotion
(below)" and no such subsection existed under this shape — the pointer had been dangling since
2026-08-18. See LEDGER D050.)*

---

## S-03 — A number that travelled through prose

**Instances**: D008, D017, D018. **Rung**: brief.

A figure enters a plan, a comment, or a summary; it is then re-quoted, reasoned from, and built on,
without anyone returning to the artifact it came from. D008's "~2 MB page cache" was wrong by 8×
and was load-bearing counter-evidence. D018's "379 ms at any corpus size" had a plausible
magnitude and a false invariance clause — the *clause*, not the number, was what made the defect
look solved. D017's register of unread data was incremented three times instead of re-derived
once, and drifted from 255 to a reported 114.

The tell is that each was *internally* consistent. Nothing inside the document contradicted them.

> **Ask**: for every number this change relies on, where was it last derived from a primary
> artifact, and by whom? Recompute one of them now. If it does not reproduce, that is the finding.

> **Ask**: does this figure carry a qualifier — "at any size", "always", "per file"? Qualifiers are
> claims too, and they are the half nobody re-checks.

---

## S-04 — A confident claim about code nobody opened

**Instances**: D004, D005, D009, D020, D039, D040, D041, D044, D046, D052. **Rung**: brief.

The richest family here, and the one that produced this package's only two S0s. D009 had two
documents describing a third file's behaviour exactly backwards. D004's four call sites assumed
`LIKE` meant prefix-match. D020 read a query plan's `INDEX 0:=` as "constraint consumed" when the
same line said `SCAN`. D005 explained a wrong number as "miscomputed by hand" — an etiology that
cannot be checked and therefore ends inquiry.

These survive because the claim is stated in the register of a fact rather than a hypothesis, and
because the person best placed to check it is the person who wrote it.

> **Ask**: this comment, doc, or design asserts a behaviour of code it does not contain. Open that
> code and confirm the assertion, line by line. Include tool output — a query plan, a type, a
> schema — in "code".

> **Ask**: does the proposed explanation for this wrong value actually *reproduce* the wrong value?
> If it does not, it is a story, not a diagnosis.

### A sub-shape, and a partial promotion (2026-08-20)

D039, D040 and D041 landed the same day and are narrower than the four above: not *a claim about
code nobody opened*, but **a comment asserting a property that nothing anywhere implements**.
D039's TSDoc said a counter "exists only so the rejection is visible" and no surface printed it.
D040's said an invariant was "true for every case that reaches here" and nothing enforced it —
verified reachable-in-principle, unreached in practice over 19,186 files. D041 is ADR 015 listing
declared write-sets among the disciplines "carried over unchanged", where the key is accepted by
the validator and read by nothing.

These survive for a different reason than the parent shape: the claim is not about *distant* code,
it is adjacent to the thing it describes — the position a reviewer is least likely to check,
because proximity reads as authorship.

**Promoted in part.** The decidable half is narrow but real, and worth a test rather than a
brief: *a field documented as reaching a user surface must have a consumer outside its own
module.* D039 was visible to `grep -rn staleWriteRejections src --include='*.ts'` — two test
fixtures and nothing else — and D041 to the same grep over `integration/`. That is an AST/grep
matrix test of the kind §5.6 endorses (one file, N assertions, automatic coverage as new code
ships), and it is the shape's cheapest rung.

**The rest is declined, with the reason.** D040's half is not decidable: "this comment asserts an
invariant nothing enforces" requires understanding what the invariant *is*. The general instruction
— open the code and confirm — stays a brief, and stays first.

> **Ask**: this comment says a value is visible, reported, surfaced, or enforced. Name the line
> that does it. If the only lines naming the value are its own declaration and a test fixture, the
> property is asserted and unimplemented.

---

## S-05 — Two producers of one value, drifting apart

**Instances**: D014, D016, D023, D024, D043. **Rung**: **promoted in part — see below.**

The same quantity computed in two places, by two authors, drifting apart. Renamed from "two
implementations of one statistic" when D023 arrived: the value that disagreed there was a **file
path**, not a statistic — the walker spelled it from a directory entry and the resolver spelled it
from the import specifier, and nothing compared them. The family is any value two components must
agree on byte-for-byte for a join, a lookup, or a comparison to work. D016's median differed
between runner and scorer because n was even and the two disagreed about what "median" means.
D014's power calculation used a mean-based formula in an instrument whose decision rule is a
median — the identical error that had already been corrected once, in the design, without anyone
asking what else used it.

> **Ask**: is this value produced anywhere else in the package? If yes, do the two agree on every
> edge case — even n, empty input, ties, a single element, mixed case, a symlink? Name the check
> that keeps them agreeing.

> **Ask**: two components join on this value. Which one *defines* its canonical form, and what
> forces the other to that form rather than merely happening to match today?

> **Ask**: this bug was just fixed in one place. Grep for the formula, not the symbol. What else
> uses it?

### Promotion (2026-08-18)

`eval/e1-hoist-score.mjs`'s `selfCheck()` is already the executable form of this shape's first Ask:
it recomputes a prior experiment's published statistic from that experiment's raw journal and
throws unless the two match to 1e-9. It was verified to pass at delta 0 before 60 builds were
committed to it.

**That check exists for one statistic and should exist for the medians D016 caught.** The
machine-decidable half is promoted; the second Ask (grep for the formula) stays a brief, because
"the same formula, written differently" is not mechanically detectable.

### Promotion, second instance (2026-08-19)

D023's half is promoted too, by the same reasoning and in a different currency:
`src/graph/__tests__/miscased-import-edge.test.ts` indexes a fixture whose on-disk casing disagrees
with its import specifier and asserts the edge survives the whole pipeline — the walker's spelling
and the resolver's spelling are now forced into agreement by a test rather than by coincidence.

**The family is declined for promotion, and the reason is worth recording:** enumerating "every pair
of components that must agree on a value" is not mechanically decidable — a grep finds the symbol,
not the agreement. What *is* decidable is one invariant per known pair, so each instance earns its
own executable check and the family stays a brief. Two pairs are pinned; a third would justify
asking whether a general mechanism exists rather than a third bespoke test.

### The third instance arrived the next day (D024)

Running this shape's *second* Ask against D016 — which had never had it run — turned a two-site
defect into a nine-site one: nine value-median expressions across `eval/`, in three behaviours
(five agreeing, three taking the upper element, one returning `undefined` on even n). The general
mechanism is now worth building rather than a fourth bespoke test, because for THIS family the
canonical form already exists: `eval/e1-schedule.mjs` exports a `median`, and `e1-fts-score.mjs`
already imports it. The decidable rule is "no `eval/` script defines its own median", which a lint
rule or an AST test can enforce, with the one deliberate exception (`medianRun`, which selects a run
rather than a value) declared.

**Not yet built, and the blocker is named:** the nine do not agree on the *empty* sample either —
the canonical one throws, two return `null`, one returns `NaN`. Unifying is therefore a semantic
decision per call site, not a sweep, and a rushed sweep through scorers whose output is already
published is precisely D014's hazard.

> **Ask**: when a defect names two components that disagree, has anyone enumerated the *family*
> before scoping the fix to the pair in front of them? Count the implementations first; the pair you
> found is a sample, not the population.

---

## S-06 — An instrument calibrated for a different decision than the one registered

**Instances**: D011, D014, D015. **Rung**: brief.

Distinct from S-05: here there is only one implementation and it is internally correct — it is
answering a different question than the one asked. D015 sized a sample for a *mean* when the
registered primary was a *median*, costing 8 points of power. D011 registered an *absolute*
millisecond band on a rig whose measured session drift was ±18%, so the band tested the rig as
much as the effect.

The reason these survive is that the formula is right, the arithmetic is right, and the mismatch
sits in the join between the instrument and the registration — a place neither review reads.

> **Ask**: name the estimator the decision rule uses, and name the estimator the power/threshold
> calculation assumes. Are they the same one? If not, the design is not sized for its own verdict.

> **Ask**: is this threshold absolute or scale-free? If absolute, what is the measured drift of the
> rig it will run on, and is the band wider than that drift?

---

## S-07 — Absence read as evidence

**Instances**: D001, D002, D010, D017, D045, D048, D049. **Rung**: brief.

The package's severity zero, generalised past code. D010 registered an experiment whose answer was
already committed and unread for four days — "we have no result" was actually "we did not look".
D017's register of unread data was a *sample* presented as exhaustive, which the operating manual
warns is worse than none. D002 is the same shape in the index itself: a consumer cannot distinguish
a symbol that does not exist from one whose file failed to write.

> **Ask**: this concludes something from data it did not see. Is it "not there" or "we did not
> look"? Write down which, and what happens if it is the second.

> **Ask**: this list is about to be read as complete. Enumerate the space it is drawn from *first*,
> then subtract what has been verified. What would belong here that nobody searched for?

---

## S-08 — A measurement contaminated by its own schedule

**Instances**: D006, D013, D051. **Rung**: brief, with one clause promotable (below).

The order in which arms run becomes part of what is measured. D013's micro-benchmark ran arm N
before arm H every repetition, so N warmed the cache for H, and the result was **~6× wrong** in the
direction that flattered the change. D006 is the same failure at the harness level — the driver
silently overrode the registered Latin square, which existed precisely to stop this.

Both look like results. Neither is noisy or obviously broken; they are precise and wrong.

> **Ask**: does every arm run in every position? If arm order is fixed, name what the first arm
> leaves behind for the second — cache, page cache, JIT, disk layout — and why it does not matter.

> **Ask**: does the executed schedule equal the registered schedule? Compare them directly rather
> than trusting the planner; D006 was found by watching four seconds of a live run.

D051 moved this shape out of measurement and into tooling: the contaminated schedule was the
integration gate's own `--targets` order, where the first target faults a 26321-file corpus in from
disk and every later target reads it warm. The contamination is not a wrong number there but a
wrong *verdict* — the same scenario ERRORed in position one and PASSed in position two, and the
target that decides the exit code is the one that runs first.

> **Ask**: when a fixed resource cap (timeout, memory, retry budget) decides an outcome, was it
> chosen against the *worst* position in the schedule or the typical one? Name the run that pays
> the cold cost, and check the cap against that run rather than the average.

### Promotable clause (candidate, still not written)

D051 was fixed by removing the confound rather than by promoting a rule: the corpus is now read
once before any target runs, so arm order no longer decides the verdict. That is the better fix,
and it leaves the clause below unpromoted and still worth writing.

The general Ask stays a brief — "does every arm run in every position" is not machine-decidable.
One clause is: **no step may inherit an implicit timeout.** `integration/lib/exec.mjs:47` supplies a
5-minute default to every command. The override exists and is used exactly once —
`lib/install.mjs:81` gives `npm install` 15 minutes because native addons build there — so the
mechanism is present and the omission elsewhere is a default nobody revisited, not a missing
feature. One cap chosen without reference to corpus size still governs both a 6-file fixture and a
26321-file monorepo, and a machine slower than this one can still hit it; what changed is only that
it can no longer hit it *for one target and not the others*. Requiring each project definition to
declare `timeoutMs` explicitly is enforceable at load in `lib/spec-validate.mjs`, which already
rejects unknown keys against closed vocabularies (`KNOWN_SCENARIO_KEYS`, line 16, which would
itself have to admit the key) — the same rung, the same file.

---

## S-09 — Tests that use inputs no user would produce

**Instances**: D002, D004, D023, D047. **Rung**: brief.

The first three S0s in this ledger share it, and D047 — filed 2026-09-01, and the first slash-terminated import specifier any fixture in this package has ever contained — is the fourth. (The ledger now holds ten S0s; the six from the 2026-08-20 bug hunt have not been assessed against this shape.) D004's four sites had tests, and not one used a path containing
an underscore or two paths differing only by case — in a package that indexes real repositories,
where `snake_case` is routine. D002's tests never used a file large enough to blow a parameter
ceiling, in a package whose stated corpus includes a 146,620-line file.

D023 is the same miss one layer up: after D004 the *range query* was tested with mixed-case paths,
but every fixture still fed it a path the resolver had spelled correctly.

The fixture is chosen to be readable, so it is small, ASCII, and lowercase — and the defect lives
exactly where real input stops being any of those.

> **Ask**: what is the largest, weirdest, and most adversarial real input this code will see in
> production? Is any test within an order of magnitude of it? Name the fixture.

> **Ask**: do the fixtures contain the characters the domain actually contains — `_`, `.`, mixed
> case, unicode, spaces? If every fixture is `a.ts`, the tests are exercising a language this
> package does not index.

---

## S-10 — The check you ran is not the check that governs

**Instances**: D021, D022, D053. **Rung**: brief. *(Added 2026-08-19.)*

A green result is reported, and it is real — it just came from a narrower instrument than the one
that decides. D021 ran `tsc --noEmit`, the first half of a `typecheck` script whose second half
(`tsc -p tsconfig.test.json`) was the half that was red, and "tsc clean" was reported from it more
than once. D022 is the environmental form: a local `pnpm build` exits 0 without emitting because a
gitignored `tsconfig.tsbuildinfo` says the project is current — a state a fresh CI checkout can
never be in, so local green and CI green mean different things.

This class is unusually well-camouflaged because nothing is *wrong* with the result. The command
succeeded, the output was read correctly, the conclusion followed from the evidence. Only the
question was smaller than the claim.

It is also the class that a defect ledger is worst at catching by itself, because the author has no
reason to look: they have a passing command in their scrollback.

> **Ask**: name the exact command the project's gate runs, character for character, and compare it
> to what you ran. A subset that passes is not the gate passing — `&&`-joined scripts and multi-config
> typechecks are where this hides.

D053 is the degenerate case: the gate ran the whole command and the command enforced nothing.
`pnpm lint` was `eslint src eval`, and no configuration block matched a `.mjs` file, so ESLint
applied zero rules and exited 0 over sixty scripts. Every symptom of a healthy lint was present —
correct command, no output, exit 0 — because a lint with no rules and a lint with nothing to
report are the same observation. It had been that way long enough for a live `ReferenceError` to
sit in the corpus-integrity gate for thirteen days (D052).

> **Ask**: does this gate enforce anything? Ask the tool what it applies to the file — ESLint's
> `--print-config`, `tsc --showConfig`, the resolved include globs — rather than inferring coverage
> from the directory named on the command line. Green over an empty rule set is the same green.

> **Ask**: what state does your working copy hold that a fresh checkout will not — a build cache, a
> gitignored artifact, a previously-built `dist/`, an installed binary, a warm database? Which of
> your green results would change without it?

> **Ask**: was any output you concluded from truncated — `head`, `tail`, a scrolled pane? Re-read it
> whole before the conclusion ships.
