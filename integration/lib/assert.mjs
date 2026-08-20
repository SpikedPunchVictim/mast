// The assertion kinds.
//
// EVERY kind here was checked against real command output before it was written. Two kinds in
// the design's first draft could not be implemented as specified, and checking the second one
// against a real run is what turned up defect D029:
//
//   * `searchMisses` over stdout is a FALSE RED. Delete `src/alpha.ts` and `mast search
//     alphaFunction` still prints the string twice — out of the surviving caller's body, which
//     the formatter echoes. Symbol presence is a question about `results[].symbol_name`.
//   * `fileUnchanged` over `graph.db` is a FALSE RED. Three runs over identical content produce
//     three different digests: WAL, `last_indexed`, and a growing `lock-metrics.jsonl`.
//     Idempotency is `captureEquals` over a normalized query battery instead.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runMast, runMastJson } from './exec.mjs';

/** Assertion kinds and their required keys — a CLOSED vocabulary, so a typo throws at validation
 *  time instead of quietly asserting nothing. */
export const ASSERT_KINDS = {
  exists: ['file'],
  notExists: ['file'],
  searchFinds: ['query', 'symbol'],
  searchMisses: ['query', 'symbol'],
  callersInclude: ['symbol', 'caller'],
  callersExclude: ['symbol', 'caller'],
  statusField: ['field', 'equals'],
  hasStaleResult: ['query', 'file'],
  noStaleResult: ['query'],
  indexEmpty: ['expected'],
  cliMatchesMcp: ['query'],
  chunkCount: ['comparedTo'],
};

const ok = () => ({ pass: true, failures: [] });
const no = (...failures) => ({ pass: false, failures });

/** Every result symbol for a query, from the JSON surface. Never stdout — see the header. */
function searchSymbols(ctx, query) {
  const res = runMastJson(ctx.installRoot, ctx.workingDir, `search "${query}" --json -n 50`);
  return {
    symbols: (res.results ?? []).map((r) => r.symbol_name).filter((s) => s != null),
    results: res.results ?? [],
    raw: res,
  };
}

function verifiedCallers(ctx, symbol) {
  const res = runMastJson(ctx.installRoot, ctx.workingDir, `query mast_callers '{"symbol":"${symbol}"}'`);
  const verified = res.verified_callers ?? [];
  return verified.map((c) => c.file_path ?? c.caller_file ?? c.symbol_name ?? JSON.stringify(c));
}

