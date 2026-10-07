# S10 — do the tests fail when the repair code is broken on purpose?

Run 2026-10-07 at `2a42293`. Script: `mutate.mjs`. Spec: `mutants.json` (35 hand-written
mutants). Raw output: `out/results.json` (all 35), `out-survivors/results.json` (the three
survivors run a second time, after the script was changed to delete the test report before each
run so that a stale one cannot be scored).

## Question

The repair code (`src/indexer/edge-repair.ts`, `src/graph/importer-repair.ts`) is pinned by a
table of 26 edit scenarios and 12 generated sequences. Each line of it was added for a defect.
If a line is removed, does a test fail? And is it the test that was written for that line?

## Method

Each mutant removes or narrows one thing: one set of candidates, one source of changed names,
one write. For each, the ten test files that exercise the repair code are run (125 tests, 20 s).
A mutant none of them fails is run against generated seeds 100 to 250 (151 sequences), and if it
still passes, against the whole suite (1,961 tests).

Borrowed from `mutate.mjs` in the grizzly-sv checkout: the spec format (find, replace, the test
expected to fail) and restoring bytes in a `finally`. Not borrowed: its server restarts and
parallel lanes.

## Result (measured)

| Verdict | Mutants | Which |
|---|---|---|
| Failed the test named for it | 18 | E01 E03 E04 E05 E06 E08 E13 E15 E16 E18 E19 E20 I01 I02 I05 I07 I10 I15 |
| Failed other tests in the ten files, not the one named | 7 | E02 E10 E12 E17 I08 I12 I13 |
| Passed the ten files; failed only on seeds 100 to 250 | 7 | E07 E09 E11 E14 I03 I06 I09 |
| Passed everything, 1,961 tests | 3 | I04 I11 I14 |

So `pnpm gate` fails for 25 of the 35 and passes for 10.

### The seven the gate does not catch, and a wider seed range does

| Mutant | What is removed | Seeds of 100–250 that fail |
|---|---|---|
| E07 | holders of edges into a shadowed file are candidates | 115, 242 |
| E09 | importers of a shadowed file are candidates | 115 |
| E11 | a deleted file's names count as changed | 113, 148, 160, 197 |
| E14 | holders are sources when importers of changed names are looked up | 148 |
| I03 | a name that disappeared counts as changed | 114, 145, 148, 192, 197, 218 |
| I06 | a changed member is looked up under its class's name | 115, 127, 135, 147, 175, 191, 231, 237 |
| I09 | the names behind a star target include what it stars in turn | 218 |

Seeds 115, 148 and 218 between them fail all seven. I had named a table row for each of the
seven, and every one of those rows passes with the line removed. Why, for four of them (inferred
from reading the rows against the code, not traced):

- E07, E09: "a new file takes over a specifier that a directory index answered" and "a directory
  index is replaced by a file of the same name". Another candidate rule finds the same importer
  in those rows, so either rule alone is enough.
- I03: "a called function is renamed and its caller is not updated". The caller holds an edge
  into the file, so it is a candidate as a holder whether or not the lost name is noticed.
- I06: "a class gains a method that a subclass elsewhere already calls through super". The
  subclass holds an `EXTENDS` edge into the file, so again it is found as a holder.

### The three that pass everything

- **I14** — the `is_external = 0` filter on unresolved imports is dropped. This widens the set of
  files resolved again and cannot change an edge. It is a cost property with no test. Equivalent
  for correctness (inferred).
- **I11** — a file with the same name and another extension is not treated as shadowed. No test
  project has a `.js` file beside a `.ts` one. Whether a row with one would fail: not checked.
- **I04** — a declaration that changes kind under the same name does not count as changed. The
  row "a type alias becomes an interface that a class implements" passes with this removed.
  Whether any edit sequence can observe it: not checked.

## Second run, after the generator gained interfaces, `implements` and damaged files (measured)

Raw output: `out-extended-generator/results.json`. The nine mutants the gate missed, run again
with the working-tree generator (uncommitted at the time, on top of `2a42293`).

| Mutant | First run | Second run |
|---|---|---|
| E09 | seeds 100–250 only | fails fixed seed 4, so the gate now catches it |
| E07, E11, I03, I06, I09 | seeds 100–250 only | still seeds 100–250 only |
| E14 | seeds 100–250 only (seed 148) | passes everything |
| I04, I11 | pass everything | pass everything |

The new cases did not close the gaps: one mutant moved into the gate by luck of a seed and one
moved out of reach. I04 still passes although the generator now turns an interface into a type
alias and back under a class that implements it.

## Third run, after eight rows were added to the scenario table (measured)

Raw output: `out-with-rows/results.json`, all 35 mutants, working tree on top of `02b7227`.

Each of the seven seed-only mutants was cut down from a failing seed to a scenario of two to five
files and one round, by a throwaway reducer that dropped rounds, files and lines while the
sequence still failed. An eighth row was written by hand for I11 (a `.ts` file added beside a
`.js` file of the same name). Every row passes on unmodified code and fails with its own mutant
applied. `mutants.json` now names these rows as the killers, so it differs from the spec the
first two runs used in those eight `killer` fields.

| Verdict | First run | Third run |
|---|---|---|
| Failed the test named for it | 18 | 26 |
| Failed other tests in the ten files | 7 | 7 |
| Failed only on seeds 100 to 250 | 7 | 0 |
| Passed everything | 3 | 2 (I04, I14) |

So `pnpm gate` now fails for 33 of the 35.

I04 was probed with nine hand-written kind changes under the same name (constant to function and
back, interface to class, class to interface, type alias to interface directly and behind a star
barrel, type alias to class, enum to class, function to class). All nine pass with the mutant
applied. The likely reason is that resolution does not look at a symbol's kind, so an importer
that names the symbol holds an edge before and after and is found as a holder. That is inferred;
I did not prove that no edit sequence can observe it. If it is true, the `|kind` part of the
export surface does nothing.

## Reading

- The table plus twelve seeds leaves 7 of 35 single-line removals undetected that the generator
  detects with more seeds. The fixed seeds are the weak part, not the generator.
- A row written for a defect does not always pin the line that fixed it. Of the 32 mutants that had
  a named row and failed somewhere, the named row kept passing for 14 (the 7 killed by other
  tests and the 7 killed only by more seeds).
- Verdict on the tool: it found gaps in under 20 minutes of machine time that reading had not.

## Limits

- 35 mutants chosen by me, in two files. Not a mutation score; a different 35 would give a
  different count.
- Each mutant is one removal. Nothing here says the code is right, only whether a test notices a
  given change.
- Vitest shortens table-row names in its report, so the named-row match is on the first 30
  characters; two rows share such a prefix ("a file gains a name that is imported"). The first
  scoring matched on the full name and miscounted 13 as "other"; `--rescore` corrected it.
- Vitest does not typecheck. A mutant that would fail `tsc` or lint still runs.
- The seeds are those of the generator at `2a42293`. Any change to the generator changes what a
  seed produces.
