# ranker-d — eval manifest

**Decision:** ADR 004. **Record:** [`PLAN-EXCERPT.md`](PLAN-EXCERPT.md).

The two levers aimed at the identifier-at-scale caveat: IDFUSE (rejected, INERT-LEVER) and DECLEX (shipped as ranker D).

> Scripts were **not** moved into this directory, and that was a decision — see ADR 001. `eval/` holds
> 153 relative imports that cross these boundaries, and two guards (`results-writers.mjs`,
> `__tests__/median-single-source.test.mjs`) classify by scanning `eval/*.mjs` and pass silently on an
> empty set. This manifest gives the navigation without breaking either.

## Scripts (8)

- `eval/declex-build-queries.mjs`
- `eval/declex-rank-check.mjs`
- `eval/declex-ranker.mjs`
- `eval/declex-score.mjs`
- `eval/idfuse-rank-check.mjs`
- `eval/idfuse-ranker.mjs`
- `eval/idfuse-run-score.mjs`
- `eval/idfuse-score.mjs`

## Inputs and fixtures

- `eval/declex-queries.json`

## Result artifacts (22)

- `eval/results/declex-gateA-selfcheck.json`
- `eval/results/declex-gateA-smoke-t1.json`
- `eval/results/declex-measure-raw-fresh-esc5.json`
- `eval/results/declex-measure-raw-fresh-esc50.json`
- `eval/results/declex-measure-raw-fresh.json`
- `eval/results/declex-measure-raw-original.json`
- `eval/results/declex-measure-raw.json`
- `eval/results/declex-measure-smoke-HpD.json`
- `eval/results/declex-measure-smoke-LpD.json`
- `eval/results/declex-measure-smoke-LpDpesc.json`
- `eval/results/declex-measure-smoke-combined.json`
- `eval/results/declex-reproducibility.json`
- `eval/results/declex-score-output.json`
- `eval/results/declex-score-smoke-output.json`
- `eval/results/idfuse-gateA-selfcheck.json`
- `eval/results/idfuse-gateA-smoke-t1.json`
- `eval/results/idfuse-gateD-reproducibility.json`
- `eval/results/idfuse-measure-raw.json`
- `eval/results/idfuse-measure-smoke-hplusi.json`
- `eval/results/idfuse-measure-smoke-lisym.json`
- `eval/results/idfuse-measure-smoke.json`
- `eval/results/idfuse-score-output.json`

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
