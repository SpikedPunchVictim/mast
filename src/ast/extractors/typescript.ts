import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { LanguageExtractor, Tree, SyntaxNode } from '../parser.js';
import type { Chunk, ChunkType, Language, SymbolRecord, ImportRecord, EdgeRecord, CallerResolution, ParamEntry } from '../types.js';
import { LocalTypeEnvironment } from '../../graph/local-type-env.js';

// ---------------------------------------------------------------------------
// TypeScriptExtractor
// ---------------------------------------------------------------------------

/**
 * TypeScript/JavaScript chunk extractor.
 *
 * Implements §10.1 chunking strategy and §10.2 signature extraction.
 * Handles class decomposition (shell + method chunks) and the two-pass
 * walk for `is_exported` detection.
 */
export class TypeScriptExtractor implements LanguageExtractor {
  readonly language = 'typescript';
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx'] as const;

  extractChunks(
    parsedTree: Tree,
    src: string,
    filePath: string,
    fileMtime: number,
    contextLines: number,
    chunkSplitThreshold: number,
  ): Chunk[] {
    const lines = src.split('\n');
    const lang = languageFromExt(extname(filePath));
    const topLevel = nodeChildren(parsedTree.rootNode);

    // -------------------------------------------------------------------------
    // Pass 1: build symbol-name → exported flag map.
    // `export function foo()` / `export class Foo` → name recorded as exported.
    // Bare declarations → name recorded as not-yet-exported (may be updated pass 2).
    // -------------------------------------------------------------------------
    const exportedNames = new Set<string>();
    const knownDeclNames = new Set<string>();

    for (const node of topLevel) {
      if (nodeType(node) === 'export_statement') {
        const decl = getWrappedDeclaration(node);
        if (decl !== null) {
          const name = getDeclName(decl);
          if (name !== null) {
            exportedNames.add(name);
            knownDeclNames.add(name);
          }
        }
      } else {
        const name = getDeclName(node);
        if (name !== null) knownDeclNames.add(name);
      }
    }

    // -------------------------------------------------------------------------
    // Pass 2: update is_exported via `export { foo }` (no `from` clause).
    // -------------------------------------------------------------------------
    for (const node of topLevel) {
      if (nodeType(node) !== 'export_statement') continue;
      if (hasFromClause(node)) continue;
      if (getWrappedDeclaration(node) !== null) continue;

      const exportClause = findChildByType(node, 'export_clause');
      if (exportClause === null) continue;

      for (const child of nodeNamedChildren(exportClause)) {
        if (nodeType(child) !== 'export_specifier') continue;
        const localName = child.childForFieldName('name')?.text;
        const alias = child.childForFieldName('alias')?.text;
        // `export { foo as bar }` exports `foo` UNDER `bar`, not as `foo` — the
        // alias is emitted as its own exported chunk in pass 3, so the local
        // name is not marked exported here.
        if (alias !== undefined && alias !== localName) continue;
        if (localName !== undefined && knownDeclNames.has(localName)) {
          exportedNames.add(localName);
        }
      }
    }

    // -------------------------------------------------------------------------
    // Emit chunks
    // -------------------------------------------------------------------------
    const chunks: Chunk[] = [];

    for (const node of topLevel) {
      const t = nodeType(node);
      if (t === 'comment' || t === 'import_statement') continue;

      let declNode: SyntaxNode = node;
      let isExported = false;

      if (t === 'export_statement') {
        const decl = getWrappedDeclaration(node);
        if (decl === null) continue; // export { } or export * from — no direct chunk
        declNode = decl;
        isExported = true;
      } else {
        const name = getDeclName(node);
        isExported = name !== null && exportedNames.has(name);
      }

      emitChunksForNode(
        declNode,
        isExported,
        chunks,
        lines,
        src,
        filePath,
        fileMtime,
        contextLines,
        chunkSplitThreshold,
        lang,
      );
    }

    // -------------------------------------------------------------------------
    // Pass 3: local re-export aliases — `export { foo as bar }` exposes foo's
    // declaration under the name `bar`. Emit a chunk for `bar` mirroring foo's
    // so it is discoverable (mast_exports / mast_search / mast_signature).
    // -------------------------------------------------------------------------
    for (const { local, alias, line } of localExportAliases(topLevel)) {
      const target = chunks.find((c) => c.symbol_name === local && c.chunk_type !== 'method');
      if (target === undefined) continue;
      chunks.push({
        ...target,
        chunk_id: sha256(`${filePath}:${line}:${alias}`),
        symbol_name: alias,
        is_exported: true,
      });
    }

    return chunks;
  }

  declarationHash(node: SyntaxNode, src: string): string {
    return declHashOf(node, src);
  }

  bodyHash(node: SyntaxNode, src: string): string {
    return bodyHashOf(node, src);
  }
}

// ---------------------------------------------------------------------------
// Chunk emission
// ---------------------------------------------------------------------------

