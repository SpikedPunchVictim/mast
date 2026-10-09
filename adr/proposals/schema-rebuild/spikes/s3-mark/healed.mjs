// D142 end to end, with the shipped code: a `mast serve` of an older released
// version is running while this mast rebuilds the index, then refreshes one
// edited file on a read. Does the next run of this mast put that file right?
// usage: node healed.mjs <new checkout, built> <old checkout, built> <project copy> <empty state dir>
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const [newRepo, oldRepo, project, state] = process.argv.slice(2);
const env = { ...process.env, MAST_STATE_DIR: state };
const sdk = `${newRepo}/node_modules/@modelcontextprotocol/sdk/dist/esm/client`;
const { Client } = await import(`${sdk}/index.js`);
const { StdioClientTransport } = await import(`${sdk}/stdio.js`);
const run = (repo, ...args) => {
  const r = spawnSync('node', [`${repo}/dist/cli/index.js`, ...args], { cwd: project, env, encoding: 'utf8' });
  const lines = `${r.stderr}${r.stdout}`.trim().split('\n').filter((l) => /^\[mast\]|^files:|^mast:/.test(l));
  return `${lines.join(' / ').replace(/duration: \d+ms/, 'duration: Nms')} (exit ${r.status})`;
};
const onDisk = (sql) => execFileSync('sqlite3', [`${state}/graph.db`, sql], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const stamp = () => JSON.parse(readFileSync(`${state}/index.json`, 'utf8')).schema_version;
const aliasFile = 'packages/static-instance/src/al.ts';
const disk = () => {
  const alias = onDisk(`select coalesce(i.aliases, 'NULL') from imports i join files f on f.id = i.file_id where f.path = '${aliasFile}'`);
  const unmarked = onDisk("select coalesce(group_concat(path), '') from files where written_by is not '1.4.0'");
  return `stamp ${stamp()}, files ${onDisk('select count(*) from files')}, alias of al.ts [${alias}], rows not marked 1.4.0 [${unmarked}]`;
};
const staleOf = () => {
  const out = spawnSync('node', [`${newRepo}/dist/cli/index.js`, 'status'], { cwd: project, env, encoding: 'utf8' }).stdout;
  return out.split('\n').filter((l) => /stale_files|index_fresh/.test(l)).map((l) => l.replace(/\s+/g, ' ').trim()).join(', ');
};

writeFileSync(`${project}/${aliasFile}`, "import { K as Kay } from './st';\nexport function viaAlias(k: Kay): void { k.save(); }\n");
console.log('1. index by the old mast:', run(oldRepo, 'index'));

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

try {
  await text('mast_search', { query: 'viaAlias' });
  console.log('2. the old server is running and has answered a search');
  console.log('3. index --incremental by the new mast:', run(newRepo, 'index', '--incremental'));
  console.log('   on disk:', disk());
  appendFileSync(`${project}/${aliasFile}`, 'export function addedLater(): number { return 1; }\n');
  await text('mast_signature', { symbol: 'viaAlias' });
  console.log('4. al.ts edited; the old server answered mast_signature for a symbol in it');
  console.log('   on disk:', disk());
  console.log('   new mast status:', staleOf());
  console.log('5. index --incremental by the new mast:', run(newRepo, 'index', '--incremental'));
  console.log('   on disk:', disk());
  console.log('   new mast status:', staleOf());
  console.log('6. old server: mast_reindex ->', (await text('mast_reindex', {})).slice(0, 120).replace(/\s+/g, ' '));
  console.log('   stamp:', stamp());
  console.log('7. index --incremental by the new mast:', run(newRepo, 'index', '--incremental'));
  console.log('   on disk:', disk());
} finally {
  await client.close();
}
