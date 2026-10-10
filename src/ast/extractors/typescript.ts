import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { parseSource, type Tree, type SyntaxNode } from '../parser.js';
import type { LanguageExtractor, FileExtraction, ExtractorOptions, IdentifierRow, StarReExportRecord } from '../extractor.js';
import type { Chunk, ChunkType, ClassFieldNames, Language, SymbolRecord, ImportRecord, EdgeRecord, CallerResolution, ParamEntry } from '../types.js';
import { WHOLE_MODULE } from '../types.js';
import { LocalTypeEnvironment } from '../../graph/local-type-env.js';
import { getImportResolver } from '../../indexer/import-resolver.js';

// ---------------------------------------------------------------------------
// TypeScriptExtractor
// ---------------------------------------------------------------------------

/**
 * TypeScript/JavaScript chunk extractor.
 *
 * Implements §10.1 chunking strategy and §10.2 signature extraction.
 * Handles class decomposition (shell + method chunks) and the two-pass
 * walk for `is_exported` detection. tree-sitter parsing is internal —
 * callers only see the `LanguageExtractor` contract.
 */
export class TypeScriptExtractor implements LanguageExtractor {
  readonly language = 'typescript';
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx'] as const;

  extract(src: string, filePath: string, fileMtime: number, options: ExtractorOptions): FileExtraction {
    const extension = extname(filePath);
    const tree = parseSource(src, extension);
    const rawChunks = this.extractChunks(tree, src, filePath, fileMtime, options.contextLines, options.chunkSplitThreshold);

    // extractChunks stamps the extension-derived language on each chunk, but
    // the extractor's own `language` is always 'typescript' — derive the
    // file-level value from the extension so `.js`/`.jsx` filters work.
    const language = languageFromExt(extension);
    const chunks = rawChunks;

    // Resolve each import specifier to a real indexed file (§13.7): relative
    // probing, tsconfig aliases, workspace packages, symlink realpath.
    const resolver = getImportResolver(options.projectRoot);
    const imports = extractImports(tree, filePath).map((imp) => {
      const r = resolver.resolve(imp.module, filePath);
      return { ...imp, isExternal: r.isExternal, resolvedPath: r.resolvedPath };
    });

    // Re-exports (§10.1): named ones become exported marker symbols (kind
    // 'export') plus RE_EXPORTS edges so rename impact can find barrels; star
    // ones become file-level re_export_files records (no per-symbol identity).
    const reExports = extractReExports(tree);
    const markerSymbols: SymbolRecord[] = reExports.named.map((r) => ({
      name: r.exportedName,
      kind: 'export',
      line: r.line,
      isExported: true,
      declarationHash: null,
      bodyHash: null,
    }));
    const reExportEdges: EdgeRecord[] = reExports.named.map((r) => ({
      fromName: r.exportedName,
      toName: r.sourceName,
      edgeType: 'RE_EXPORTS',
      // Same resolver call already made for imports/starReExports above — the
      // file evidence `insertEdges` needs to scope this edge to the module the
      // re-export actually names (Task 0 fix, see EdgeRecord.toResolvedPath).
      toResolvedPath: resolver.resolve(r.module, filePath).resolvedPath,
    }));
    const starReExports: StarReExportRecord[] = reExports.stars.map((s) => ({
      module: s.module,
      resolvedPath: resolver.resolve(s.module, filePath).resolvedPath,
      line: s.line,
    }));

    // The default export has a name of its own, and `default` finds it by this
    // flag. Every top-level row of the name: a class merged with an interface
    // is exported as both (D148).
    const defaultName = defaultExportName(nodeChildren(tree.rootNode));
    const symbols = [
      ...symbolsFromChunks(chunks).map((s) => (s.name === defaultName ? { ...s, isDefaultExport: true as const } : s)),
      ...markerSymbols,
    ];
    // `export { a as b }` of a declaration of this file. Only where `a` has a
    // row: that is when `b` was given one beside it.
    const localAliasRecords: EdgeRecord[] = localExportAliases(nodeChildren(tree.rootNode))
      .filter(({ local }) => symbols.some((s) => s.name === local && s.kind !== 'export'))
      .map(({ local, alias }) => ({ fromName: alias, toName: local, edgeType: 'RE_EXPORTS', localAlias: true }));
    const edges = [...extractEdges(tree, filePath, src), ...reExportEdges, ...localAliasRecords];

    // F5 (Stage 3): qualified compounds ("Class.method") for identifier_fts.
    // `searchIdentifiers` phrase-quotes its query term, and identifier_fts'
    // unicode61 tokenizer treats '.' as a separator, so a query for a
    // qualified method name only matches a row whose identifiers column has
    // the class/method tokens ADJACENT — which the bare-identifier bag below
    // essentially never produces (the chunk text rarely repeats "Class"
    // immediately followed by "method"). Deriving the compounds from `edges`
    // (rather than re-walking the AST) rides the SAME resolution already
    // computed by `extractEdges`/`LocalTypeEnvironment` — no parallel
    // mechanism, and a receiver `extractEdges` could not statically link
    // (DI/factory calls, §10.3.1's documented gap) correctly contributes
    // nothing here either, since no POTENTIAL_CALL edge exists for it.
    const qualifiedMentionsByFromName = new Map<string, string[]>();
    for (const e of edges) {
      // `toName` is qualified ("Type.method") only for a receiver-based call
      // (LocalTypeEnvironment.resolveCall's `${binding.type}.${method}` path)
      // — a bare call (import/same_file resolution) has no receiver and
      // therefore no dot. PARENT_OF/EXTENDS/etc. use a different fromName
      // scope (the class itself, not a method body) and must not leak in.
      if (e.edgeType !== 'POTENTIAL_CALL' || !e.toName.includes('.')) continue;
      const mentions = qualifiedMentionsByFromName.get(e.fromName);
      if (mentions === undefined) qualifiedMentionsByFromName.set(e.fromName, [e.toName]);
      else mentions.push(e.toName);
    }

    const identifierRows: IdentifierRow[] = chunks.flatMap((chunk) => {
      const base = extractIdentifiers(chunk.content);
      // Declaration self-discoverability: a method chunk's own qualified
      // name (constructor/getter/setter forms are already qualified, since
      // `symbol_name` is always `${className}.${methodName}` for chunk_type
      // 'method' — see the `chunks.push` call above).
      const ownQualified = chunk.chunk_type === 'method' && chunk.symbol_name !== null
        ? [chunk.symbol_name]
        : [];
      const mentionQualified = chunk.symbol_name !== null
        ? qualifiedMentionsByFromName.get(chunk.symbol_name) ?? []
        : [];
      const identifiers = appendQualifiedCompounds(base, [...ownQualified, ...mentionQualified]);
      // ONE row per chunk, in chunk order, even when the bag is empty. The empty
      // ones are dropped in `extractFile` AFTER `remapIdentifierRows` has used the
      // positional correspondence to re-key them (D040) — dropping them here is what
      // made the correspondence partial, and a partial correspondence cannot be
      // reconstructed from `chunk_id` alone once two chunks share one.
      return [{ chunk_id: chunk.chunk_id, identifiers }];
    });

    return { language, chunks, symbols, imports, edges, identifierRows, starReExports };
  }

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
        const name = getDeclName(unwrapAmbient(node));
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
        const localName = specifierName(child, 'name');
        const alias = specifierName(child, 'alias');
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
    // `declare function f(a: string): void; declare function f(a: number): void;`
    // is one function. The first signature is its symbol; a later one keeps its
    // text as a block, as an overload of a function with a body does.
    const ambientFunctions = new Set<string>();

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
        declNode = unwrapAmbient(node);
        const name = getDeclName(declNode);
        isExported = name !== null && exportedNames.has(name);
      }

      if (isAmbientFunction(declNode)) {
        const name = getDeclName(declNode);
        if (name !== null && ambientFunctions.has(name)) declNode = node;
        else if (name !== null) ambientFunctions.add(name);
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

  // An overload of a function with a body is a `function_signature` too, and
  // is a block; only the ambient one is a function.
  switch (isAmbientFunction(node) ? 'function_declaration' : t) {
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
      const isFunc = isFunctionValue(valNode);
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
        ...classFieldsOf(bodyNode),
      });

      // Method chunks
      if (bodyNode !== null && className !== null) {
        for (const member of nodeNamedChildren(bodyNode)) {
          if (!isMethodMember(member, bodyNode)) continue;
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
            ...(isStaticMember(member) ? { is_static: true as const } : {}),
          });
        }
      }
      break;
    }

    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text ?? null;
      const interfaceBody = node.childForFieldName('body');
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
        classFields: classFieldsOf(interfaceBody),
      });

      // Method chunks, named as a class's are. A call on a receiver typed as
      // the interface is resolved to the member of the interface (§10.3.1).
      if (name !== null) {
        for (const member of interfaceMethodsOf(node)) {
          const methodName = member.childForFieldName('name')?.text ?? '';
          const mStart = nodeStartLine(member);
          const mEnd = nodeEndLine(member);
          // No context: the lines around a member are other members, and with
          // them a search for one member's name matches its neighbours' chunks.
          const comment = member.previousNamedSibling;
          const contentStart = comment !== null && nodeType(comment) === 'comment' && nodeEndLine(comment) === mStart - 1 ? nodeStartLine(comment) : mStart;
          chunks.push({
            chunk_id: chunkId(filePath, mStart),
            file_path: filePath,
            start_line: mStart,
            end_line: mEnd,
            content: expandContent(lines, contentStart, mEnd, 0),
            chunk_type: 'method',
            symbol_name: `${name}.${methodName}`,
            parent_symbol: name,
            is_exported: isExported,
            language,
            file_mtime: fileMtime,
            declaration_hash: declHashOf(member, src),
            body_hash: bodyHashOf(member, src),
          });
        }
      }
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
      // Skip zero-content nodes. `declare module 'x';` parses as an
      // `ambient_declaration` (the real content) PLUS a sibling
      // `empty_statement` for the trailing `;` — both fall into this default
      // branch, and `expandContent` then makes the `;` chunk byte-identical
      // to the real declaration's, colliding on chunk_id (GITNEXUS_COMPARISON.md
      // §15.3; measured: directus/app/src/shims.d.ts, 40 chunks/24 unique ids).
      // Filtering here kills the collision at its source — a disambiguator
      // alone would instead legitimize junk `;`-only chunks. The broader
      // whitespace-only check catches the same failure mode for any other
      // node type tree-sitter might emit with no real source text.
      if (t === 'empty_statement' || src.slice(node.startIndex, node.endIndex).trim() === '') {
        break;
      }

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
  /** The fields of the declaration, kept on the chunk its symbol is read from. */
  classFields?: { readonly class_fields?: ClassFieldNames };
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
      ...opts.classFields,
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
      ...(subIndex > 0 ? { continues_declaration: true as const } : opts.classFields),
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
  /**
   * The names the parameter types and the return type refer to, in the order
   * written, each once. Read off the tree, so a name is one whatever its
   * spelling, and a property key or a string in a type is not one (D149).
   */
  readonly typeNames: readonly string[];
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
    const decl = topLevelDeclaration(node);
    if (decl === null) continue;
    // Doc precedes the `export` or `declare` wrapper when there is one.
    const docHost = node;
    // The first signature of an ambient function is the one reported (D109).
    const isAmbient = isAmbientFunction(decl);
    if (isAmbient && out.some((o) => o.name === getDeclName(decl))) continue;
    const t = isAmbient ? 'function_declaration' : nodeType(decl);

    switch (t) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = decl.childForFieldName('name')?.text;
        if (name !== undefined) out.push(signatureFor(name, decl, docHost, root, src));
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        const declarator = findChildByType(decl, 'variable_declarator');
        const value = declarator?.childForFieldName('value') ?? null;
        const name = declarator?.childForFieldName('name')?.text ?? null;
        if (name !== null && value !== null && isFunctionValue(value)) {
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
            typeNames: [],
            doc: getLeadingComment(docHost, root, src),
          });
          // None for a type alias: it has no `method_signature` of its own.
          const docParent = decl.childForFieldName('body') ?? decl;
          for (const member of interfaceMethodsOf(decl)) {
            out.push(signatureFor(`${name}.${member.childForFieldName('name')?.text ?? ''}`, member, member, docParent, src));
          }
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
          typeNames: [],
          doc: getLeadingComment(docHost, root, src),
        });
        const body = decl.childForFieldName('body') ?? findChildByType(decl, 'class_body');
        if (body !== null) {
          for (const member of nodeNamedChildren(body)) {
            if (!isMethodMember(member, body)) continue;
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
    typeNames: typeNamesOf(node),
    doc: getLeadingComment(docHost, docParent, src),
  };
}

