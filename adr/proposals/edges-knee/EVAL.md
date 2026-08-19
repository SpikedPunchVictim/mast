# edges-knee — eval manifest

**Decision:** ADR 012. **Record:** [`PLAN-EXCERPT.md`](PLAN-EXCERPT.md).

The edges phase and the FTS delete behind it: E1-SCAN, E1-LADDER, E1-HOIST, E1-FTS, E1-VERIFY.

> Scripts were **not** moved into this directory, and that was a decision — see ADR 001. `eval/` holds
> 153 relative imports that cross these boundaries, and two guards (`results-writers.mjs`,
> `__tests__/median-single-source.test.mjs`) classify by scanning `eval/*.mjs` and pass silently on an
> empty set. This manifest gives the navigation without breaking either.

## Scripts (16)

- `eval/e1-fts-invariant.mjs`
- `eval/e1-fts-report.mjs`
- `eval/e1-fts-run.mjs`
- `eval/e1-fts-schedule.mjs`
- `eval/e1-fts-score.mjs`
- `eval/e1-hoist-run.mjs`
- `eval/e1-hoist-schedule.mjs`
- `eval/e1-hoist-score.mjs`
- `eval/e1-ladder-run.mjs`
- `eval/e1-ladder-schedule.mjs`
- `eval/e1-ladder-score.mjs`
- `eval/e1-scan-run.mjs`
- `eval/e1-scan-schedule.mjs`
- `eval/e1-scan-score.mjs`
- `eval/e1-verify-run.mjs`
- `eval/e1-verify-score.mjs`

## Result artifacts (23)

- `eval/results/e1-fts-design-review.md`
- `eval/results/e1-fts-invariant.json`
- `eval/results/e1-fts-results-review.md`
- `eval/results/e1-fts-runs-summary.json`
- `eval/results/e1-fts-runs.jsonl`
- `eval/results/e1-fts-schedule.json`
- `eval/results/e1-fts-verdict.json`
- `eval/results/e1-hoist-runs-summary.json`
- `eval/results/e1-hoist-runs.jsonl`
- `eval/results/e1-hoist-schedule.json`
- `eval/results/e1-hoist-verdict.json`
- `eval/results/e1-ladder-runs-summary.json`
- `eval/results/e1-ladder-runs.jsonl`
- `eval/results/e1-ladder-schedule.json`
- `eval/results/e1-ladder-verdict.json`
- `eval/results/e1-scan-runs-summary.json`
- `eval/results/e1-scan-runs.jsonl`
- `eval/results/e1-scan-schedule.json`
- `eval/results/e1-scan-verdict.json`
- `eval/results/e1-verify-calibration.json`
- `eval/results/e1-verify-runs.jsonl`
- `eval/results/e1-verify-schedule.json`
- `eval/results/e1-verify-verdict.json`

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
