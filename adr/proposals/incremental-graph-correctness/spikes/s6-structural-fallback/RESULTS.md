# S6 — what an `implements` / `extends` edge does without file evidence (2026-10-06, exploratory)

**Question (decision 1, D085).** When nothing in a file says where an `implements` or `extends`
target comes from, which of three behaviours gives the best tool answers: keep today's
whole-graph name guess (A), record no edge (B), or guess only when the name is unique (C)?

**Script.** `s6-structural.mjs <dist> <project> <out-dir>`, on a fresh full index, in a
transaction that is rolled back. For every `IMPLEMENTS` / `EXTENDS` record the extractor emits
it looks for evidence the way call edges do (the file's named imports, then a same-file
declaration), using mast's own resolver through a probe record. It builds each option's edges
and runs the real `queryImplementors` for every interface name. Raw output per corpus:
`summary.json`, `no-evidence.txt`, `evidence-disagrees-with-today.txt`, `tool-answers-diff.txt`.

**Which tools read these edges** (grep of `src/`, every hit read): `IMPLEMENTS` and `PARENT_OF`
are read by `queryImplementors` (`mast_implementors`) and nothing else. `EXTENDS` is read by
nothing. `mast_implementors` matches the interface by name, so an edge that points at the
wrong same-named interface does not change its answer; a missing edge, or one that points at
a non-interface, does.

## n8n (13,985 files, 3,424 records, 3,154 edges today)

| Evidence for the target name | Records | Today's edge against the evidence |
|---|---|---|
| Named import, found in the imported file | 2,532 | 2,340 same; 192 point at another file |
| Declared in the same file | 334 | 254 same; 80 point at another file |
| Named import, name not found through the imported file | 276 | 182 have an edge today; 94 have none |
| Named import, specifier did not resolve | 130 | 79 have an edge today; 51 have none |
| **None** | **152** | **27 have an edge today; 125 have none** |

So today 272 edges point at a different file than the class's own import or file names.

### The 152 records with no evidence (the decision)

| How the name is in scope | Records | Edge today | Of those, right |
|---|---|---|---|
| TypeScript lib global (`Record`, `Function`, `Error`, ...) | 118 | 7 | 0 |
| Aliased import (`import { X as Y }`, then `extends Y`) | 29 | 20 | 0 |
| Default import | 3 | 0 | — |
| Declared in the file but not a recorded symbol | 2 | 0 | — |

| Option | Edges from these 152 | Right | Wrong |
|---|---|---|---|
| A, today's guess | 27 | 0 | 27 |
| B, no edge | 0 | 0 | 0 |
| C, guess when unique | 21 | 0 | 21 |

Checked by hand: `interface OAuth2AccessTokenErrorResponse extends Record<string, unknown>` is
linked to `class Record` in a typeorm test fixture; `interface Migration extends Function` to
the `Function` node class; `import { AddMfaColumns1690000000030 as BaseMigration }` then
`extends BaseMigration` to `interface BaseMigration` in another file.

### `mast_implementors` over all 4,360 interface names

| Graph | Answers | Interface names answered | Lost against today | Gained |
|---|---|---|---|---|
| Today | 1,758 | 146 | — | — |
| Evidence + A | 1,748 | 142 | 63 | 53 |
| Evidence + B | 1,747 | 142 | 64 | 53 |
| Evidence + C | 1,748 | 142 | 63 | 53 |
| Evidence + B, star-then-named gap closed | 1,784 | 147 | 27 | 53 |

A and C differ from B by one answer, and it is one of the wrong aliased-import edges. The
choice between A, B and C changes one tool answer on n8n.

The 53 gained are classes whose interface today's guess missed, because the first symbol with
that name is a `type` or a class (45 are `OperationHandler`).

The 64 lost are not caused by the fallback. 37 are D086 and 24 are D087, both below; 1 is a
package import guessed onto a local interface (`Tracer`); 1 resolves by evidence to a `type`
(`Span`); 1 is the wrong aliased-import edge.

### `PARENT_OF` by the class's own file

17,664 records give 17,650 edges, the same count as today; today's 239 cross-file edges become
0. No `mast_implementors` method list changed. Separately, `queryImplementors` looks the
implementing class up by bare name (`queries.ts`, first row), so 175 answers whose class name
is declared in more than one file may list another class's methods. Not measured further.

## Two resolver gaps the spike found

**D086, star then named.** `resolveThroughStarChain` looks only for declarations in the files
an `export *` reaches. It does not follow a named re-export there. n8n's package entry points
are built this way (`index.ts`: `export * from './errors'`; `errors/index.ts`:
`export { UserError } from './base/user.error'`). Of the 276 "name not found" records, 182 are
found when that is followed (146 the same target as today, 36 a different and correct one:
`UnexpectedError`); 94 are mixin constants (`export const WithTimestamps = mixin(...)`) that no
option links. For call edges: of 10,971 import call records (one per file and name), 6,891 are
found, 3,652 name a package or an unresolved specifier, 428 are not found, and 84 of those are
found when the gap is closed. Four-file reproduction in the ledger row.

**D087, a package's own path alias.** The import resolver loads `paths` from the project
root's `tsconfig.json` only. All 4,834 of n8n's `@/...` import rows (1,361 files, 9.4% of
51,617 rows) are stored with no resolved path and `is_external = 1`, although
`packages/cli/tsconfig.json` maps `@/*` to `./src/*`. Of the 79 edges today's guess makes for
such imports, 52 match the specifier's path and 27 do not (18 are `Command` from
`@oclif/core` linked to a local `Command`). Two-file reproduction in the ledger row.

## mast (162 files)

13 records, 8 edges today, all the same under every option; 5 records without evidence, all
lib globals with no candidate. `mast_implementors`: 5 answers under every option.

## What this shows

- B. On n8n the guess is wrong 27 times out of 27, and guessing only unique names is wrong 21
  times out of 21.
- The answers B appears to lose come from D086 and D087, not from the fallback. Resolving
  structural edges by file evidence should land with the D086 fix, or `mast_implementors`
  loses 37 right answers on n8n. D087 costs 24 more whatever is chosen here, and already
  costs call edges.
- Aliased imports are not recorded under their local name (29 records). Recording the alias
  would turn 20 wrong edges into right ones; that is tracking, not guessing.

## Limits

- mast does not separate the options, so this is one corpus.
- "Right" and "wrong" for the 27 are judged from the import statement's text and the path it
  resolves to, not by the TypeScript checker. The 52 / 27 split for unresolved specifiers is a
  path-suffix match.
- 344 of the 428 unfound import call records were not explained.
- Default config: test and spec files are outside the graph.
