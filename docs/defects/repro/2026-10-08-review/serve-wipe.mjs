// A running `mast serve` is asked to reindex an index another version stamped.
// usage: node serve-wipe.mjs <mast checkout> <project> <state dir>
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const [repo, project, state] = process.argv.slice(2);
const sdk = `${repo}/node_modules/@modelcontextprotocol/sdk/dist/esm/client`;
const { Client } = await import(`${sdk}/index.js`);
const { StdioClientTransport } = await import(`${sdk}/stdio.js`);
const transport = new StdioClientTransport({
  command: 'node',
  args: [`${repo}/dist/cli/index.js`, 'serve', '--no-watch', '--no-startup-reindex'],
  cwd: project,
  env: { ...process.env, MAST_STATE_DIR: state },
  stderr: 'ignore',
});
const client = new Client({ name: 'repro', version: '0' });
await client.connect(transport);
const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
const metrics = () => execFileSync('sqlite3', [`${state}/graph.db`, 'select count(*) from metrics']).toString().trim();
const files = () => execFileSync('sqlite3', [`${state}/graph.db`, 'select group_concat(path) from files']).toString().trim();
const found = async (query) => JSON.parse(await call('mast_search', { query })).results.map((r) => r.file_path);
try {
  console.log('  search "one" before:', JSON.stringify(await found('one')));
  await found('one');
  await new Promise((r) => setTimeout(r, 500));
  console.log('  metrics rows on disk before:', metrics());
  const stamp = `${state}/index.json`;
  writeFileSync(stamp, readFileSync(stamp, 'utf8').replace('"1.4.0"', '"1.3.0"'));
  writeFileSync(`${project}/src/fresh.ts`, 'export function freshlyAdded(): number { return 2; }\n');
  console.log('  mast_reindex:', (await call('mast_reindex', {})).slice(0, 200));
  console.log('  files in graph.db on disk:', files(), ' metrics rows on disk after:', metrics());
  console.log('  search "freshlyAdded" from the server:', JSON.stringify(await found('freshlyAdded')));
  console.log('  search "one" from the server:', JSON.stringify(await found('one')));
  console.log('  mast_reindex full:', (await call('mast_reindex', { full: true })).slice(0, 200));
  console.log('  search "freshlyAdded" again:', JSON.stringify(await found('freshlyAdded')));
} finally {
  await client.close();
}
