import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const R = process.argv[4] ?? new URL('../../../../../', import.meta.url).pathname;
const { startWatchMode } = await import(join(R,'dist/indexer/watcher.js'));
const { resolveConfig } = await import(join(R,'dist/store/config.js'));
process.env.MAST_STATE_DIR = mkdtempSync(join(tmpdir(),'mast-hang-'));
const mode = process.argv[3];
for (let i=1;i<=8;i++){
  const ready=Promise.withResolvers(); const t=performance.now();
  const h=startWatchMode({config:resolveConfig({projectRoot:process.argv[2]}),settleMs:0,runBatch:async()=>{},onWarn:(m)=>console.log('warn',m),onReady:()=>ready.resolve(), ...(mode==='noask'?{isSymbolicLink:()=>false}:{})});
  const r = await Promise.race([ready.promise.then(()=> 'ready'), new Promise(r=>setTimeout(()=>r('NOT READY after 20s'),20000))]);
  const t2=performance.now();
  const c = await Promise.race([h.close().then(()=>'closed'), new Promise(r=>setTimeout(()=>r('CLOSE HUNG 20s'),20000))]);
  console.log(mode,i,r,Math.round(t2-t),'ms',c,Math.round(performance.now()-t2),'ms');
  if (r!=='ready'||c!=='closed') process.exit(1);
}
process.exit(0);
