# ADR 017 — Agent priming: telling the model to use mast through hooks, not prose

- **Status:** Proposed (2026-10-04). Stages 1–3 of five are implemented; see the stage table.
- **Decided:** 2026-10-04
- **Evidence:** the vendor documentation cited inline, each opened on 2026-10-04 ·
  `gastownhall/beads` `cmd/bd/setup/claude.go`, `docs/integrations/claude-code.md` (prior art) ·
  the startup timings reproduced below

## Context

mast's only instrument for getting an agent to reach for `mast_search` instead of its built-in
grep is `assets/skill.md`: 84 lines that `mast skill --install` splices into `CLAUDE.md`,
`AGENTS.md`, `.cursorrules`, `.windsurfrules` or `.github/copilot-instructions.md`. The
observed problem, **reported by the maintainer and not measured in this repo**, is that agents
with that text in context still use grep.

Three things about the current delivery are verifiable from the code:

- The instruction is passive. It is read once, at the top of a session, and nothing restates
  it when the model is about to make the choice it governs, or after compaction.
- "Prefer it over reading files or grepping" is one sentence of the 84. Most of the rest is
  the signal reference.
- `src/mcp/server.ts:214` constructs `new McpServer({ name: 'mast', version: '0.1.0' })` —
  no `instructions`, although the installed SDK (`@modelcontextprotocol/sdk` 1.30.0,
  `dist/esm/server/index.d.ts:15`) accepts one. The literal `0.1.0` is also a second producer
  of the package version (shape S-05; `package.json` says 0.3.0).

`beads` solves the same problem with a `SessionStart` hook that injects a short primer and
fires again after compaction, plus a minimal pointer in `CLAUDE.md`. It does not gate tool
calls for its users. Whether that achieves better compliance than prose is **unmeasured**, by
beads or by us; this ADR adopts the mechanism on the argument that it restates the rule at
the moments prose cannot, and says so rather than claiming an effect.

`FINDINGS.md` and ADR 013 were searched for prior work on agent tool choice (`adoption`,
`tool selection`, `instead of grep`, `compliance`): no hit bears on it. The closest record is
`eval/ab-agent-prompt.md`, which notes that in the Q1/OUTCOME runs mast's tools were deferred
and reaching them needed an explicit `ToolSearch` — an instance of the same problem, not a
measurement of it.

## Decision

Decisions taken by the maintainer on 2026-10-04: the pre-search hook **reminds, it does not
deny**; every harness named in the README is supported to the extent it can be; installation
defaults to **project** settings with an optional `--global`.

### 1. Three delivery channels, strongest available per harness

| channel | what it does | when the model sees it |
|---|---|---|
| **Session primer** | a short rule set plus the live `mast status` result | session start, and again after compaction where the harness re-fires |
| **Search reminder** | one line naming `mast_search`, attached to a built-in search call | at the call (Claude Code, VS Code) or just after it (Cursor) |
| **Static** | the MCP `instructions` string, and a pointer in the harness's rules file | wherever the harness chooses to surface them |

### 2. What each harness can actually receive

Read from each vendor's hook documentation; the confidence class is per cell.

| harness | session primer | search reminder | static only |
|---|---|---|---|
| Claude Code | `SessionStart`, all sources incl. `compact` — **documented** | `PreToolUse` on `Grep\|Glob`, `additionalContext`, call proceeds — **documented** | |
| Cursor | `sessionStart` → `additional_context` — **documented** | `postToolUse` on `Grep` → `additional_context`, i.e. *after* the call — **documented**. `preToolUse` has no context field and `agent_message` is deny-only | |
| VS Code Copilot | `SessionStart` → `additionalContext` — **documented** | `PreToolUse` → `additionalContext` — **documented as a field; the search tool's name is not documented** | |
| Windsurf | none — no session-start event | none — `pre_read_code` can only block | yes |
| Zed | none — no hook system found | none | yes |
| Claude Desktop (chat) | none — no hook system found | none | yes |

Sources: `code.claude.com/docs/en/hooks.md`; `cursor.com/docs/hooks`;
`code.visualstudio.com/docs/agents/reference/hooks-reference` and
`…/docs/copilot/customization/hooks`; `docs.devin.ai/desktop/cascade/hooks` (Windsurf's docs
now redirect there); `zed.dev/docs/ai/instructions`. The Claude Code, Cursor and VS Code rows
were re-read by the author after the research pass; the Windsurf, Zed and Claude Desktop rows
rest on the research pass alone and are **not independently verified**.

"Support" for the last three therefore means the static channel only. That is a limit of the
harness, and `mast setup` will say so when run for one of them rather than report success.

### 3. Surface

| command | role |
|---|---|
| `mast prime [path]` | prints the primer: rules and live index health. Plain text; the thing a human can run to see what the agent is told |
| `mast hook <harness> <event>` | the hook entry point. Reads the harness's JSON on stdin, writes that harness's envelope on stdout. Never exits non-zero for an ordinary condition — a failing hook must not break a session |
| `mast setup <harness> [path]` | installs the hooks and the rules pointer. `--global`, `--check`, `--remove`, `--dry-run` |

