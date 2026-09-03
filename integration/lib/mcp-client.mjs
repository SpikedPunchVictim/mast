// A real MCP client over real stdio.
//
// The SDK is resolved from the INSTALL ROOT's node_modules — the copy that shipped with the
// package under test — not from this repository's. Testing the shipped transport against a
// different SDK build than the one a user gets is a category of green nobody wants.
import { createRequire } from 'node:module';
import { mastEntryPath, sanitizeEnv } from './exec.mjs';

export async function callMcpTool(installRoot, workingDir, tool, args) {
  const require = createRequire(`${installRoot}/node_modules/@spikedpunch/mast/package.json`);
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
  const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));

  const transport = new StdioClientTransport({
    command: process.execPath,
    // `--no-watch` because `serve` watches by default as of 2026-09-03: a chokidar watcher over
    // a 26k-file corpus would reindex underneath a running scenario and make its assertions
    // nondeterministic. The harness drives indexing explicitly, step by step.
    // NO positional argument. `mast serve` (`src/cli/serve.ts`) registers `--state-dir`,
    // `--no-startup-reindex` and `--watch` and takes ZERO positionals; passing the working
    // directory made commander exit "too many arguments for 'serve'" before the transport ever
    // spoke, so every `mcpCall` step failed as an unrunnable ERROR (LEDGER D042). The project
    // root comes from `cwd`, set below, which always did the job.
    args: [mastEntryPath(installRoot), 'serve', '--no-watch'],
    cwd: workingDir,
    env: sanitizeEnv(process.env),
  });
  const client = new Client({ name: 'mast-integration-harness', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content ?? []).map((c) => c.text ?? '').join('');
    return { text, raw: result };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Handshake only — proves `mast serve` speaks MCP over stdio and lists its tools. This is the
 *  whole of the editor-integration contract that is mast's to keep (ADR 015 §5). */
export async function listMcpTools(installRoot, workingDir) {
  const require = createRequire(`${installRoot}/node_modules/@spikedpunch/mast/package.json`);
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
  const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    // `--no-watch` because `serve` watches by default as of 2026-09-03: a chokidar watcher over
    // a 26k-file corpus would reindex underneath a running scenario and make its assertions
    // nondeterministic. The harness drives indexing explicitly, step by step.
    // NO positional argument. `mast serve` (`src/cli/serve.ts`) registers `--state-dir`,
    // `--no-startup-reindex` and `--watch` and takes ZERO positionals; passing the working
    // directory made commander exit "too many arguments for 'serve'" before the transport ever
    // spoke, so every `mcpCall` step failed as an unrunnable ERROR (LEDGER D042). The project
    // root comes from `cwd`, set below, which always did the job.
    args: [mastEntryPath(installRoot), 'serve', '--no-watch'],
    cwd: workingDir,
    env: sanitizeEnv(process.env),
  });
  const client = new Client({ name: 'mast-integration-harness', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * A PERSISTENT `mast serve` session: one server process, many calls, closed explicitly.
 *
 * `callMcpTool` above spawns a server per call and kills it, which is right for asserting on a
 * tool's answer and useless for asserting on `serve` itself. Everything `serve` actually owns is
 * a property of a SESSION and cannot survive a process that lives for one request: the file
 * watcher (§11.4) reindexing after the client connected, the startup reindex's effect on a later
 * query, and the freshness probe's cached `unindexed_files` count, which is primed in the
 * background at startup and read by whatever search comes next.
 *
 * `serveArgs` is passed verbatim so a scenario chooses its own flags. Nothing is defaulted —
 * notably NOT `--no-watch`, which the one-shot helpers hard-code: a scenario testing the watcher
 * must be able to leave it on, and one that would be made nondeterministic by it must be able to
 * say so itself.
 */
export async function openMcpSession(installRoot, workingDir, serveArgs = []) {
  const require = createRequire(`${installRoot}/node_modules/@spikedpunch/mast/package.json`);
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
  const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));

  const transport = new StdioClientTransport({
    command: process.execPath,
    // See LEDGER D042: `mast serve` takes ZERO positionals; the project root comes from `cwd`.
    args: [mastEntryPath(installRoot), 'serve', ...serveArgs],
    cwd: workingDir,
    env: sanitizeEnv(process.env),
  });
  const client = new Client({ name: 'mast-integration-harness', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  return {
    serveArgs,
    async call(tool, args) {
      const result = await client.callTool({ name: tool, arguments: args ?? {} });
      const text = (result.content ?? []).map((c) => c.text ?? '').join('');
      return { text, raw: result };
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}
