# MAST — Monorepo AST Search Tool

MAST is a code-search engine that runs as either an MCP server (for AI assistants) or a standalone CLI. It parses TypeScript and JavaScript source files with a real AST parser (`tree-sitter`), stores the resulting symbol graph and code chunks in SQLite, and answers queries with lexical BM25 search fused against a declaration-exact ranker via Reciprocal Rank Fusion.

The core design principle: **return exactly the code an assistant needs, nothing more**. Rather than reading entire files, MAST returns the specific function, interface, or type declaration that matches a query — saving tokens, reducing context noise, and letting AI tools navigate large codebases without drowning in irrelevant content.

---

## Contents

- [Why MAST?](#why-mast)
- [Requirements](#requirements)
- [Install](#install)
- [Quick Start](#quick-start)
- [Use it from your AI assistant](#use-it-from-your-ai-assistant)
- [Upgrading](#upgrading)
- [Using MAST in a monorepo](#using-mast-in-a-monorepo)
- [CLI Reference](#cli-reference)
- [MCP Tool Reference](#mcp-tool-reference)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Token Efficiency](#token-efficiency)
- [History](#history)

---

## Why MAST?

When an AI assistant needs to understand code, the naive approach is to read full files. This wastes tokens (most of a 200-line file is irrelevant to the question), inflates context windows, and forces the model to filter signal from noise on every call.

MAST takes a different approach:

- **AST-level chunking** — every function, class, interface, and type alias is its own chunk. The assistant gets the exact declaration it needs, not the file it happens to live in.
- **Ranked search** — BM25 (FTS5) handles keyword and identifier queries; a declaration-exact ranker ("ranker D") catches exact-symbol-name queries that BM25's trigram tokenizer can rank inconsistently. Both are fused via Reciprocal Rank Fusion so a chunk that both rankers agree on outranks one that only one of them found.
- **Structural queries** — "who calls this function?", "what implements this interface?", "what does this file import?" are answered from a pre-built symbol graph, not by grepping source. Answers are instantaneous and structurally correct.
- **Staleness handling that says what it actually does** — five read tools (`mast_signature`, `mast_callers`, `mast_exports`, `mast_dependencies`, `mast_rename_impact`) re-parse a changed file inline before answering; `mast_search` and `mast_implementors` flag affected results with `stale: true` rather than re-parsing. Both only cover files the index *already knows*: a brand-new file is invisible until a reindex, which is why `mast serve` watches by default and why `mast_search` carries an `unindexed_files` warning when it does not.
- **Token accounting** — every tool response includes `_stats` with the token count returned and the counterfactual "what would a naive full-file read have cost?", giving a concrete measure of efficiency over time.

---

## Requirements

- **Node.js ≥ 22** (this repo pins the version it develops against in `.nvmrc`)
- **A C++ toolchain**, for the two native modules (`better-sqlite3`, `tree-sitter`).
  Prebuilt binaries cover most platforms; when none matches your Node ABI, `node-gyp`
  builds from source and needs:
  - **macOS** — `xcode-select --install`
  - **Debian/Ubuntu** — `sudo apt install build-essential python3`
  - **Windows** — install the "Desktop development with C++" workload from Visual Studio
    Build Tools

No services, no API keys, no network at query time. Everything is local SQLite.

---

## Install

As a dev dependency of the project you want to index — recommended, because the version
is then pinned in your lockfile alongside everything else:

```bash
pnpm add -D @spikedpunch/mast     # or: npm i -D / yarn add -D
```

Or globally, if you want one `mast` across many checkouts:

```bash
pnpm add -g @spikedpunch/mast
```

Verify:

```bash
mast --version
```

---

## Quick Start

Three commands from nothing to a searchable index:

```bash
cd /path/to/your/project

mast init                    # write .mast/, then run the first full index
mast status                  # confirm it is fresh
mast search "createUser"     # search it
```

`mast search` prints the matching declaration, not the file it lives in:

```
$ mast search "compareVersions" -n 1
src/cli/upgrade-cmd.ts:39  compareVersions  function  (exported)
    /** Semver compare, prerelease-aware. Returns <0, 0, or >0. */
    export function compareVersions(a: string, b: string): number {
      ...
    }

270 tokens returned vs 2140 to read the files whole — 87% saved
```

The last line is real accounting, not a slogan: every response carries `_stats` with what
it returned and an upper bound on reading the referenced files whole. On a small file the
saving can be *negative*, and MAST says so rather than rounding it into a win.

An answer that MAST cannot fully stand behind says so, on the same surface that shows the
result. A file edited since it was indexed is marked, because the body printed under it is
the *old* one:

```
! 1 of 2 results are from files that changed since indexing —
  the code shown below may be out of date. Run `mast index` to refresh.

src/a.ts:1  alphaFunction  function  (exported)  [STALE]
```

And an empty answer distinguishes the two reasons it can be empty:

```
$ mast search "kept_symbol"
no matches (mast indexes TypeScript, JavaScript, and Markdown only —
a symbol in any other language is invisible to it, not absent from the repo)

$ mast search "anything"          # in a directory with no index
nothing is indexed at this path — this is not evidence the symbol is absent.
run `mast index` first, or check `mast status` for the path being used.
```

Narrow it with `--type`, `--language`, `--exported`, `--file`, `-n`:

```bash
mast search "greet" --type method --exported -n 5
mast search "config" --file "src/store/**"
```

Keep it current as you work — or let a git hook do it:

```bash
mast index --incremental     # reindex only what changed
mast install-hooks           # reindex automatically after commits and checkouts
```

Everything shipped with your build is readable offline, so you never have to work out
which docs match your version:

```bash
mast docs                    # list the topics
mast docs spec               # the full behavioural specification
mast skill                   # the instructions to paste into an agent prompt
```

---

## Use it from your AI assistant

MAST speaks MCP over stdio. `mast serve` is the server command; the configuration below
differs only in where each tool keeps its config file.

If you installed MAST as a dev dependency rather than globally, replace `mast` with
`npx @spikedpunch/mast` (or `pnpm exec mast`) in any of these.

### Claude Code

```bash
claude mcp add mast -- mast serve
```

Add `--scope project` to write `.mcp.json` into the repository so your team picks it up
from the checkout.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "mast": {
      "command": "mast",
      "args": ["serve"],
      "env": { "MAST_STATE_DIR": "/absolute/path/to/your/project/.mast" }
    }
  }
}
```

Claude Desktop does not run in your project directory, so `MAST_STATE_DIR` must be
absolute. The CLI and editor integrations below infer it from the working directory.

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "mast": { "command": "mast", "args": ["serve"] }
  }
}
```

### VS Code (GitHub Copilot)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "mast": { "type": "stdio", "command": "mast", "args": ["serve"] }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "mast": { "command": "mast", "args": ["serve"] }
  }
}
```

### Zed

`settings.json`:

```json
{
  "context_servers": {
    "mast": { "command": { "path": "mast", "args": ["serve"] } }
  }
}
```

### Any other MCP client

Run `mast serve` over stdio from the project root. It advertises eleven read tools and
needs no arguments beyond `serve`.

### Tell the assistant how to use it

Registering the server gives the model the tools; it does not tell it *when* to reach for
them, or how to read a flagged answer. `mast skill` prints instructions written for that —
paste them into your system prompt, `CLAUDE.md`, `.cursorrules`, or a skill file:

```bash
mast skill                    # print it
mast skill --install          # splice it into this project's agent config files
mast skill --install --dry-run
```

`--install` writes only into files that **already exist** — `CLAUDE.md`, `AGENTS.md`,
`.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md` — and writes inside a
marked block, so re-running after an upgrade replaces the previous copy instead of adding
a second one. It never runs on its own, and it never creates a config file you did not
already keep.

---

## Upgrading

```bash
mast upgrade
```

This checks for a newer release and prints the exact command for how *you* installed it —
it does not upgrade in place, because a CLI cannot reliably tell a global install from a
dev dependency, and guessing wrong runs the wrong command in your repository.

More importantly, it tells you the one thing your package manager cannot: whether the
upgrade changes the **index schema**. When it does, MAST discards the index and rebuilds
it on the next `serve` or `index`. Nothing is lost that cannot be rebuilt — the index is
derived state — but on a large monorepo it is minutes, and it is better known in advance
than discovered as an unexplained stall.

---

## Using MAST in a monorepo

**One index at the repository root** is usually right. Cross-package imports resolve, so
`mast_callers` finds callers in sibling packages — which is the reason to use a monorepo
tool rather than one index per package.

**What is indexed.** `.ts`, `.tsx`, `.js`, `.jsx`, and `.md`, minus `node_modules`,
`dist`, `build`, `coverage`, `.next`, `.turbo`, `.mast`, and test files. Override with
`--extensions` and `--exclude` on `mast init`, or — for a setting the whole team should
get — `file_extensions` / `exclude_patterns` in `mast.config.json` at the project root.
Editing `.mast/config.json` also works and is read back, but that file is gitignored and
per-machine, so the change will not travel; `mast.config.json` outranks it.

**Other languages are not indexed, and this matters.** MAST parses TypeScript and
JavaScript only. A symbol defined in Python, Go, Java, or Rust is absent from the index,
which looks exactly like absent from the repository. Treat an empty result as "MAST did
not find it", never as "it does not exist" — `mast skill` says this to the model too.

**Add `.mast/` to `.gitignore`.** It is derived state, it is large, and it is
machine-specific — on a 14k-file monorepo it is around 420 MB, almost all of it `graph.db`.
Ignore the whole directory, including `.mast/config.json`: that file is a *resolved*
snapshot and carries absolute paths (`project_root`, `resolved_state_dir`) that mean
nothing on anyone else's machine. The file meant to be committed is `mast.config.json` at
the project root — see the next paragraph.

**If you move the index, move the ignore rule with it.** `.mast/` is the default location,
not the only one: a `state_dir` in `mast.config.json`, a `MAST_STATE_DIR` in the
environment, or a `--state-dir` flag all put the index somewhere else, and a `.gitignore`
naming `.mast/` then protects nothing.

**A custom index location is not remembered between runs.** `--state-dir` applies to the
one command you pass it to. Path settings are deliberately never read back out of a
persisted config — an absolute path written by a previous run (or a previous container)
can resolve somewhere that no longer exists, or worse, somewhere belonging to a different
project. To make a custom location stick, put it in source control or the environment:

```json
// mast.config.json, at the project root
{ "state_dir": ".cache/mast" }
```

```bash
export MAST_STATE_DIR=/absolute/path/to/index
```

Resolution order is `--state-dir` → `MAST_STATE_DIR` → `mast.config.json` → `.mast`.
`mast status` prints the directory it resolved, and says so plainly when nothing has been
indexed there.

**Scale.** A cold index of VS Code — 8,653 files, 152,969 chunks — takes about two
minutes and produces a 794 MB state directory. Incremental reindexing of a changed file
is milliseconds.
## CLI Reference

### `mast init [path]`

Initialise MAST for a project and run the initial full index.

```
Options:
  --state-dir <dir>        Where to write index state (default: <path>/.mast)
  --extensions <ext,...>   File extensions to index (default: .ts,.tsx,.js,.jsx,.md)
  --exclude <pattern,...>  Glob patterns to exclude
  --no-index               Create config only; skip initial indexing
```

**Why:** Creates the state directory structure, writes `config.json`, and runs a full parse + symbol extraction pass. Running this once upfront means subsequent incremental runs only touch changed files.

---

### `mast search <query> [path]`

Search the index and print readable results.

```
Options:
  -n, --limit <n>        Max results, 1-50 (default: 10)
  -t, --type <kind>      function | method | class_shell | interface | type | export | block | doc
  -l, --language <lang>  typescript | javascript | markdown
  -e, --exported         Only exported symbols
  -f, --file <glob>      Restrict to files matching a glob
      --state-dir <dir>  State directory
      --json             Emit the raw MCP response instead of text
```

**Why:** the fastest way to check what the index actually contains, and the same code path
the MCP `mast_search` tool uses — it dispatches through the registered handler rather than
re-implementing ranking, so CLI and assistant results cannot disagree. Staleness and
truncation flags are printed above the results; an empty result that is empty *because* the
index was busy says so.

For scripting, `mast query mast_search '{...}'` gives byte-identical MCP output.

---

### `mast index [path]`

Build or update the index.

```
Options:
  --state-dir <dir>    State directory
  --incremental        Only reindex files changed since last run
  --show-progress      Print indexing progress to stderr
  --checker            Opt-in TypeScript-checker pass: upgrades heuristic potential_matches
                        into verified caller edges (or drops non-call-site noise). Can take
                        tens of seconds on a large monorepo — not part of the default path.
```

**Why incremental:** The incremental path diffs the current file manifest against stored mtimes. Only stale, added, or deleted files are processed — for a large codebase this cuts index time from seconds to milliseconds on most runs.

---

### `mast serve`

Start the MCP server over stdio.

```
Options:
  --state-dir <dir>         State directory
  --no-startup-reindex      Skip the startup staleness check (not recommended)
  --no-watch                Do not watch source files (batch/container use)
  --watch                   Watch source files and incrementally reindex on change
                             (the default; accepted for compatibility)
```

Watching is **on by default**. JIT staleness only re-parses files the index already knows,
so without a watcher a file created during a session stays invisible to every read tool
until something reindexes — and nothing does. A watcher failure (EMFILE, permissions) logs
a warning and the server keeps serving, so the default cannot stop `serve` from starting.

The server implements a four-step startup ladder so MCP clients get a usable server in under a second even for large projects. See [Startup Ladder](#startup-ladder) for details.

---

### `mast status [path]`

Print index health.

```
Options:
  --state-dir <dir>    State directory
  --json               Output as JSON
```

Reports `last_indexed`, `indexed_files`, `chunk_count`, `stale_files`, `parse_errors`, `write_errors`, `index_fresh`, and `freshness_cause`. Use this to diagnose why search results look outdated.

---

### `mast metrics [path]`

Show token-efficiency metrics.

```
Options:
  --since <window>        Time window: 7d, 24h, 30m (default: 7d)
  --rollup                Collapse raw rows older than --keep-days into daily roll-ups
  --vacuum                Delete daily roll-up rows older than --keep-days
  --keep-days <n>         Retention days (default: 7 for rollup, 90 for vacuum)
  --state-dir <dir>       State directory
```

Prints a column-aligned table: tool name, call count, tokens returned, average duration, and efficiency ratio. Use `--rollup` + `--vacuum` periodically to keep the metrics database from growing unbounded.

---

### `mast install-hooks [path]`

Install git `post-commit` / `post-checkout` hooks that run `mast index --incremental` automatically, so the index stays fresh across commits and branch switches without a manual step.

---

### `mast query <tool> [json] [path]`

Invoke any MCP read tool directly, with byte-identical output to the MCP transport.

```
Options:
  --state-dir <dir>   State directory
  --json              Emit the exact single-line MCP response (default pretty-prints)
```

```bash
mast query mast_callers '{"symbol":"resolveConfig"}'
mast query mast_project_skeleton '{}'
```

**Why:** the scripting and debugging surface. `mast search` is the readable front door to
one tool; this reaches all eleven, and returns exactly what an assistant would receive —
so a disagreement between what you see and what the model saw is not possible. Naming a
tool that does not exist lists the ones that do.

---

### `mast docs [topic]`

Print documentation shipped with the installed build — `readme`, `spec`, or `skill`. No
argument lists the topics with the version they belong to.

**Why:** removes the step where a reader looks up their version and then finds docs for a
different one. What `mast docs` prints is what the binary in your `node_modules` does.

---

### `mast skill [path]`

Print the MAST instructions to paste into an agent prompt, `CLAUDE.md`, `.cursorrules`, or
a skill file.

```
Options:
  --install    Splice into this project's existing agent config files
  --dry-run    With --install, report what would change without writing
```

**Why:** registering the MCP server gives a model the tools but not the judgement — when to
search instead of reading, that code tokens beat prose in a query, and how to read a
staleness or truncation flag. It also tells the model that an empty result means "MAST did
not find it", not "it does not exist", which is the single most consequential thing to get
right about a search tool.

---

### `mast upgrade [path]`

Check for a newer release; print how to install it, and what it will cost.

**Why:** it detects how MAST was installed and prints the matching command rather than
running it, because a CLI cannot reliably distinguish a global install from a dev
dependency. It also reports whether the upgrade bumps the index schema — which forces a
full reindex on the next `serve` — and your package manager cannot tell you that.

---

## MCP Tool Reference

MAST registers 11 tools with the MCP server. Every read tool includes a `_stats` block:

```typescript
{
  tool: string,
  tokens_returned: number,
  tokens_full_file_upper_bound: number,
  files_referenced: string[],
  efficiency_ratio: number,           // 1 - (returned / full_file)
  duration_ms: number,
}
```

---

### `mast_search`

Lexical BM25 + declaration-exact search over the indexed codebase.

```typescript
{
  query:         string,              // natural language or identifier
  limit?:        number,              // max results (default 10, max 50)
  language?:     "typescript" | "javascript" | "markdown" | null,
  file_pattern?: string | null,       // glob: "src/api/**"
  chunk_type?:   "function" | "method" | "class_shell" | "interface" | "type" | "export" | "block" | "doc" | null,
  only_exported?: boolean
}
```

**Returns:** `{ results[], suggestions?, _stats }`. Each result includes `file_path`, `start_line`, `end_line`, `content`, `chunk_type`, `symbol_name`, `parent_symbol`, `is_exported`, `match_score` (BM25 score, negative; `null` when the hit came only from ranker D), `rank`, `match_snippet`, and an optional `related` hint when a method and its class shell both matched (only the higher-ranked one is returned). `suggestions` is present, possibly empty, only when `results` is empty — a zero-result "did you mean" assist.

**Why:** `grep` and `glob` find exact strings and require the caller to already know the pattern. `mast_search` ranks by relevance across two signals fused with Reciprocal Rank Fusion:

- **BM25 (FTS5, trigram-tokenized)** — the general-purpose lexical ranker; handles keyword queries and sub-token/camelCase matches.
- **Ranker D (declaration-exact)** — a direct match against a chunk's own `symbol_name` (full name or final dot-segment, case-insensitive). Catches exact-symbol queries BM25's trigram scoring can under-rank. Gated by the `declaration_exact_ranker` config key (default on); when off, `mast_search` is BM25-only.

A chunk both rankers agree on outranks one only one of them found. `file_pattern` and `language` bound the pool **both** rankers draw from, so a scoped search never returns a file outside the scope. `file_pattern` is a glob matched with the same primitive that applies `exclude_patterns` at index time: `*` does not cross `/`, `**` does, `?` is one non-`/` character, matching is case-sensitive, and everything else — `.`, `_`, `-` — is literal.

---

### `mast_project_skeleton`

All exported symbols grouped by file, optionally scoped to a directory.

```typescript
{
  directory?:    string | null,       // path prefix: "src/api"
  max_depth?:    number,              // max subdirectory depth (default unlimited)
  file_pattern?: string | null        // glob filter on file paths
}
```

**Returns:** `{ files: [{ file_path, exports: string[] }], _stats }`.

**Why:** Before navigating a codebase, an assistant needs orientation — "what exists here?". Reading every file to find its exports is wasteful. `mast_project_skeleton` returns a directory-scoped map of file → exported names in a single call, letting an assistant build a mental model of a subsystem without opening any files.

---

### `mast_exports`

All exported symbols from a single file with type signatures and TSDoc.

```typescript
{
  file_path: string                   // relative to project root
}
```

**Returns:** `{ file_path, exports: [{ name, kind, signature, line, doc }], _stats }`.

**Why:** The natural follow-up to `mast_project_skeleton`. Once an assistant knows which file is relevant, `mast_exports` gives full signatures without the function bodies — enough to understand the public surface of a module without paying for the implementation.

Methods are intentionally omitted (they surface via `mast_signature` on their parent class), so the result stays focused on the module's public contract.

---

### `mast_signature`

Declaration, TSDoc, and resolved parameter type context for a named symbol.

```typescript
{
  symbol:     string,                 // e.g. "handleLogin", "AuthService"
  file_path?: string | null           // narrow to a specific file
}
```

**Returns:** An array of `SignatureResult`, each with `symbol`, `file_path`, `line`, `signature`, `doc`, `params`, `return_type`, and `type_context`.

`type_context` is automatically populated: user-defined PascalCase type names appearing in the signature are resolved to their own signatures via a three-priority lookup — same file first, then named imports, then a global exported-type fallback. Long signatures are truncated at 500 characters. This means a single `mast_signature` call gives the assistant the full type picture for a function without needing separate lookups.

**Why:** When an assistant sees `function processOrder(order: Order, ctx: RequestContext): Promise<Result>`, knowing the signature of `Order`, `RequestContext`, and `Result` is essential for understanding what the function does. Rather than making three more tool calls, `mast_signature` resolves them inline.

---

### `mast_callers`

Who calls a given symbol, split into verified callers (from the symbol graph) and potential matches (from full-text identifier search).

```typescript
{
  symbol:              string,
  file_path?:          string | null,
  transitive?:         boolean,       // walk the full call chain (default false)
  include_potential?:  boolean        // include identifier_fts matches (default true)
}
```

**Returns:** `{ verified_callers[], potential_matches[], summary: { verified_count, potential_count, transitive, checker_classified_non_call_site, checker_classified_different_declaration }, _stats }`.

**Why:** Impact analysis before a refactor requires knowing who depends on a symbol. Verified callers are graph-resolved (definitive, no false positives from name collisions). Potential matches are identifier-FTS hits where the call wasn't statically resolvable — they may be false positives but are worth reviewing. Separating the two lets the assistant reason about confidence: if `verified_count` is 3 and `potential_count` is 0, the refactor scope is well-understood. If `potential_count` is 15, there's more uncertainty. Running `mast index --checker` upgrades some potential matches to verified edges (or drops non-call-site noise) — the `checker_classified_*` counts report how many, and are 0 when the checker pass has never run.

---

### `mast_dependencies`

All imports recorded for a file.

```typescript
{
  file_path: string
}
```

**Returns:** `{ file_path, imports: [{ module, symbols[], is_external, resolved_path? }], _stats }`.

**Why:** Understanding a file's dependency surface is the first step in reasoning about what it does. External imports (no `resolved_path`) are flagged so the assistant knows the resolution boundary. Internal imports include the resolved path so callers can follow the chain.

---

### `mast_implementors`

All concrete classes that implement a given interface, with their method lists.

```typescript
{
  interface_name: string
}
```

**Returns:** `{ results: [{ class_name, file_path, line, methods[] }], _stats }`.

**Why:** In a dependency-injection codebase, `interface_name → implementors` is the answer to "what actually runs here?". Rather than grepping for `implements InterfaceName`, MAST stores explicit `IMPLEMENTS` edges in the graph at index time, making the lookup instantaneous and structurally correct.

---

### `mast_rename_impact`

Composed refactor checklist for renaming a symbol: declaration sites, verified callers, potential matches, and barrel re-exports, in one call.

```typescript
{
  symbol:     string,
  file_path?: string | null
}
```

**Returns:** `{ symbol, declaration_sites[], verified_callers[], potential_matches[], barrel_exports[], summary: { declaration_count, verified_count, potential_count, barrel_count, checklist, checker_classified_non_call_site, checker_classified_different_declaration }, _stats }`.

**Why:** A rename touches more than call sites — barrel re-exports (`export { Foo } from './foo'`, possibly aliased) also need updating, and are easy to miss with a plain caller search. `mast_rename_impact` composes `mast_callers`' machinery with barrel-export detection so the assistant gets one checklist instead of three separate queries.

---

### `mast_reindex`

Trigger a synchronous reindex from within an MCP session.

```typescript
{
  full?: boolean                      // force full reindex (default: incremental)
}
```

**Returns:** `{ files_indexed, files_skipped, chunks_added, chunks_removed, parse_errors, write_errors, duration_ms }`.

**Why:** Long-running editing sessions accumulate staleness — new symbols and files won't be found by `mast_search` until they're indexed (JIT staleness handling keeps *already-indexed* files' line coordinates correct on read, but can't discover a brand-new file or symbol). `mast_reindex` lets the assistant refresh the index on demand — for example, after a large refactor — without leaving the MCP session. The `full` flag is available when incremental state is suspected to be corrupt.

---

### `mast_status`

Health snapshot of the index.

```typescript
// no inputs
```

**Returns:** `{ state_dir, last_indexed, indexed_files, chunk_count, stale_files, parse_errors, write_errors, index_fresh, freshness_cause, seed_commit? }`.

`index_fresh` is `true` only when `stale_files = 0` and the index has been run at least once. `freshness_cause` is `"phase1_stale"` when stale files remain, `null` when fresh. `stale_files` counts changed files, files on disk that are not in the index at all, and indexed files that are gone from disk — the same number `mast status` reports, from the same producer.

**Why:** Before a long agentic workflow that depends on accurate code navigation, an assistant can call `mast_status` to confirm the index is fresh, or surface the number of stale files to the user if not.

---

### `mast_efficiency`

Token savings report for the current session or all time.

```typescript
{
  scope:          "session" | "global",
  since_minutes?: number              // global scope: restrict to last N minutes
}
```

**Returns:** `{ scope, window_started_at, tokens_returned, tokens_full_file_upper_bound, efficiency_ratio, calls_total, calls_by_tool, tokenizer, counterfactual }`.

The `counterfactual` field is a human-readable sentence: *"Would have cost ~14,200 tokens with naive full-file reads; saved ~11,400 tokens (80.3%)."*

**Why:** Token efficiency is the whole reason MAST exists, but without measurement it is just a claim. Every tool call records tokens returned to `metrics` asynchronously (fire-and-forget, < 1 ms). `mast_efficiency` aggregates those records so the value of precise code navigation is concrete and auditable.

---

## Configuration

MAST reads configuration from `mast.config.json` in the project root, environment variables, or CLI flags. Priority order (highest to lowest): CLI flag → `MAST_STATE_DIR` env var → `mast.config.json` → built-in defaults.

| Key                       | Default                                                                     | Description                                                                 |
| -------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------|
| `state_dir`                | `.mast`                                                                     | Directory for all index state (relative to project root)                   |
| `file_extensions`          | `.ts,.tsx,.js,.jsx,.md`                                                     | Source file extensions to index                                            |
| `exclude_patterns`         | `node_modules/**`, `dist/**`, `coverage/**`, `.kluster/**`, `**/*.test.ts`, `**/*.spec.ts` | Glob patterns to skip                                     |
| `rrf_k`                    | `60`                                                                        | Reciprocal Rank Fusion constant (higher = flatter ranking)                 |
| `declaration_exact_ranker` | `true`                                                                      | Fuse ranker D (declaration-exact match) into `mast_search`. Set `false` to restore BM25-only ranking without a code change. |
| `chunk_split_threshold`    | `100`                                                                       | Lines above which a declaration is split into overlapping sub-chunks       |
| `context_lines`            | `3`                                                                         | Source lines before/after AST boundaries included in stored content        |
| `markdown_heading_depth`   | `2`                                                                         | Maximum ATX heading level (`##`) that starts a new markdown doc chunk      |

**`mast.config.json` example:**

```json
{
  "state_dir": ".mast",
  "exclude_patterns": ["node_modules/**", "dist/**", "**/*.test.ts"],
  "declaration_exact_ranker": true,
  "context_lines": 5
}
```

**`MAST_STATE_DIR`** — override the state directory without touching `mast.config.json`. Useful in CI or Docker environments where the project root is read-only.

---

## How It Works

### Indexing

`runIndex` walks the project with `fast-glob`, computes an mtime-based manifest, and diffs it against the stored manifest to find stale, added, and deleted files. For each file that needs processing:

1. **Parse** — `tree-sitter` parses the file into a concrete syntax tree. The TypeScript grammar is used for `.ts` and `.tsx`; the JavaScript grammar for `.js` and `.jsx`. Markdown files are chunked by heading (`markdown_heading_depth`), not parsed with tree-sitter.
2. **Chunk** — the extractor decomposes the CST into typed chunks: `function`, `class_shell` (the class declaration plus member signatures, without bodies), `method` (individual methods), `interface`, `type`, `export`, `block`, and `doc` (markdown sections). Classes are always decomposed so that a search for a single method doesn't return the entire class body.
3. **Sub-chunk** — declarations longer than `chunk_split_threshold` lines are split into overlapping segments so no single chunk is too large to be a useful, self-contained search result.
4. **Symbol graph** — symbols, imports, and edges (IMPLEMENTS, PARENT_OF, POTENTIAL_CALL) are written to SQLite. The two-pass write strategy (all files first, then edges) ensures edges can reference symbols that may be defined in a file parsed later in the same run.
5. **FTS** — chunk content is written to an FTS5 virtual table with a trigram tokeniser, enabling sub-token and camelCase searches. An `identifier_fts` table with a unicode61 tokeniser handles exact-identifier lookups for `mast_callers` potential matches.

Indexing is a single phase — chunk/graph/FTS all update together in one `runIndex` pass; there is no separate embedding step.

### Ranked Search (BM25 + Ranker D via RRF)

A query goes through two rankers:

**BM25 (FTS5):** The query is matched against `chunk_fts` using SQLite's built-in BM25 ranking, over a trigram tokeniser. File-pattern and language filters are pushed into this query as SQL predicates against the `files` table (not as FTS MATCH predicates, because SQLite FTS5 LIKE on UNINDEXED columns is unreliable with MATCH). BM25 scores in SQLite's convention are negative — more negative is a stronger match; `mast_search`'s `match_score` preserves that sign.

**Ranker D (declaration-exact):** A direct SQL predicate against `chunks.symbol_name` — full-name match or final-dot-segment match, case-insensitive, deterministically ordered. Gated by the `declaration_exact_ranker` config key (default on).

**RRF fusion:** The two ranked lists are combined using Reciprocal Rank Fusion:

```
score(chunk) = Σ 1 / (k + rank(chunk))
```

with default `k = 60`. A chunk appearing at rank 1 in both lists scores twice as high as a chunk appearing in only one. Chunks appearing in only one list still score well — neither signal dominates.

### JIT Staleness Checks

Read tools handle a file that changed since it was indexed in one of **two** ways. Which one a tool
uses is fixed per tool, not decided at runtime:

**Re-parse inline** — `mast_signature`, `mast_callers`, `mast_exports`, `mast_dependencies`,
`mast_rename_impact`. Before returning, each calls `jitRefreshFile`, which:

1. Reads the stored mtime for the file from the `files` table. **If there is no row, it returns
   immediately** — an unindexed file has no stored mtime to compare against, which is the whole of
   why JIT cannot discover new files.
2. Calls `stat()` on the file on disk.
3. If the disk mtime is newer, acquires the `structure.lock` and re-parses the file immediately,
   on the request path — the answer waits for it.

If the lock is held by a concurrent writer the previous chunk is returned with
`file_busy_returning_stale_cache` set, so the caller is told rather than quietly served stale data.

**Stat and flag** — `mast_search`, `mast_implementors`. These call `findStaleFiles`, which stats the
files behind the results and sets `stale: true` on the affected ones. **No re-parse is attempted**:
taking a write lock on a ranked result set would serialise the cheapest tools in the package behind
the most expensive operation in it. The line coordinates on a flagged result may be off; the caller
is expected to re-read or call a re-parsing tool.

**Neither** — `mast_project_skeleton` (documented exempt) and `mast_efficiency`.

Both mechanisms only ever touch files the index **already knows**. Neither can discover a file that
was never indexed, so a file created during a session is invisible to every read tool until
something reindexes it — which is why `mast serve` watches by default, and why `mast_search`
reports `unindexed_files` when the index is nonetheless behind.

### Startup Ladder

`mast serve` starts accepting MCP connections in under 1 second via a four-step ladder:

```
Step 1  Bootstrap state directory; copy Docker seed layer if present;
        best-effort remove orphaned pre-vector-store state              < 500ms
Step 2  Schema version check; open SQLite                               < 1s
Step 3  Register all 11 MCP tools; open stdio transport                 < 500ms
Step 4  Background incremental reindex                                  async
```

All tools are ready to serve as soon as Step 3 completes — there is no reduced-capability startup window. When a pre-built seed index is available at `/opt/mast-seed`, it is copied to the state directory in Step 1 — the background reindex in Step 4 then only needs to process files changed since the seed was built.

### Concurrency Model

One advisory lock coordinates concurrent writers:

- **`structure.lock`** — held by `runIndex` and JIT re-parses. Prevents two writers from modifying the SQLite graph simultaneously.

The lock uses `proper-lockfile` (POSIX advisory locks via a `.lock` marker file). A 10-second stale lock timeout prevents a crashed process from blocking the system indefinitely. Read tools never acquire a write lock — they may see a briefly inconsistent state during a concurrent reindex, and return `file_busy_returning_stale_cache: true` in that case.

### Storage Layout

```
.mast/
  graph.db              SQLite — symbols, edges, imports, chunks, FTS5 tables, metrics
  file_manifest.json    mtime snapshot from the last index run
  index.json            schema version, file count, chunk count, last_indexed
  config.json           resolved config written at init/serve time
  structure              lock marker (proper-lockfile target)
```

---

## Token Efficiency

Every tool call records its token count to `metrics` asynchronously. The record includes:

- `tokens_returned` — actual tokens in the response (Anthropic CL100k tokenizer)
- `tokens_full_file_upper_bound` — what a naive full-file read would have cost (when calculable)
- `duration_ms`, `session_id`, and `status`

`metrics_daily` rolls these up by `(day, tool_name)` with a running average for duration and running totals for token counts. The rollup upsert uses an incremental average formula to avoid storing all raw rows indefinitely:

```sql
avg_duration_ms = (old_avg * old_n + new_val) / (old_n + 1)
```

Use `mast metrics --since 7d` for a human-readable table, or `mast_efficiency` from within an MCP session for a machine-readable JSON summary with a `counterfactual` narrative.

---

## History

MAST originally fused BM25 with a vector-embedding search leg (LanceDB + a local ONNX embedding model). Measurement did not support keeping it: the vector store was removed 2026-08-06 per the M2 decision (see [ADR 003](adr/003-2026-08-04-vector-store-deletion.md)). The pre-deletion system — including the embedding pipeline and the eval instruments that measured it — is preserved at the git tag `mast-pre-vector-delete` for anyone re-running that evidence.
