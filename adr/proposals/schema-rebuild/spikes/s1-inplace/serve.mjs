// Q3, Q4: what a running `mast serve` answers after another process rebuilds the
// index under it, by today's file removal and by the in-place clear.
// usage: node serve.mjs <mast checkout> <project copy> <state dir> remove|clear
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import Sqlite from 'better-sqlite3';
import { clearDerived } from './clear.mjs';

const [repo, project, state, arm] = process.argv.slice(2);
const cli = `${repo}/dist/cli/index.js`;
const env = { ...process.env, MAST_STATE_DIR: state };
const sdk = `${repo}/node_modules/@modelcontextprotocol/sdk/dist/esm/client`;
const { Client } = await import(`${sdk}/index.js`);
const { StdioClientTransport } = await import(`${sdk}/stdio.js`);

const index = () => execFileSync('node', [cli, 'index'], { cwd: project, env }).toString().trim().split('\n').pop();
const onDisk = (sql) => execFileSync('sqlite3', [`${state}/graph.db`, sql]).toString().trim();
console.log(`arm: ${arm}`);
console.log('  first index:', index());

const transport = new StdioClientTransport({
  command: 'node',
  args: [cli, 'serve', '--no-watch', '--no-startup-reindex'],
  cwd: project,
  env,
  stderr: 'ignore',
});
const client = new Client({ name: 'spike', version: '0' });
await client.connect(transport);
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const found = async (query) => [...new Set((await call('mast_search', { query })).results.map((r) => r.file_path))];
const callers = async (symbol) => {
  const answer = await call('mast_callers', { symbol });
  return (answer.verified_callers ?? []).map((c) => `${c.file_path}:${c.caller_symbol}`).sort();
};
const fromCli = (tool, args) => JSON.parse(execFileSync('node', [cli, 'query', '--json', tool, JSON.stringify(args)], { cwd: project, env }).toString());

try {
  console.log('  server before: search "freshlyAdded"', JSON.stringify(await found('freshlyAdded')), ' callers of K.save', JSON.stringify(await callers('K.save')));
  await new Promise((r) => setTimeout(r, 500));
  console.log('  metrics rows on disk before:', onDisk('select count(*) from metrics'));

  writeFileSync(
    `${project}/packages/static-instance/src/fresh.ts`,
    "import { K } from './st';\nexport function freshlyAdded(k: K): void { k.save(); }\n",
  );
  if (arm === 'remove') {
    const stamp = `${state}/index.json`;
    writeFileSync(stamp, readFileSync(stamp, 'utf8').replace(/"schema_version": "[^"]+"/, '"schema_version": "1.3.0"'));
  } else {
    const sqlite = new Sqlite(`${state}/graph.db`);
    sqlite.pragma('busy_timeout = 5000');
    console.log('  clear in place:', JSON.stringify(clearDerived(sqlite).ms.toFixed(1)), 'ms');
    sqlite.close();
  }
  console.log('  rebuild by a second process:', index());
  console.log('  on disk after: files', onDisk('select count(*) from files'), ' metrics rows', onDisk('select count(*) from metrics'));

  console.log('  server after:  search "freshlyAdded"', JSON.stringify(await found('freshlyAdded')), ' callers of K.save', JSON.stringify(await callers('K.save')));
  const cliCallers = (fromCli('mast_callers', { symbol: 'K.save' }).verified_callers ?? []).map((c) => `${c.file_path}:${c.caller_symbol}`).sort();
  console.log('  a new process: callers of K.save', JSON.stringify(cliCallers));
  const status = await call('mast_status', {});
  console.log('  server mast_status:', JSON.stringify({ file_count: status.file_count, stale_files: status.stale_files, cause: status.cause ?? null }));
} finally {
  await client.close();
}
