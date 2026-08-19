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

## Rigour on load-bearing claims

**Applies to** any artifact someone will act on without re-deriving it: findings, reviews,
measurements, corrections, benchmark results, architecture decisions, migration plans. **Does not
apply** to exploratory work, throwaway analysis, or a first pass you are about to throw away — if
which mode you are in is unclear, say so in one line and continue.

The failure this prevents is not sloppiness, which is easy to spot. It is **plausible work**:
internally consistent, confidently written, correct in the places you checked, and wrong in the two
or three you did not. Plausible work is more dangerous than obviously bad work, because it is
adopted.

### Derive, don't recall

- A number you assert must be derived **in this session, from the primary artifact**. Copying a
  figure out of your own earlier message is the most common way an error propagates — **your
  earlier self is not a source.**
- If a number originates in prose (a plan, a comment, a summary, a README), recompute it before
  repeating it. If it does not reproduce, that is a finding. Do not round it into agreement.
- Name the estimator whenever one exists. "Median per rung, OLS over nine points" is a claim that
  can be checked; "the exponent" is not.

### Read your own tool output

- Search results are evidence, not a lookup. If a grep prints a file that contradicts the claim you
  are about to write, **that line is the most important thing in the output.** Do not summarise
  past it.
- Before writing "X is unused / unread / uncalled / absent", grep for X and read **every** hit,
  including hits in files you did not expect. Most false negatives of this form are visible in
  output the author already generated.

### Ask the completeness question

- "Is X true?" and "what else is like X?" are different questions, and only the second produces a
  complete list. Enumerate the space first, then subtract what you have verified.
- A register of exceptions that is actually a *sample* of exceptions is worse than none — it will
  be read as exhaustive.
- After any list, ask explicitly: what would belong here that I never looked for?

### Count precisely

Every count must state what it counts. Lines, records, rows, and *valid* rows are four different
numbers. Cross-check any `n` against an independent source — a scored artifact, a test count, a
second query — before quoting it.

### Keep confidence classes separate

Label each claim **measured**, **inferred from code/spec**, or **unmeasured**, and never blur them
inside one sentence. A mechanism measured in one context and asserted in another is *inference*,
however strong the mechanism. Report the classes separately even when they point the same way.

### Primary vs supporting figures

When a source defines a primary statistic, quote the primary. Read what the source calls its own
headline before adopting a number from it. Pairing one experiment's primary with another's
supporting output is not a comparison, even when both are correct in isolation.

### Verify every citation you write

`file:line`, commit SHAs, section numbers, test names, URLs. Cite it, then open it and confirm it
says what you claim. Citations decay, and a confidently wrong one costs a future reader more than
no citation at all. This applies to citations handed to you by a tool, a subagent, or a reviewer —
**verify borrowed citations before adopting them.**

### Switch stance before you finish, not after

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

### Budget it deliberately

This section is expensive and is meant to be. Spend it on artifacts that will be trusted without
re-derivation, and say plainly when you are choosing not to — "spot-checked, not exhaustively
verified" is an honest and often correct thing to write. Silence about depth reads as a claim of
depth.