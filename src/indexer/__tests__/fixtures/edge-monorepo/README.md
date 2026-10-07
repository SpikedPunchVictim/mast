# edge-monorepo

A two-package workspace in the shape that hid D083, D085 and D086, read by
`../../fixture-monorepo.test.ts`. The test copies it to a scratch directory, indexes it, and
compares the graph with `expected-edges.txt`, which was written by hand from the source and
not from mast's output.

What each part is here for:

- `packages/app` sorts before `packages/core`, so every caller is walked before the barrels
  it imports through (D083).
- `core/src/index.ts` stars `errors/index.ts`, which re-exports each class by name (D086).
- `BaseError` is a class in both packages, and `Handler` is a `type` in core and an
  `interface` in app (D085).
- `Store` has three implementors, two of them through the package entry point.

When a resolver defect is fixed, add its shape here and its edges to `expected-edges.txt`.
Files in this directory are parser input: they are not type-checked or linted.
