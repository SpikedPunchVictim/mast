# Spikes — incremental graph correctness

Throwaway, exploratory measurements behind `../PROPOSAL.md`. Nothing here is a registered
experiment under ADR 010 and no number here may be quoted as a settled finding. Each spike has
a directory holding the script that produced it and its raw output. Scripts were run from a
session scratch directory and carry absolute paths to it; they are kept as the record of what
was run, and need their paths changed to run again.

Corpora:

- **scratch projects**: two to eight files, built by the script itself.
- **n8n copy**: `git archive` of `/Users/spikedpunchvictim/temp/enterprise-apps/n8n`, indexed with
  mast's default config (which excludes `*.test.ts` and `*.spec.ts`): 13,985 files.
  The copy was edited by the timing probes as they ran, so counts taken at different times
  differ (see S0-T below).

All runs: built CLI (`dist/`) from this branch, 2026-10-06, macOS, one machine.

| Spike | Question | Status |
|---|---|---|
| S0-R | Do the reported edge losses reproduce? | done — `s0-reproductions/` |
| S0-T | What does an incremental run cost, by number and kind of changed file? | done — `s0-timings/` |
| S1 | How many edges does a full index miss because of walk order (D083)? | done — `s1-walk-order/`: n8n 1,939 of 55,620; mast 0 |
| S2 | How many edges does a replayed sequence of real commits lose (D081, D084)? | done — `s2-commit-replay/`: n8n 2,541 of 53,681 over 200 commits; mast 54 of 669 over 100; found D085 |
| S3 | How many files would need re-resolving per changed file? | done — `s3-importers/`: by stored edge p99 7, max 1,115; by name through barrels p99 37, max 5,011 |
| S4 | How often does a real change alter a file's names or re-exports? | done — in `s2-commit-replay/RESULTS.md`: 72 to 74% of modifications do not |
| S5 | What does re-resolving one file cost, by re-parse and from records? | done — `s5-reresolve-cost/`: about 3 to 4 ms against 0.3 to 0.8 ms per file |
| S6 | Decision 1: which fallback for `implements` / `extends` without file evidence gives the best tool answers? | done — `s6-structural-fallback/`: n8n today's guess wrong 27 of 27, unique-name guess wrong 21 of 21; found D086 and D087 |
| S8 | Does the importer repair (M3b) give a full index's graph on n8n, and at what cost? | done, one hand-made sequence — `s8-importer-repair-validation/`: 0 of 108,288 rows differ after six incremental runs; 565 files resolved again for the package barrel in 3.3 to 3.6 s |
| S7 | Decision 2: how often would a cap on re-resolution be hit? | done, an estimate — `s7-cap-sizing/`: n8n p90 103 files, 9 of 143 runs over 500; mast max 56 |
| S9 | D092: how many call edges come from the name-only guess, and are they right? | done — `s9-call-fallback/`: n8n 7 of 30,740, all 7 right (dynamic import of a workspace package); mast 0 of 616 |
| S10 | Do the tests fail when one line of the repair code is removed? | done — `s10-mutation/`: of 35 hand-written mutants the gate fails for 25; 7 more fail only on generated seeds 100 to 250; 3 pass all 1,961 tests. After eight rows were added to the scenario table the gate fails for 33 |

S1 to S5 (2026-10-06) used two further corpora, both scratch clones so that commits could be
checked out: n8n at `9d9e9bf97e` (13,985 indexed files) and this repository at `d062339`
(166 files, index built into a scratch state directory). The S1 to S5 scripts take their paths
as arguments. `*.json` files beside each script are raw output; `RESULTS.md` is the reading.
