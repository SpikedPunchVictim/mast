import { createRequire } from 'node:module';
import type { Tree } from 'tree-sitter';

// tree-sitter ships a CJS-only native addon; createRequire loads it from ESM.
const require = createRequire(import.meta.url);

// `tree-sitter` ships its own TypeScript declarations (Tree, SyntaxNode, …), so
// the Parser class is fully typed. The grammar package `tree-sitter-typescript`
// ships no declarations. Derive the Language type from setLanguage's own
// parameter rather than importing Parser.Language directly — ESM + `export =`
// does not allow that namespace member import.
const Parser = require('tree-sitter') as typeof import('tree-sitter');
type Language = NonNullable<Parameters<InstanceType<typeof Parser>['setLanguage']>[0]>;
const { typescript: tsGrammar, tsx: tsxGrammar } = require('tree-sitter-typescript') as {
  typescript: Language;
  tsx: Language;
};

export type { Tree, SyntaxNode } from 'tree-sitter';

// The LanguageExtractor contract lives in ../extractor.ts. It is deliberately
// parser-agnostic — tree-sitter is an implementation detail of the extractors
// that need it — so this module only exposes parsing helpers.

/** Parse a source file with tree-sitter, returning the syntax tree. */
export function parseSource(src: string, extension: string): Tree {
  const parser = new Parser();
  // setLanguage accepts an opaque native grammar object (typed `any` upstream).
  parser.setLanguage(extension === '.tsx' ? tsxGrammar : tsGrammar);
  return parser.parse(src);
}
