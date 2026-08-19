# Failure shapes — `packages/mast`

Derived from `LEDGER.md` on 2026-08-18. Every shape here has **at least two real instances in this
package**; the starter shapes in `packages/mast/CLAUDE.md` were deliberately not copied across —
one that this package has never exhibited would cost attention in a review brief and return
nothing.

**How to use this file:** when reviewing a change, copy the **Ask** lines of the shapes that touch
it into the review brief. Copy the questions, not the prose, and not the whole file.

---

## S-01 — Damage that leaves the exit code alone

**Instances**: D002, D003, D012, D022. **Rung**: brief, with one instance promoted (below).

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

**Instances**: D006, D007, D019. **Rung**: brief, and one clause has earned promotion (below).

Not a guard in the wrong *place* — a guard whose predicate is correct for the situation its author
had in mind and silently wrong for the general one. D019's FTS guard fires on *was this file ever
indexed*, which is exactly right for cold builds and exactly wrong for the incremental path it was
credited with fixing. D007's orphan counter is correct for a schedule where each cell runs once.
D006's control-first ordering is correct for repair groups and destroyed the Latin square
everywhere else.

All three shipped green. In D006 every existing test exercised the half of the input space where
the guard was correct — the suite was not weak, it was *aimed* at the author's case, because the
author wrote both.

> **Ask**: state the case this condition was written for, then state the complementary case. Which
> tests cover the complement? If the answer is "none", the guard is untested exactly where it is
> most likely to be wrong.

> **Ask**: this guard is credited with fixing a problem. Is the credited fix in the same case as
> the guard's condition, or is it in the complement?

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

**Instances**: D004, D005, D009, D020. **Rung**: brief.

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

---

## S-05 — Two producers of one value, drifting apart

**Instances**: D014, D016, D023. **Rung**: **promoted in part — see below.**

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

**Instances**: D001, D002, D010, D017. **Rung**: brief.

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

**Instances**: D006, D013. **Rung**: brief.

The order in which arms run becomes part of what is measured. D013's micro-benchmark ran arm N
before arm H every repetition, so N warmed the cache for H, and the result was **~6× wrong** in the
direction that flattered the change. D006 is the same failure at the harness level — the driver
silently overrode the registered Latin square, which existed precisely to stop this.

Both look like results. Neither is noisy or obviously broken; they are precise and wrong.

> **Ask**: does every arm run in every position? If arm order is fixed, name what the first arm
> leaves behind for the second — cache, page cache, JIT, disk layout — and why it does not matter.

> **Ask**: does the executed schedule equal the registered schedule? Compare them directly rather
> than trusting the planner; D006 was found by watching four seconds of a live run.

---

## S-09 — Tests that use inputs no user would produce

**Instances**: D002, D004, D023. **Rung**: brief.

All three S0s in this ledger share it. D004's four sites had tests, and not one used a path containing
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

**Instances**: D021, D022. **Rung**: brief. *(Added 2026-08-19.)*

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

> **Ask**: what state does your working copy hold that a fresh checkout will not — a build cache, a
> gitignored artifact, a previously-built `dist/`, an installed binary, a warm database? Which of
> your green results would change without it?

> **Ask**: was any output you concluded from truncated — `head`, `tail`, a scrolled pane? Re-read it
> whole before the conclusion ships.
