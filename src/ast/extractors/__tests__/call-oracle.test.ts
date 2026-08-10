import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseSource } from '../../parser.js';
import type { Tree, SyntaxNode } from '../../parser.js';
import { extractEdges, collectCalls, type CallSiteOutcome } from '../typescript.js';

/**
 * D7 (IMPLEMENTATION_PLAN.md Stage 4) — self-oracle invariant test over
 * mast's own `src/` (eval/GITNEXUS_COMPARISON.md §14.6's oracle-vs-sampling
 * framing, §13.9 E2's denominator idea). Deliberately an IN-REPO corpus, not
 * an external one — pulling a registered external corpus is E1/E2 territory
 * and out of scope here.
 *
 * The core invariant: every `call_expression` node `collectCalls` visits
 * yields EXACTLY one of the four `CallSiteOutcome` buckets — no call is
 * silently dropped without a recorded reason. `expectedCallSites` below is
 * an INDEPENDENT re-derivation of "which call sites does `extractEdges`
 * visit for this file", built only from the exported `collectCalls`
 * primitive plus tree-sitter's own `SyntaxNode` API — not by calling any of
 * `extractEdges`' own private dispatch helpers. It deliberately mirrors
 * `extractEdges`' top-level scope dispatch (function/class-method/arrow-const
 * declarations) so the two sides can disagree if a future change to either
 * one drifts from the other.
 */

const SELF_PATH = fileURLToPath(import.meta.url);
// src/ast/extractors/__tests__ -> src
const SRC_ROOT = join(dirname(SELF_PATH), '../../..');

const DECLARATION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'lexical_declaration',
  'variable_declaration',
  'enum_declaration',
]);

/** Mirrors `getWrappedDeclaration` in typescript.ts: unwrap `export ...` to the declaration it wraps. */
function unwrapExport(node: SyntaxNode): SyntaxNode | null {
  if (node.type !== 'export_statement') return node;
  const fieldDecl = node.childForFieldName('declaration');
  if (fieldDecl !== null) return fieldDecl;
  return node.namedChildren.find((child) => DECLARATION_TYPES.has(child.type)) ?? null;
}

/**
 * Independently enumerate the call_expression nodes `extractEdges` hands to
 * `parseCallee` for a file's top-level function/class-method/arrow-const
 * scopes — see file header for why this exists and what it does and does not
 * verify.
 */
function expectedCallSites(tree: Tree): SyntaxNode[] {
  const sites: SyntaxNode[] = [];
  for (const node of tree.rootNode.namedChildren) {
    const declNode = unwrapExport(node);
    if (declNode === null) continue;
    const t = declNode.type;

    if (t === 'class_declaration' || t === 'abstract_class_declaration') {
      const body = declNode.childForFieldName('body');
      if (body === null) continue;
      for (const member of body.namedChildren) {
        if (member.type !== 'method_definition' && member.type !== 'abstract_method_signature') continue;
        const methodBody = member.childForFieldName('body');
        if (methodBody !== null) sites.push(...collectCalls(methodBody));
      }
    } else if (t === 'function_declaration' || t === 'generator_function_declaration') {
      const body = declNode.childForFieldName('body');
      if (body !== null) sites.push(...collectCalls(body));
    } else if (t === 'lexical_declaration' || t === 'variable_declaration') {
      // extractEdges only ever looks at the FIRST variable_declarator in a
      // declaration statement (`findChildByType` returns the first match) —
      // mirrored here rather than summing over every declarator, so a
      // multi-declarator statement doesn't manufacture a phantom oracle/
      // extractor disagreement out of a dispatch limitation this test isn't
      // scoped to characterise.
      const declarator = declNode.namedChildren.find((child) => child.type === 'variable_declarator');
      const value = declarator?.childForFieldName('value') ?? null;
      if (value !== null && value.type === 'arrow_function') {
        const body = value.childForFieldName('body');
        if (body !== null) sites.push(...collectCalls(body));
      }
    }
  }
  return sites;
}

/** Recursively collect every `.ts`/`.tsx` file under `dir`, excluding `__tests__` directories —
 *  test files' own call shapes (mocks, fixtures, assertion helpers) are noise for a corpus meant
 *  to characterise the extractor's behavior over real production code. */
function findSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...findSourceFiles(join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function emptyTally(): Record<CallSiteOutcome, number> {
  return { edge_emitted: 0, unparseable_callee: 0, unresolved_receiver: 0, bare_call_unresolved: 0 };
}

function sumTally(t: Record<CallSiteOutcome, number>): number {
  return t.edge_emitted + t.unparseable_callee + t.unresolved_receiver + t.bare_call_unresolved;
}

describe('D7 — call-site self-oracle over mast\'s own src/ corpus', () => {
  const files = findSourceFiles(SRC_ROOT);

  it('sanity: the corpus walk found a non-trivial number of source files', () => {
    // Floor, not a pin: if this collapses toward zero, SRC_ROOT or the
    // __tests__ exclusion broke, not that the package shrank to nothing.
    expect(files.length).toBeGreaterThan(30);
  });

  it('accounting invariant: outcomes-sum equals the independently-enumerated call count, per file', () => {
    const mismatches: string[] = [];
    for (const filePath of files) {
      const src = readFileSync(filePath, 'utf8');
      const tree = parseSource(src, extname(filePath));
      const tally = emptyTally();
      extractEdges(tree, filePath, src, (outcome) => {
        tally[outcome] += 1;
      });
      const expected = expectedCallSites(tree).length;
      const actual = sumTally(tally);
      if (actual !== expected) {
        mismatches.push(`${relative(SRC_ROOT, filePath)}: outcomes-sum=${actual} vs collectCalls=${expected}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every emitted POTENTIAL_CALL edge\'s callLine text plausibly contains a call', () => {
    for (const filePath of files) {
      const src = readFileSync(filePath, 'utf8');
      const tree = parseSource(src, extname(filePath));
      const edges = extractEdges(tree, filePath, src);
      for (const edge of edges) {
        if (edge.edgeType !== 'POTENTIAL_CALL') continue;
        const where = `${relative(SRC_ROOT, filePath)}:${edge.callLine ?? '?'} -> ${edge.toName}`;
        expect(edge.context, where).toBeTruthy();
        expect(edge.context, where).toContain('(');
      }
    }
  });

  it('documents the live outcome distribution over the corpus (the E2 denominator)', () => {
    const totals = emptyTally();
    for (const filePath of files) {
      const src = readFileSync(filePath, 'utf8');
      const tree = parseSource(src, extname(filePath));
      extractEdges(tree, filePath, src, (outcome) => {
        totals[outcome] += 1;
      });
    }
    const total = sumTally(totals);
    // Informational: makes the outcome distribution visible in test output
    // (`pnpm test -- call-oracle` -run) so the live denominator is not
    // buried in a one-off script's stdout. See IMPLEMENTATION_PLAN.md's D7
    // result for the numbers captured at the time this test was written.
    // eslint-disable-next-line no-console
    console.log('D7 self-corpus outcome distribution:', { ...totals, total, files: files.length });
    expect(total).toBeGreaterThan(0);
  });
});
