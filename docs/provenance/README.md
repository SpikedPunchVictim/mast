# Where this repo came from, and how to resolve a commit citation

MAST was developed inside the `kluster` monorepo at `packages/mast` and split out on
2026-08-19 with:

```
git filter-repo --path packages/mast --path-rename packages/mast/:
```

187 commits carried over, with every path rewritten from `packages/mast/…` to `…/`.

## The citations problem

`FINDINGS.md`, `IMPLEMENTATION_PLAN.md`, `docs/defects/LEDGER.md` and `docs/defects/SHAPES.md`
cite commits by SHA — "fixed in `c4b4816`", "`a677831`, `8cb7e0e`". **Those are kluster SHAs.**
A history rewrite necessarily produces new commit objects, so none of them name a commit in
*this* repo. They were deliberately left in place rather than rewritten at split time; this
file is what makes them recoverable.

**53 distinct commits are cited. 52 have a counterpart here. One does not:** `07d705b`
(`docs(foldv2): S5 handoff plan`) never touched `packages/mast` and was dropped by the filter.
It is cited for context only.

## Resolving one

`kluster-commit-map.tsv` is the mapping `git filter-repo` emitted — two columns, old SHA then
new SHA, one row per commit in the source history. A new SHA of all zeros means the commit was
dropped because it touched nothing under `packages/mast`.

```sh
# a cited SHA is usually abbreviated, so match on the prefix
grep ^c4b4816 docs/provenance/kluster-commit-map.tsv
git show <the second column>
```

## Rewriting them for good

The map makes that mechanical whenever it is worth doing — for each citation, look up the
prefix and substitute the new SHA. Two things to get right if you do:

* **Abbreviations are not unique across repos.** Expand to the full old SHA against the map,
  then re-abbreviate against *this* repo's object database, or you will mint a citation that
  is ambiguous or resolves to the wrong commit.
* **`07d705b` has no counterpart.** Leave it, and mark it as a kluster reference, rather than
  mapping it to something plausible.

Until then a citation in this repo means "a commit in kluster", and this file is how you
follow it. Do not quote one as if it resolved locally — verifying a citation before repeating
it is §11.7, and this is the exact situation it is about.
