import { createHash } from 'node:crypto';
import { extname, posix } from 'node:path';
import type { LanguageExtractor } from '../parser.js';
import type { Chunk, ChunkType, Language, SymbolRecord, ImportRecord, EdgeRecord } from '../types.js';

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parsedTree: any,
    src: string,
    filePath: string,
    fileMtime: number,
    contextLines: number,
    chunkSplitThreshold: number,
  ): Chunk[] {
    const lines = src.split('\n');
    const lang = languageFromExt(extname(filePath));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const rootNode: unknown = parsedTree.rootNode;
    const topLevel = nodeChildren(rootNode);

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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const localName: string | undefined = (child as any).childForFieldName?.('name')?.text;
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

      let declNode: unknown = node;
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

    return chunks;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  declarationHash(node: any, src: string): string {
    return sha256(extractSignatureText(node, src));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bodyHash(node: any, src: string): string {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
    const bodyNode = (node as any).childForFieldName?.('body') ?? findChildByType(node, 'statement_block');
    if (bodyNode === null) return sha256('');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return sha256(src.slice((bodyNode as any).startIndex as number, (bodyNode as any).endIndex as number));
  }
}

// ---------------------------------------------------------------------------
// Chunk emission
// ---------------------------------------------------------------------------

function emitChunksForNode(
  node: unknown,
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const name: string | null = (node as any).childForFieldName?.('name')?.text ?? null;
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
      });
      break;
    }

    case 'lexical_declaration':
    case 'variable_declaration': {
      const declarator = findChildByType(node, 'variable_declarator');
      if (declarator === null) break;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const valNode: unknown = (declarator as any).childForFieldName?.('value') ?? null;
      const isFunc =
        valNode !== null &&
        (nodeType(valNode) === 'arrow_function' ||
          nodeType(valNode) === 'function' ||
          nodeType(valNode) === 'generator_function');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const name: string | null = (declarator as any).childForFieldName?.('name')?.text ?? null;
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
      });
      break;
    }

    case 'class_declaration':
    case 'abstract_class_declaration': {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const className: string | null = (node as any).childForFieldName?.('name')?.text ?? null;
      const bodyNode: unknown =
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        (node as any).childForFieldName?.('body') ?? findChildByType(node, 'class_body');

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
      });

      // Method chunks
      if (bodyNode !== null && className !== null) {
        for (const member of nodeNamedChildren(bodyNode)) {
          const mt = nodeType(member);
          if (mt !== 'method_definition' && mt !== 'abstract_method_signature') continue;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
          const methodName: string | null = (member as any).childForFieldName?.('name')?.text ?? null;
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
          });
        }
      }
      break;
    }

    case 'interface_declaration': {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const name: string | null = (node as any).childForFieldName?.('name')?.text ?? null;
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
      });
      break;
    }

    case 'type_alias_declaration': {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const name: string | null = (node as any).childForFieldName?.('name')?.text ?? null;
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
  classNode: unknown,
  bodyNode: unknown,
  src: string,
): string {
  // Header: class declaration up to (not including) the opening `{`
  let header: string;
  if (bodyNode !== null) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const classStart = (classNode as any).startIndex as number;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const bodyStart = (bodyNode as any).startIndex as number;
    header = src.slice(classStart, bodyStart).trimEnd();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    header = src.slice((classNode as any).startIndex as number, (classNode as any).endIndex as number);
  }

  if (bodyNode === null) return header;

  const memberLines: string[] = [header + ' {'];

  for (const member of nodeNamedChildren(bodyNode)) {
    const mt = nodeType(member);
    if (
      mt !== 'method_definition' &&
      mt !== 'abstract_method_signature' &&
      mt !== 'public_field_definition' &&
      mt !== 'readonly_type'
    ) continue;

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
export function extractSignatureText(node: unknown, src: string): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const bodyNode: unknown = (node as any).childForFieldName?.('body') ?? findChildByType(node, 'statement_block');

  if (bodyNode === null) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return src.slice((node as any).startIndex as number, (node as any).endIndex as number);
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return src.slice((node as any).startIndex as number, (bodyNode as any).startIndex as number).trimEnd();
}