`mast setup` follows the two rules `skill-install.ts` already states: write only inside a
marked or keyed region it owns, and be a byte-level no-op on re-run. Unlike `skill --install`
it *does* create its hook file when none exists, because a hook file is tool configuration,
not a hand-curated prompt; it never overwrites hooks it did not write. Existing settings are
parsed with zod before being merged; a file that does not parse is reported and left alone.

### 4. The reminder stays quiet when it would be wrong

The reminder is emitted only when all of these hold, each decidable without opening the
database: an index exists at the resolved state directory; the search is not scoped by its
`glob`/`type`/`path` input to a language mast does not index. Otherwise the hook emits
nothing. A reminder to use an index that is absent, or for a Python search, teaches the model
to ignore the reminder.

It is one line. It repeats on every matching call; whether repeating helps or habituates is
part of what §"What this does not claim" leaves unmeasured.

### 5. The hook must not pay CLI startup

Measured 2026-10-04 on this checkout, `node dist/cli/index.js --version`, three runs:
**1.69 s, 1.27 s, 1.21 s** wall. Bare `node -e ""`: **0.08–0.09 s**. Importing the
dependencies one at a time in a single process (so later ones benefit from a warm module
cache — descriptive, not additive): `typescript` 214 ms, `kysely` 220 ms,
`@modelcontextprotocol/sdk` 149 ms, `@anthropic-ai/tokenizer` 66 ms, the rest under 35 ms each.

`PreToolUse` runs before the tool call, so a hook that goes through `buildProgram()` would
add roughly a second to every Grep. `cli/index.ts` will therefore dispatch `hook` before it
imports the program, to a module that imports Node built-ins only. The bar: **`mast hook`
for a search reminder completes within 150 ms wall on this machine**, asserted by reading the
import graph in a test (no eager import of `typescript`, `kysely`, the MCP SDK or the
tokenizer from the hook entry) rather than by a timing assertion, which would be flaky.
`mast prime` may pay full startup: it runs once per session.

### 6. The static channel

`mast serve` passes a short `instructions` string to `McpServer`, and takes its version from
`cli/version.ts` instead of a literal. The rules-file targets gain Cursor's current location
(`.cursor/rules/mast.mdc`) and Windsurf's (`.windsurf/rules/mast.md`; `.devin/rules/` if that
directory exists). `assets/skill.md` is cut to the rules and the tool table; the signal
reference moves to `mast docs`.

## Stages

Each stage is test-first, ends on `pnpm gate`, and is small enough to review whole.

| # | deliverable | tests live at |
|---|---|---|
| 1 | `instructions` on the server; version from the manifest; ledger row for the literal (D066). **Done 2026-10-04** | `mcp/__tests__/server-identity.test.ts`: the `initialize` result carries the string and the manifest version |
| 2 | `mast prime` and `assets/prime.md`. **Done 2026-10-04** | pure renderer over a `StatusReport`: fresh, stale, not initialised |
| 3 | `mast hook` — per-harness envelopes, the quiet conditions, the light entry. **Done 2026-10-04** | pure `decide(harness, event, input, indexExists)` table test; import-graph test for §5 |
| 4 | `mast setup claude|cursor|vscode` with `--global --check --remove --dry-run` | merge/idempotence/foreign-hook-preserved/unparseable-file tests against temp dirs |
| 5 | static-only harnesses in `setup`; new rules targets; skill cut; README, `MAST_SPEC.md` | `docs-cmd.test.ts` drift guard, `spec-conformance.test.ts` |

## What this does not claim

- **That any of it changes agent behaviour.** Unmeasured. A before/after on the share of
  discovery calls that go to mast needs a pre-registration under ADR 010 and has not been
  designed; whether the existing A/B harness can drive an agent with hooks installed has not
  been checked.
- **That the MCP `instructions` string reaches the model** in Cursor, VS Code, Windsurf, Zed
  or Claude Desktop. No vendor page says. For Claude Code it is observed, not documented: the
  session this ADR was written in showed other servers' instructions in its own context.
- **The VS Code search reminder works end to end.** The field is documented; the tool name to
  match is not, and has to be read from VS Code's agent debug log by someone running it.
  Stage 4 ships VS Code's session primer and leaves its reminder behind that lookup.
- **How the installed hook command should be spelled for a dev-dependency install.** A global
  install can use `mast hook …`. A project install has no `mast` on `PATH`; Claude Code offers
  `$CLAUDE_PROJECT_DIR` to build a path from, and the working directory of Cursor and VS Code
  hooks was not checked. To be settled in stage 4, against each vendor's docs.
- **Deny mode.** Declined for now, not refuted: a wrong deny on a stale index or a non-TS file
  makes mast worse than absent. Revisit only with a measurement in hand.
