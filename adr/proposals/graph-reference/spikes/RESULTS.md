# graph-reference — spike results

Exploratory. Nothing here is a settled `FINDINGS.md` claim. Raw output sits beside each
script; if this page and a raw file disagree, the raw file wins.

## S1 — call edges against the TypeScript checker (`s1-call-edges/reference.mjs`)

### This repository, 2026-10-07

Run on the working tree on top of `0a744c9`, after a full `mast index`. TypeScript 5.9.3,
compiler options from `tsconfig.json`, program built over the 98 TypeScript files mast indexed
(tests included). Raw: `s1-call-edges/mast.json`, summary `mast.summary.json`.

```
node adr/proposals/graph-reference/spikes/s1-call-edges/reference.mjs . tsconfig.json .mast/graph.db <out.json>
```

| Question | Result (measured) |
|---|---|
| Q1 join key | 410 of 410 declarations that have a mast symbol join on file and exact start line. No tolerance needed here. 55 more are local declarations mast does not index (53 variables, 2 nested functions). |
| Q2 caller side | After the two corrections below, 0 of 705 edges name a different caller than the syntax tree does. |
| Q3 wrong edges | **0 of 705.** Every stored `POTENTIAL_CALL` edge agrees with the checker: `same_file` 395, `import` 289, `this_method` 8, `new_expression` 7, `parameter_type` 5, `super_method` 1. |
| Q4 missing edges | The checker supports 751 caller-callee pairs between indexed symbols. mast has 705 of them and lacks **46**. |
| Q6 cost | 2.4 s wall and 400 MB peak on the kept run (2.4 to 3.6 s over four runs), one program. |

The 46 pairs mast lacks, read by hand (the cause in each row is inferred from the source
line, not confirmed in the resolver):

| Pairs | What they are | Inside the six cases of `MAST_SPEC.md` §10.3.1? |
|---|---|---|
| 20 | `new X()`: construction itself. No stored edge points at a class (0 in the graph). | No. Case 5 covers a call on the constructed value, not the construction. |
| 17 | `dice.pick()` where `dice` is typed by the function's contextual type (`const f: Edit = (project, dice) =>`), all in one test helper | No. Case 4 needs an annotated parameter. |
| 2 | `env.recordImport()` on an annotated parameter of an arrow function nested in a function | Yes, case 4 |
| 2 | calls to imported functions inside a function declared inside another function (`staleness.ts:294-295`) | Yes, case 1 |
| 2 | `export const planCursor = (...) => planFlat(...)`: an arrow whose body is the call | Yes, case 6 |
| 1 | a call in a default parameter value (`program: Command = buildProgram()`) | Yes, case 6 |
| 1 | a call in a closure inside a long function (`import-resolver.ts:215`) | Yes, case 6 |
| 1 | `countTokens(content)` inside a `try` (`tokenizer.ts:210`) | Yes, case 6 |

So 9 of 751 pairs are calls the spec says mast catches and it does not; 37 are outside what
the spec claims. None of the 9 has a ledger row yet: they are unconfirmed readings.

### n8n `packages/core`, 2026-10-07

A fresh clone of the user's n8n checkout at `9d9e9bf97e`, outside this repository.
Dependencies installed with `corepack pnpm@10.32.1 install --frozen-lockfile --ignore-scripts`
(exit 0, 4.2 GB; n8n needs pnpm 10.22 or later). Workspace packages were **not** built.
`packages/core` indexed on its own with the built CLI into a state directory outside the
clone: 156 TypeScript files, 558 `POTENTIAL_CALL` edges. Compiler options from
`packages/core/tsconfig.json`; TypeScript 5.9.3 read n8n's configuration with no errors.
Raw: `s1-call-edges/n8n-core.json`, summary `n8n-core.summary.json`.

