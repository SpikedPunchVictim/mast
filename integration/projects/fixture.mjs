// The default project: small, fully known, no network.
//
// Shaped to make the mutation family assertable rather than to look like a real codebase:
//   - `alphaFunction` is declared in ONE file and called from ONE other, so a delete or a move
//     has exactly one caller to check.
//   - `DeepDir/mod.ts` is mixed-case on purpose — it is the case-only-rename scenario's subject,
//     and the class D023 lives in.
//   - `unreferenced.ts` exports a symbol nothing calls, so "no callers" has a true instance to
//     distinguish from a phantom.
export default {
  id: 'fixture',
  description: 'A four-file TypeScript project with a fully known symbol and call graph.',
  files: {
    'package.json': JSON.stringify({ name: 'mast-fixture', version: '1.0.0', private: true, type: 'module' }, null, 2) + '\n',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true } }, null, 2) + '\n',
    'src/alpha.ts':
`/** Returns the answer. The single declaration of alphaFunction in this project. */
export function alphaFunction(): number {
  return 41 + 1;
}
`,
    'src/beta.ts':
`import { alphaFunction } from './alpha.js';

/** The single verified caller of alphaFunction. */
export function betaCaller(): number {
  return alphaFunction() * 2;
}
`,
    'src/DeepDir/mod.ts':
`/** Lives in a mixed-case directory on purpose — see the case-only-rename scenario. */
export function deepHelper(): string {
  return 'deep';
}
`,
    'src/uses-deep.ts':
`import { deepHelper } from './DeepDir/mod.js';

export function callsDeep(): string {
  return deepHelper().toUpperCase();
}
`,
    'src/unreferenced.ts':
`/** Nothing calls this. "No callers" here is a TRUE absence, not a failure to resolve. */
export function orphanFunction(): boolean {
  return true;
}
`,
    'docs/notes.md': '# Notes\n\nMarkdown is indexed too — `alphaFunction` is mentioned here in prose.\n',
  },
};