/**
 * Find the immediately preceding TSDoc or line comment for a node.
 * Returns the comment text, or null if none found.
 */
function getLeadingComment(node: unknown, parentNode: unknown, src: string): string | null {
  const siblings = nodeChildren(parentNode);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const nodeStart = (node as any).startIndex as number;

  // Walk backwards from the node's position to find an adjacent comment.
  let precedingComment: unknown | null = null;
  for (const sibling of siblings) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const sibEnd = (sibling as any).endIndex as number;
    if (sibEnd > nodeStart) break;
    if (nodeType(sibling) === 'comment') {
      precedingComment = sibling;
    } else if (nodeType(sibling) !== 'comment') {
      // Reset if a non-comment, non-whitespace node appears between the comment and our node.
      precedingComment = null;
    }
  }

  if (precedingComment === null) return null;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return src.slice((precedingComment as any).startIndex as number, (precedingComment as any).endIndex as number);
}

// ---------------------------------------------------------------------------
// Node helpers (all typed as unknown → any casts inside, never leaked)
// ---------------------------------------------------------------------------

function nodeType(node: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return (node as any).type as string;
}

function nodeStartLine(node: unknown): number {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return ((node as any).startPosition.row as number) + 1;
}

function nodeEndLine(node: unknown): number {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return ((node as any).endPosition.row as number) + 1;
}

function nodeChildren(node: unknown): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return ((node as any).children as unknown[] | undefined) ?? [];
}

function nodeNamedChildren(node: unknown): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return ((node as any).namedChildren as unknown[] | undefined) ?? [];
}

function findChildByType(node: unknown, type: string): unknown | null {
  for (const child of nodeChildren(node)) {
    if (nodeType(child) === type) return child;
  }
  return null;
}

/**
 * Return the wrapped declaration node for `export function foo(){}` style.
 * Returns null for `export { foo }` and `export * from '...'` forms.
 */
function getWrappedDeclaration(exportStmtNode: unknown): unknown | null {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  const fieldDecl: unknown = (exportStmtNode as any).childForFieldName?.('declaration') ?? null;
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
 * Return true if the export_statement has a `from` clause (re-exporting from another module).
 */
function hasFromClause(node: unknown): boolean {
  for (const child of nodeChildren(node)) {
    if (nodeType(child) === 'string') return true; // `from './module'` has a string child
  }
  return false;
}

/**
 * Get the primary declared name from a declaration node, or null.
 */
function getDeclName(node: unknown): string | null {
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    return (node as any).childForFieldName?.('name')?.text ?? null;
  }

  if (t === 'lexical_declaration' || t === 'variable_declaration') {
    const declarator = findChildByType(node, 'variable_declarator');
    if (declarator === null) return null;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    return (declarator as any).childForFieldName?.('name')?.text ?? null;
  }

  return null;
}

/**
 * Return true if the class member has a `private` accessibility modifier.
 */
