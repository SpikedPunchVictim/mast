# S12 — how often is a name declared in two files behind one barrel's `export *` lines (D094)?

Run 2026-10-07, `dist/` built from the working tree on top of `0d73ac4`. Scripts: `count.py`
(reads a `graph.db`), `barrel-lines.py` (reads the barrels `count.py` reported),
`ns-star-repro.sh`. Raw output: `n8n.json`, `mast.json`, `n8n.barrel-lines.json`,
`ns-star-repro.out.txt`.

## Question

D094's fix orders the candidates for a star-ambiguous name by file path. That makes the choice
the same on every run; it does not make it right. TypeScript exports neither declaration, so
"no edge" would be the faithful answer. Is that worth building? Before this spike the only
figure was 7 of 60 generated seeds, which reflects the generator's pool of a few names.

## Corpora

| | n8n | mast |
|---|---|---|
| Index | scratch clone at `9d9e9bf97e`, as left by S8 and S11 | this repository's own `.mast/` |
| Files | 13,985 | 193 |

## Result (measured)

| | n8n | mast |
|---|---|---|
| Files with a star re-export row | 202 | 1 |
| Of those, with a name declared in two files behind their stars | 10 | 0 |
| Such names (barrel and name) | 18 | 0 |
| Import rows | 51,617 | 439 |
| Import rows that resolve to such a barrel and list such a name | **0** | **0** |

`count.py` matches a name by spelling in the stored `re_export_files` rows, so 18 is an upper
bound. `barrel-lines.py` then read the ten barrels:

| | n8n |
|---|---|
| Barrels reported | 10 |
| `export * as ns from` lines in them | 56 |
| `export * from` lines in them | 1 |
| Of the 18 names, declared in two files that are both behind `export * from` lines | **0** |

All 18 are behind `export * as ns from` lines (`export * as loadOptions from './loadOptions'`
beside `export * as resourceMapping from './resourceMapping'`, both declaring `getColumns`).
Such a name is exported as `loadOptions.getColumns`, not as `getColumns`, so none of the 18 is
ambiguous to TypeScript. On n8n the true count of D094 cases is 0 names.

## Decision (2026-10-07)

**D094 stays as fixed: lowest path, no further work.** "No edge for a star-ambiguous name" is
not built. On two repositories no import row names such a name, and on n8n no such name exists.
Reopen if a corpus shows an import row that does.

## Found on the way: D096

The stored star rows treat `export * as ns from './a'` as `export * from './a'`
(`src/ast/extractors/typescript.ts:945` says so on purpose). `ns-star-repro.sh`, four files:

```
src/a.ts        export function fn
src/b.ts        export function fn
src/barrel.ts   export * as ns from './a.js';  export * from './b.js';
src/zc.ts       import { fn } from './barrel.js';  calls fn()
```

TypeScript resolves the call to `b.ts`. mast stores `POTENTIAL_CALL src/zc.ts:use ->
src/a.ts:fn`: a verified caller on the wrong declaration. Size on n8n: 137 `export * as` lines
in 57 files against 820 `export * from` lines (text search of tracked non-test source, not
only indexed files). The wrong edge needs the same name behind a plain star as well, and the
table above says no import row on n8n is in that position. Ledger row D096, open.

## Limits

- Two corpora, and mast has one star barrel.
- `barrel-lines.py` matches lines by regular expression and reads only the barrel itself, not
  the barrels it stars in turn. With 1 plain star line among the ten barrels the conclusion
  does not depend on that.
- Test and spec files are outside both indexes.
- Not checked for D096: whether `import { ns } from './barrel'` then `ns.fn()` gets an edge;
  what `mast_exports` and `mast_rename_impact` list for such a barrel.

## D096 fixed (2026-10-08)

The extractor makes no star record for `export * as ns from`. `ns-star-repro.sh` on the fixed
build prints `POTENTIAL_CALL|src/zc.ts:use|src/b.ts:fn` and one star row, `barrel -> b`.
Whole n8n: 1,063 star rows before, 926 after, and the same 71,091 edges. The check left open
above was made: `import { ns } from './barrel'` then `ns.fn()` gets no edge, before the fix
and after. Evidence in `../d096-namespace-star/`.