/** Signature info for an arrow-function const (`export const f = (...) => ...`). */
/**
 * A variable's value that makes the variable a function: an arrow function, a
 * function expression or a generator function expression. One predicate for
 * the chunk, the signature and the call edges, which each had their own and
 * agreed only on the arrow (D144).
 */
function isFunctionValue(value: SyntaxNode | null): boolean {
  if (value === null) return false;
  const type = nodeType(value);
  return type === 'arrow_function' || type === 'function_expression' || type === 'generator_function';
}

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
    typeNames: typeNamesOf(arrow),
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

/**
 * The type names in a function's parameter annotations and return type. A
 * `type_identifier` is a reference to a type; the name after `typeof` is a
 * value, kept because a class is both; the first name of `a.b.C` is kept
 * because an enum or a namespace is found by it.
 */
function typeNamesOf(node: SyntaxNode): string[] {
  const names = new Set<string>();
  const collect = (within: SyntaxNode): void => {
    const type = nodeType(within);
    if (type === 'type_identifier') names.add(within.text);
    else if (type === 'nested_type_identifier') {
      // `Color.Red`: the first name is the enum or namespace the file imports
      // or declares, and the last is collected as a `type_identifier` below.
      let first = within.childForFieldName('module');
      while (first !== null && nodeType(first) === 'nested_identifier') first = first.childForFieldName('object');
      if (first !== null && nodeType(first) === 'identifier') names.add(first.text);
    } else if (type === 'type_query') {
      // `typeof a.b.c` is asked about `a`.
      let queried = within.namedChildren[0] ?? null;
      while (queried !== null && nodeType(queried) === 'member_expression') queried = queried.childForFieldName('object');
      if (queried !== null && nodeType(queried) === 'identifier') names.add(queried.text);
    }
    for (const child of nodeNamedChildren(within)) collect(child);
  };
  const parameters = node.childForFieldName('parameters') ?? findChildByType(node, 'formal_parameters');
  for (const parameter of parameters === null ? [] : nodeNamedChildren(parameters)) {
    const annotation = findChildByType(parameter, 'type_annotation');
    if (annotation !== null) collect(annotation);
  }
  const returnType = node.childForFieldName('return_type');
  if (returnType !== null) collect(returnType);
  return [...names];
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
 * Whether a child of a class body is a method with a symbol of its own: one
 * with a body, an abstract one, or one written with no body (`m?(): T;`, or
 * any method of a `declare class`). A bodiless method beside an implementation
 * of the same name is an overload of it and is not a member (D107).
 */
/** Whether a class member is declared `static`. */
function isStaticMember(member: SyntaxNode): boolean {
  return nodeChildren(member).some((child) => nodeType(child) === 'static');
}

function isMethodMember(member: SyntaxNode, classBody: SyntaxNode): boolean {
  const type = nodeType(member);
  if (type === 'method_definition' || type === 'abstract_method_signature') return true;
  if (type !== 'method_signature') return false;
  const name = member.childForFieldName('name')?.text;
  return !nodeNamedChildren(classBody).some(
    (other) => nodeType(other) === 'method_definition' && other.childForFieldName('name')?.text === name,
  );
}

/**
 * The methods of an interface that are symbols: each `method_signature` of its
 * body, once however many overloads it is written as.
 *
 * Not one that a class of the interface's name declares in the same file, nor
 * one an earlier declaration of the interface has. They are one merged
 * declaration, and two rows of one name in one file cannot be told apart by a
 * caller's record; where there is a class, its method is the code a call runs.
 * A property with a function type is a field, as it is in a class (D115).
 */
function interfaceMethodsOf(interfaceNode: SyntaxNode): SyntaxNode[] {
  const body = interfaceNode.childForFieldName('body');
  const name = interfaceNode.childForFieldName('name')?.text ?? null;
  if (body === null || name === null) return [];
  const taken = methodNamesDeclaredElsewhere(interfaceNode, name);
  const methods: SyntaxNode[] = [];
  for (const member of nodeNamedChildren(body)) {
    const methodName = interfaceMethodName(member);
    if (methodName === null || taken.has(methodName)) continue;
    taken.add(methodName);
    methods.push(member);
  }
  return methods;
}

/** The name of an interface member that is a method, or null for any other member. */
function interfaceMethodName(member: SyntaxNode): string | null {
  return nodeType(member) === 'method_signature' ? member.childForFieldName('name')?.text ?? null : null;
}

/**
 * The method names that the top-level class called `name`, and the top-level
 * interfaces of that name written before `interfaceNode`, declare in its file.
 */
function methodNamesDeclaredElsewhere(interfaceNode: SyntaxNode, name: string): Set<string> {
  let root = interfaceNode;
  while (root.parent !== null) root = root.parent;
  const names = new Set<string>();
  let isBefore = true;
  for (const topLevel of nodeNamedChildren(root)) {
    const decl = topLevelDeclaration(topLevel);
    if (decl === null) continue;
    if (decl.startIndex === interfaceNode.startIndex) isBefore = false;
    if (decl.childForFieldName('name')?.text !== name) continue;
    const type = nodeType(decl);
    const body = decl.childForFieldName('body') ?? findChildByType(decl, 'class_body');
    if (body === null) continue;
    for (const member of nodeNamedChildren(body)) {
      const memberName = type === 'class_declaration' || type === 'abstract_class_declaration'
        ? (isMethodMember(member, body) ? member.childForFieldName('name')?.text ?? null : null)
        : type === 'interface_declaration' && isBefore ? interfaceMethodName(member) : null;
      if (memberName !== null) names.add(memberName);
    }
  }
  return names;
}

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
    memberType === 'method_signature' ||
    memberType === 'public_field_definition' ||
    memberType === 'property_signature'
  );
}

/** A constructor parameter is a property of the class when it carries one of these. */
const PARAMETER_PROPERTY_MARKS: ReadonlySet<string> = new Set(['accessibility_modifier', 'override_modifier', 'readonly']);

/**
 * The fields of a class body as `{ class_fields }`, or `{}` when it has none
 * (D115). A field written `static` is a member of the class itself.
 */