function hasPrivateModifier(memberNode: unknown): boolean {
  for (const child of nodeChildren(memberNode)) {
    const t = nodeType(child);
    if (t === 'accessibility_modifier') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      return ((child as any).text as string) === 'private';
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
      declarationHash: declarationHashFromContent(c.content),
      bodyHash: bodyHashFromContent(c.content),
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
 * `filePath` is the relative path of the file being indexed (used for
 * resolving relative module specifiers to monorepo paths).
 */
export function extractImports(parsedTree: unknown, filePath: string): ImportRecord[] {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const topLevel = nodeChildren((parsedTree as any).rootNode);
  const imports: ImportRecord[] = [];

  for (const node of topLevel) {
    if (nodeType(node) !== 'import_statement') continue;

    // Module specifier: find the string child (quoted module path).
    const moduleNode = findChildByType(node, 'string');
    if (moduleNode === null) continue;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const rawText = (moduleNode as any).text as string;
    // Strip surrounding quotes (' or ").
    const module = rawText.slice(1, -1);

    const isExternal = !module.startsWith('.') && !module.startsWith('/');

    // Resolve relative path for intra-monorepo imports.
    let resolvedPath: string | null = null;
    if (!isExternal) {
      const dir = posix.dirname(filePath);
      resolvedPath = posix.normalize(posix.join(dir, module));
    }

    // Extract named imports from the import_clause.
    const symbols: string[] = [];
    const importClause = findChildByType(node, 'import_clause');
    if (importClause !== null) {
      const namedImports = findChildByType(importClause, 'named_imports');
      if (namedImports !== null) {
        for (const specifier of nodeNamedChildren(namedImports)) {
          if (nodeType(specifier) !== 'import_specifier') continue;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
          const name: string | undefined = (specifier as any).childForFieldName?.('name')?.text;
          if (name !== undefined) symbols.push(name);
        }
      }
    }

    imports.push({ module, symbols, isExternal, resolvedPath });
  }

  return imports;
}

/**
 * Extract IMPLEMENTS edge records from a parsed tree.
 *
 * Walks top-level class declarations and emits one EdgeRecord per entry in
 * each class's `implements` clause.  Edge records use symbol names (not IDs)
 * — `insertEdges` resolves them against the symbols table after all files have
 * been inserted (two-pass requirement).
 */
export function extractEdges(parsedTree: unknown, _filePath: string): EdgeRecord[] {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const topLevel = nodeChildren((parsedTree as any).rootNode);
  const edges: EdgeRecord[] = [];

  for (const node of topLevel) {
    let declNode = node;
    if (nodeType(node) === 'export_statement') {
      const decl = getWrappedDeclaration(node);
      if (decl === null) continue;
      declNode = decl;
    }

    const t = nodeType(declNode);
    if (t !== 'class_declaration' && t !== 'abstract_class_declaration') continue;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const className: string | null = (declNode as any).childForFieldName?.('name')?.text ?? null;
    if (className === null) continue;

    // tree-sitter-typescript wraps extends/implements in a `class_heritage` node.
    // Fall back to scanning named children if the grammar version doesn't use it.
    const heritage = findChildByType(declNode, 'class_heritage');
    const implClause = heritage !== null
      ? findChildByType(heritage, 'implements_clause')
      : findChildByType(declNode, 'implements_clause');

    if (implClause !== null) {
      for (const typeRef of nodeNamedChildren(implClause)) {
        let ifaceName: string | null = null;
        if (nodeType(typeRef) === 'type_identifier') {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          ifaceName = (typeRef as any).text as string;
        } else if (nodeType(typeRef) === 'generic_type') {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
          ifaceName = (typeRef as any).childForFieldName?.('name')?.text ?? null;
        }
        if (ifaceName !== null) {
          edges.push({ fromName: className, toName: ifaceName, edgeType: 'IMPLEMENTS' });
        }
      }
    }

    // PARENT_OF edges: class → method symbols (method symbol names are `ClassName.methodName`).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const bodyNode: unknown = (declNode as any).childForFieldName?.('body') ?? findChildByType(declNode, 'class_body');
    if (bodyNode !== null) {
      for (const member of nodeNamedChildren(bodyNode)) {
        const mt = nodeType(member);
        if (mt !== 'method_definition' && mt !== 'abstract_method_signature') continue;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const methodName: string | null = (member as any).childForFieldName?.('name')?.text ?? null;
        if (methodName === null) continue;
        edges.push({ fromName: className, toName: `${className}.${methodName}`, edgeType: 'PARENT_OF' });
      }
    }
  }

  return edges;
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
    seen.add(m[0] as string);
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

/** sha256 of the content up to (not including) the first `{`. */
function declarationHashFromContent(content: string): string {
  const idx = content.indexOf('{');
  return sha256(idx >= 0 ? content.slice(0, idx) : content);
}

/** sha256 of the content from the first `{` to the end (the body). */
function bodyHashFromContent(content: string): string {
  const idx = content.indexOf('{');
  return sha256(idx >= 0 ? content.slice(idx) : '');
}
