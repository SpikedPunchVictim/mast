# retrieval-q1 — eval manifest

**Decision:** ADR 002. **Record:** [`PLAN-EXCERPT.md`](PLAN-EXCERPT.md).

Q1 and every arm under it — RESERVE, RESERVE-2, OUTCOME, SCALE, ARM-V, Q4 — plus the real-query harvest and the gold-set builders whose circularity was the hardest part of the whole question.

> Scripts were **not** moved into this directory, and that was a decision — see ADR 001. `eval/` holds
> 153 relative imports that cross these boundaries, and two guards (`results-writers.mjs`,
> `__tests__/median-single-source.test.mjs`) classify by scanning `eval/*.mjs` and pass silently on an
> empty set. This manifest gives the navigation without breaking either.

## Scripts (30)

- `eval/ab-audit-paraphrase.mjs`
- `eval/ab-build-tasks.mjs`
- `eval/ab-freeze.mjs`
- `eval/ab-gates.mjs`
- `eval/ab-rank-check.mjs`
- `eval/ab-run-setup.mjs`
- `eval/ab-score.mjs`
- `eval/ab-search.mjs`
- `eval/build-normal-set-r2.mjs`
- `eval/build-normal-set.mjs`
- `eval/decomp-index.mjs`
- `eval/extract-normal-candidates.mjs`
- `eval/f16-rrf-sweep.mjs`
- `eval/harvest-real-queries.mjs`
- `eval/q1-final.mjs`
- `eval/q1-nest-replication.mjs`
- `eval/q1-reserve-decomp.mjs`
- `eval/q1-reserve2.mjs`
- `eval/q1-vector-value.mjs`
- `eval/reserve2-index.mjs`
- `eval/scale-build-queries.mjs`
- `eval/scale-build-tiers.mjs`
- `eval/scale-embed-tiers.mjs`
- `eval/scale-rank-check.mjs`
- `eval/scale-run-measure.mjs`
- `eval/scale-run-score.mjs`
- `eval/scale-run-selfcheck.mjs`
- `eval/scale-score.mjs`
- `eval/truncation-analysis.mjs`
- `eval/verify-gold.mjs`

## Inputs and fixtures

- `eval/gold-set.json`
- `eval/gold-set-nest.json`
- `eval/gold-set-normal.json`
- `eval/gold-set-normal-r2.json`
- `eval/ab-tasks.json`
- `eval/ab-paraphrase-audit.json`
- `eval/ab-agent-prompt.md`
- `eval/scale-queries.json`
- `eval/scale-tiers.json`
- `eval/corpus-subset.json`
- `eval/corpus-subset-nest.json`

## Result artifacts (24)

- `eval/results/ab-gates.json`
- `eval/results/ab-outcome.json`
- `eval/results/ab-rank-check.json`
- `eval/results/ab-runs`
- `eval/results/q1-declex-design-review.md`
- `eval/results/q1-declex-results-review.md`
- `eval/results/q1-final-fullembed.json`
- `eval/results/q1-idfuse-design-review.md`
- `eval/results/q1-idfuse-results-review.md`
- `eval/results/q1-nest-replication.json`
- `eval/results/q1-reserve-decomp.json`
- `eval/results/q1-reserve2.json`
- `eval/results/q1-scale-design-review.md`
- `eval/results/q1-scale-results-review.md`
- `eval/results/q1-vector-value.json`
- `eval/results/scale-embed-tiers-gate0cd.json`
- `eval/results/scale-gate2-selfcheck.json`
- `eval/results/scale-gate4-vector-coverage.json`
- `eval/results/scale-measure-raw.json`
- `eval/results/scale-measure-summary.json`
- `eval/results/scale-score-output.json`
- `eval/results/task9-score-after.json`
- `eval/results/task9-score-before.json`
- `eval/results/truncation.json`

## Shared harness — not owned by this decision

Imported across tracks; changing any of these affects every experiment:

- `eval/paths.mjs`
- `eval/models.mjs`
- `eval/e1-common.mjs`
- `eval/e1-schedule.mjs`
- `eval/e1-stats.mjs`
- `eval/harness-embedder.mjs`
- `eval/results-writers.mjs`
- `eval/aggregate.mjs`
- `eval/build-corpus.mjs`
- `eval/dump-corpus.mjs`
- `eval/make-subset.mjs`
- `eval/score-only.mjs`

## Two standing hazards

Both have already cost a run (`FINDINGS.md` §5):

- **Never** open `graph.db` with `?mode=ro&immutable=1`. It is WAL-blind and will silently report
  an empty table — which is how this harness's own operator once concluded the write path was
  broken while it was working.
- **Run every eval script from the repository root**, never from a subdirectory. `eval/paths.mjs`
  resolves relative to the cwd, and a wrong cwd produces plausible-looking wrong numbers rather
  than an error.

## Before re-running anything

`eval/results/` is committed evidence. Several scripts overwrite it. Check first:

```
node eval/results-writers.mjs <script>.mjs
```

It classifies every `eval/*.mjs` as a proven writer, an assumed writer, or no-results-write, and
it is deliberately fail-safe: an unresolvable write target is reported as a writer (defect D025).
