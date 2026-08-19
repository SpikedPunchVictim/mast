# D004 — `LIKE` prefix match bound edges to the wrong file

**Severity**: S0. **Filed**: 2026-08-18 (reconstructed). **Fixed**: `88f4592`, 2026-08-17.
**Shapes**: [S-04](SHAPES.md#s-04), [S-09](SHAPES.md#s-09).

A detail page is earned here for one reason: **the first fix was wrong, and wrong in the direction
that made the defect look safer than it was.** That sequence is invisible in the final diff and
recoverable only by commit archaeology across `f604034` → `080ca1f` → `88f4592`.

## The defect

Four sites resolved a file by prefix with:

```sql
path LIKE ? || '%'
```

Two independent faults, both live at every site:

1. **The prefix is interpolated unescaped.** In SQL `LIKE`, `_` matches any single character. Real
   TypeScript repositories are full of `snake_case` filenames, so this is not an edge case.
2. **Default `LIKE` is case-insensitive; the index sorts `BINARY`.** The comparison and the
   ordering disagree.

Combined with `ORDER BY path ASC`, the query returns a file the caller never named — *even when the
exact path exists in the table*:

| files present | resolvedPath | `LIKE` returns |
|---|---|---|
| `src/my.util.ts`, `src/my_util.ts` | `src/my_util.ts` | `src/my.util.ts` |
| `src/FOO.ts`, `src/Foo.ts` | `src/Foo.ts` | `src/FOO.ts` |

## Why it is S0 rather than a performance bug

The resolver binds a `POTENTIAL_CALL` edge to the returned file. Those rows feed `verified_callers`,
which the tool's own documentation describes as safe to act on. So the failure mode is: an agent
asks who calls a function, receives a confident answer naming the wrong file, and edits it. Nothing
reports an error. This is the severity-zero definition in `LEDGER.md`, reached by the shortest
possible path.

A performance defect rides along — SQLite cannot apply the `LIKE` optimization when
`case_sensitive_like` is OFF against a `BINARY` index, so the plan degraded to `SCAN`. Confirmed on
the 8,651-file vscode database: `SCAN files USING COVERING INDEX` → `SEARCH (path>? AND path<?)`.
**The performance symptom is what drew attention; the correctness bug was found underneath it.**
Had the query been fast, nobody would have looked.

## The part worth recording: the first fix claimed to be behaviour-preserving

`f604034` proposed swapping `LIKE` for a range query and described the change as *"provably
behaviour-preserving"*. An adversarial review by a second model (Fable) returned it as FATAL, and
the finding reproduced independently before being adopted.

It was not behaviour-preserving, because the existing behaviour was **already wrong**. A swap that
preserves behaviour would have preserved the defect. The phrase did real damage: it framed the work
as a free performance swap, when in fact it required a semantics decision — escape the pattern, or
change to a range query — and the choice between those determines whether the two counterexamples
above are fixed or merely made faster.

The same review found a second claim in the same commit: a mis-derived exponent had been explained
as *"miscomputed by hand"*. Two systematic faults reproduce the old figures to four decimal places
(dropping rung T6 → 1.111717; reading `measurement.duration_ms` → 1.079053). A simultaneous double
match is not chance. "Hand error" is unfalsifiable and closes inquiry; a systematic fold bug implies
every number derived in that session needs re-deriving. That is filed separately as **D005**.

## Which check should have caught it, and did not

**Nothing did, and tests existed.** Three test files exercised `resolvedPath` before the fix
(`re-export.test.ts`, `import-resolver.test.ts`, `tools.test.ts`). Verified on 2026-08-18 against
`88f4592~1`: **not one of them used a `.ts` fixture path containing an underscore**, and none used
two paths differing only by case. The dedicated `path-prefix-match.test.ts` did not exist — it was
created by the fix.

The fixtures were `a.ts`, `b.ts`, and their kin: readable, short, lowercase, ASCII. The defect lives
exactly where real input stops being those things. This is the whole of S-09, and both of this
package's S0s exhibit it.

## Fix and pin

Range query (`path > ? AND path < ?`) at all four sites, with `pathPrefixUpperBound` as the shared
derivation. Each counterexample in the table above became a test that **failed against the shipped
code first**. Pinned by `src/graph/__tests__/path-prefix-match.test.ts`.

## What transfers

- A performance investigation is a correctness investigation you have not finished yet. D004 and
  D019 were both opened as "this query is slow".
- "Behaviour-preserving" is a claim about the *old* behaviour as much as the new one, and it is
  worthless until someone has established the old behaviour was correct.
- A proposed cause that does not reproduce the observed wrong value is a story. Make it reproduce
  the number, or keep looking.
