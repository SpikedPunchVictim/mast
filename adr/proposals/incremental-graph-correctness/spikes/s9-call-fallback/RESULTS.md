# S9 — how often a call edge comes from the name-only guess, and how often it is right (D092)

Run 2026-10-07 with `dist/` built from `a4219a8`. Script: `s9-call-fallback.mjs`. Raw output:
`n8n/` and `mast/` (`summary.json`, and `records.jsonl` with one line per record where the
guess ran).

## Question

A call `x.method()` whose receiver type `Type` is neither a recorded named import of the calling
file nor declared in it is resolved by `legacyGlobalFirstMatch`: the first symbol named
`Type.method` anywhere in the graph. D092 is that such an edge is not put back by an incremental
run, because nothing stored ties the calling file to the target's file. Before choosing a fix:
how many edges does the guess produce, and are they right?

## Method

For each file, extract it, and for every distinct `POTENTIAL_CALL` record whose resolution can
reach the guess (`field_type`, `parameter_type`, `new_expression`, or none) repeat the resolver's
evidence lookup. Where there is no evidence the guess is what ran; the stored edge is what it
picked. The source text is then searched for how the type name comes into scope.

## Corpora

| | n8n | mast |
|---|---|---|
| Checkout | scratch clone at `9d9e9bf97e`, with the 5 working-tree edits left by S8 | scratch clone at `d062339` |
| Files indexed | 13,985 | 162 |
| Stored `POTENTIAL_CALL` edges | 30,740 | 616 |

## Result (measured)

| | n8n | mast |
|---|---|---|
| Distinct records that can reach the guess | 15,016 | 228 |
| Records where the guess ran (no file evidence) | 3,312 | 83 |
| of which it found a symbol and stored an edge | 7 | 0 |
| of which it found nothing | 3,305 | 83 |

No record was emitted without a resolution on either corpus, so the `default:` branch of
`resolveCallTarget` never ran.

Where the guess found nothing on n8n, the type name was: a TypeScript lib global (`Map`, `Set`,
`Error`, ...) 3,062; a default import 93; unknown to the probe 62; an aliased import 40; a type
parameter 24; a namespace import 17; declared in the file but not a symbol 7.

The 7 edges on n8n, read by hand (3 files): all are right. Every one is a class taken from a
dynamic import of a workspace package, which the extractor does not record as an import:

- `packages/cli/src/modules/agents/json-config/from-json-config.ts:504`
  `const { Memory } = await import('@n8n/agents')`, 4 edges to
  `packages/@n8n/agents/src/sdk/memory.ts`; that package's `src/index.ts:130` re-exports `Memory`
  from there.
- `create-workflow-from-code.tool.ts:263`, `update-workflow.tool.ts:927`,
  `validate-workflow-code.tool.ts:131` under `packages/cli/src/modules/mcp/tools/workflow-builder/`:
  `const { ParseValidateHandler, ... } = await import('@n8n/ai-workflow-builder')`, 3 edges to
  `packages/@n8n/ai-workflow-builder.ee/src/code-builder/handlers/parse-validate-handler.ts`.

In all 7 the qualified name had exactly one candidate symbol in the graph.

## Reading

- The guess accounts for 7 of 30,740 stored call edges on n8n (0.02%) and none on mast. Unlike
  the `implements` / `extends` guess (S6: wrong 27 of 27), these 7 are right, but only because
  the names happen to be unique.
- Dropping the guess loses those 7 edges and makes D092 impossible. Keeping it needs stored
  records (M4) or a new lookup to repair 7 edges.
- All 7 have real file evidence the extractor ignores: a destructured `await import('pkg')`.
  Recording that as an import would give them back with evidence, and through the normal
  importer repair.

## Not checked

- Only two corpora, and mast is at an old commit. A codebase that leans on default or namespace
  imports of classes might show more guessed edges; on n8n those 150 records found nothing
  because the symbol is stored under its declared name, not the local one.
- The "how it comes into scope" column is a regular-expression probe (the S6 one), not a parse.
  It decides nothing about the 7 edges, which were read by hand.
- Whether a guessed edge can be wrong when the name has several candidates: no instance on
  either corpus.