| Question | Result (measured) |
|---|---|
| Q1 join key | 445 declarations join: 441 on the start line, 4 on the name line (not read; a decorator above the name is the likely reason). 20 do not: 18 local variables mast does not index and the 2 overload signatures of `DirectedGraph.removeNode`. No near miss within 3 lines. |
| Q2 caller side | 2 of 558 edges name a caller the script does not: both are calls inside a `get` accessor. mast is right; the script does not treat accessors as declarations. |
| Q3 wrong edges | **0 of 558.** `this_method` 241, `same_file` 127, `import` 102, `parameter_type` 37, `field_type` 34, `new_expression` 12, `super_method` 5. |
| Q4 missing edges | The checker supports 701 pairs between indexed symbols. mast has 547 of them and lacks **154**; 2 of the 154 are the accessor pairs above counted under the class, so 152. mast's other 11 pairs are 9 self-calls, which the script skips, and the 2 accessor pairs. |
| Q5 unjudgeable | 900 of 3,419 calls get no symbol from the checker. For 878 the receiver has the error type: 20 import specifiers do not resolve (`n8n-workflow` in 157 imports, `@n8n/di` in 40, ...), because those packages point their types at build output. All 558 stored edges were still judged. |
| Q6 cost | 2.0 s wall, 502 MB peak, one program of 1,403 source files. |

The 154 pairs mast lacks. The receiver and nesting columns are from the checker and the
syntax tree (`detail` in the raw file); "claimed" is my reading of `MAST_SPEC.md` §10.3.1.

| Pairs | What they are | Claimed by the spec? |
|---|---|---|
| 44 | `new X()`: the construction itself | No |
| 30 | `this.m()` where `m` is inherited from a class in another file | Not stated either way (D099) |
| 23 | `x.m()` where `x` is a variable or destructured binding with an inferred type | No: "factory return types" |
| 9 | `X.m()`: a static method called on the class | No |
| 8 | `f().m()` or `new X().m()`: no intermediate binding | No: "chained calls" |
| 11 | `this.field.m()` where the field's class is imported from a directory index that re-exports it (`from '@/errors'`). The same class imported from its own file (`from '@/errors/error-reporter'`) gets the edge. 10 of the 11 import lines read. | No: "re-exported types", though the spec says only "not yet resolved" |
| 3 | receiver annotated with a union (`X \| undefined`): 1 field, 2 parameters | No: the annotation must be a named type |
| 17 | plain calls to an import or a same-file function; 15 are in three files, each read at one site: inside methods of an object literal | **Yes, cases 1 and 6** (D098) |
| 2 | method call on the annotated parameter of a nested function expression | **Yes, case 4** (D098) |
| 2 | `this.m()` in a class property initializer | Not stated (D098 e) |
| 2 | `super.m()`: one to a grandparent's method, one to the direct parent's (`execute-single-context.ts:126`), not explained | Not stated (D099) |
| 1 | `x.m()` where `x` is initialised with `new` | Yes, case 5; not read |
| 2 | the accessor pairs (script limit, not a mast gap) | n/a |

Counting the 2 accessor pairs as held, mast stores 549 of the 701 pairs (78%) and lacks 152,
with no wrong edge. 20
pairs are ones the spec claims; the rest are outside it or not stated.

### n8n `packages/core` inside the whole-monorepo index, with its dependencies built