function classFieldsOf(bodyNode: SyntaxNode | null): { readonly class_fields?: ClassFieldNames } {
  if (bodyNode === null) return {};
  const instance = new Set<string>();
  const statics = new Set<string>();
  for (const member of nodeNamedChildren(bodyNode)) {
    const mt = nodeType(member);
    if (mt === 'public_field_definition' || mt === 'property_signature') {
      const name = member.childForFieldName('name')?.text;
      if (name === undefined) continue;
      (isStaticMember(member) ? statics : instance).add(name);
    } else if (mt === 'method_definition' && member.childForFieldName('name')?.text === 'constructor') {
      for (const param of nodeNamedChildren(member.childForFieldName('parameters') ?? member)) {
        const pt = nodeType(param);
        if (pt !== 'required_parameter' && pt !== 'optional_parameter') continue;
        if (!nodeChildren(param).some((child) => PARAMETER_PROPERTY_MARKS.has(nodeType(child)))) continue;
        const name = findChildByType(param, 'identifier')?.text;
        if (name !== undefined) instance.add(name);
      }
    }
  }
  if (instance.size === 0 && statics.size === 0) return {};
  return { class_fields: { instance: [...instance].sort(), static: [...statics].sort() } };
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
  if (fieldDecl !== null) return unwrapAmbient(fieldDecl);

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
 * What `declare` can stand in front of and still be the declaration it would
 * be without it. A `declare module`, `declare global` or `declare namespace`
 * block is not here: what it holds is not declared at the top of this file.
 */
const AMBIENT_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'function_signature',
  'lexical_declaration',
  'variable_declaration',
  'enum_declaration',
]);

/**
 * The declaration inside `declare <declaration>`, and any other node as it is.
 * The parser wraps the former in an `ambient_declaration`, which no reader of
 * declarations knows (D109).
 */
function unwrapAmbient(node: SyntaxNode): SyntaxNode {
  if (nodeType(node) !== 'ambient_declaration') return node;
  const inner = nodeNamedChildren(node)[0];
  return inner !== undefined && AMBIENT_DECLARATION_TYPES.has(nodeType(inner)) ? inner : node;
}

/**
 * The name of the declaration a file exports as its default: the one written
 * after `export default`, or the identifier in `export default name;`. Null
 * when the file has no default export, or exports an expression or an unnamed
 * function or class. `export { name as default }` is a local alias and is not
 * read here.
 */
function defaultExportName(topLevel: readonly SyntaxNode[]): string | null {
  for (const node of topLevel) {
    if (nodeType(node) !== 'export_statement') continue;
    if (!nodeChildren(node).some((child) => nodeType(child) === 'default')) continue;
    const declared = getWrappedDeclaration(node)?.childForFieldName('name')?.text;
    if (declared !== undefined) return declared;
    const value = node.childForFieldName('value');
    return value !== null && nodeType(value) === 'identifier' ? value.text : null;
  }
  return null;
}

/** The declaration a top-level node holds, under `export`, `declare`, both or neither. */
function topLevelDeclaration(node: SyntaxNode): SyntaxNode | null {
  return nodeType(node) === 'export_statement' ? getWrappedDeclaration(node) : unwrapAmbient(node);
}

/**
 * `declare function f(): T;`. It has no body and is the whole function. The
 * same node without `declare` is an overload of a function that has a body,
 * and that function is the symbol.
 */
function isAmbientFunction(node: SyntaxNode): boolean {
  return nodeType(node) === 'function_signature' && node.parent !== null && nodeType(node.parent) === 'ambient_declaration';
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
      const local = specifierName(spec, 'name');
      const alias = specifierName(spec, 'alias');
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

/** A named import: what the local name is in its module, and the module's specifier. */
interface ImportBinding {
  readonly exported: string;
  readonly module: string;
}

/**
 * The local name of a default import (`X` of `import X from` and of
 * `import X, { a } from`), which binds the name `default` of the module (D130).
 */
function defaultImportName(importClause: SyntaxNode): string | undefined {
  return nodeNamedChildren(importClause).find((child) => nodeType(child) === 'identifier')?.text;
}

/**
 * The file's imports of a name by local name: `Y` of `import { X as Y }`, and
 * `X` of `import X from`, which is `default` under a name. The first import of
 * a local name wins, as the call scope's seeding does.
 */
/**
 * The name in the `name` or `alias` field of an import or export specifier.
 * Either may be written as a string (`import { "a b" as c }`), and the name is
 * then what is between the quotes, however it is quoted (D139).
 */
function specifierName(specifier: SyntaxNode, field: 'name' | 'alias'): string | undefined {
  const node = specifier.childForFieldName(field);
  if (node === null) return undefined;
  return nodeType(node) === 'string' ? node.text.slice(1, -1) : node.text;
}

function namedImportBindings(topLevel: readonly SyntaxNode[]): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const node of topLevel) {
    if (nodeType(node) !== 'import_statement') continue;
    const importClause = findChildByType(node, 'import_clause');
    const namedImports = importClause !== null ? findChildByType(importClause, 'named_imports') : null;
    const moduleNode = findChildByType(node, 'string');
    if (moduleNode === null) continue;
    const defaultLocal = importClause === null ? undefined : defaultImportName(importClause);
    if (defaultLocal !== undefined && !bindings.has(defaultLocal)) {
      bindings.set(defaultLocal, { exported: 'default', module: moduleNode.text.slice(1, -1) });
    }
    if (namedImports === null) continue;
    for (const spec of nodeNamedChildren(namedImports)) {
      if (nodeType(spec) !== 'import_specifier') continue;
      const exported = specifierName(spec, 'name');
      if (exported === undefined) continue;
      const local = specifierName(spec, 'alias') ?? exported;
      if (!bindings.has(local)) bindings.set(local, { exported, module: moduleNode.text.slice(1, -1) });
    }
  }
  return bindings;
}

/**
 * The file's namespace imports by local name: `ns` of `import * as ns from
 * './x'` and of `import d, * as ns from './x'`, with the specifier as written.
 * The first import of a local name wins, as for a named import.
 */
function namespaceImportModules(topLevel: readonly SyntaxNode[]): Map<string, string> {
  const modules = new Map<string, string>();
  for (const node of topLevel) {
    if (nodeType(node) !== 'import_statement') continue;
    const importClause = findChildByType(node, 'import_clause');
    const namespaceImport = importClause === null ? null : findChildByType(importClause, 'namespace_import');
    const local = namespaceImport === null ? undefined : findChildByType(namespaceImport, 'identifier')?.text;
    const moduleNode = findChildByType(node, 'string');
    if (local === undefined || moduleNode === null) continue;
    if (!modules.has(local)) modules.set(local, moduleNode.text.slice(1, -1));
  }
  return modules;
}

export interface NamedReExport {
  /** Name the barrel exposes (`bar` in `export { foo as bar } from './x'`). */
  readonly exportedName: string;
  /** Name in the source module (`foo` above); equals exportedName when unaliased. */
  readonly sourceName: string;
  readonly line: number;
  /** The `from` clause's module specifier (`'./x'` above) — resolved to a real
   *  file by the caller (`extract()`, which has the import resolver in scope),
   *  since this pure function has no filesystem access. Carries the file
   *  evidence a same-named RE_EXPORTS edge needs to resolve correctly. */
  readonly module: string;
}

export interface StarReExport {
  readonly module: string;
  readonly line: number;
}

/**
 * Extract `from`-clause re-exports from a file's top level (§10.1).
 *
 * - `export { Foo, Bar as Baz } from './x'` → named records (one per specifier).
 * - `export * from './x'` → star record; stars carry no per-symbol names, so
 *   they map to `re_export_files` rows rather than symbols/edges.
 * - `export * as ns from './x'` → nothing. It exports the one name `ns`, a
 *   namespace, and mast has no symbol for a namespace (D096).
 *
 * - `import { Foo as F } from './x'; export { F as Baz };` → a named record, as
 *   if written `export { Foo as Baz } from './x'`. Only named imports: a
 *   default or namespace import that is then exported is not followed.
 *
 * An alias of a declaration of the file itself (`export { foo as bar }`) is NOT
 * a re-export — it is handled by `localExportAliases`.
 */
