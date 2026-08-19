# indexing-scale — eval manifest

**Decision:** ADR 011. **Record:** [`PLAN-EXCERPT.md`](PLAN-EXCERPT.md).

The nine-rung nested ladder and its phase decomposition: E1, E1-PHASE, E1-AB, plus the vscode build that measured the 150k target.

> Scripts were **not** moved into this directory, and that was a decision — see ADR 001. `eval/` holds
> 153 relative imports that cross these boundaries, and two guards (`results-writers.mjs`,
> `__tests__/median-single-source.test.mjs`) classify by scanning `eval/*.mjs` and pass silently on an
> empty set. This manifest gives the navigation without breaking either.

## Scripts (16)

- `eval/e1-ab-report.mjs`
- `eval/e1-ab-run.mjs`
- `eval/e1-ab-schedule.mjs`
- `eval/e1-ab-score.mjs`
- `eval/e1-build-tiers.mjs`
- `eval/e1-p0-build.mjs`
- `eval/e1-phase-attribution.mjs`
- `eval/e1-phase-report.mjs`
- `eval/e1-phase-run.mjs`
- `eval/e1-phase-schedule.mjs`
- `eval/e1-phase-score.mjs`
- `eval/e1-report.mjs`
- `eval/e1-run.mjs`
- `eval/e1-score.mjs`
- `eval/e1-unread-fit.mjs`
- `eval/vscode-build.mjs`

## Result artifacts (21)

- `eval/results/discarded-amendment3`
- `eval/results/e1-ab-results-review.md`
- `eval/results/e1-ab-runs-summary.json`
- `eval/results/e1-ab-runs.jsonl`
- `eval/results/e1-ab-schedule.json`
- `eval/results/e1-ab-verdict.json`
- `eval/results/e1-calibration.json`
- `eval/results/e1-p0.json`
- `eval/results/e1-phase-attribution.json`
- `eval/results/e1-phase-calibration.json`
- `eval/results/e1-phase-runs-summary.json`
- `eval/results/e1-phase-runs.jsonl`
- `eval/results/e1-phase-schedule.json`
- `eval/results/e1-phase-verdict.json`
- `eval/results/e1-runs-summary.json`
- `eval/results/e1-runs.jsonl`
- `eval/results/e1-schedule.json`
- `eval/results/e1-tiers.json`
- `eval/results/e1-unread-fit.json`
- `eval/results/e1-verdict.json`
- `eval/results/vscode-build.json`

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
