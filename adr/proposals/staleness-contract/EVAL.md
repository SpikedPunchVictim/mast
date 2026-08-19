# staleness-contract — eval manifest

**Decision:** ADR 005. **Record:** [`PLAN-EXCERPT.md`](PLAN-EXCERPT.md).

Locking and concurrency instruments. These live under ADR 009’s manifest as harness tooling; listed here because they are what E7 and F1 were scored from.

> Scripts were **not** moved into this directory, and that was a decision — see ADR 001. `eval/` holds
> 153 relative imports that cross these boundaries, and two guards (`results-writers.mjs`,
> `__tests__/median-single-source.test.mjs`) classify by scanning `eval/*.mjs` and pass silently on an
> empty set. This manifest gives the navigation without breaking either.

## Inputs and fixtures

- `eval/f1-lock-scope.json`
- `eval/e7-concurrency.json`
- `eval/e7-round2.json`
- `eval/baseline-locks.json`
- `eval/eventloop-probe.json`

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
