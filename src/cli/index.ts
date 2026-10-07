#!/usr/bin/env node
// `hook` is dispatched before the program is imported: a hook runs ahead of every Grep,
// and importing the program (commander, zod, typescript, kysely, the MCP SDK) costs about
// a second. See ADR 017 section 5 and hook-import-graph.test.ts.
if (process.argv[2] === 'hook') {
  const { runHookFromProcess } = await import('./hook.js');
  await runHookFromProcess(process.argv[3] ?? '', process.argv[4] ?? '');
} else {
  const { runCli } = await import('./program.js');
  const exitCode = await runCli(process.argv, (text) => process.stderr.write(text));
  if (exitCode !== undefined) process.exitCode = exitCode;
}