function emitChunksForNode(
  node: SyntaxNode,
  isExported: boolean,
  chunks: Chunk[],
  lines: readonly string[],
  src: string,
  filePath: string,
  fileMtime: number,
  contextLines: number,
  chunkSplitThreshold: number,
  language: Language,
): void {
  const t = nodeType(node);
  const startLine = nodeStartLine(node);
  const endLine = nodeEndLine(node);

  switch (t) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = node.childForFieldName('name')?.text ?? null;
      pushChunks(chunks, {
        chunkType: 'function',
        symbolName: name,
        parentSymbol: null,
        isExported,
        startLine,
        endLine,
        lines,
        filePath,
        fileMtime,
        contextLines,
        chunkSplitThreshold,
        language,
        declarationHash: declHashOf(node, src),
        bodyHash: bodyHashOf(node, src),
      });
      break;
    }

    case 'lexical_declaration':
    case 'variable_declaration': {
      const declarator = findChildByType(node, 'variable_declarator');
      if (declarator === null) break;
      const valNode = declarator.childForFieldName('value');
      const isFunc =
        valNode !== null &&
        (nodeType(valNode) === 'arrow_function' ||
          nodeType(valNode) === 'function' ||
          nodeType(valNode) === 'generator_function');
      const name = declarator.childForFieldName('name')?.text ?? null;
      pushChunks(chunks, {
        chunkType: isFunc ? 'function' : 'block',
        symbolName: name,
        parentSymbol: null,
        isExported,
        startLine,
        endLine,
        lines,
        filePath,
        fileMtime,
        contextLines,
        chunkSplitThreshold,
        language,
        declarationHash: declHashOf(node, src),
        bodyHash: bodyHashOf(node, src),
      });
      break;
    }

    case 'class_declaration':
    case 'abstract_class_declaration': {
      const className = node.childForFieldName('name')?.text ?? null;
      const bodyNode = node.childForFieldName('body') ?? findChildByType(node, 'class_body');

      // Synthesized class_shell chunk
      const shellContent = synthesiseClassShell(node, bodyNode, src);
      chunks.push({
        chunk_id: chunkId(filePath, startLine),
        file_path: filePath,
        start_line: startLine,
        end_line: endLine,
        content: shellContent,
        chunk_type: 'class_shell',
        symbol_name: className,
        parent_symbol: null,
        is_exported: isExported,
        language,
        file_mtime: fileMtime,
        declaration_hash: declHashOf(node, src),
        body_hash: bodyNode !== null ? classShellBodyHashOf(bodyNode, src) : sha256(''),
      });

      // Method chunks
      if (bodyNode !== null && className !== null) {
        for (const member of nodeNamedChildren(bodyNode)) {
          const mt = nodeType(member);
          if (mt !== 'method_definition' && mt !== 'abstract_method_signature') continue;
          const methodName = member.childForFieldName('name')?.text ?? null;
          if (methodName === null) continue;

          const isPrivate = hasPrivateModifier(member);
          const methodExported = isExported && !isPrivate;
          const mStart = nodeStartLine(member);
          const mEnd = nodeEndLine(member);
          const content = expandContent(lines, mStart, mEnd, contextLines);

          chunks.push({
            chunk_id: chunkId(filePath, mStart),
            file_path: filePath,
            start_line: mStart,
            end_line: mEnd,
            content,
            chunk_type: 'method',
            symbol_name: `${className}.${methodName}`,
            parent_symbol: className,
            is_exported: methodExported,
            language,
            file_mtime: fileMtime,
            declaration_hash: declHashOf(member, src),
            body_hash: bodyHashOf(member, src),
          });
        }
      }
      break;
    }

    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text ?? null;
      pushChunks(chunks, {
        chunkType: 'interface',
        symbolName: name,
        parentSymbol: null,
        isExported,
        startLine,
        endLine,
        lines,
        filePath,
        fileMtime,
        contextLines,
        chunkSplitThreshold,
        language,
        declarationHash: declHashOf(node, src),
        bodyHash: bodyHashOf(node, src),
      });
      break;
    }

    case 'type_alias_declaration': {
      const name = node.childForFieldName('name')?.text ?? null;
      pushChunks(chunks, {
        chunkType: 'type',
        symbolName: name,
        parentSymbol: null,
        isExported,
        startLine,
        endLine,
        lines,
        filePath,
        fileMtime,
        contextLines,
        chunkSplitThreshold,
        language,
        declarationHash: declHashOf(node, src),
        bodyHash: bodyHashOf(node, src),
      });
      break;
    }

    default: {
      // Everything else at top level → block (skip if we have no meaningful content)
      const name = getDeclName(node);
      pushChunks(chunks, {
        chunkType: 'block',
        symbolName: name,
        parentSymbol: null,
        isExported,
        startLine,
        endLine,
        lines,
        filePath,
        fileMtime,
        contextLines,
        chunkSplitThreshold,
        language,
      });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-chunking
// ---------------------------------------------------------------------------

interface PushChunksOpts {
  chunkType: ChunkType;
  symbolName: string | null;
  parentSymbol: string | null;
  isExported: boolean;
  startLine: number;
  endLine: number;
  lines: readonly string[];
  filePath: string;
  fileMtime: number;
  contextLines: number;
  chunkSplitThreshold: number;
  language: Language;
  declarationHash?: string;
  bodyHash?: string;
}

/**
 * Push one chunk — or N overlapping sub-chunks when the declaration exceeds
 * `chunkSplitThreshold` lines (§10.1 split rule). The first sub-chunk always
 * starts at the declaration header so signature extraction works from sub-chunk 0.
 */
function pushChunks(chunks: Chunk[], opts: PushChunksOpts): void {
  const { startLine, endLine, filePath, fileMtime, lines, contextLines, language } = opts;
  const lineCount = endLine - startLine + 1;

  if (lineCount <= opts.chunkSplitThreshold) {
    chunks.push({
      chunk_id: chunkId(filePath, startLine),
      file_path: filePath,
      start_line: startLine,
      end_line: endLine,
      content: expandContent(lines, startLine, endLine, contextLines),
      chunk_type: opts.chunkType,
      symbol_name: opts.symbolName,
      parent_symbol: opts.parentSymbol,
      is_exported: opts.isExported,
      language,
      file_mtime: fileMtime,
      declaration_hash: opts.declarationHash,
      body_hash: opts.bodyHash,
    });
    return;
  }

  // Split into overlapping sub-chunks with OVERLAP_LINES overlap.
  const OVERLAP_LINES = 10;
  const windowSize = opts.chunkSplitThreshold;
  let subStart = startLine;
  let subIndex = 0;

  while (subStart <= endLine) {
    const subEnd = Math.min(subStart + windowSize - 1, endLine);
    chunks.push({
      // Qualify sub-chunk IDs with sub-index to keep them unique.
      chunk_id: sha256(`${filePath}:${startLine}:${subIndex}`),
      file_path: filePath,
      start_line: subStart,
      end_line: subEnd,
      content: expandContent(lines, subStart, subEnd, contextLines),
      chunk_type: opts.chunkType,
      symbol_name: opts.symbolName,
      parent_symbol: opts.parentSymbol,
      is_exported: opts.isExported,
      language,
      file_mtime: fileMtime,
      declaration_hash: opts.declarationHash,
      body_hash: opts.bodyHash,
    });

    if (subEnd >= endLine) break;
    subStart = subEnd - OVERLAP_LINES + 1;
    subIndex++;
  }
}

// ---------------------------------------------------------------------------
// Class shell synthesis
// ---------------------------------------------------------------------------

/**
 * Synthesise the class_shell content: class declaration header + member
 * signatures (TSDoc + signature line, no bodies) + closing brace.
 */
export function synthesiseClassShell(
  classNode: SyntaxNode,
  bodyNode: SyntaxNode | null,
  src: string,
): string {
  // Header: class declaration up to (not including) the opening `{`
  const header =
    bodyNode !== null
      ? src.slice(classNode.startIndex, bodyNode.startIndex).trimEnd()
      : src.slice(classNode.startIndex, classNode.endIndex);

  if (bodyNode === null) return header;

  const memberLines: string[] = [header + ' {'];

  for (const member of nodeNamedChildren(bodyNode)) {
    if (!isClassShellMember(nodeType(member))) continue;

    // Leading TSDoc/comment
    const doc = getLeadingComment(member, bodyNode, src);
    if (doc !== null) memberLines.push('  ' + doc.trim());

    // Signature without body
    memberLines.push('  ' + extractSignatureText(member, src).trim());
  }

  memberLines.push('}');
  return memberLines.join('\n');
}

// ---------------------------------------------------------------------------
// Signature / doc extraction
// ---------------------------------------------------------------------------

/**
 * Extract declaration text up to (not including) the body block.
 * For interfaces and type aliases the full node is the signature.
 */
export function extractSignatureText(node: SyntaxNode, src: string): string {
  const bodyNode = node.childForFieldName('body') ?? findChildByType(node, 'statement_block');

  if (bodyNode === null) {
    return src.slice(node.startIndex, node.endIndex);
  }

  return src.slice(node.startIndex, bodyNode.startIndex).trimEnd();
}

// ---------------------------------------------------------------------------
// Signature extraction (§10.2) — body-free declaration, params, return type
// ---------------------------------------------------------------------------

/** A symbol's declaration as the AST sees it: no body, structured params. */
export interface ExtractedSignature {
  /** Qualified `Class.method` for methods; bare name otherwise. */
  readonly name: string;
  readonly line: number;            // 1-indexed declaration start
  readonly signature: string;       // declaration text, body stripped
  readonly params: readonly ParamEntry[];
  readonly returnType: string | null;
  readonly doc: string | null;      // leading TSDoc/line comment, if any
}

/**
 * Extract a body-free signature (plus structured params and return type) for
 * every top-level symbol and class method in `tree`. Used by `mast_signature`
 * and `mast_exports` so they report the declaration, not the function body.
 */
export function extractSignatures(tree: Tree, src: string): ExtractedSignature[] {
  const out: ExtractedSignature[] = [];
  const root = tree.rootNode;

  for (const node of nodeChildren(root)) {
    const isExport = nodeType(node) === 'export_statement';
    const decl = isExport ? getWrappedDeclaration(node) : node;
    if (decl === null) continue;
    // Doc precedes the export wrapper when there is one.
    const docHost = isExport ? node : decl;
    const t = nodeType(decl);

    switch (t) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = decl.childForFieldName('name')?.text;
        if (name !== undefined) out.push(signatureFor(name, decl, decl, root, src));
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        const declarator = findChildByType(decl, 'variable_declarator');
        const value = declarator?.childForFieldName('value') ?? null;
        const name = declarator?.childForFieldName('name')?.text ?? null;
        if (name !== null && value !== null && nodeType(value) === 'arrow_function') {
          out.push(arrowSignatureFor(name, decl, value, docHost, root, src));
        }
        break;
      }
      case 'interface_declaration':
      case 'type_alias_declaration': {
        const name = decl.childForFieldName('name')?.text;
        if (name !== undefined) {
          out.push({
            name,
            line: nodeStartLine(decl),
            signature: extractSignatureText(decl, src),
            params: [],
            returnType: null,
            doc: getLeadingComment(docHost, root, src),
          });
        }
        break;
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const className = decl.childForFieldName('name')?.text;
        if (className === undefined) break;
        out.push({
          name: className,
          line: nodeStartLine(decl),
          signature: extractSignatureText(decl, src),
          params: [],
          returnType: null,
          doc: getLeadingComment(docHost, root, src),
        });
        const body = decl.childForFieldName('body') ?? findChildByType(decl, 'class_body');
        if (body !== null) {
          for (const member of nodeNamedChildren(body)) {
            const mt = nodeType(member);
            if (mt !== 'method_definition' && mt !== 'abstract_method_signature') continue;
            const mName = member.childForFieldName('name')?.text;
            if (mName !== undefined) out.push(signatureFor(`${className}.${mName}`, member, member, body, src));
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // Local re-export aliases (`export { foo as bar }`) expose foo's signature
  // under `bar`, so mast_signature/mast_exports can look it up by export name.
  for (const { local, alias } of localExportAliases(nodeChildren(root))) {
    const base = out.find((s) => s.name === local);
    if (base !== undefined) out.push({ ...base, name: alias });
  }

  return out;
}

/** Signature info for a function/method node. */
function signatureFor(name: string, node: SyntaxNode, docHost: SyntaxNode, docParent: SyntaxNode, src: string): ExtractedSignature {
  return {
    name,
    line: nodeStartLine(node),
    signature: extractSignatureText(node, src),
    params: paramsOf(node, src),
    returnType: returnTypeOf(node, src),
    doc: getLeadingComment(docHost, docParent, src),
  };
}

/** Signature info for an arrow-function const (`export const f = (...) => ...`). */
function arrowSignatureFor(name: string, declNode: SyntaxNode, arrow: SyntaxNode, docHost: SyntaxNode, docParent: SyntaxNode, src: string): ExtractedSignature {
  const body = arrow.childForFieldName('body');
  // Declaration text up to the arrow body, with a trailing `=>` trimmed.
  const raw = body !== null
    ? src.slice(declNode.startIndex, body.startIndex).trimEnd()
    : src.slice(declNode.startIndex, declNode.endIndex);
  return {
    name,
    line: nodeStartLine(declNode),
    signature: raw.replace(/=>\s*$/, '').trimEnd(),
    params: paramsOf(arrow, src),
    returnType: returnTypeOf(arrow, src),
    doc: getLeadingComment(docHost, docParent, src),
  };
}

/** Structured parameters from a node's `formal_parameters`. */
function paramsOf(node: SyntaxNode, src: string): ParamEntry[] {
  const fp = node.childForFieldName('parameters') ?? findChildByType(node, 'formal_parameters');
  if (fp === null) return [];
  const params: ParamEntry[] = [];
  for (const p of nodeNamedChildren(fp)) {
    const pt = nodeType(p);
    if (pt !== 'required_parameter' && pt !== 'optional_parameter') continue;
    const nameNode = p.childForFieldName('pattern') ?? findChildByType(p, 'identifier');
    const name = nameNode !== null ? src.slice(nameNode.startIndex, nameNode.endIndex) : '';
    params.push({ name, type: typeAnnotationText(p, src) ?? '' });
  }
  return params;
}

/** Return-type text from a node's `return_type` annotation, or null. */
function returnTypeOf(node: SyntaxNode, src: string): string | null {
  const rt = node.childForFieldName('return_type');
  if (rt === null) return null;
  const typeNode = nodeNamedChildren(rt)[0];
  return typeNode !== undefined ? src.slice(typeNode.startIndex, typeNode.endIndex) : null;
}

/** Full type text from a node's `type_annotation` child (e.g. `Promise<void>`). */
function typeAnnotationText(node: SyntaxNode, src: string): string | null {
  const ann = findChildByType(node, 'type_annotation');
  if (ann === null) return null;
  const typeNode = nodeNamedChildren(ann)[0];
  return typeNode !== undefined ? src.slice(typeNode.startIndex, typeNode.endIndex) : null;
}

// ---------------------------------------------------------------------------
// Stability hashes (§7.1) — computed from the AST, never from raw chunk text
// ---------------------------------------------------------------------------

/** sha256 of a declaration's signature (everything up to, not including, its body). */
function declHashOf(node: SyntaxNode, src: string): string {
  return sha256(extractSignatureText(node, src));
}

/** sha256 of a declaration's body block; empty-body hash when there is none. */
function bodyHashOf(node: SyntaxNode, src: string): string {
  const bodyNode = node.childForFieldName('body') ?? findChildByType(node, 'statement_block');
  if (bodyNode === null) return sha256('');
  return sha256(src.slice(bodyNode.startIndex, bodyNode.endIndex));
}

/**
 * Body hash for a `class_shell`: sha256 of the sorted member signatures (each
 * with its leading doc), with NO method bodies (§10.1). This makes the shell
 * re-embed when a method is renamed/added/removed but stay stable when only a
 * method body changes — that change is captured by the method chunk's own hash.
 */
/**
 * Class-body members whose signatures make up the `class_shell` outline (§10.1).
 * Shared by `synthesiseClassShell` (the outline text) and `classShellBodyHashOf`
 * (its body hash) so the two cannot disagree on what counts as a member.
 * `property_signature` covers ambient/`declare` class fields; `readonly_type`
 * (a type-level node, not a member) is intentionally excluded.
 */
function isClassShellMember(memberType: string): boolean {
  return (
    memberType === 'method_definition' ||
    memberType === 'abstract_method_signature' ||
    memberType === 'public_field_definition' ||
    memberType === 'property_signature'
  );
}

function classShellBodyHashOf(bodyNode: SyntaxNode, src: string): string {
  const sigs: string[] = [];
  for (const member of nodeNamedChildren(bodyNode)) {
    if (!isClassShellMember(nodeType(member))) continue;
    const doc = getLeadingComment(member, bodyNode, src) ?? '';
    sigs.push((doc + '\n' + extractSignatureText(member, src)).trim());
  }
  sigs.sort();
  return sha256(sigs.join('\n'));
}

/**
 * Find the immediately preceding TSDoc or line comment for a node.
 * Returns the comment text, or null if none found.
 */
function getLeadingComment(node: SyntaxNode, parentNode: SyntaxNode, src: string): string | null {
  const siblings = nodeChildren(parentNode);
  const nodeStart = node.startIndex;

  // Walk backwards from the node's position to find an adjacent comment.
  let precedingComment: SyntaxNode | null = null;
  for (const sibling of siblings) {
    if (sibling.endIndex > nodeStart) break;
    if (nodeType(sibling) === 'comment') {
      precedingComment = sibling;
    } else {
      // Reset if a non-comment node appears between the comment and our node.
      precedingComment = null;
    }
  }

  if (precedingComment === null) return null;
  return src.slice(precedingComment.startIndex, precedingComment.endIndex);
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

function nodeType(node: SyntaxNode): string {
  return node.type;
}

function nodeStartLine(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function nodeEndLine(node: SyntaxNode): number {
  return node.endPosition.row + 1;
}

function nodeChildren(node: SyntaxNode): SyntaxNode[] {
  return node.children;
}

function nodeNamedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren;
}

function findChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of nodeChildren(node)) {
    if (nodeType(child) === type) return child;
  }
  return null;
}

/**
 * Return the wrapped declaration node for `export function foo(){}` style.
 * Returns null for `export { foo }` and `export * from '...'` forms.
 */
function getWrappedDeclaration(exportStmtNode: SyntaxNode): SyntaxNode | null {
  const fieldDecl = exportStmtNode.childForFieldName('declaration');
  if (fieldDecl !== null) return fieldDecl;

  // Fallback: look for a named child that is a declaration-type node
  for (const child of nodeNamedChildren(exportStmtNode)) {
    const t = nodeType(child);
    if (
      t === 'function_declaration' ||
      t === 'generator_function_declaration' ||
      t === 'class_declaration' ||
      t === 'abstract_class_declaration' ||
      t === 'interface_declaration' ||
      t === 'type_alias_declaration' ||
      t === 'lexical_declaration' ||
      t === 'variable_declaration' ||
      t === 'enum_declaration'
    ) {
      return child;
    }
  }
  return null;
}

/**
 * Local re-export aliases: `export { foo as bar }` (no `from` clause) pairs
 * each local name with the exported alias. Used to expose the aliased
 * declaration under its export name in both chunks and signatures.
 */
function localExportAliases(
  topLevel: readonly SyntaxNode[],
): { local: string; alias: string; line: number }[] {
  const aliases: { local: string; alias: string; line: number }[] = [];
  for (const node of topLevel) {
    if (nodeType(node) !== 'export_statement') continue;
    if (hasFromClause(node)) continue;
    if (getWrappedDeclaration(node) !== null) continue;
    const clause = findChildByType(node, 'export_clause');
    if (clause === null) continue;
    for (const spec of nodeNamedChildren(clause)) {
      if (nodeType(spec) !== 'export_specifier') continue;
      const local = spec.childForFieldName('name')?.text;
      const alias = spec.childForFieldName('alias')?.text;
      if (local !== undefined && alias !== undefined && alias !== local) {
        aliases.push({ local, alias, line: nodeStartLine(spec) });
      }
    }
  }
  return aliases;
}

/**
 * Return true if the export_statement has a `from` clause (re-exporting from another module).
 */
function hasFromClause(node: SyntaxNode): boolean {
  for (const child of nodeChildren(node)) {
    if (nodeType(child) === 'string') return true; // `from './module'` has a string child
  }
  return false;
}

/**
 * Get the primary declared name from a declaration node, or null.
 */
function getDeclName(node: SyntaxNode): string | null {
  const t = nodeType(node);

  if (
    t === 'function_declaration' ||
    t === 'generator_function_declaration' ||
    t === 'class_declaration' ||
    t === 'abstract_class_declaration' ||
    t === 'interface_declaration' ||
    t === 'type_alias_declaration' ||
    t === 'enum_declaration'
  ) {
    return node.childForFieldName('name')?.text ?? null;
  }

  if (t === 'lexical_declaration' || t === 'variable_declaration') {
    const declarator = findChildByType(node, 'variable_declarator');
    if (declarator === null) return null;
    return declarator.childForFieldName('name')?.text ?? null;
  }

  return null;
}

/**
 * Return true if the class member has a `private` accessibility modifier.
 */
function hasPrivateModifier(memberNode: SyntaxNode): boolean {
  for (const child of nodeChildren(memberNode)) {
    const t = nodeType(child);
    if (t === 'accessibility_modifier') {
      return child.text === 'private';
    }
    // TypeScript grammar uses '#' for private fields (ESNext private syntax)
    if (t === 'private_field_definition') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public helpers (re-exported from Stage 1 scaffold, now implemented)
// ---------------------------------------------------------------------------

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function chunkId(filePath: string, startLine: number): string {
  return sha256(`${filePath}:${startLine}`);
}

/** Determine language from extension. */
export function languageFromExt(ext: string): Language {
  return ext === '.js' || ext === '.jsx' ? 'javascript' : 'typescript';
}

/**
 * Expand chunk content by `contextLines` around `[startLine, endLine]`.
 * Returns the expanded content slice; `startLine`/`endLine` in the chunk
 * record always reflect AST boundaries, not the expanded region.
 */
export function expandContent(
  lines: readonly string[],
  startLine: number, // 1-indexed
  endLine: number,   // 1-indexed, inclusive
  contextLines: number,
): string {
  const expandedStart = Math.max(1, startLine - contextLines);
  const expandedEnd = Math.min(lines.length, endLine + contextLines);
  return lines.slice(expandedStart - 1, expandedEnd).join('\n');
}

// ---------------------------------------------------------------------------
// Graph data extraction (symbols, imports, identifiers)
// ---------------------------------------------------------------------------

/**
 * Derive `SymbolRecord` entries from an already-extracted chunk list.
 * Skips anonymous chunks (`symbol_name === null`) and raw `block` chunks.
 */
export function symbolsFromChunks(chunks: readonly Chunk[]): SymbolRecord[] {
  const records: SymbolRecord[] = [];
  for (const c of chunks) {
    if (c.symbol_name === null || c.chunk_type === 'block') continue;
    records.push({
      name: c.symbol_name,
      kind: chunkTypeToKind(c.chunk_type),
      line: c.start_line,
      isExported: c.is_exported,
      // AST-derived hashes attached during extraction (§7.1). Null only if a
      // symbol chunk somehow lacked them (defensive; should not happen).
      declarationHash: c.declaration_hash ?? null,
      bodyHash: c.body_hash ?? null,
    });
  }
  return records;
}

/**
 * Extract import records from the tree-sitter AST.
 *
 * Handles named imports (`import { foo } from './bar'`). Side-effect imports
 * (`import './side-effect'`), default imports, and namespace imports are
 * recorded with an empty `symbols` array.
 *
 * Specifier-to-file resolution (relative probing, tsconfig aliases, workspace
 * packages) is NOT done here — it needs project context and is applied by
 * `extract.ts` via the import resolver (§13.7).
 */
export function extractImports(parsedTree: Tree, _filePath: string): ImportRecord[] {
  const topLevel = nodeChildren(parsedTree.rootNode);
  const imports: ImportRecord[] = [];

  for (const node of topLevel) {
    if (nodeType(node) !== 'import_statement') continue;

    // Module specifier: find the string child (quoted module path).
    const moduleNode = findChildByType(node, 'string');
    if (moduleNode === null) continue;
    // Strip surrounding quotes (' or ").
    const module = moduleNode.text.slice(1, -1);

    // Placeholder classification; extract.ts re-resolves authoritatively via
    // the import resolver (§13.7 — tsconfig aliases, workspace packages,
    // extension probing, symlink realpath). `resolvedPath` is filled there.
    const isExternal = !module.startsWith('.') && !module.startsWith('/');
    const resolvedPath: string | null = null;

    // Extract named imports from the import_clause.
    const symbols: string[] = [];
    const importClause = findChildByType(node, 'import_clause');
    if (importClause !== null) {
      const namedImports = findChildByType(importClause, 'named_imports');
      if (namedImports !== null) {
        for (const specifier of nodeNamedChildren(namedImports)) {
          if (nodeType(specifier) !== 'import_specifier') continue;
          const name = specifier.childForFieldName('name')?.text;
          if (name !== undefined) symbols.push(name);
        }
      }
    }

    imports.push({ module, symbols, isExternal, resolvedPath });
  }

  return imports;
}

/**
 * Extract graph edge records from a parsed tree:
 *   - IMPLEMENTS  — class → interface (`implements` clause)
 *   - EXTENDS     — class/interface → its base (`extends` clause)
 *   - PARENT_OF   — class → its method symbols
 *   - POTENTIAL_CALL — caller symbol → statically-resolved callee (§10.3.1)
 *
 * Edge records use symbol *names*; `insertEdges` resolves them to ids after all
 * files' symbols are inserted (two-pass requirement). A POTENTIAL_CALL whose
 * callee name is not a known indexed symbol is dropped there — that is how the
 * "only a known symbol becomes a verified edge" rule from §10.3 is enforced.
 *
 * `src` is the raw source, used to attach the call-site line + context.
 */
export function extractEdges(parsedTree: Tree, _filePath: string, src: string): EdgeRecord[] {
  const lines = src.split('\n');
  const topLevel = nodeChildren(parsedTree.rootNode);
  const edges: EdgeRecord[] = [];

  // File-scoped callables: named imports + same-file top-level symbol names.
  const importedNames: string[] = [];
  const sameFileNames: string[] = [];
  for (const node of topLevel) {
    if (nodeType(node) === 'import_statement') {
      const importClause = findChildByType(node, 'import_clause');
      const namedImports = importClause !== null ? findChildByType(importClause, 'named_imports') : null;
      if (namedImports !== null) {
        for (const spec of nodeNamedChildren(namedImports)) {
          if (nodeType(spec) !== 'import_specifier') continue;
          const name = spec.childForFieldName('name')?.text;
          if (name !== undefined) importedNames.push(name);
        }
      }
      continue;
    }
    const decl = nodeType(node) === 'export_statement' ? getWrappedDeclaration(node) : node;
    if (decl === null) continue;
    const name = getDeclName(decl);
    if (name !== null) sameFileNames.push(name);
  }

  const seedFileScope = (env: LocalTypeEnvironment): void => {
    for (const n of importedNames) env.recordImport(n);
    for (const n of sameFileNames) env.recordSameFileSymbol(n);
  };

  for (const node of topLevel) {
    const declNode = nodeType(node) === 'export_statement' ? getWrappedDeclaration(node) : node;
    if (declNode === null) continue;
    const t = nodeType(declNode);

    if (t === 'class_declaration' || t === 'abstract_class_declaration') {
      emitClassEdges(declNode, edges, seedFileScope, lines);
    } else if (t === 'interface_declaration') {
      emitInterfaceExtends(declNode, edges);
    } else if (t === 'function_declaration' || t === 'generator_function_declaration') {
      const name = declNode.childForFieldName('name')?.text ?? null;
      const body = declNode.childForFieldName('body');
      if (name !== null && body !== null) {
        emitCallEdges(name, declNode.childForFieldName('parameters'), body, edges, seedFileScope, lines);
      }
    } else if (t === 'lexical_declaration' || t === 'variable_declaration') {
      const declarator = findChildByType(declNode, 'variable_declarator');
      const value = declarator?.childForFieldName('value') ?? null;
      const name = declarator?.childForFieldName('name')?.text ?? null;
      if (name !== null && value !== null && nodeType(value) === 'arrow_function') {
        const body = value.childForFieldName('body');
        if (body !== null) {
          emitCallEdges(name, value.childForFieldName('parameters'), body, edges, seedFileScope, lines);
        }
      }
    }
  }

  return edges;
}

/** IMPLEMENTS + EXTENDS + PARENT_OF + per-method POTENTIAL_CALL for one class. */
function emitClassEdges(
  classNode: SyntaxNode,
  edges: EdgeRecord[],
  seedFileScope: (env: LocalTypeEnvironment) => void,
  lines: readonly string[],
): void {
  const className = classNode.childForFieldName('name')?.text ?? null;
  if (className === null) return;

  // tree-sitter-typescript wraps extends/implements in a `class_heritage` node.
  const heritage = findChildByType(classNode, 'class_heritage');
  const implClause = heritage !== null
    ? findChildByType(heritage, 'implements_clause')
    : findChildByType(classNode, 'implements_clause');
  if (implClause !== null) {
    for (const typeRef of nodeNamedChildren(implClause)) {
      const ifaceName = typeRefName(typeRef);
      if (ifaceName !== null) edges.push({ fromName: className, toName: ifaceName, edgeType: 'IMPLEMENTS' });
    }
  }

  // EXTENDS: the `extends` clause names the base class.
  const extendsClause = heritage !== null
    ? findChildByType(heritage, 'extends_clause')
    : findChildByType(classNode, 'extends_clause');
  if (extendsClause !== null) {
    for (const typeRef of nodeNamedChildren(extendsClause)) {
      const baseName = typeRefName(typeRef);
      if (baseName !== null) {
        edges.push({ fromName: className, toName: baseName, edgeType: 'EXTENDS' });
        break; // a class extends at most one base
      }
    }
  }

  const bodyNode = classNode.childForFieldName('body') ?? findChildByType(classNode, 'class_body');
  if (bodyNode === null) return;

  // Class-wide receiver bindings: constructor parameter properties + fields.
  const fieldBindings = collectClassFieldBindings(bodyNode);

  for (const member of nodeNamedChildren(bodyNode)) {
    const mt = nodeType(member);
    if (mt !== 'method_definition' && mt !== 'abstract_method_signature') continue;
    const methodName = member.childForFieldName('name')?.text ?? null;
    if (methodName === null) continue;

    edges.push({ fromName: className, toName: `${className}.${methodName}`, edgeType: 'PARENT_OF' });

    const body = member.childForFieldName('body');
    if (body === null) continue; // abstract / no body
    emitCallEdges(
      `${className}.${methodName}`,
      member.childForFieldName('parameters'),
      body,
      edges,
      seedFileScope,
      lines,
      fieldBindings,
    );
  }
}

/** interface extends interface(s). */
function emitInterfaceExtends(ifaceNode: SyntaxNode, edges: EdgeRecord[]): void {
  const name = ifaceNode.childForFieldName('name')?.text ?? null;
  if (name === null) return;
  const extendsClause = findChildByType(ifaceNode, 'extends_type_clause')
    ?? findChildByType(ifaceNode, 'extends_clause');
  if (extendsClause === null) return;
  for (const typeRef of nodeNamedChildren(extendsClause)) {
    const baseName = typeRefName(typeRef);
    if (baseName !== null) edges.push({ fromName: name, toName: baseName, edgeType: 'EXTENDS' });
  }
}

/**
 * Build the local type environment for a function/method scope and emit one
 * POTENTIAL_CALL edge per statically-resolvable call site in its body.
 */
function emitCallEdges(
  fromName: string,
  paramsNode: SyntaxNode | null,
  bodyNode: SyntaxNode,
  edges: EdgeRecord[],
  seedFileScope: (env: LocalTypeEnvironment) => void,
  lines: readonly string[],
  classFieldBindings: readonly ReceiverBinding[] = [],
): void {
  const env = new LocalTypeEnvironment();
  seedFileScope(env);
  for (const b of classFieldBindings) env.recordReceiverType(b.receiver, b.type, b.resolution);
  if (paramsNode !== null) {
    for (const b of collectParamBindings(paramsNode)) env.recordReceiverType(b.receiver, b.type, b.resolution);
  }
  for (const b of collectNewBindings(bodyNode)) env.recordReceiverType(b.receiver, b.type, b.resolution);

  for (const call of collectCalls(bodyNode)) {
    const parsed = parseCallee(call);
    if (parsed === null) continue;
    const resolved = env.resolveCall(parsed.receiver, parsed.method);
    if (resolved === null) continue;
    const line = call.startPosition.row + 1;
    edges.push({
      fromName,
      toName: resolved.callee,
      edgeType: 'POTENTIAL_CALL',
      resolution: resolved.resolution,
      callLine: line,
      context: (lines[line - 1] ?? '').trim(),
    });
  }
}

interface ReceiverBinding {
  readonly receiver: string;
  readonly type: string;
  readonly resolution: CallerResolution;
}

/** Constructor parameter properties + plain field declarations → `this.x` bindings. */
function collectClassFieldBindings(classBody: SyntaxNode): ReceiverBinding[] {
  const bindings: ReceiverBinding[] = [];
  for (const member of nodeNamedChildren(classBody)) {
    const mt = nodeType(member);
    if (mt === 'public_field_definition' || mt === 'property_signature') {
      const name = member.childForFieldName('name')?.text ?? null;
      const type = annotationTypeName(member);
      if (name !== null && type !== null) bindings.push({ receiver: `this.${name}`, type, resolution: 'field_type' });
    } else if (mt === 'method_definition' && member.childForFieldName('name')?.text === 'constructor') {
      const params = member.childForFieldName('parameters');
      if (params !== null) {
        for (const param of nodeNamedChildren(params)) {
          // A constructor parameter property carries an accessibility modifier.
          if (findChildByType(param, 'accessibility_modifier') === null) continue;
          const name = findChildByType(param, 'identifier')?.text ?? null;
          const type = annotationTypeName(param);
          if (name !== null && type !== null) bindings.push({ receiver: `this.${name}`, type, resolution: 'field_type' });
        }
      }
    }
  }
  return bindings;
}

/** Annotated (non-property) parameters → bare-name receiver bindings. */
function collectParamBindings(paramsNode: SyntaxNode): ReceiverBinding[] {
  const bindings: ReceiverBinding[] = [];
  for (const param of nodeNamedChildren(paramsNode)) {
    const pt = nodeType(param);
    if (pt !== 'required_parameter' && pt !== 'optional_parameter') continue;
    if (findChildByType(param, 'accessibility_modifier') !== null) continue; // handled as a field
    const name = findChildByType(param, 'identifier')?.text ?? null;
    const type = annotationTypeName(param);
    if (name !== null && type !== null) bindings.push({ receiver: name, type, resolution: 'parameter_type' });
  }
  return bindings;
}

/** `const x = new Foo()` → `x` resolves to type `Foo`. */
function collectNewBindings(bodyNode: SyntaxNode): ReceiverBinding[] {
  const bindings: ReceiverBinding[] = [];
  const visit = (node: SyntaxNode): void => {
    if (nodeType(node) === 'variable_declarator') {
      const value = node.childForFieldName('value');
      const name = node.childForFieldName('name')?.text ?? null;
      if (name !== null && value !== null && nodeType(value) === 'new_expression') {
        const ctor = value.childForFieldName('constructor') ?? value.namedChildren[0] ?? null;
        const type = ctor !== null && nodeType(ctor) === 'identifier' ? ctor.text : null;
        if (type !== null) bindings.push({ receiver: name, type, resolution: 'new_expression' });
      }
    }
    for (const child of nodeNamedChildren(node)) visit(child);
  };
  visit(bodyNode);
  return bindings;
}

/** Collect call_expression nodes within a body, not descending into nested
 *  named functions/methods/classes (their calls belong to their own scope). */
function collectCalls(bodyNode: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  const visit = (node: SyntaxNode): void => {
    for (const child of nodeNamedChildren(node)) {
      const t = nodeType(child);
      if (t === 'function_declaration' || t === 'method_definition' ||
          t === 'class_declaration' || t === 'abstract_class_declaration') {
        continue;
      }
      if (t === 'call_expression') calls.push(child);
      visit(child);
    }
  };
  visit(bodyNode);
  return calls;
}

/** Extract `{ receiver, method }` from a call expression, or null if unhandled. */
function parseCallee(call: SyntaxNode): { receiver: string | null; method: string } | null {
  const fn = call.childForFieldName('function') ?? call.namedChildren[0] ?? null;
  if (fn === null) return null;

  if (nodeType(fn) === 'identifier') {
    return { receiver: null, method: fn.text };
  }
  if (nodeType(fn) === 'member_expression') {
    const method = fn.childForFieldName('property')?.text ?? null;
    const objectNode = fn.childForFieldName('object');
    if (method === null || objectNode === null) return null;
    const receiver = receiverString(objectNode);
    if (receiver === null) return null;
    return { receiver, method };
  }
  return null;
}

/** Stringify a member-expression receiver for the conservative resolver. */
function receiverString(objectNode: SyntaxNode): string | null {
  const t = nodeType(objectNode);
  if (t === 'identifier') return objectNode.text;
  if (t === 'member_expression') {
    const inner = objectNode.childForFieldName('object');
    const prop = objectNode.childForFieldName('property')?.text ?? null;
    if (inner !== null && prop !== null && nodeType(inner) === 'this') return `this.${prop}`;
  }
  return null;
}

/** Name of a type reference node in a heritage clause. */
function typeRefName(typeRef: SyntaxNode): string | null {
  const t = nodeType(typeRef);
  if (t === 'type_identifier' || t === 'identifier') return typeRef.text;
  if (t === 'generic_type') return typeRef.childForFieldName('name')?.text ?? null;
  return null;
}

/** Resolve the named type from a node's `type_annotation` child, if simple. */
function annotationTypeName(node: SyntaxNode): string | null {
  const annotation = findChildByType(node, 'type_annotation');
  if (annotation === null) return null;
  for (const child of nodeNamedChildren(annotation)) {
    const t = nodeType(child);
    if (t === 'type_identifier') return child.text;
    if (t === 'generic_type') return child.childForFieldName('name')?.text ?? null;
  }
  return null;
}

/**
 * Extract all identifier tokens from chunk content for `identifier_fts`.
 * Returns a whitespace-separated, deduplicated list of identifier strings.
 * Uses a word-boundary regex — sufficient for the unicode61 tokeniser's
 * identifier-boundary separators.
 */
export function extractIdentifiers(content: string): string {
  const re = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    seen.add(m[0]);
  }
  return [...seen].join(' ');
}

// ---------------------------------------------------------------------------
// Private hash helpers for symbol records
// ---------------------------------------------------------------------------

function chunkTypeToKind(t: ChunkType): string {
  switch (t) {
    case 'function': return 'function';
    case 'class_shell': return 'class';
    case 'method': return 'method';
    case 'interface': return 'interface';
    case 'type': return 'type';
    default: return 'const';
  }
}
