const { assertIndexOfThisVersion } = await import(process.argv[2] + '/dist/store/index-stamp.js');
const dir = process.argv[3];
for (let i = 0; i < 1000; i++) assertIndexOfThisVersion(dir);
const runs = [];
for (let r = 0; r < 5; r++) {
  const t = process.hrtime.bigint();
  for (let i = 0; i < 10000; i++) assertIndexOfThisVersion(dir);
  runs.push(Number(process.hrtime.bigint() - t) / 1e6 / 10000 * 1000);
}
console.log('µs per call, five runs of 10,000:', runs.map((x) => x.toFixed(1)).join(', '));
