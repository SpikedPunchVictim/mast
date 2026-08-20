import type { Command } from 'commander';
import { runQuery, QueryError } from './query.js';

/**
 * `mast search <query>` — the readable front door to `mast_search`.
 *
 * This is a presentation layer, not a second search implementation. It builds
 * `mast_search`'s arguments and dispatches through `runQuery`, which routes to the
 * registered MCP handler exactly as `mast query` does (D0). Ranking, JIT refresh,
 * staleness flags, and `_stats` therefore cannot drift between the two surfaces —
 * re-implementing any of it here is the drift D0 exists to prevent.
 *
 * `mast query mast_search '{...}'` remains the exact-MCP-parity surface for scripts;
 * this one is for a human at a terminal, and prints text rather than JSON.
 */

export interface SearchFlags {
  readonly limit?: string;
  readonly type?: string;
  readonly language?: string;
  readonly exported?: boolean;
  readonly file?: string;
}

/** Maps CLI flags onto `mast_search`'s schema fields. Absent flags are omitted, not nulled. */
export function buildSearchArgs(query: string, flags: SearchFlags): string {
  const args: Record<string, unknown> = { query };
  if (flags.limit !== undefined) {
    // Commander hands through whatever was typed; `Number('ten')` is NaN, which
    // would serialise as `null` and be rejected far from the mistake.
    const limit = Number(flags.limit);
    if (!Number.isInteger(limit)) throw new QueryError(`--limit must be a whole number, got "${flags.limit}"`);
    args['limit'] = limit;
  }
  if (flags.type !== undefined) args['chunk_type'] = flags.type;
  if (flags.language !== undefined) args['language'] = flags.language;
  if (flags.exported === true) args['only_exported'] = true;
  if (flags.file !== undefined) args['file_pattern'] = flags.file;
  return JSON.stringify(args);
}

interface SearchHit {
  readonly file_path?: string;
  readonly start_line?: number;
  readonly symbol_name?: string | null;
  readonly chunk_type?: string;
  readonly is_exported?: boolean;
  readonly content?: string;
  // PER-RESULT, not top-level — `mcp/tools/search.ts:43` spreads it into each hit
  // whose file has changed since indexing. The formatter's top-level signal scan
  // therefore cannot see it, which is the whole of defect D029.
  readonly stale?: boolean;
}

/** Zero-result assist emitted by `mast_search`; dropping it silently was part of D029. */
interface SearchSuggestion {
  readonly symbol?: string;
  readonly file_path?: string;
}

/**
 * Renders the MCP response as text.
 *
 * Every confidence signal the response carries is echoed. An empty result that is
 * empty *because* the index was busy or stale reads identically to "this symbol
 * does not exist" unless the flag is shown — the S0 confusion this package's whole
 * severity scale is built around.
 */
