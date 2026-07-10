// Helper — dump the corpus so gold-set targets can be grounded in real chunks.
//
// Usage:
//   node eval/dump-corpus.mjs                 # summary stats
//   node eval/dump-corpus.mjs grep <regex>    # chunks whose file/symbol match
//   node eval/dump-corpus.mjs file <substr>   # chunks in files matching substr

import { LanceStore } from '../dist/store/lance.js';
import { BASE_STATE_DIR } from './paths.mjs';

const lance = await LanceStore.open(BASE_STATE_DIR);
const chunks = await lance.getAllChunks();

const [mode, arg] = process.argv.slice(2);

if (!mode) {
  const byType = new Map();
  const byLang = new Map();
  let maxLines = 0;
  const longChunks = [];
  for (const c of chunks) {
    byType.set(c.chunk_type, (byType.get(c.chunk_type) ?? 0) + 1);
    byLang.set(c.language, (byLang.get(c.language) ?? 0) + 1);
    const lines = c.end_line - c.start_line + 1;
    if (lines > maxLines) maxLines = lines;
    if (c.content.length > 6000) longChunks.push({ f: c.file_path, s: c.symbol_name, chars: c.content.length });
  }
  console.log(`total chunks: ${chunks.length}`);
  console.log('by type:', Object.fromEntries([...byType].sort((a, b) => b[1] - a[1])));
  console.log('by lang:', Object.fromEntries([...byLang].sort((a, b) => b[1] - a[1])));
  console.log(`max chunk lines: ${maxLines}`);
  console.log(`chunks > 6000 chars: ${longChunks.length}`);
} else if (mode === 'grep') {
  const rx = new RegExp(arg, 'i');
  const hits = chunks.filter((c) => rx.test(`${c.file_path} ${c.symbol_name ?? ''}`));
  for (const c of hits.slice(0, 60)) {
    console.log(`${c.file_path}\t${c.chunk_type}\t${c.symbol_name ?? '-'}\tL${c.start_line}-${c.end_line}\t${c.content.length}ch`);
  }
  console.log(`(${hits.length} hits)`);
} else if (mode === 'file') {
  const hits = chunks.filter((c) => c.file_path.includes(arg));
  for (const c of hits.slice(0, 80)) {
    console.log(`${c.file_path}\t${c.chunk_type}\t${c.symbol_name ?? '-'}\tL${c.start_line}-${c.end_line}`);
  }
  console.log(`(${hits.length} hits)`);
}