export function extractReExports(parsedTree: Tree): { named: NamedReExport[]; stars: StarReExport[] } {
  const named: NamedReExport[] = [];
  const stars: StarReExport[] = [];
  const topLevel = nodeChildren(parsedTree.rootNode);
  const imported = namedImportBindings(topLevel);

  for (const node of topLevel) {
    if (nodeType(node) !== 'export_statement') continue;
    if (!hasFromClause(node)) {
      // `import { Foo } from './x'; export { Foo };` re-exports as surely as the
      // `from` form does, and a chain through this file has to find it (D108).
      const clause = getWrappedDeclaration(node) === null ? findChildByType(node, 'export_clause') : null;
      for (const spec of clause === null ? [] : nodeNamedChildren(clause)) {
        if (nodeType(spec) !== 'export_specifier') continue;
        const local = specifierName(spec, 'name');
        const binding = local === undefined ? undefined : imported.get(local);
        if (local === undefined || binding === undefined) continue;
        named.push({
          exportedName: specifierName(spec, 'alias') ?? local,
          sourceName: binding.exported,
          line: nodeStartLine(spec),
          module: binding.module,
        });
      }
      continue;
    }

    const moduleNode = findChildByType(node, 'string');
    if (moduleNode === null) continue;
    const module = moduleNode.text.slice(1, -1);

    const clause = findChildByType(node, 'export_clause');
    if (clause === null) {
      // `export * as ns from` exports `ns` and none of the names behind it, so a
      // star record would put those names where TypeScript has none (D096).
      if (findChildByType(node, 'namespace_export') !== null) continue;
      stars.push({ module, line: nodeStartLine(node) });
      continue;
    }

    for (const spec of nodeNamedChildren(clause)) {
      if (nodeType(spec) !== 'export_specifier') continue;
      const sourceName = specifierName(spec, 'name');
      if (sourceName === undefined) continue;
      const alias = specifierName(spec, 'alias');
      named.push({
        exportedName: alias ?? sourceName,
        sourceName,
        line: nodeStartLine(spec),
        module,
      });
    }
  }

  return { named, stars };
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
    t === 'enum_declaration' ||
    isAmbientFunction(node)
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
 * Skips anonymous chunks (`symbol_name === null`), raw `block` chunks, and the
 * later sub-chunks of a split declaration: a declaration is one symbol however
 * many chunks it was cut into, and its line is the declaration's line (D097).
 */
export function symbolsFromChunks(chunks: readonly Chunk[]): SymbolRecord[] {
  const records: SymbolRecord[] = [];
  for (const c of chunks) {
    if (c.symbol_name === null || c.chunk_type === 'block') continue;
    if (c.continues_declaration === true) continue;
    records.push({
      name: c.symbol_name,
      kind: chunkTypeToKind(c.chunk_type),
      line: c.start_line,
      isExported: c.is_exported,
      // AST-derived hashes attached during extraction (§7.1). Null only if a
      // symbol chunk somehow lacked them (defensive; should not happen).
      declarationHash: c.declaration_hash ?? null,
      bodyHash: c.body_hash ?? null,
      ...(c.is_static === true ? { isStatic: true as const } : {}),
      ...(c.class_fields === undefined ? {} : { fields: c.class_fields }),
    });
  }
  return records;
}

/**
 * Extract import records from the tree-sitter AST.
 *
 * Handles named imports (`import { foo } from './bar'`) and default imports
 * (`import foo from './bar'`, stored as the name `default` under the alias
 * `foo`, D130). Side-effect imports (`import './side-effect'`) and namespace
 * imports are recorded with an empty `symbols` array; a namespace import has
 * its local name in `aliases`, under `WHOLE_MODULE`.
 *
 * Specifier-to-file resolution (relative probing, tsconfig aliases, workspace
 * packages) is NOT done here — it needs project context and is applied by
 * `extract.ts` via the import resolver (§13.7).
 */
export function extractImports(parsedTree: Tree, _filePath: string): ImportRecord[] {
  const topLevel = nodeChildren(parsedTree.rootNode);
  const imports: ImportRecord[] = [];
  const exportedLocals = localsExportedByName(topLevel);

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
    // A Map, not an object: a local name may be `__proto__`, which assigned as
    // a key of an object sets its prototype and stores nothing (D139).
    const aliases = new Map<string, string>();
    let exportedAs: readonly string[] = [];
    const importClause = findChildByType(node, 'import_clause');
    if (importClause !== null) {
      // `import X from` is `import { default as X } from` and is stored as it.
      const defaultLocal = defaultImportName(importClause);
      if (defaultLocal !== undefined) {
        symbols.push('default');
        aliases.set(defaultLocal, 'default');
      }
      // `import * as ns from` lists no name. The local name is kept, as the
      // name of all of the module, for a file that goes on to export `ns`.
      const namespaceImport = findChildByType(importClause, 'namespace_import');
      const namespaceLocal = namespaceImport === null ? undefined : findChildByType(namespaceImport, 'identifier')?.text;
      if (namespaceLocal !== undefined) aliases.set(namespaceLocal, WHOLE_MODULE);
      // `import type * as ns` binds nothing that can be called through.
      const isTypeOnly = nodeChildren(node).some((child) => nodeType(child) === 'type');
      exportedAs = namespaceLocal === undefined || isTypeOnly ? [] : exportedLocals.get(namespaceLocal) ?? [];
      const namedImports = findChildByType(importClause, 'named_imports');
      if (namedImports !== null) {
        for (const specifier of nodeNamedChildren(namedImports)) {
          if (nodeType(specifier) !== 'import_specifier') continue;
          const name = specifierName(specifier, 'name');
          if (name === undefined) continue;
          symbols.push(name);
          const local = specifierName(specifier, 'alias');
          if (local !== undefined && local !== name) aliases.set(local, name);
        }
      }
    }

    imports.push({ module, symbols, ...renamedBy(aliases), ...(exportedAs.length > 0 ? { exportedAs } : {}), isExternal, resolvedPath });
  }

  // `export * as ns from './x'` binds nothing in the file and exports all of
  // `./x` as `ns`. It gets an import row, which is where that is recorded and
  // what keeps the path the specifier resolves to current.
  for (const node of topLevel) {
    if (nodeType(node) !== 'export_statement' || isTypeOnlyExport(node)) continue;
    const exportedName = namespaceExportName(node);
    const moduleNode = findChildByType(node, 'string');
    if (exportedName === undefined || moduleNode === null) continue;
    const module = moduleNode.text.slice(1, -1);
    imports.push({ module, symbols: [], exportedAs: [exportedName], isExternal: !module.startsWith('.') && !module.startsWith('/'), resolvedPath: null });
  }

  // `const { X } = await import('./x')`, anywhere in the file: the file imports
  // `X` from `./x` as surely as a static import does. A call of `X` is placed
  // by this row, and repair finds the file by it when `./x` changes. After the
  // static rows, so a lookup by name still finds a static import first.
  // The row is one per module for the whole file, so a local name written in
  // two scopes for two exports keeps the first.
  const dynamic = new Map<string, { symbols: string[]; aliases: Map<string, string> }>();
  const visit = (node: SyntaxNode): void => {
    if (nodeType(node) === 'variable_declarator') {
      for (const { local, binding } of destructuredFromDynamicImport(node)) {
        const row = dynamic.get(binding.module) ?? { symbols: [], aliases: new Map<string, string>() };
        if (!row.symbols.includes(binding.exported)) row.symbols.push(binding.exported);
        if (local !== binding.exported && !row.aliases.has(local)) row.aliases.set(local, binding.exported);
        dynamic.set(binding.module, row);
      }
    }
    for (const child of nodeNamedChildren(node)) visit(child);
  };
  visit(parsedTree.rootNode);
  for (const [module, { symbols, aliases }] of dynamic) {
    imports.push({ module, symbols, ...renamedBy(aliases), isExternal: !module.startsWith('.') && !module.startsWith('/'), resolvedPath: null });
  }

  return imports;
}

/** The `aliases` field of an import record, absent when nothing is renamed. */
/** `ns` of `export * as ns from`, or undefined for any other statement. */
function namespaceExportName(exportStatement: SyntaxNode): string | undefined {
  const namespaceExport = findChildByType(exportStatement, 'namespace_export');
  // Not the first child: a comment may stand before the name. A name written
  // as a string is stored without its quotes, as an import of it is (D139).
  const name = namespaceExport === null ? undefined : nodeNamedChildren(namespaceExport).find((child) => nodeType(child) !== 'comment');
  if (name === undefined) return undefined;
  return nodeType(name) === 'string' ? name.text.slice(1, -1) : name.text;
}

/**
 * `export type { a }` and `export type * as ns from`: nothing that can be
 * called. The grammar (tree-sitter-typescript 0.23.2) reads the `type` of the
 * second as an error. Only an error that is the word counts.
 */
function isTypeOnlyExport(exportStatement: SyntaxNode): boolean {
  return nodeChildren(exportStatement).some(
    (child) => nodeType(child) === 'type' || (nodeType(child) === 'ERROR' && child.text === 'type'),
  );
}

/**
 * For each local name a top-level `export { local }` or `export { local as
 * other }` names, the names it is exported under. Statements with a `from` and
 * type-only ones are left out.
 */
function localsExportedByName(topLevel: readonly SyntaxNode[]): Map<string, string[]> {
  const exported = new Map<string, string[]>();
  for (const node of topLevel) {
    if (nodeType(node) !== 'export_statement' || hasFromClause(node) || isTypeOnlyExport(node)) continue;
    const clause = getWrappedDeclaration(node) === null ? findChildByType(node, 'export_clause') : null;
    for (const spec of clause === null ? [] : nodeNamedChildren(clause)) {
      if (nodeType(spec) !== 'export_specifier' || nodeChildren(spec).some((child) => nodeType(child) === 'type')) continue;
      const local = specifierName(spec, 'name');
      if (local === undefined) continue;
      const names = exported.get(local) ?? [];
      names.push(specifierName(spec, 'alias') ?? local);
      exported.set(local, names);
    }
  }
  return exported;
}

