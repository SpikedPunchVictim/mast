// usage: node full.mjs <dist> <project> <state-dir>  — full index into a separate state dir
const [dist, project, stateDir] = process.argv.slice(2);
const { runIndex } = await import(`${dist}/indexer/index.js`);
const { resolveConfig } = await import(`${dist}/store/config.js`);
const r = await runIndex(resolveConfig({ projectRoot: project, stateDirOverride: stateDir }), { incremental: false });
console.log(JSON.stringify({ indexed: r.filesIndexed, ms: r.durationMs }));
