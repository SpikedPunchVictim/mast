# ADR 014 — Packaging and the first-run experience

- **Status:** Accepted and shipped
- **Decided:** 2026-08-19
- **Evidence:** `package.json`, `.github/workflows/release.yml`, `RELEASING.md`, `README.md`, `assets/skill.md`, `src/cli/`

## Context

MAST was measured, correct, and **uninstallable**. Running the first-run path end to end
on a fresh project found the engine in good shape — `init` indexed in 49 ms, `status` was
informative, `mast_search` returned a correct ranked chunk — and every failure in the
packaging layer around it:

- `"private": true`, so `npm publish` refused outright.
- The README's install command was `pnpm --filter @kluster/mast build` — wrong package
  name, and no workspace to filter, both stale since the eject.
- The MCP configuration example pointed at a path deleted by the eject.
- `dist/` is gitignored with no `prepublishOnly`, so a publish from a clean checkout
  would ship an empty `dist/` and report success. **This is D8's shape one layer out** —
  the artifact that ships not being built from the source at that commit.
- The CLI hardcoded `.version('0.1.0')` beside package.json's own version: two producers
  of one value (S-05), in exactly the place D8 made expensive.
- Default excludes still carried `.kluster/**`, meaningless to any other consumer.

## Decisions

### 1. Publish `@spikedpunch/mast` to the public npm registry

Chosen over GitHub Packages (which needs an `.npmrc` and a token per consumer, even for
public packages) and over installing from git (which forces every consumer to have a C++
toolchain for `tree-sitter`, and makes upgrades a SHA).

### 2. Releases are tag-driven, via Trusted Publishing — and the first one is not

`.github/workflows/release.yml` publishes on a `v*` tag using npm's OIDC Trusted
Publishing with provenance. **There is no `NPM_TOKEN` and there should never be one.**

The bootstrap is genuinely circular and is documented rather than worked around: Trusted
Publishing binds an *existing* package to a *named workflow*, so the package must exist
before it can be configured and the configuration must exist before CI can publish. v0.1.0
is published from a laptop once; every release after is a tag push. `RELEASING.md` owns it.

The workflow runs the full PR gate plus one check aimed at D8 specifically: assert the
freshly built binary reports the version being released, before the tarball reaches the
registry.

### 3. `mast upgrade` checks and instructs; it does not upgrade

A CLI cannot reliably know whether it is a global install, a dev dependency, a `dlx`
invocation, or a monorepo catalog entry — and guessing wrong runs the wrong command in
someone's repository. Self-mutating also needs write access to its own install directory,
which is exactly what fails in CI and containers.

The reason the command exists at all is the half a package manager **cannot** serve:
upgrading across a `CURRENT_SCHEMA_VERSION` change makes `bootstrapState` discard the
index and reindex from scratch. On a 150k-chunk monorepo that is minutes of silence on the
next `serve`, and `pnpm up` will never mention it. `mast upgrade` reports it in advance,
quoting the user's own chunk count.

An unreachable registry reports **unknown**, never "up to date" — a lie in that direction
is the expensive one.

### 4. `mast docs` and `mast skill` ship inside the package

Both read files from the installed package rather than pointing at a website, so what a
reader gets is what their binary does. The step this removes — work out your version, then
find the matching docs — is the step where a reader silently ends up on the wrong ones.

`mast skill` exists because registering an MCP server gives a model the tools but not the
judgement. It carries the usage rules and, more importantly, how to read a flagged answer:
staleness, truncation, and that **an empty result is not proof of absence** because only
TypeScript, JavaScript, and Markdown are indexed. That last point is the S0 confusion this
package's severity scale is built around, delivered to the agent that would otherwise act
on it.

### 5. `mast search` is a presentation layer, never a second implementation

It dispatches through `runQuery` to the registered MCP handler exactly as `mast query`
does. Ranking, JIT refresh, staleness flags, and `_stats` therefore cannot diverge between
the CLI and what an assistant sees — re-implementing any of it is the drift D0 exists to
prevent. `mast query` remains the exact-parity surface for scripts.

## Consequences

- Three drift guards now exist where prose and code state the same thing, each
  mutation-verified: version ↔ manifest, skill text ↔ tool registry, README ↔ command
  registry.
- Commands are registered in exactly one place, `buildProgram()`. The first version of the
  README guard re-listed the register functions and could therefore have gone stale in
  step with the CLI — the flaw it was written to catch.
- `MAST_SPEC.md`'s documented defaults are enforced by D3's conformance test, which caught
  the excludes change during this work. That is the test doing its job.

## What this does not claim

**Nothing here is published yet.** The manifest, workflow, and instructions are in place;
v0.1.0 has not been pushed to npm and the Trusted Publisher relationship has not been
registered. Until both happen, `mast upgrade` correctly reports the latest version as
unknown, because the package does not exist on the registry.

Install was verified by `npm pack --dry-run` and by running the built binary against a
scratch project and against this repository. **It has not been verified by installing the
tarball into a clean project on another machine** — in particular, the native-module story
(`better-sqlite3`, `tree-sitter`) is unverified on Windows and on Linux ABIs other than
this one. That is the first thing to test after the initial publish.

The MCP configuration snippets for Cursor, VS Code, Windsurf, and Zed are written from
each tool's documented config format and **have not been executed** against those clients.
Claude Code and the CLI path are the two that were run.