export function evaluateAssert(spec, ctx) {
  switch (spec.kind) {
    case 'exists':
      return existsSync(join(ctx.workingDir, spec.file)) ? ok() : no(`${spec.file} does not exist`);

    case 'notExists':
      return !existsSync(join(ctx.workingDir, spec.file)) ? ok() : no(`${spec.file} still exists`);

    case 'searchFinds': {
      const { symbols, results } = searchSymbols(ctx, spec.query);
      if (!symbols.includes(spec.symbol)) {
        return no(`search "${spec.query}" did not return symbol '${spec.symbol}'. Returned: ${symbols.join(', ') || '(nothing)'}`);
      }
      if (spec.inFile !== undefined) {
        const paths = results.filter((r) => r.symbol_name === spec.symbol).map((r) => r.file_path);
        if (!paths.includes(spec.inFile)) {
          return no(`'${spec.symbol}' was found, but at ${paths.join(', ')} — expected ${spec.inFile}`);
        }
      }
      return ok();
    }

    case 'searchMisses': {
      const { symbols, results } = searchSymbols(ctx, spec.query);
      if (symbols.includes(spec.symbol)) {
        const where = results.filter((r) => r.symbol_name === spec.symbol).map((r) => r.file_path).join(', ');
        return no(`search "${spec.query}" still returns symbol '${spec.symbol}' (at ${where}) — the index believes a deleted or moved declaration is still there`);
      }
      return ok();
    }

    case 'callersInclude': {
      const callers = verifiedCallers(ctx, spec.symbol);
      return callers.some((c) => c.includes(spec.caller))
        ? ok()
        : no(`verified callers of '${spec.symbol}' do not include '${spec.caller}'. Got: ${callers.join(', ') || '(none)'}`);
    }

    case 'callersExclude': {
      const callers = verifiedCallers(ctx, spec.symbol);
      return callers.some((c) => c.includes(spec.caller))
        ? no(`verified callers of '${spec.symbol}' still include '${spec.caller}' — a phantom caller survives`)
        : ok();
    }

    case 'statusField': {
      const status = runMastJson(ctx.installRoot, ctx.workingDir, 'status --json');
      const actual = status[spec.field];
      return actual === spec.equals
        ? ok()
        : no(`status.${spec.field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(spec.equals)}`);
    }

    case 'hasStaleResult': {
      // Per-RESULT, not top-level: mcp/tools/search.ts spreads `stale` into the hit whose file
      // changed. Reading it from the top level is what D029 was.
      const { results } = searchSymbols(ctx, spec.query);
      const hit = results.find((r) => r.file_path === spec.file);
      if (hit === undefined) return no(`search "${spec.query}" returned nothing from ${spec.file}, so staleness cannot be judged`);
      return hit.stale === true ? ok() : no(`the result from ${spec.file} is not flagged stale, though the file changed since indexing`);
    }

    case 'noStaleResult': {
      const { results } = searchSymbols(ctx, spec.query);
      const stale = results.filter((r) => r.stale === true).map((r) => r.file_path);
      return stale.length === 0 ? ok() : no(`results are flagged stale when nothing changed: ${stale.join(', ')}`);
    }

    case 'indexEmpty': {
      const { raw } = searchSymbols(ctx, spec.query ?? 'anything');
      const actual = raw.index_empty === true;
      return actual === spec.expected ? ok() : no(`index_empty is ${actual}, expected ${spec.expected}`);
    }

    case 'cliMatchesMcp': {
      // A byte check across the two dispatch paths. Content parity is structural (ADR 014 §5),
      // so this catches transport framing and serialization, not ranking. It is a footnote, and
      // ADR 015 §2 says so rather than selling it as the headline.
      const cli = runMast(ctx.installRoot, ctx.workingDir, `search "${spec.query}" --json -n 50`);
      const via = runMast(ctx.installRoot, ctx.workingDir, `query mast_search '{"query":"${spec.query}","limit":50}'`);
      const strip = (t) => JSON.stringify(stripVolatile(JSON.parse(t)));
      return strip(cli.stdout) === strip(via.stdout)
        ? ok()
        : no(`mast search --json and mast query mast_search disagree:\n  search: ${strip(cli.stdout).slice(0, 400)}\n  query : ${strip(via.stdout).slice(0, 400)}`);
    }

    case 'chunkCount': {
      const status = runMastJson(ctx.installRoot, ctx.workingDir, 'status --json');
      const actual = status.chunk_count;
      const prior = ctx.snapshots.get(spec.comparedTo);
      if (prior === undefined) throw new Error(`chunkCount: no snapshot named '${spec.comparedTo}'`);
      const expected = prior.chunk_count;
      const cmp = spec.direction ?? 'lt';
      const held = cmp === 'lt' ? actual < expected : cmp === 'gt' ? actual > expected : actual === expected;
      return held ? ok() : no(`chunk_count is ${actual}; expected ${cmp} ${expected} (snapshot '${spec.comparedTo}')`);
    }

    default:
      throw new Error(`unknown assert kind '${spec.kind}' — known: ${Object.keys(ASSERT_KINDS).join(', ')}`);
  }
}

/** Fields that differ between two identical runs and would make any comparison flaky. Named
 *  individually rather than blanket-normalized: a blanket float rule would hide a ranking
 *  regression, which is the one thing worth catching here. */
function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'duration_ms' || k === 'last_indexed' || k === 'state_dir') continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

/** Snapshot of the numbers a later assertion can compare against. */
export function captureCounts(ctx) {
  const status = runMastJson(ctx.installRoot, ctx.workingDir, 'status --json');
  return { chunk_count: status.chunk_count, file_count: status.file_count, stale_files: status.stale_files };
}

/** `expect` on a `run` step. */
export function evaluateExpect(expect, result) {
  if (expect === undefined) return ok();
  const failures = [];
  if (expect.exit !== undefined && result.exitCode !== expect.exit) {
    failures.push(`exit ${result.exitCode}, expected ${expect.exit}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
  if (expect.stdoutContains !== undefined && !result.stdout.includes(expect.stdoutContains)) {
    failures.push(`stdout does not contain ${JSON.stringify(expect.stdoutContains)}\n--- stdout ---\n${result.stdout}`);
  }
  if (expect.stderrContains !== undefined && !result.stderr.includes(expect.stderrContains)) {
    failures.push(`stderr does not contain ${JSON.stringify(expect.stderrContains)}\n--- stderr ---\n${result.stderr}`);
  }
  if (expect.stdoutMatches !== undefined && !new RegExp(expect.stdoutMatches).test(result.stdout)) {
    failures.push(`stdout does not match /${expect.stdoutMatches}/\n--- stdout ---\n${result.stdout}`);
  }
  return failures.length === 0 ? ok() : { pass: false, failures };
}
