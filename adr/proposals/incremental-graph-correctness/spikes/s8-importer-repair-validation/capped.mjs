// usage: node capped.mjs <dist> <project> <budgetMs|none>
const [dist, project, budget] = process.argv.slice(2);
const { runIndex } = await import(`${dist}/indexer/index.js`);
const { resolveConfig } = await import(`${dist}/store/config.js`);
const config = resolveConfig({ projectRoot: project });
const r = await runIndex(config, { incremental: true, ...(budget !== 'none' ? { edgeRepairBudgetMs: Number(budget) } : {}) });
console.log(JSON.stringify({ indexed: r.filesIndexed, reResolved: r.filesReResolved, pending: r.edgeRepairsPending, ms: r.durationMs, phase: r.phaseMs }));