Decided 2026-10-07 (user): judge edges between packages. The packages `n8n-core` depends on
were built in the copy (`pnpm --filter "n8n-core^..." run build`, with pnpm 10 first on the
`PATH`: a nested `pnpm compile` otherwise picks up the machine's pnpm 9 and fails silently).
Only `n8n-workflow` emits declaration maps, so build output alone cannot be joined to source
rows. The script therefore maps each of the 52 workspace packages by name to its `src/`
(`WORKSPACE_SRC=1`). mast indexed the whole copy (13,985 files, 28,930 call edges, 88 s on a
loaded machine); calls are read from `packages/core/`. Raw:
`s1-call-edges/n8n-core-in-monorepo.json`.

| | Result (measured) |
|---|---|
| Unjudgeable | 18 of 3,419 calls get no symbol (900 before). |
| Edges from core | 548, against 558 when core is indexed alone: 4 `field_type`, 5 `import` and 1 `new_expression` fewer. Not read; D087 (`paths` taken from the root tsconfig only) fits. |
| Wrong edges | **0 of 548**, 11 of them into another package. |
| Pairs the checker supports | 1,057. mast holds 537 of them (its other 11 are the self-calls and accessor pairs as before) and lacks **520**. |
| Of the 520, into core | 205 (154 when core's imports did not resolve; the floor moved as expected). |
| Of the 520, into another package | **315**, against 11 held. 232 are into `n8n-workflow`, 56 into `@n8n/backend-common`. By shape: 118 constructions, 73 plain calls of an imported function (`jsonParse` from `'n8n-workflow'`), 62 method calls on an annotated field or parameter, the rest property chains and inferred types. |

So across package boundaries mast stores about 3% of the calls the checker supports (11 of
326). Every one of these imports goes through a package's index file, which re-exports. That
is the directory-index gap of the fixtures below, at the size of a package. The cause on
n8n is inferred from that fixture, not separately isolated: a package name also has to be
resolved to its source, and the two were not separated here.

### Fixtures (`s1-call-edges/fixtures.sh`, output `fixtures.out.txt`)

Two small projects, to separate causes the n8n rows only suggest. Measured:

- A class reached through a directory index (`export { Reporter } from './reporter'`) gives
  no `field_type` edge, with a `@/` alias and with a relative import alike. Imported from its
  own file through the alias, it does. So the alias is not the cause; the re-export is.
- `this.m()` to an inherited method: no edge. `super.m()` to the direct parent: edge, with or
  without type arguments. So type arguments do not explain `execute-single-context.ts:126`.
- A static call `X.make()`, and a receiver annotated `X | undefined`: no edge.
- Position of the call (13 shapes): no edge inside a function declared in a function, a
  method of an object literal, an arrow whose body is the call, a default parameter value, a
  property initializer, or on the annotated parameter of a nested arrow. Edges for a direct
  call, a nested arrow callback, `try`, a getter, and a field or outer parameter used inside a
  nested arrow. Ledger row D098.
- `mast_callers` on the fixture lists the missed call lines as potential matches, so these
  callers are demoted, not lost.

This revises the first table above: of this repository's 9 "inside the six cases" pairs, 7
match a fixture shape (2 nested function, 2 arrow body, 1 default value, 2 nested-arrow
parameter). The fixture shows a call inside `try` and a call in a nested arrow callback do
get edges, so `tokenizer.ts:210` and `import-resolver.ts:215` have some other cause, not
found.

### Found on the way

- **D097: one `symbols` row per sub-chunk of a long function.** 15 functions in this
  repository have 2 or 3 rows (37 rows), 90 lines apart, the later ones on lines in the middle
  of the body. All 145 outgoing call edges of those functions hang off the last row and all 20
  incoming ones off the first. `mast_rename_impact` for `emitChunksForNode` reports
  `declaration_count: 3` with sites at lines 252, 342 and 432. A transitive `mast_callers`
  for `pushChunks` stops at `emitChunksForNode` and does not reach
  `TypeScriptExtractor.extractChunks`, which calls it. Ledger row D097, open.
- **The first run of the comparison was wrong twice, both because of D097.** It reported 144
  caller disagreements and 190 missing pairs. The script now treats rows with one file, name
  and kind as one symbol, and matches an enclosing declaration by name as well as line.
- **D098 and D099**, from the n8n run and the fixtures above.
- **640 against 705 edges: explained, see S2 below.** Before the full index, the index the
  MCP server had been keeping for this repository held 640 `POTENTIAL_CALL` edges (224
  `import`); the full index gave 705 (289 `import`), every other kind equal.

### Limits

- Two corpora, and calls read from one package of the second. Calls into other n8n packages
  were judged with package names mapped to source, which is a choice of the script: the
  compiler itself would resolve them to build output.
- The n8n clone lives in a job temp directory and is not kept. The raw output is; the
  commands above rebuild the rest.
- The raw files for this repository were regenerated after the script gained the Q5 and
  `detail` fields; the counts are unchanged (705, 751, 46).
- An edge is judged at its stored `call_line`. Edges are one per caller-callee pair, so a
  second call of the same pair on another line is not looked at.
- "Agrees" means the checker resolves a call of that name on that line to the stored
  declaration. It does not check `context`.
- The script decides which declarations mast should have a symbol for (functions, methods,
  classes, variables, constructors). Calls to anything else are not counted as missing.
- Structural edges (`EXTENDS`, `IMPLEMENTS`, `PARENT_OF`, `RE_EXPORTS`) are not compared.

## S2 — the branch's commits replayed under a running `mast serve` (`s2-watcher-replay/`)

Question: why did the index the MCP server kept hold 65 fewer `import` edges than a full
index? Run 2026-10-07. Script `watch-replay.sh`, output `watch-replay.out.txt`.

What was found first (measured, `ps`): a `mast serve` for this repository, pid 31197, had been
running since 2026-10-06 18:59:54. HEAD at that moment was `c8021eb`. A server keeps the code
it loaded, so that process still runs a build from before `a4219a8` (D080: edges deleted on
a re-write and not put back) and the two fixes after it, and it has been writing to
`.mast/graph.db` through every edit since. Two more servers, started 11:54 today, run the
current build on the same state directory.

The test: clone this repository at `c8021eb`, index it, start `mast serve` in the clone, check
out each of the 16 commits up to `0a744c9` seven seconds apart, stop the server, and compare
the graph with a full index of the same tree by the same build.

| Build | `import` edges under the server | Full index | In full, not kept | Kept, not in full |
|---|---|---|---|---|
| built from `c8021eb` | 219 | 289 | 76 (70 `import`, 4 `EXTENDS`, 2 `RE_EXPORTS`) | 2 `EXTENDS` |
| current `dist/` (`0a744c9` tree) | 289 | 289 | 0 | 0 |

Every other call kind was equal in both runs, as in the observed index. So the old build
loses `import` edges under the watcher in the amount seen (70 here, 65 observed; the
schedules differ), and the current build loses none over the same 16 commits.

Confidence: the two rows are measured. That pid 31197 caused the 640 is inferred: its exact
build is not known (`dist/` at 18:59 may have held uncommitted work), and the 640-edge index
is gone. This is also the first time the watcher path was compared with a full index on real
commits; it is one run of 16 commits on one repository, not a standing check.

Open: pid 31197 is still running and still writes to this repository's index with the old
code. Not stopped, since it is not this session's process.

## Re-runs after each fix

The same script and the same corpora, run again after a fix lands. Each row is a fresh full
index with that commit's `dist/`.

| After | Corpus | Repeated `symbols` rows | mast edges | Pairs the checker supports | mast holds | Wrong | Raw output |
|---|---|---|---|---|---|---|---|
| D097 (one row per declaration) | this repository | 15 functions → 0 | 705 | 751 | 705 | 0 | `s1-call-edges/mast.after-d097.summary.json` |
| D097 | n8n `packages/core`, indexed alone | 12 functions → 0 | 558 | not re-run | not re-run | not re-run | none; counted with `sqlite3` |
| D087 (aliases from the nearest tsconfig) | n8n `packages/core` inside the whole-monorepo index | 0 | 548 → 569 | 1,057 | 537 → 558 | 0 | `s1-call-edges/n8n-core-in-monorepo.after-d087.summary.json` |
| D100 (a package entry point traced to its source) | n8n `packages/core` inside the whole-monorepo index | 0 | 569 → 657 | 1,057 | 558 → 646 | 0 | `s1-call-edges/n8n-core-in-monorepo.after-d100.summary.json` |
| D098 and D101 (calls in nested functions, defaults and field initializers) | this repository | 0 | 705 → 727 | 765 | 727 | 0 | `s1-call-edges/mast.after-d098.summary.json` |
| D098 and D101 | n8n `packages/core` inside the whole-monorepo index | 0 | 657 → 679 | 1,057 | 646 → 667 | 0 | `s1-call-edges/n8n-core-in-monorepo.after-d098.summary.json` |
| Construction edges and D102 (members through a re-exporting index) | this repository | 0 | 727 → 751 | 768 | 750 | 0 | `s1-call-edges/mast.after-construction.summary.json` |
| Construction edges and D102 | n8n `packages/core` inside the whole-monorepo index | 0 | 679 → 889 | 1,057 | 667 → 875 | 0 | `s1-call-edges/n8n-core-in-monorepo.after-construction.summary.json` |
| `this.m()` to a method of the direct parent class | this repository | 0 | 751 → 752 | 769 | 751 | 0 | `s1-call-edges/mast.after-inherited-this.summary.json` |
| `this.m()` to a method of the direct parent class | n8n `packages/core` inside the whole-monorepo index | 0 | 889 → 905 | 1,057 | 875 → 891 | 0 | `s1-call-edges/n8n-core-in-monorepo.after-inherited-this.summary.json` |

D097 changes which row an edge sits on, not which edges exist, so the pair counts were
expected to stay the same and did.

### D087 on the whole n8n copy

Full index of the copy at `9d9e9bf97e` (13,985 files), the build before the fix and the build
with it, read with `sqlite3`:

| | Before | After |
|---|---|---|
| Import rows whose module begins `@/`, unresolved | 4,834 of 4,834 | 0 of 4,834 |
| `POTENTIAL_CALL` edges | 28,930 | 32,052 |
| `field_type` | 2,709 | 4,401 |
| `import` | 7,422 | 8,715 |
| `parameter_type` | 298 | 424 |
| `EXTENDS` / `IMPLEMENTS` | 870 / 632 | 899 / 656 |

Only `packages/core` was judged against the checker: its 21 new edges all agree. The other
3,101 new call edges were not judged.

**Time.** `s1-call-edges/n8n-full-index-timing.sh` ran the two builds alternately, with the
machine under other work (load average 20 to 34), output in
`n8n-full-index-timing.d087.out.txt`:

| Run | Build | Wall | User CPU | Sys CPU |
|---|---|---|---|---|
| 1 | before | 375.7 s | 77.4 s | 54.6 s |
| 2 | after | 269.2 s | 69.6 s | 46.0 s |
| 3 | before | 140.9 s | 61.3 s | 33.1 s |
| 4 | after | 176.6 s | 64.0 s | 36.4 s |

Wall time varies more between two runs of one build than between the builds, so this shows no
cost and does not rule a small one out. It needs a quiet machine.

**One run not explained.** Run 2 reported `13843 indexed`, `parse_errors: 138`,
`write_errors: 4`. Its stderr was not kept. Four other runs of the same build on the same tree
(one before it, run 4, and two afterwards with stderr kept and empty) indexed 13,985 files with
no errors. Not known: whether the cause was the machine or the build.

### D100 on the whole n8n copy

Full index of the same copy, `packages/core`'s dependencies built, the D087 build then the
build with D100 fixed, read with `sqlite3`:

| | Before | After |
|---|---|---|
| Import rows resolved to a path containing `/dist/` | 10,301 | 14 |
| Non-external import rows whose `resolved_path` has no `files` row | 10,734 | 447 |
| `POTENTIAL_CALL` edges | 32,052 | 33,888 |
| `import` | 8,715 | 10,258 |
| `parameter_type` | 424 | 564 |
| `field_type` | 4,401 | 4,536 |
| `EXTENDS` | 899 | 1,283 |
| `IMPLEMENTS` | 656 | 1,821 |
| `RE_EXPORTS` | 4,086 | 4,175 |

The 14 left are under `node_modules` (`@langchain/*`, `esprima-next`). The largest groups in the
447 are `.vue` files, which mast does not index. That run's stderr was kept and is empty;
13,985 files, exit 0.

Only `packages/core` was judged against the checker: 657 edges, none to another declaration.
Of the 1,057 pairs the checker supports there, mast now holds 646 (537 before D087 and D100).
The 411 it lacks: 162 construction, 73 a method on a local or imported name, 61 a method on a
field, 57 a method on an expression, 32 `this.m()`, 24 a plain call, 2 `super.m()`. The 1,165
new `IMPLEMENTS` and 384 new `EXTENDS` edges were not judged; the script covers calls only.

### D098 and D101

This repository's 765 is not the earlier 751: the source grew by the fixes made in this
session. Of the 38 pairs it lacks, 20 are construction, 17 a method on a local name, 1 a plain
call.

On n8n core, one of the 22 new edges is a pair the script does not produce: a function that
calls itself from an object-literal method (`buildSecretsValueProxy`,
`get-secrets-proxy.ts:18`). The script skips self-calls; the edge was read by hand and is
right. So 12 of mast's 679 pairs there are outside the script (11 before), and 667 are among
the 1,057.

Whole n8n copy, before then after: `POTENTIAL_CALL` 33,888 → 35,001 (`import` 10,258 → 11,052,
`same_file` 9,355 → 9,603, `this_method` 8,873 → 8,910, `parameter_type` 564 → 587,
`new_expression` 277 → 283, `field_type` 4,536 → 4,541). 13,985 files, exit 0, stderr empty.
Only `packages/core` was judged.

The fixture script after the fix is in `s1-call-edges/fixtures.after-d098.out.txt`: every
position of fx2 has its edge, and fx1 gains `obj -> helper` (an object-literal method).

### Construction edges and D102

`new X()` is now stored as a call, `resolution` `construction`, to X's `constructor` symbol
when the class declares one and to the class otherwise. `reference.mjs` was changed to the
same rule before these runs: for a `new` expression it takes the class's constructor
declaration when there is one. Without that it reported every constructor-targeted edge as
"no call of that name on the line".

The first build was wrong on n8n core and is recorded because the checker is what caught it:
of 162 construction edges, 40 agreed and **122 were on the class although it declares a
constructor** (`UnexpectedError`, `FsByteStore`, ...). All 122 were classes imported through
an index file. The qualified name `X.constructor` was looked up along the re-export chain,
where only `X` has a marker, and the fallback then took the class. That is the directory-index
gap of the fixtures above, which also blocked method calls; it is ledger row D102 and was
fixed before anything was committed. This repository showed 20 of 20 agreeing on that first
build, because nothing here is imported through an index file.

After the fix, fresh full indexes:

| | this repository | n8n `packages/core` |
|---|---|---|
| Edges judged | 751 | 889 |
| On another declaration | 0 | 0 |
| `construction` | 20, all agree | 162, all agree |
| `field_type` | none | 34 → 80, all agree |
| Pairs the checker supports | 768 | 1,057 |
| Held | 750 | 875 |
| Outside the script | 1 self-call | 14: 10 self-calls, 4 with a getter as caller |

The 182 pairs n8n core lacks: 71 a method on a local or imported name, 57 a method on an
expression, 30 `this.m()` to an inherited method, 15 a method on a field, 5 a plain call, 2
`super.m()`, 2 construction. The 18 this repository lacks: 17 a method on a parameter whose
type is inferred, 1 a plain call.

The 4 caller disagreements on n8n core are the accessor limit of the script noted above (2
before; two of the new construction edges are inside getters). The 14 repeated `symbols` rows
it reports are getter and setter pairs of one name, none in `packages/core`, unchanged since
the D098 run.

Whole n8n copy, before then after: `POTENTIAL_CALL` 35,001 → 42,566. `construction` 0 → 5,106,
of which 4,711 are on a constructor and 395 on a class; `field_type` 4,541 → 6,761;
`parameter_type` 587 → 797; `new_expression` 283 → 311; `super_method` 25 → 26; `import`, `same_file` and
`this_method` unchanged. 13,985 files, exit 0; stderr holds the `time` lines only. Only
`packages/core` was judged.

Not done: `mast_callers` on a class does not include callers of its constructor.

### Inherited methods

`this.m()` where the class does not declare `m` now goes to `m` on the class named in the
`extends` clause, one step up, placed as `super.m()` already was. Read from the checker's
output before writing it: of the 30 `this.m()` pairs n8n core lacked, 22 had the target on
the direct parent, 6 further up (`ExecuteContext` → `BaseExecuteContext` →
`NodeExecutionContext`), and 2 are a function with a `this` parameter, not a class.

After: `this_method` 243 → 259 on n8n core, all agree; 16 of the 22 gained. The other 6 are
all `await this._getCredentials<T>(...)`. tree-sitter-typescript 0.23.2 reads
`await f<T>(x)` as `(await f)<T>(x)`, so the call has an await expression where its function
should be and no edge is written, for an own method as much as an inherited one. That is
ledger row D103, fixed separately.

Whole n8n copy: `this_method` 8,910 → 9,973, every other count unchanged; `POTENTIAL_CALL`
42,566 → 43,629. 13,985 files, exit 0, stderr empty. Only `packages/core` was judged.

Not done: a method two or more classes up. Finding it means walking stored `EXTENDS` edges,
which makes a file's call edges depend on files it does not import. That needs the
structural edges of every file written before any call edge, and the repair after an edit
to reach every file below the edited class. Not built; 6 pairs on n8n core.