export function formatSearchResults(responseText: string): string {
  const res = JSON.parse(responseText) as {
    results?: readonly SearchHit[];
    suggestions?: readonly SearchSuggestion[];
    // `mast_search` sets this only on the empty-result path (M6, ADR 008). Without
    // it, "the index is empty" and "this symbol does not exist" print identically.
    index_empty?: boolean;
    // Field names taken from a captured `mast_search` response, not from memory —
    // an earlier version of this file guessed `returned_tokens`/`full_file_tokens`
    // and silently printed nothing, because the guess only ever met a hand-written
    // fixture that shared it (shape S-09).
    _stats?: { tokens_returned?: number; tokens_full_file_upper_bound?: number };
    [flag: string]: unknown;
  };
  const lines: string[] = [];

  // Top-level flags. `mast_search` emits none of these — it reserves
  // `file_busy_returning_stale_cache` for the other tools (mcp/tools/search.ts:33) —
  // so this branch is kept for shape compatibility and is NOT what protects search.
  // The three signals search really emits are handled below.
  const signals = Object.keys(res).filter(
    (k) => /^(file_busy|stale|index_stale|truncated|potential_truncated)/.test(k) && res[k] === true,
  );
  if (signals.length > 0) lines.push(`! ${signals.join(', ')} — this answer may be incomplete`, '');

  const hits = res.results ?? [];
  const staleHits = hits.filter((h) => h.stale === true).length;
  if (staleHits > 0) {
    lines.push(
      `! ${String(staleHits)} of ${String(hits.length)} results are from files that changed since indexing —`,
      `  the code shown below may be out of date. Run \`mast index\` to refresh.`,
      '',
    );
  }

  if (hits.length === 0) {
    if (res.index_empty === true) {
      // The M6 case (ADR 008): an answer that is empty because the system has
      // nothing to answer FROM must not read like a searched-and-not-found.
      lines.push('nothing is indexed at this path — this is not evidence the symbol is absent.');
      lines.push('run `mast index` first, or check `mast status` for the path being used.');
    } else {
      lines.push('no matches (mast indexes TypeScript, JavaScript, and Markdown only —');
      lines.push('a symbol in any other language is invisible to it, not absent from the repo)');
    }
    for (const g of res.suggestions ?? []) {
      lines.push(`  did you mean: ${g.symbol ?? '?'}${g.file_path !== undefined ? `  (${g.file_path})` : ''}`);
    }
  } else {
    for (const h of hits) {
      const where = `${h.file_path ?? '?'}:${String(h.start_line ?? '?')}`;
      const what = [h.symbol_name, h.chunk_type].filter(Boolean).join('  ');
      const marks = [h.is_exported === true ? '(exported)' : '', h.stale === true ? '[STALE]' : '']
        .filter(Boolean).join('  ');
      lines.push(`${where}  ${what}${marks === '' ? '' : `  ${marks}`}`);
      for (const l of (h.content ?? '').split('\n')) lines.push(`    ${l}`);
      lines.push('');
    }
  }

  const s = res._stats;
  const got = s?.tokens_returned;
  const whole = s?.tokens_full_file_upper_bound;
  // Only meaningful when something matched: with no results the bound is 0 and the
  // line renders "7 tokens returned vs 0 — 0% MORE", a comparison against nothing
  // printed as a verdict.
  if (hits.length > 0 && got !== undefined && whole !== undefined) {
    // `tokens_full_file_upper_bound` is a bound on reading the referenced files
    // whole. On small files a ranked result set can exceed it, and the saving is
    // then negative — reported as such rather than clamped, because a tool whose
    // efficiency number can only ever look good is not an efficiency number.
    const saved = whole - got;
    const pct = whole > 0 ? Math.round((saved / whole) * 100) : 0;
    lines.push(saved >= 0
      ? `${String(got)} tokens returned vs ${String(whole)} to read the files whole — ${String(pct)}% saved`
      : `${String(got)} tokens returned vs ${String(whole)} to read the files whole — ${String(-pct)}% MORE (the matched files are small enough to read outright)`);
  }
  return lines.join('\n');
}

export function registerSearchCommand(program: Command): void {
  program
    .command('search <query> [path]')
    .description('Search the index and print readable results (see `mast query mast_search` for raw MCP output)')
    .option('--state-dir <dir>', 'State directory')
    .option('-n, --limit <n>', 'Max results (1-50, default 10)')
    .option('-t, --type <kind>', 'Restrict to a chunk kind: function, method, class_shell, interface, type, export, block, doc')
    .option('-l, --language <lang>', 'Restrict to typescript, javascript, or markdown')
    .option('-e, --exported', 'Only exported symbols')
    .option('-f, --file <glob>', 'Restrict to files matching a glob')
    .option('--json', 'Emit the raw MCP response instead of text')
    .action(async (query: string, path: string | undefined, opts: SearchFlags & { stateDir?: string; json?: boolean }) => {
      try {
        const text = await runQuery('mast_search', buildSearchArgs(query, opts), { stateDir: opts.stateDir, path });
        process.stdout.write((opts.json === true ? text : formatSearchResults(text)) + '\n');
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}
