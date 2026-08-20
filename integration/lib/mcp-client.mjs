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
    // NO positional argument. `mast serve` (`src/cli/serve.ts`) registers `--state-dir`,
    // `--no-startup-reindex` and `--watch` and takes ZERO positionals; passing the working
    // directory made commander exit "too many arguments for 'serve'" before the transport ever
    // spoke, so every `mcpCall` step failed as an unrunnable ERROR (LEDGER D042). The project
    // root comes from `cwd`, set below, which always did the job.
    args: [mastEntryPath(installRoot), 'serve'],
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
    // NO positional argument. `mast serve` (`src/cli/serve.ts`) registers `--state-dir`,
    // `--no-startup-reindex` and `--watch` and takes ZERO positionals; passing the working
    // directory made commander exit "too many arguments for 'serve'" before the transport ever
    // spoke, so every `mcpCall` step failed as an unrunnable ERROR (LEDGER D042). The project
    // root comes from `cwd`, set below, which always did the job.
    args: [mastEntryPath(installRoot), 'serve'],
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
