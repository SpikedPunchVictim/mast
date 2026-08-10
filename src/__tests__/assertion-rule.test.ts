import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * D4 (IMPLEMENTATION_PLAN.md Stage 4) — enforcement half of the test-assertion
 * rule from eval/GITNEXUS_COMPARISON.md §13.7/§14.6: shape-only assertions
 * (`typeof res.summary.potential_count === 'number'`) pass identically
 * whether a returned array has 0, 50, or 50-silently-truncated-from-71
 * entries — the exact defect (M4) this rule exists to stop recurring. The
 * pattern that enabled it was a response cast to `unknown[]` (or a bare
 * `: unknown` field): typing a parsed tool/CLI response loosely enough that
 * a test never has to say what the array actually contains, so a
 * length-only or type-only assertion feels sufficient.
 *
 * **What this test DOES enforce, mechanically**: no `src/**​/__tests__/*.test.ts`
 * file casts a value to a type containing `unknown[]`, and no
 * interface/type-literal member in a test file is typed bare `unknown`,
 * UNLESS the declaration carries a `mast-assertion-rule-allow: <reason>`
 * comment within a few lines above it (or on the same line) — every
 * allowlist entry requires a written, non-trivial reason, checked at scan
 * time (not just that the marker exists, but that real text follows it).
 * See `mcp/tools/__tests__/tools.test.ts`'s `is_exported` round-trip test
 * for a genuine, allowlisted case: `unknown` there is deliberate, because
 * the test verifies a RUNTIME type survives a JSON round-trip — annotating
 * it `boolean` would hide exactly the defect class the test exists to catch.
 *
 * **What this test CANNOT and does NOT enforce**: "every returned array
 * gets a content assertion" — the other half of the D4 rule — is a semantic
 * judgment (does `expect(x).toEqual(realValue)` actually pin real content,
 * or is `expect(x.length).toBeGreaterThan(0)` dressed up as if it did?) that
 * no cheap mechanical scan can make reliably; a regex or AST pass has no way
 * to know whether a given `expect()` call constitutes "real" content
 * verification for the domain at hand. Banning `unknown[]`/bare-`unknown`
 * blocks the ANNOTATION laziness that let the M4 defect's shape-only
 * assertions go unnoticed in the first place; it does not audit assertion
 * quality directly. That half was a one-time manual sweep (see the D4 sweep
 * result in IMPLEMENTATION_PLAN.md Stage 4) — this test only stops the
 * pattern that made the defect easy to introduce from recurring.
 */

const TEST_FILE_URL = import.meta.url;
const SELF_PATH = fileURLToPath(TEST_FILE_URL);
const SRC_ROOT = join(dirname(SELF_PATH), '..');
const ALLOW_MARKER = 'mast-assertion-rule-allow';
// How far above a violating line to look for an allowlist marker/reason —
// generous enough for a multi-line explanatory comment block (the longest
// real one in this suite today is 10 lines), still a bounded, cheap scan.
const ALLOWLIST_LOOKBACK_LINES = 20;
// An allowlist marker with no real explanation after the colon defeats the
// point (§4.3 "document the contract, not the implementation" applies to
// exceptions too) — require a nontrivial amount of reason text.
const MIN_ALLOW_REASON_LENGTH = 15;

interface Violation {
  readonly filePath: string;
  readonly line: number;
  readonly text: string;
}

/** Recursively collects every `*.test.ts` file that lives directly inside a `__tests__` directory under `dir`. */
function findTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts') && dir.endsWith('__tests__')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * True when a `mast-assertion-rule-allow:` marker with a real reason
 * appears on the violating line itself or on one of the preceding
 * {@link ALLOWLIST_LOOKBACK_LINES} lines — covers both same-line and
 * preceding-comment-block placement.
 */
function isAllowlisted(lines: readonly string[], lineIndex: number): boolean {
  const from = Math.max(0, lineIndex - ALLOWLIST_LOOKBACK_LINES);
  for (let i = from; i <= lineIndex; i++) {
    const markerIndex = lines[i]?.indexOf(ALLOW_MARKER) ?? -1;
    if (markerIndex === -1) continue;
    const reason = lines[i]!.slice(markerIndex + ALLOW_MARKER.length).replace(/^[:\s]+/, '');
    if (reason.length >= MIN_ALLOW_REASON_LENGTH) return true;
  }
  return false;
}

function scanFile(filePath: string): Violation[] {
  const source = readFileSync(filePath, 'utf8');
  const lines = source.split('\n');
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  function report(node: ts.Node, label: string): void {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    if (isAllowlisted(lines, line)) return;
    violations.push({ filePath, line: line + 1, text: `${label} — ${lines[line]?.trim() ?? ''}` });
  }

  function visit(node: ts.Node): void {
    // `unknown[]` — an array type whose element is the bare `unknown` keyword.
    if (ts.isArrayTypeNode(node) && node.elementType.kind === ts.SyntaxKind.UnknownKeyword) {
      report(node, 'unknown[]');
    }
    // A bare `unknown`-typed member of an interface or type-literal (e.g.
    // `{ foo: unknown }`, `as { results: unknown[] }`'s siblings). Property
    // signatures are a distinct AST node from function parameters, so this
    // does NOT flag mock signatures like `tool(name: string, schema: unknown, ...)`.
    if (ts.isPropertySignature(node) && node.type?.kind === ts.SyntaxKind.UnknownKeyword) {
      report(node, 'bare `unknown` field');
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

describe('D4 assertion rule — no unknown[] / bare-unknown response annotations', () => {
  it('every src/**/__tests__/*.test.ts file is free of unallowlisted unknown[] and bare-unknown fields', () => {
    const testFiles = findTestFiles(SRC_ROOT).filter((filePath) => filePath !== SELF_PATH);
    // Sanity floor: if this ever collapses to near-zero, the scan itself is
    // broken (wrong root, glob typo), not that the suite got this clean.
    expect(testFiles.length).toBeGreaterThan(30);

    const allViolations = testFiles.flatMap(scanFile);

    if (allViolations.length > 0) {
      const reportLines = allViolations
        .map((v) => `  ${relative(SRC_ROOT, v.filePath)}:${v.line} — ${v.text}`)
        .join('\n');
      throw new Error(
        `Found ${allViolations.length} unknown[]/bare-unknown response type annotation(s). ` +
          `Give the field a concrete minimal shape (see tools.test.ts for the convention: ` +
          `{ results: Array<{ file_path: string }> } style, annotating only fields the test ` +
          `uses), or — if the \`unknown\` is genuinely deliberate (e.g. verifying a runtime type, ` +
          `not just being lazy about a shape) — add a same-line or preceding comment: ` +
          `"${ALLOW_MARKER}: <a real reason, not just the marker>".\n${reportLines}`,
      );
    }

    expect(allViolations).toEqual([]);
  });
});
