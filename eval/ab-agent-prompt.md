# Q1/OUTCOME — the subagent instrument (closes AMENDMENT 3's unresolved gap)

The 2026-08-02 adversarial review of the results found that the 30 subagent prompts, the
model identity, and the tool availability were **not in the committed record** — only
`cards.json`'s question text. That gap is load-bearing: whether agents were asked for *"the
symbol this line refers to"* versus *"the code implementing this"* is exactly what decides
whether the four T-task failures are genuine failures or ground-truth extraction artifacts
(AMENDMENT 3, finding 3). Recorded here verbatim so the question is settleable.

## Run configuration

| property | value |
|---|---|
| harness | Claude Code `Agent` tool, `subagent_type: "general-purpose"` |
| model | **inherited from the session — `claude-opus-5`**. No `model` override was passed on any of the 30 runs. (The two adversarial reviews and the paraphrase step DID pass `model: "fable"`; those are not task runs.) |
| concurrency | 3 batches of 10, `run_in_background: false` |
| tools available | the general-purpose set (`*`) — including `Bash`, `Read`, `Grep`, `Glob`. mast's MCP tools were **deferred** in this harness, so reaching them required an explicit `ToolSearch`; none occurred. |
| context | each run a fresh subagent with no memory of any other run or of this investigation |

## The prompt, verbatim

Identical for all 30 runs. Only `<WORKTREE>`, `<QUESTION>`, `<RUN_ID>` varied. `<QUESTION>`
is the frozen `query` field from `ab-tasks.json` (verbatim doc line for S-ident, audited
paraphrase for S-concept).

```
You are locating code in a TypeScript monorepo.

WORKING DIRECTORY: <WORKTREE>
Work only inside that directory.

QUESTION — find the code this describes:
"<QUESTION>"

The answer is a single exported symbol (interface, type, class, or function) somewhere
under `packages/workbench/` or `packages/kluster-bt/`. It is NOT in `packages/mast`.

YOUR CODE SEARCH TOOL:
  bash /Users/spikedpunchvictim/.cache/mast-eval/ab-runs/<RUN_ID>/search.sh --query "<your search text>" --limit 10

It returns JSON: ranked code chunks with file_path, start_line, symbol_name, content. Call
it as many times as you like, varying the query.

RULES:
1. Use that command as your PRIMARY means of finding code.
2. Do NOT use any mcp__mast__* tool, and do not load them via ToolSearch.
3. Do NOT read the search command's implementation, its directory, or anything under
   packages/mast. It is irrelevant to the question and reading it invalidates this run.
4. You MAY fall back to Read/Grep/Glob if search is not getting you there. If you do,
   COUNT those calls — you must report the number honestly.

WHEN DONE, write the file
/Users/spikedpunchvictim/.cache/mast-eval/ab-runs/<RUN_ID>/result.json containing exactly:
{"run_id":"<RUN_ID>","answer_file":"<repo-relative path>","answer_symbol":"<symbol name>","confidence":"high|medium|low","fallback_calls":<integer>,"fallback_used":<true|false>,"notes":"<one sentence>"}

Then reply with ONE line: "<RUN_ID> done: <answer_symbol> in <answer_file>". Nothing else.
```

## What the wording settles — read against AMENDMENT 3 finding 3

The prompt says **"find the code this describes"** and asks for **"a single exported
symbol"**. It does *not* say "the symbol this line names" or "the first identifier
mentioned". So an agent reading T06 — *"shared by `installToolchain` and the composition
root's provisioning `install`…"* — and answering `retrySpawn` (the shared retry behaviour
the sentence is *about*) is **following the instruction correctly**. The recorded ground
truth (`installToolchain`, the first uniquely-resolving backticked identifier) is what the
*harvester* extracted, not what the prompt asked for.

**This confirms, rather than merely suspects, that T01 / T04 / T06 are ground-truth
extraction artifacts**: the prompt asked for the described code and the harvester graded
against a mentioned identifier. The two are not the same question.

Consequences, all already recorded in AMENDMENT 3 and unchanged by this confirmation:

- `b = c = 0` is **unaffected** — both arms gave byte-identical answers on all 12 tasks,
  so no regrading can create a discordant pair.
- Marginals regrade from 8/12 to ~11/12 in **both** arms, which brushes the registered
  Gate 5 ceiling rule. "The task set discriminated" stays **withdrawn**.
- The instrument defect is in `ab-build-tasks.mjs:88-104` (first-uniquely-resolving
  identifier), not in the prompt.

**Required before any repeat:** either (a) align the harvester with the prompt by selecting
the identifier the line is *about*, or (b) align the prompt with the harvester by asking for
"the symbol this line names". Pre-register a referent-ambiguity rule either way. Do not
leave the mismatch and grade around it.
