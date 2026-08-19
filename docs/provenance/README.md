# Where this repo came from, and how to resolve a commit citation

MAST was developed inside the `kluster` monorepo at `packages/mast` and split out on
2026-08-19 with:

```
git filter-repo --path packages/mast --path-rename packages/mast/:
```

187 commits carried over, with every path rewritten from `packages/mast/…` to `…/`.

## The citations problem — rewritten 2026-08-19

`FINDINGS.md`, `IMPLEMENTATION_PLAN.md`, the handoffs, `docs/defects/` and the review
documents under `eval/results/` cite commits by SHA. Those were **kluster** SHAs; a history
rewrite mints new commit objects, so none of them named a commit in this repo.

**217 citations across 15 files have been rewritten to this repo's SHAs.** They resolve
here now, and `git show` on any of them works. The map below is retained for the reverse
lookup — given a SHA quoted in an old message, an issue, or a chat log, it tells you which
commit here it became.

### The four that were deliberately not rewritten

They have no counterpart in this history because they never touched `packages/mast`, so
there is nothing to point them at. Each is annotated in place:

| SHA | What it is |
|---|---|
| `07d705b` | **The kluster corpus pin**, not a citation — the commit `base-state-r2` is built from. `eval/ASSETS.md`, `IMPLEMENTATION_PLAN.md` |
| `65d8d2c`, `8c6a35e`, `8d2e040` | foldv2 commits referenced by a spike write-up. `eval/spikes/capsule/PILOT_RUN_1.md` |

`07d705b` is the one that matters. `eval/paths.mjs` sets `PROJECT_ROOT` to
`~/.cache/mast-eval/corpus-kluster`, a worktree of the kluster repo at that commit, and
per `eval/ASSETS.md` every headline Q1 ranking number comes from the corpus built there.
**Reproducing the Q1 baseline requires the kluster repository.** The E1 track has no such
dependency — its six corpora are external OSS repos pinned in `eval/e1-common.mjs`.

### What was left alone, and why that was not automatic

58 hex tokens in these documents are not commits at all — the external corpus SHAs
(`5ebbe53` vscode, `f7fffd6` nest, `7f3e7eaa9f6b` opentelemetry-js and the rest), sha256
digests, byte counts like `1048576`, and dates like `20260715`. Rewriting one of those
would have silently repointed a frozen corpus. The rewrite only touched tokens that
resolve to a commit **in kluster** and have a non-dropped entry in the map.

## Resolving one

`kluster-commit-map.tsv` is the mapping `git filter-repo` emitted — two columns, old SHA then
new SHA, one row per commit in the source history. A new SHA of all zeros means the commit was
dropped because it touched nothing under `packages/mast`.

```sh
# forward: an old kluster SHA -> the commit here
grep ^c4b4816 docs/provenance/kluster-commit-map.tsv

# reverse: a SHA in this repo -> where it came from
grep 88f4592 docs/provenance/kluster-commit-map.tsv
```

## How the rewrite was done

For each citation: expand the prefix to a full old SHA, look it up, re-abbreviate against
this repo. Two things it would have been easy to get wrong, and were checked:

* **Abbreviations are not unique across repos.** Every prefix was expanded against kluster,
  mapped, then re-abbreviated with `git rev-parse --short` against *this* object database
  and re-resolved to confirm it is unambiguous here. Reusing the old abbreviation length
  would eventually mint a citation pointing at the wrong commit. 0 came back ambiguous.
* **A hex string is not a commit.** See above — the filter is "resolves in kluster", which
  is what kept the external corpus pins intact.

Verified afterwards by re-scanning every markdown file: 130 distinct citations resolve in
this repo, 5 occurrences of the 4 SHAs above resolve only in kluster and are annotated,
and 58 non-commit tokens were untouched.
