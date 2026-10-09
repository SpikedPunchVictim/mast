// D138 end to end, with the shipped code: what `mast status`, `mast search`,
// `mast query` and the read tools of a running server say over an index
// another schema version built. The other version is a released mast, not a
// stamp edited by hand, except in case 5 (no newer mast exists to build one).
// usage: node run.mjs <new checkout, built> <old checkout, built> <project copy> <empty state dir>
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [newRepo, oldRepo, project, state] = process.argv.slice(2);
const env = { ...process.env, MAST_STATE_DIR: state };
const sdk = `${newRepo}/node_modules/@modelcontextprotocol/sdk/dist/esm/client`;
const { Client } = await import(`${sdk}/index.js`);
const { StdioClientTransport } = await import(`${sdk}/stdio.js`);
const scrub = (s) => s.split(state).join('<state>').split(project).join('<project>').replace(/duration: \d+ms/, 'duration: Nms');
const run = (repo, keep, ...args) => {
  const r = spawnSync('node', [`${repo}/dist/cli/index.js`, ...args], { cwd: project, env, encoding: 'utf8' });
  const lines = `${r.stderr}${r.stdout}`.trim().split('\n').filter((l) => keep.test(l));
  return `${scrub(lines.join('\n     ')).slice(0, 700)}\n     (exit ${r.status})`;
};
const INDEX = /^\[mast\]|^files:|^mast:/;
const STATUS = /schema_version|index_fresh|freshness_cause|^!|^ {2}(?!changed|unindexed|deleted)\S|^index:/;
const ANSWER = /^the index|^\[mast\]|st\.ts/;
const stampFile = `${state}/index.json`;
const stamp = () => JSON.parse(readFileSync(stampFile, 'utf8')).schema_version;

console.log('1. index by this mast:', run(newRepo, INDEX, 'index'));

const transport = new StdioClientTransport({
  command: 'node',
  args: [`${newRepo}/dist/cli/index.js`, 'serve', '--no-watch', '--no-startup-reindex'],
  cwd: project,
  env,
  stderr: 'ignore',
});
const client = new Client({ name: 'spike', version: '0' });
await client.connect(transport);
const tool = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return `${r.isError === true ? 'isError ' : ''}${scrub(r.content[0].text).slice(0, 330).replace(/\s+/g, ' ')}`;
};
const statusOf = async () => {
  const s = JSON.parse((await client.callTool({ name: 'mast_status', arguments: {} })).content[0].text);
  return JSON.stringify({ schema_version: s.schema_version, index_schema_version: s.index_schema_version, index_fresh: s.index_fresh, freshness_cause: s.freshness_cause });
};

try {
  console.log('2. a server of this mast is running. mast_search K ->', await tool('mast_search', { query: 'K', limit: 1 }));
  console.log('   mast_status ->', await statusOf());

  console.log('3. the released older mast runs `mast index` on the same state dir:', run(oldRepo, INDEX, 'index'));
  console.log('   stamp:', stamp());
  console.log('   this server, mast_status ->', await statusOf());
  for (const [name, args] of [
    ['mast_search', { query: 'K' }], ['mast_signature', { symbol: 'K' }], ['mast_callers', { symbol: 'K.save' }],
    ['mast_exports', { file_path: 'packages/static-instance/src/st.ts' }],
  ]) console.log(`   this server, ${name} ->`, await tool(name, args));
  console.log('   this CLI, mast status:\n    ', run(newRepo, STATUS, 'status'));
  console.log('   this CLI, mast search K:', run(newRepo, ANSWER, 'search', 'K'));
  console.log('   this CLI, mast query mast_callers:', run(newRepo, ANSWER, 'query', 'mast_callers', '{"symbol":"K.save"}'));

  console.log('4. this server, mast_reindex ->', await tool('mast_reindex', {}));
  console.log('   stamp:', stamp());
  console.log('   this server, mast_status ->', await statusOf());
  console.log('   this server, mast_search K ->', await tool('mast_search', { query: 'K', limit: 1 }));

  const built = JSON.parse(readFileSync(stampFile, 'utf8'));
  writeFileSync(stampFile, JSON.stringify({ ...built, schema_version: '9.9.0' }));
  console.log('5. stamp set to 9.9.0 by hand.');
  console.log('   this server, mast_status ->', await statusOf());
  console.log('   this server, mast_search K ->', await tool('mast_search', { query: 'K', limit: 1 }));
  console.log('   this CLI, mast search K:', run(newRepo, ANSWER, 'search', 'K'));
  console.log('   this CLI, mast search --reindex K:', run(newRepo, ANSWER, 'search', '--reindex', 'K'));
  console.log('   this CLI, mast status:\n    ', run(newRepo, STATUS, 'status'));

  writeFileSync(stampFile, JSON.stringify({ ...built, schema_version: '1.3.0' }));
  console.log('6. stamp set to 1.3.0 by hand: this CLI, mast search --reindex K:', run(newRepo, ANSWER, 'search', '--reindex', 'K'));
  console.log('   stamp:', stamp());

  writeFileSync(stampFile, '');
  console.log('7. index.json emptied.');
  console.log('   this CLI, mast status:\n    ', run(newRepo, STATUS, 'status'));
  console.log('   this server, mast_status ->', await statusOf());
  console.log('   this server, mast_search K ->', await tool('mast_search', { query: 'K', limit: 1 }));
} finally {
  await client.close();
}
