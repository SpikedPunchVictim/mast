// Q7: a `mast serve` of the previous schema version is running when a newer
// mast rebuilds the index. usage: node mixed.mjs <new checkout> <old checkout> <project copy> <state dir> remove|clear
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import Sqlite from 'better-sqlite3';
import { clearDerived } from './clear.mjs';

const [newRepo, oldRepo, project, state, arm] = process.argv.slice(2);
const env = { ...process.env, MAST_STATE_DIR: state };
const sdk = `${newRepo}/node_modules/@modelcontextprotocol/sdk/dist/esm/client`;
const { Client } = await import(`${sdk}/index.js`);
const { StdioClientTransport } = await import(`${sdk}/stdio.js`);
const index = (repo) => execFileSync('node', [`${repo}/dist/cli/index.js`, 'index'], { cwd: project, env }).toString().trim().split('\n').pop();
const onDisk = (sql) => execFileSync('sqlite3', [`${state}/graph.db`, sql], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const stampPath = `${state}/index.json`;
const stamp = () => JSON.parse(readFileSync(stampPath, 'utf8')).schema_version;
const aliasFile = 'packages/static-instance/src/al.ts';
const aliasRows = () => {
  try {
    return onDisk(`select coalesce(i.aliases, 'NULL') from imports i join files f on f.id = i.file_id where f.path = '${aliasFile}'`);
  } catch {
    return 'the imports table has no aliases column';
  }
};
const disk = () => `stamp ${stamp()}, files ${onDisk('select count(*) from files')}, aliases of al.ts imports [${aliasRows()}]`;

writeFileSync(`${project}/${aliasFile}`, "import { K as Kay } from './st';\nexport function viaAlias(k: Kay): void { k.save(); }\n");
console.log(`arm: ${arm}`);
console.log('  index by the old mast:', index(oldRepo));
console.log('  on disk:', disk());

const transport = new StdioClientTransport({
  command: 'node',
  args: [`${oldRepo}/dist/cli/index.js`, 'serve', '--no-watch', '--no-startup-reindex'],
  cwd: project,
  env,
  stderr: 'ignore',
});
const client = new Client({ name: 'spike', version: '0' });
await client.connect(transport);
const text = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
const found = async (query) => [...new Set(JSON.parse(await text('mast_search', { query })).results.map((r) => r.file_path))];

try {
  console.log('  old server: search "viaAlias"', JSON.stringify(await found('viaAlias')));
  if (arm === 'clear') {
    const sqlite = new Sqlite(`${state}/graph.db`);
    sqlite.pragma('busy_timeout = 5000');
    clearDerived(sqlite);
    sqlite.close();
    writeFileSync(stampPath, readFileSync(stampPath, 'utf8').replace('"1.3.0"', '"1.4.0"'));
  }
  console.log('  index by the new mast:', index(newRepo));
  console.log('  on disk:', disk());
  // Q8: a per-file mark only the new mast writes. Here it is put on by hand.
  onDisk("alter table files add column written_by TEXT; update files set written_by = '1.4.0'");
  const unmarked = () => `files with no mark [${onDisk("select group_concat(path) from files where written_by is null")}] of ${onDisk('select count(*) from files')}`;

  appendFileSync(`${project}/${aliasFile}`, 'export function addedLater(): number { return 1; }\n');
  console.log('  al.ts edited. old server: search "addedLater"', JSON.stringify(await found('addedLater')));
  console.log('  old server: mast_signature viaAlias ->', (await text('mast_signature', { symbol: 'viaAlias' })).slice(0, 160).replace(/\s+/g, ' '));
  console.log('  on disk:', disk(), '|', unmarked());
  console.log('  old server: mast_reindex ->', (await text('mast_reindex', {})).slice(0, 160).replace(/\s+/g, ' '));
  let marks;
  try {
    marks = unmarked();
  } catch {
    marks = 'the files table has no written_by column';
  }
  console.log('  on disk:', disk(), '|', marks);
} finally {
  await client.close();
}
