// Workspace project scope for Q2 (compiler cost) and Q3 (checker resolution).
//
// Methodology: pnpm-workspace.yaml declares four glob patterns — `packages/*`,
// `packages/kluster-bt/*`, `packages/workbench/foldv2/*`, `application/*` (plus
// a redundant explicit `packages/mast`). "The kluster monorepo" is defined here
// as every directory matching those globs that has BOTH a package.json and a
// tsconfig.json (i.e. a real, independently buildable TS package) — 25 projects,
// enumerated below.
//
// Explicitly SKIPPED, with reasons:
//   - packages/kluster-bt/ itself: no package.json (container dir only, matched
//     by `packages/*` but not independently buildable).
//   - packages/workbench/fold/* (v1) and packages/workbench/sdd/apps/*: not
//     matched by ANY pnpm-workspace.yaml glob — fold (v1, pre-foldv2) and the
//     SDD apps directory are scaffolded/generated output trees, not workspace
//     members. `sdd/apps/**` also contains .build/**/tsconfig.json — literally
//     one-off scratch dirs from prior spec-driven builds, not source.
//   - packages/workbench/foldv2/.example/**, archetypes/templates/*/tsconfig.base.json:
//     template/example tsconfig.base.json files meant to be `extends`-ed by
//     scaffolded output, not standalone buildable projects (no "include", or
//     the containing dir is example fixture data, not a workspace package).
//   - The root tsconfig.json and packages/tsconfig.base.json: base configs
//     (`extends`-ed by the 25 below); neither has an "include" of its own, so
//     ts.createProgram over either sees zero project files.
export const PROJECTS = [
  'packages/mast',
  'packages/kluster-bt/cli',
  'packages/kluster-bt/core',
  'packages/kluster-bt/llm-anthropic',
  'packages/kluster-bt/llm-ollama',
  'packages/kluster-bt/llm-openai',
  'packages/kluster-bt/llm-types',
  'packages/kluster-bt/nodes-fs',
  'packages/kluster-bt/nodes-git',
  'packages/kluster-bt/nodes-http',
  'packages/kluster-bt/nodes-llm',
  'packages/kluster-bt/workflows',
  'packages/workbench/foldv2/archetypes',
  'packages/workbench/foldv2/cli',
  'packages/workbench/foldv2/contracts',
  'packages/workbench/foldv2/gates',
  'packages/workbench/foldv2/library-vetting',
  'packages/workbench/foldv2/mast-bridge',
  'packages/workbench/foldv2/orchestrator',
  'packages/workbench/foldv2/phases',
  'packages/workbench/foldv2/reconcile',
  'packages/workbench/foldv2/runner-bridge',
  'packages/workbench/foldv2/schemas',
  'application/api',
  'application/ui',
];
