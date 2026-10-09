import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const R = new URL('../../../../../', import.meta.url).pathname;
const { startWatchMode } = await import(join(R,'dist/indexer/watcher.js'));
const { resolveConfig } = await import(join(R,'dist/store/config.js'));
const base = realpathSync(mkdtempSync(join(tmpdir(),'mast-linkroot-')));
const real = join(base,'real'); mkdirSync(join(real,'src'),{recursive:true}); writeFileSync(join(real,'src','a.ts'),'export const a=1;\n');
const link = join(base,'link'); symlinkSync(real, link);
process.env.MAST_STATE_DIR = mkdtempSync(join(tmpdir(),'mast-linkroot-state-'));
for (const [label, root] of [['root is a real path', real], ['root is a symbolic link', link], ['root under /tmp-style unresolved tmpdir', null]]) {
  if (root === null) continue;
  const config = resolveConfig({projectRoot: root});
  const batches=[]; const ready=Promise.withResolvers();
  const h = startWatchMode({ config, debounceMs:200, runBatch: async (p)=>{ batches.push(p); }, onWarn:(m)=>console.log('warn',m), onReady:()=>ready.resolve() });
  await ready.promise;
  writeFileSync(join(root,'src','a.ts'),`export const a=${Date.now()};\n`);
  await new Promise(r=>setTimeout(r,1500));
  writeFileSync(join(root,'src','new'+label.length+'.ts'),'export const n=1;\n');
  await new Promise(r=>setTimeout(r,1500));
  console.log(label, '| resolved root', config.resolved_project_root === root ? 'as given' : config.resolved_project_root, '| batches', batches.length);
  await h.close();
}