function renamedBy(aliases: ReadonlyMap<string, string>): { aliases?: Readonly<Record<string, string>> } {
  // `Object.fromEntries` defines each key as the object's own, `__proto__` too.
  return aliases.size > 0 ? { aliases: Object.fromEntries(aliases) } : {};
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
 *
 * `onCallSite` (D7, Stage 4) is an optional diagnostics seam: when provided,
 * it is invoked exactly once per `call_expression` node returned by
 * `collectCalls`, classifying the outcome of resolving that call. It exists
 * to make the invariant "every visited call yields an edge or a recorded
 * drop-reason" assertable in tests (`call-oracle.test.ts`); it is not
 * persisted, configured, or surfaced in any tool response — a future
 * instrumentation hook (E2's registered corpus measurement), not a shipped
 * feature. Leaving it `undefined` (the default) costs one `undefined`-check
 * per call site and zero allocation on the production path.
 */
export function extractEdges(
  parsedTree: Tree,
  _filePath: string,
  src: string,
  onCallSite?: (outcome: CallSiteOutcome) => void,
): EdgeRecord[] {
  const lines = src.split('\n');
  const topLevel = nodeChildren(parsedTree.rootNode);
  const edges: EdgeRecord[] = [];

  // File-scoped callables: named imports + same-file top-level symbol names.
  // An import is in scope under its local name (`Y` of `import { X as Y }`);
  // `importBindings` keeps what that name is in its module (D106).
  const importBindings = namedImportBindings(topLevel);
  const importedNames = [...importBindings.keys()];
  const namespaceModules = namespaceImportModules(topLevel);
  const sameFileNames: string[] = [];
  for (const node of topLevel) {
    if (nodeType(node) === 'import_statement') continue;
    const decl = topLevelDeclaration(node);
    if (decl === null) continue;
    const name = getDeclName(decl);
    if (name !== null) sameFileNames.push(name);
  }

  const seedFileScope = (env: LocalTypeEnvironment): void => {
    for (const n of importedNames) env.recordImport(n);
    for (const [local, module] of namespaceModules) env.recordNamespaceImport(local, module);
    for (const n of sameFileNames) env.recordSameFileSymbol(n);
  };

  for (const node of topLevel) {
    const declNode = topLevelDeclaration(node);
    if (declNode === null) continue;
    const t = nodeType(declNode);

    if (t === 'class_declaration' || t === 'abstract_class_declaration') {
      emitClassEdges(declNode, edges, seedFileScope, lines, onCallSite);
    } else if (t === 'interface_declaration') {
      emitInterfaceEdges(declNode, edges);
    } else if (t === 'function_declaration' || t === 'generator_function_declaration') {
      const name = declNode.childForFieldName('name')?.text ?? null;
      const body = declNode.childForFieldName('body');
      if (name !== null && body !== null) {
        emitCallEdges(name, nodeStartLine(declNode), declNode.childForFieldName('parameters'), body, edges, seedFileScope, lines, [], onCallSite);
      }
    } else if (t === 'lexical_declaration' || t === 'variable_declaration') {
      const declarator = findChildByType(declNode, 'variable_declarator');
      const value = declarator?.childForFieldName('value') ?? null;
      const name = declarator?.childForFieldName('name')?.text ?? null;
      if (name !== null && value !== null && isFunctionValue(value)) {
        const body = value.childForFieldName('body');
        if (body !== null) {
          const params = value.childForFieldName('parameters') ?? value.childForFieldName('parameter');
          emitCallEdges(name, nodeStartLine(declNode), params, body, edges, seedFileScope, lines, [], onCallSite);
        }
      }
    }
  }

  return edges.map((edge) => placedByImport(edge, importBindings));
}

/**
 * Say where a record's first name comes from, and name it as its module does.
 * A member (`PARENT_OF`) and a call the scope placed in this file are left as
 * they are: the file is their evidence.
 */
function placedByImport(
  edge: EdgeRecord,
  importBindings: ReadonlyMap<string, ImportBinding>,
): EdgeRecord {
  if (edge.edgeType === 'PARENT_OF' || edge.resolution === 'same_file' || edge.resolution === 'this_method') return edge;
  // Already placed, by a dynamic import in the function that makes the call.
  if (edge.importModule !== undefined) return edge;
  const dot = edge.toName.indexOf('.');
  const binding = importBindings.get(dot === -1 ? edge.toName : edge.toName.slice(0, dot));
  if (binding === undefined) return { ...edge, importModule: null };
  return { ...edge, toName: `${binding.exported}${dot === -1 ? '' : edge.toName.slice(dot)}`, importModule: binding.module };
}

/** IMPLEMENTS + EXTENDS + PARENT_OF + per-method POTENTIAL_CALL for one class. */
function emitClassEdges(
  classNode: SyntaxNode,
  edges: EdgeRecord[],
  seedFileScope: (env: LocalTypeEnvironment) => void,
  lines: readonly string[],
  onCallSite?: (outcome: CallSiteOutcome) => void,
): void {
  const className = classNode.childForFieldName('name')?.text ?? null;
  if (className === null) return;
  const classLine = nodeStartLine(classNode);

  // tree-sitter-typescript wraps extends/implements in a `class_heritage` node.
  const heritage = findChildByType(classNode, 'class_heritage');
  const implClause = heritage !== null
    ? findChildByType(heritage, 'implements_clause')
    : findChildByType(classNode, 'implements_clause');
  if (implClause !== null) {
    for (const typeRef of nodeNamedChildren(implClause)) {
      const ifaceName = typeRefName(typeRef);
      if (ifaceName !== null) edges.push({ fromName: className, fromLine: classLine, toName: ifaceName, edgeType: 'IMPLEMENTS' });
    }
  }

  // EXTENDS: the `extends` clause names the base class. `baseClassName` is
  // also the F4 `super_method` receiver binding's type below — captured here
  // rather than re-derived so the binding and the edge agree by construction.
  const extendsClause = heritage !== null
    ? findChildByType(heritage, 'extends_clause')
    : findChildByType(classNode, 'extends_clause');
  let baseClassName: string | null = null;
  if (extendsClause !== null) {
    for (const typeRef of nodeNamedChildren(extendsClause)) {
      const name = typeRefName(typeRef);
      if (name !== null) {
        baseClassName = name;
        edges.push({ fromName: className, fromLine: classLine, toName: name, edgeType: 'EXTENDS' });
        break; // a class extends at most one base
      }
    }
  }

  // A decorator written before `export` is a child of the export statement.
  const exportNode = classNode.parent !== null && nodeType(classNode.parent) === 'export_statement' ? classNode.parent : null;
  const classDecorators = [...(exportNode === null ? [] : decoratorsOf(exportNode)), ...decoratorsOf(classNode)];
  emitDecoratorEdges(className, classLine, classDecorators, edges, seedFileScope, lines, onCallSite);

  const bodyNode = classNode.childForFieldName('body') ?? findChildByType(classNode, 'class_body');
  if (bodyNode === null) return;

  // Class-wide receiver bindings: constructor parameter properties + fields,
  // plus F4's `this`/`super` bindings — riding the same receiver-binding
  // machinery LocalTypeEnvironment already provides for `field_type` etc.,
  // per §10.3.1 "Method calls on super and this". No `super` binding when
  // there is no parent class: an unresolvable super-call must fall through
  // to the identifier_fts potential set, never guess a target.
  const classScopeBindings: ReceiverBinding[] = [
    ...collectClassFieldBindings(bodyNode),
    { receiver: 'this', type: className, resolution: 'this_method' },
  ];
  if (baseClassName !== null) {
    classScopeBindings.push({ receiver: 'super', type: baseClassName, resolution: 'super_method' });
  }

  // A method's decorators are not its children: they come before it in the body.
  let decoratorsBefore: SyntaxNode[] = [];
  for (const member of nodeNamedChildren(bodyNode)) {
    const mt = nodeType(member);
    if (mt === 'decorator') {
      decoratorsBefore.push(member);
      continue;
    }
    // A comment between a decorator and its method does not part them.
    if (mt === 'comment') continue;
    const memberDecorators = decoratorsBefore;
    decoratorsBefore = [];
    if (mt === 'public_field_definition') {
      // A field has no symbol of its own, so a call in its initializer is the
      // class's (D098), and so are its decorators.
      emitDecoratorEdges(className, classLine, decoratorsOf(member), edges, seedFileScope, lines, onCallSite);
      const value = member.childForFieldName('value');
      if (value !== null) {
        emitCallEdges(className, classLine, null, value, edges, seedFileScope, lines, classScopeBindings, onCallSite);
      }
      continue;
    }
    if (!isMethodMember(member, bodyNode)) continue;
    const methodName = member.childForFieldName('name')?.text ?? null;
    if (methodName === null) continue;

    const memberLine = nodeStartLine(member);
    edges.push({
      fromName: className,
      fromLine: classLine,
      toName: `${className}.${methodName}`,
      toLine: memberLine,
      edgeType: 'PARENT_OF',
    });

    const parameters = member.childForFieldName('parameters');
    const parameterDecorators = parameters === null ? [] : nodeNamedChildren(parameters).flatMap(decoratorsOf);
    emitDecoratorEdges(`${className}.${methodName}`, memberLine, [...memberDecorators, ...parameterDecorators], edges, seedFileScope, lines, onCallSite);

    const body = member.childForFieldName('body');
    if (body === null) continue; // abstract / no body
    emitCallEdges(
      `${className}.${methodName}`,
      memberLine,
      parameters,
      body,
      edges,
      seedFileScope,
      lines,
      classScopeBindings,
      onCallSite,
      isStaticMember(member),
    );
  }
}

function decoratorsOf(node: SyntaxNode): SyntaxNode[] {
  return nodeNamedChildren(node).filter((child) => nodeType(child) === 'decorator');
}

/**
 * A decorator written as a call (`@name(...)`) is a call from the declaration
 * it is on, and so is every call in its arguments. `@name` with no parentheses
 * is not read: it is not a call expression, and the scorecard's reference has
 * no pair for one (checker-widening, spike s6).
 *
 * The scope is given no class bindings. `this` in a decorator's arguments is
 * not the instance, so `this.m()` there is not the class's `m`.
 */
function emitDecoratorEdges(
  fromName: string,
  fromLine: number,
  decorators: readonly SyntaxNode[],
  edges: EdgeRecord[],
  seedFileScope: (env: LocalTypeEnvironment) => void,
  lines: readonly string[],
  onCallSite?: (outcome: CallSiteOutcome) => void,
): void {
  for (const decorator of decorators) {
    const call = decorator.namedChildren[0] ?? null;
    if (call === null || nodeType(call) !== 'call_expression') continue;
    emitCallEdges(fromName, fromLine, null, call, edges, seedFileScope, lines, [], onCallSite);
  }
}

/** PARENT_OF for each method of an interface, and EXTENDS for each interface it extends. */
function emitInterfaceEdges(ifaceNode: SyntaxNode, edges: EdgeRecord[]): void {
  const name = ifaceNode.childForFieldName('name')?.text ?? null;
  if (name === null) return;
  for (const member of interfaceMethodsOf(ifaceNode)) {
    edges.push({
      fromName: name,
      fromLine: nodeStartLine(ifaceNode),
      toName: `${name}.${member.childForFieldName('name')?.text ?? ''}`,
      toLine: nodeStartLine(member),
      edgeType: 'PARENT_OF',
    });
  }
  const extendsClause = findChildByType(ifaceNode, 'extends_type_clause')
    ?? findChildByType(ifaceNode, 'extends_clause');
  if (extendsClause === null) return;
  for (const typeRef of nodeNamedChildren(extendsClause)) {
    const baseName = typeRefName(typeRef);
    if (baseName !== null) edges.push({ fromName: name, fromLine: nodeStartLine(ifaceNode), toName: baseName, edgeType: 'EXTENDS' });
  }
}

/**
 * Line of the callee TOKEN itself — the method name for `obj.method()`, or
 * the identifier for a bare `foo()`. Deliberately NOT `call.startPosition`:
 * for a multi-line fluent/chained call (e.g. `program\n  .command(...)`),
 * the call_expression node's own start position is the RECEIVER's line, not
 * the line the call syntax actually appears on — which previously produced
 * a `context` string with no parentheses at all (e.g. the trimmed text
 * `program`), violating `EdgeRecord.context`'s "source text of the
 * call-site line" contract. Found by the D7 self-oracle test running over
 * mast's own `src/` corpus (`cli/index-cmd.ts:9`, `program.command(...)`);
 * see IMPLEMENTATION_PLAN.md's D7 result for the finding.
 */
function calleeLine(call: SyntaxNode): number {
  const fn = call.childForFieldName('function') ?? call.namedChildren[0] ?? null;
  if (fn !== null && nodeType(fn) === 'member_expression') {
    const property = fn.childForFieldName('property');
    if (property !== null) return property.startPosition.row + 1;
  }
  return call.startPosition.row + 1;
}

/**
 * D7 (Stage 4) closed outcome union for the `onCallSite` diagnostics seam.
 * Every `call_expression` node `collectCalls` returns is classified into
 * EXACTLY one of these four buckets by `emitCallEdges` — that totality is
 * the self-oracle invariant `call-oracle.test.ts` asserts over mast's own
 * `src/` corpus:
 *
 * - `edge_emitted`: `parseCallee` extracted a receiver/method AND
 *   `LocalTypeEnvironment.resolveCall` linked it — a POTENTIAL_CALL edge
 *   was pushed.
 * - `unparseable_callee`: `parseCallee` returned null — the callee shape is
 *   not a bare identifier or a member-expression whose receiver
 *   `receiverString` can stringify (e.g. a chained call `getX().m()`, or a
 *   dynamic/computed receiver `registry['key'].m()`).
 * - `unresolved_receiver`: the callee parsed to a non-null receiver string
 *   (`repo`, `this.repo`, `this`, `super`, ...) but `resolveCall` found no
 *   binding for it — an unannotated local, a DI container lookup, or any
 *   other §10.3.1 "does NOT catch" receiver shape.
 * - `bare_call_unresolved`: the callee parsed as a receiver-less call
 *   (`foo()`) but the name matched neither an import nor a same-file symbol.
 *
 * **Boundary**: `collectCallSites` does not descend into a nested class —
 * those call sites are never handed to `parseCallee` at all and are outside
 * this invariant. Nested functions of every kind are inside it (D098), and so
 * is a decorator written as a call on a top-level class, its members or their
 * parameters, with the calls in its arguments (`emitDecoratorEdges`).
 */
export type CallSiteOutcome =
  | 'edge_emitted'
  | 'unparseable_callee'
  | 'unresolved_receiver'
  | 'bare_call_unresolved';

/**
 * Build the local type environment for a function/method scope and emit one
 * POTENTIAL_CALL edge per statically-resolvable call site in its body.
 */
function emitCallEdges(
  fromName: string,
  // The line of the declaration the scope is the body of, as its symbol has it.
  fromLine: number,
  paramsNode: SyntaxNode | null,
  bodyNode: SyntaxNode,
  edges: EdgeRecord[],
  seedFileScope: (env: LocalTypeEnvironment) => void,
  lines: readonly string[],
  // Class-wide bindings for a method scope: field/constructor-parameter
  // types (`this.x`) plus F4's `this`/`super` bindings. Empty for top-level
  // function/arrow scopes, which have no enclosing class.
  classScopeBindings: readonly ReceiverBinding[] = [],
  onCallSite?: (outcome: CallSiteOutcome) => void,
  // The scope is a static method, whose `this` is the class itself.
  isStaticScope = false,
): void {
  const env = new LocalTypeEnvironment();
  seedFileScope(env);
  for (const b of classScopeBindings) env.recordReceiverType(b.receiver, b.type, b.resolution);
  if (paramsNode !== null) {
    for (const b of collectParamBindings(paramsNode)) env.recordReceiverType(b.receiver, b.type, b.resolution);
  }
  const names: ScopeNames = { declarations: localDeclarations(bodyNode), ownParams: ownParamNames(paramsNode) };

  for (const site of collectCallSites(bodyNode, paramsNode)) {
    const { call } = site;
    const isConstruction = nodeType(call) === 'new_expression';
    const parsed = isConstruction ? parseConstructed(call) : parseCallee(call);
    if (parsed === null) {
      onCallSite?.('unparseable_callee');
      continue;
    }
    const linked = resolveCallSite(env, site, parsed, names, isConstruction);
    // `new X()` is placed like a bare call of `X` (an import or a same-file
    // declaration) and stored as a construction, so the graph writer can
    // choose between the class and its constructor.
    const resolved = linked !== null && isConstruction ? { ...linked, resolution: 'construction' as const } : linked;
    if (resolved === null) {
      onCallSite?.(parsed.receiver === null ? 'bare_call_unresolved' : 'unresolved_receiver');
      continue;
    }
    onCallSite?.('edge_emitted');
    const line = calleeLine(call);
    edges.push({
      fromName,
      fromLine,
      toName: resolved.callee,
      ...(resolved.importModule === undefined ? {} : { importModule: resolved.importModule }),
      ...(isStaticScope && OWN_CLASS_RESOLUTIONS.has(resolved.resolution) ? { inStaticMethod: true as const } : {}),
      edgeType: 'POTENTIAL_CALL',
      resolution: resolved.resolution,
      callLine: line,
      context: (lines[line - 1] ?? '').trim(),
    });
  }
}

/** The rules that read `this` or `super`, which a static method gives another meaning. */
const OWN_CLASS_RESOLUTIONS: ReadonlySet<CallerResolution> = new Set(['this_method', 'super_method']);

/** `import('./x')` with a literal specifier, awaited or not; the specifier, or null. */
function dynamicImportSpecifier(value: SyntaxNode | null): string | null {
  const call = value !== null && nodeType(value) === 'await_expression' ? value.namedChildren[0] ?? null : value;
  if (call === null || nodeType(call) !== 'call_expression') return null;
  const callee = call.childForFieldName('function');
  const args = call.childForFieldName('arguments');
  const only = args !== null && args.namedChildren.length === 1 ? args.namedChildren[0] ?? null : null;
  if (callee === null || nodeType(callee) !== 'import' || only === null || nodeType(only) !== 'string') return null;
  return only.text.slice(1, -1);
}

/** What each destructured name of `const { X, Y: Z } = await import('./x')` is in its module. */
function destructuredFromDynamicImport(declarator: SyntaxNode): { local: string; binding: ImportBinding }[] {
  const pattern = declarator.childForFieldName('name');
  const value = declarator.childForFieldName('value');
  if (pattern === null || nodeType(pattern) !== 'object_pattern') return [];
  // Only `await import(...)`: without the await the names are a promise's.
  const module = value !== null && nodeType(value) === 'await_expression' ? dynamicImportSpecifier(value) : null;
  if (module === null) return [];
  const found: { local: string; binding: ImportBinding }[] = [];
  for (const part of nodeNamedChildren(pattern)) {
    if (nodeType(part) === 'shorthand_property_identifier_pattern') {
      found.push({ local: part.text, binding: { exported: part.text, module } });
    } else if (nodeType(part) === 'pair_pattern') {
      const key = part.childForFieldName('key');
      const local = part.childForFieldName('value');
      if (key !== null && local !== null && nodeType(key) === 'property_identifier' && nodeType(local) === 'identifier') {
        found.push({ local: local.text, binding: { exported: key.text, module } });
      }
    }
  }
  return found;
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

/** A name declared inside a function, with the part of the function it is visible in. */
interface LocalDeclaration {
  readonly name: string;
  /** The node the name is visible in: a block, a loop, a `catch`, or a function. */
  readonly scope: SyntaxNode;
  /** A parameter of a function nested in the scope. `CallSite.nestedParams` holds its type. */
  readonly isNestedParam: boolean;
  /** `= new X()` when that is the whole initializer, and null for anything else. */
  readonly constructed: Construction | null;
  /** What the name is in its module, when it is destructured from `await import()`. */
  readonly imported: ImportBinding | null;
}

/** `new X()`: the name written, and the expression, which is where the name is read. */
interface Construction {
  readonly className: string;
  readonly at: SyntaxNode;
}

/** The names a declaration's own code can declare over the file's. */
interface ScopeNames {
  /** Every declaration in the body, nested functions included. */
  readonly declarations: readonly LocalDeclaration[];
  /** The declaration's own parameters, visible in all of it. */
  readonly ownParams: ReadonlySet<string>;
}

/** The names of a parameter list; `x => ...` hands in its one bare identifier in place of a list. */
function ownParamNames(paramsNode: SyntaxNode | null): Set<string> {
  if (paramsNode === null) return new Set();
  if (nodeType(paramsNode) === 'identifier') return new Set([paramsNode.text]);
  return new Set(paramsIn(paramsNode).keys());
}

/** The nodes that bound a `let`, a `const`, a function or a class declared directly in them. */
const BLOCK_SCOPE_TYPES = new Set(['statement_block', 'switch_body', 'for_statement', 'for_in_statement', 'catch_clause']);

/**
 * Every name declared in a function body, nested functions included, each
 * with the node it is visible in. A `var` is visible in the whole function
 * that declares it; anything else in its block. Nested classes are not
 * entered: `collectCallSites` reads no call there.
 */
function localDeclarations(bodyNode: SyntaxNode): LocalDeclaration[] {
  const found: LocalDeclaration[] = [];
  const declare = (
    pattern: SyntaxNode | null,
    scope: SyntaxNode,
    constructed: Construction | null = null,
    imported: ReadonlyMap<string, ImportBinding> = new Map(),
  ): void => {
    if (pattern === null) return;
    for (const name of namesBoundBy(pattern)) {
      found.push({ name, scope, isNestedParam: false, constructed, imported: imported.get(name) ?? null });
    }
  };
  const visit = (node: SyntaxNode, block: SyntaxNode, fn: SyntaxNode): void => {
    const t = nodeType(node);
    if (NAMED_LOCAL_DECLARATION_TYPES.has(t)) {
      // A class's name is a type identifier, which no binding pattern holds.
      const name = node.childForFieldName('name')?.text;
      if (name !== undefined) found.push({ name, scope: block, isNestedParam: false, constructed: null, imported: null });
    }
    if (NESTED_CLASS_TYPES.has(t)) return;

    let innerBlock = block;
    let innerFn = fn;
    if (NESTED_FUNCTION_TYPES.has(t)) {
      for (const name of declaredParams(node).keys()) found.push({ name, scope: node, isNestedParam: true, constructed: null, imported: null });
      // `function f() {}` as an expression binds `f` inside itself only, as a
      // parameter would (D163).
      const ownName = FUNCTION_EXPRESSION_TYPES.has(t) ? node.childForFieldName('name')?.text : undefined;
      if (ownName !== undefined) found.push({ name: ownName, scope: node, isNestedParam: true, constructed: null, imported: null });
      innerBlock = node;
      innerFn = node;
    } else if (BLOCK_SCOPE_TYPES.has(t)) {
      innerBlock = node;
    }

    if (t === 'for_in_statement') declare(node.childForFieldName('left'), node);
    if (t === 'catch_clause') declare(node.childForFieldName('parameter'), node);
    if (t === 'variable_declaration' || t === 'lexical_declaration') {
      const scope = t === 'variable_declaration' ? fn : block;
      for (const declarator of nodeNamedChildren(node)) {
        if (nodeType(declarator) !== 'variable_declarator') continue;
        const pattern = declarator.childForFieldName('name');
        const isOneName = pattern !== null && nodeType(pattern) === 'identifier';
        const imported = new Map(destructuredFromDynamicImport(declarator).map(({ local, binding }) => [local, binding]));
        declare(pattern, scope, isOneName ? constructionIn(declarator.childForFieldName('value')) : null, imported);
      }
    }
    for (const child of nodeNamedChildren(node)) visit(child, innerBlock, innerFn);
  };
  visit(bodyNode, bodyNode, bodyNode);
  return found;
}

/** `new X()` as a construction, or null for any other expression and for `new a.B()`. */
function constructionIn(value: SyntaxNode | null): Construction | null {
  if (value === null || nodeType(value) !== 'new_expression') return null;
  const ctor = value.childForFieldName('constructor') ?? value.namedChildren[0] ?? null;
  return ctor !== null && nodeType(ctor) === 'identifier' ? { className: ctor.text, at: value } : null;
}

/**
 * The declaration of `name` that code at `at` sees: the one whose scope is
 * the smallest around `at`. Null when none of them is around it. Two in one
 * scope that disagree (`var` written twice) are read as a name of no known
 * class and no module.
 */
function visibleDeclaration(declarations: readonly LocalDeclaration[], name: string, at: SyntaxNode): LocalDeclaration | null {
  const around = declarations.filter(
    ({ name: declared, scope }) => declared === name && scope.startIndex <= at.startIndex && at.endIndex <= scope.endIndex,
  );
  const sizeOf = (declaration: LocalDeclaration): number => declaration.scope.endIndex - declaration.scope.startIndex;
  const smallest = Math.min(...around.map(sizeOf));
  const nearest = around.filter((declaration) => sizeOf(declaration) === smallest);
  const first = nearest[0];
  if (first === undefined) return null;
  const agree = nearest.every(
    (declaration) =>
      declaration.constructed?.className === first.constructed?.className &&
      declaration.imported?.module === first.imported?.module &&
      declaration.imported?.exported === first.imported?.exported,
  );
  return agree ? first : { ...first, constructed: null, imported: null };
}

/** A call found in a scope, with what the functions nested around it change. */
interface CallSite {
  readonly call: SyntaxNode;
  /**
   * True inside a non-arrow function nested in the scope. Such a function has
   * its own `this`, so `this.m()` and `super.m()` there are not the enclosing
   * class's. Arrow functions inherit `this` and leave this false.
   */
  readonly ownThis: boolean;
  /**
   * Parameters declared by the nested functions around the call: name to its
   * annotated type, or null when it has none. The innermost declaration of a
   * name is the one held. A name here hides the enclosing scope's binding and
   * any import or top-level symbol of the same name.
   */
  readonly nestedParams: ReadonlyMap<string, string | null>;
}

const NESTED_FUNCTION_TYPES = new Set([
  'arrow_function', 'function_declaration', 'function_expression', 'generator_function',
  'generator_function_declaration', 'method_definition',
]);
const NESTED_CLASS_TYPES = new Set(['class_declaration', 'abstract_class_declaration', 'class']);

/**
 * Every call and `new` expression in a declaration: its body, and its
 * parameters' default values.
 *
 * A call belongs to the nearest enclosing declaration that has a symbol.
 * Functions nested in a body (declarations, expressions, arrows, object-literal
 * methods) have none, so this descends into them and the calls there are the
 * enclosing declaration's (D098). It records what each one changes on the way
 * down, see {@link CallSite}. It does not descend into a nested class, whose
 * calls are left unlinked, nor into a parameter's decorators, which
 * `emitDecoratorEdges` reads as a scope of their own.
 */
function collectCallSites(bodyNode: SyntaxNode, paramsNode: SyntaxNode | null = null): CallSite[] {
  const sites: CallSite[] = [];
  const consider = (node: SyntaxNode, ownThis: boolean, nestedParams: ReadonlyMap<string, string | null>): void => {
    const t = nodeType(node);
    if (NESTED_CLASS_TYPES.has(t) || t === 'decorator') return;

    let innerOwnThis = ownThis;
    let innerParams = nestedParams;
    if (NESTED_FUNCTION_TYPES.has(t)) {
      innerOwnThis = ownThis || t !== 'arrow_function';
      innerParams = new Map([...nestedParams, ...declaredParams(node)]);
    } else if (t === 'call_expression' || t === 'new_expression') {
      sites.push({ call: node, ownThis, nestedParams });
    }
    for (const child of nodeNamedChildren(node)) consider(child, innerOwnThis, innerParams);
  };

  const outermost: ReadonlyMap<string, string | null> = new Map();
  if (paramsNode !== null) consider(paramsNode, false, outermost);
  // The body is the scope itself, not something nested in it. An arrow whose
  // body is a single call hands that call in, and a field initializer can be
  // a function with parameters of its own; both are considered whole. Anything
  // else is entered without the check on its own type, so that a class which
  // is the whole body of an arrow is read.
  const bodyType = nodeType(bodyNode);
  if (bodyType === 'call_expression' || bodyType === 'new_expression' || NESTED_FUNCTION_TYPES.has(bodyType)) {
    consider(bodyNode, false, outermost);
  } else {
    for (const child of nodeNamedChildren(bodyNode)) consider(child, false, outermost);
  }
  return sites;
}

/**
 * The call nodes {@link collectCallSites} finds, in the same order.
 *
 * Exported (D7, Stage 4) so `call-oracle.test.ts` can independently enumerate
 * the call sites `emitCallEdges` visits, as the ground truth for the
 * `onCallSite` accounting invariant — not part of the extractor's public
 * tool-facing surface.
 */
export function collectCalls(bodyNode: SyntaxNode, paramsNode: SyntaxNode | null = null): SyntaxNode[] {
  return collectCallSites(bodyNode, paramsNode).map((site) => site.call);
}

/** The parameters a function-like node declares: name to annotated type, or null. */
function declaredParams(fn: SyntaxNode): Map<string, string | null> {
  const declared = new Map<string, string | null>();
  // `x => ...` has one bare identifier in place of a parameter list.
  const single = fn.childForFieldName('parameter');
  if (single !== null) declared.set(single.text, null);

  const list = fn.childForFieldName('parameters');
  if (list === null) return declared;
  for (const [name, type] of paramsIn(list)) declared.set(name, type);
  return declared;
}

/** The parameters in a parameter list: name to annotated type, or null. */
function paramsIn(list: SyntaxNode): Map<string, string | null> {
  const declared = new Map<string, string | null>();
  for (const param of nodeNamedChildren(list)) {
    const pattern = param.childForFieldName('pattern') ?? findChildByType(param, 'identifier');
    if (pattern === null) continue;
    if (nodeType(pattern) === 'identifier') {
      declared.set(pattern.text, annotationTypeName(param));
      continue;
    }
    // Destructured: none of the names has a type this resolver can read.
    for (const name of namesBoundBy(pattern)) declared.set(name, null);
  }
  return declared;
}

const DEFAULTED_PATTERN_TYPES = new Set(['assignment_pattern', 'object_assignment_pattern']);

/**
 * Every name a binding pattern binds (`x`, `{ a, b: c }`, `[d, ...e]`). A
 * default value (`{ a = make() }`) is an expression, and no name in it is
 * bound.
 */
function namesBoundBy(pattern: SyntaxNode): string[] {
  const bound: string[] = [];
  const visit = (node: SyntaxNode): void => {
    const nt = nodeType(node);
    if (nt === 'identifier' || nt === 'shorthand_property_identifier_pattern') bound.push(node.text);
    if (DEFAULTED_PATTERN_TYPES.has(nt)) {
      const left = node.childForFieldName('left');
      if (left !== null) visit(left);
      return;
    }
    for (const child of nodeNamedChildren(node)) visit(child);
  };
  visit(pattern);
  return bound;
}

const NAMED_LOCAL_DECLARATION_TYPES = new Set([
  'function_declaration', 'generator_function_declaration', 'class_declaration', 'abstract_class_declaration',
  'enum_declaration',
]);
const FUNCTION_EXPRESSION_TYPES = new Set(['function_expression', 'generator_function']);
/** Where a call goes: the name, how it was read, and the module when a dynamic import names it. */
interface ResolvedCall {
  readonly callee: string;
  readonly resolution: CallerResolution;
  readonly importModule?: string;
}

/**
 * Resolve one call site. A name is read by the nearest declaration around the
 * call: one in a block or a nested function, then the scope's own parameters,
 * then the file's imports and declarations (D104, D116, D117).
 */
function resolveCallSite(
  env: LocalTypeEnvironment,
  site: CallSite,
  parsed: { receiver: string | null; method: string },
  names: ScopeNames,
  isConstruction = false,
): ResolvedCall | null {
  const { receiver, method } = parsed;
  if (receiver === null) return resolveName(env, method, site.call, names);

  const root = receiver.split('.')[0] ?? receiver;
  if (site.ownThis && (root === 'this' || root === 'super')) return null;
  const declared = visibleDeclaration(names.declarations, root, site.call);
  // `ns.f()` and `new ns.C()` through `import * as ns` name `f` and `C` of the
  // module, as a named import of them would. A local or a parameter called
  // `ns` is not the namespace.
  const isShadowed = declared !== null || site.nestedParams.has(root) || names.ownParams.has(root);
  const namespaceModule = receiver === root && !isShadowed ? env.namespaceModule(root) : undefined;
  if (namespaceModule !== undefined) return { callee: method, resolution: 'import', importModule: namespaceModule };
  // `new a.B()` is read through a namespace and through nothing else: the
  // rules below are for a method called on `a`, which `B` is not.
  if (isConstruction) return null;
  if (declared !== null && !declared.isNestedParam) {
    if (receiver !== root) return null;
    // A local is what its declaration made it: a name of a module, an instance
    // of the class it was constructed from, or nothing this resolver can name.
    if (declared.imported !== null) {
      return { callee: `${declared.imported.exported}.${method}`, resolution: 'static_method', importModule: declared.imported.module };
    }
    if (declared.constructed === null) return null;
    // The class is the name as the `new` reads it, which a local or a
    // parameter can be (D123). A name the file does not know is kept: whether
    // it is a class is settled when the edge is stored.
    const { className, at } = declared.constructed;
    const classDeclared = visibleDeclaration(names.declarations, className, at);
    if (classDeclared !== null && classDeclared.imported !== null) {
      return { callee: `${classDeclared.imported.exported}.${method}`, resolution: 'new_expression', importModule: classDeclared.imported.module };
    }
    return classDeclared !== null || names.ownParams.has(className) ? null : { callee: `${className}.${method}`, resolution: 'new_expression' };
  }
  if (site.nestedParams.has(root)) {
    const type = site.nestedParams.get(root) ?? null;
    return type === null || receiver !== root
      ? null
      : { callee: `${type}.${method}`, resolution: 'parameter_type' };
  }
  const resolved = env.resolveCall(receiver, method);
  // The scope's own parameter has the type it is annotated with. With none,
  // it is not the class of the same name.
  if (resolved?.resolution === 'static_method' && names.ownParams.has(root)) return null;
  return resolved;
}

/**
 * What a bare name is where it is written at `at`: a name of the module a
 * dynamic import in sight took it from, or an import or declaration of the
 * file. Null for any other local and for a parameter, whatever import shares
 * the name.
 */
function resolveName(env: LocalTypeEnvironment, name: string, at: SyntaxNode, names: ScopeNames): ResolvedCall | null {
  const declared = visibleDeclaration(names.declarations, name, at);
  if (declared !== null) {
    return declared.imported === null
      ? null
      : { callee: declared.imported.exported, resolution: 'import', importModule: declared.imported.module };
  }
  return names.ownParams.has(name) ? null : env.resolveCall(null, name);
}

/**
 * The class a `new` expression names: a bare callee for `new X()`, `B` on the
 * receiver `a` for `new a.B()`, and null for anything else.
 */
function parseConstructed(expr: SyntaxNode): { receiver: string | null; method: string } | null {
  const ctor = expr.childForFieldName('constructor') ?? expr.namedChildren[0] ?? null;
  if (ctor === null) return null;
  if (nodeType(ctor) === 'identifier') return { receiver: null, method: ctor.text };
  if (nodeType(ctor) !== 'member_expression') return null;
  const object = ctor.childForFieldName('object');
  const property = ctor.childForFieldName('property')?.text;
  if (object === null || property === undefined || nodeType(object) !== 'identifier') return null;
  return { receiver: object.text, method: property };
}

/** Extract `{ receiver, method }` from a call expression, or null if unhandled. */
function parseCallee(call: SyntaxNode): { receiver: string | null; method: string } | null {
  const written = call.childForFieldName('function') ?? call.namedChildren[0] ?? null;
  if (written === null) return null;
  // tree-sitter-typescript 0.23.2 reads `await f<T>(x)` as `(await f)<T>(x)`,
  // so the function of the call is the await expression (D103). A written
  // `(await f)(x)` is a parenthesized expression and does not come here.
  const fn = nodeType(written) === 'await_expression' ? (written.namedChildren[0] ?? null) : written;
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

/**
 * Unwrap `(await x)` down to `x` for the receiver position (F3). Tree-sitter
 * parses `(await x).m()`'s object as `parenthesized_expression(
 * await_expression(x))` — verified via a tree-sitter S-expression dump
 * against `tree-sitter-typescript`'s current grammar. Only unwraps an
 * await specifically (not parens in general) — this is syntax unwrapping,
 * not type inference: `const y = await makeFoo(); y.bar()` still does not
 * resolve, per §10.3.1's "does NOT catch" list.
 */
function unwrapAwaitedReceiver(node: SyntaxNode): SyntaxNode {
  if (nodeType(node) !== 'parenthesized_expression') return node;
  const inner = node.namedChildren[0];
  if (inner === undefined || nodeType(inner) !== 'await_expression') return node;
  const awaited = inner.namedChildren[0];
  return awaited ?? node;
}

/** Stringify a member-expression receiver for the conservative resolver. */
function receiverString(objectNode: SyntaxNode): string | null {
  const node = unwrapAwaitedReceiver(objectNode);
  const t = nodeType(node);
  if (t === 'identifier') return node.text;
  // F4: bare `this`/`super` as the receiver — `this.foo()`/`super.foo()`.
  // The env bindings for these two literal strings are seeded per-method by
  // `emitClassEdges`; outside a class scope no binding exists and
  // `resolveCall` returns null, same as any other unbound receiver. Inside a
  // nested function with its own `this`, `resolveCallSite` refuses first.
  if (t === 'this') return 'this';
  if (t === 'super') return 'super';
  if (t === 'member_expression') {
    const inner = node.childForFieldName('object');
    const prop = node.childForFieldName('property')?.text ?? null;
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
    if (t === 'generic_type') return specifierName(child, 'name') ?? null;
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

/**
 * Append qualified compound strings (e.g. "Class.method", F5) to an
 * already-built identifier bag, deduplicated and appended AFTER the bare
 * bag — never interleaved — so the qualified compound's own two sub-tokens
 * (post unicode61 tokenisation, which splits on '.') land adjacent to each
 * other and are not accidentally split apart by an unrelated bare token.
 */
function appendQualifiedCompounds(base: string, extra: readonly string[]): string {
  if (extra.length === 0) return base;
  const seen = new Set(base.length > 0 ? base.split(' ') : []);
  for (const q of extra) seen.add(q);
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
