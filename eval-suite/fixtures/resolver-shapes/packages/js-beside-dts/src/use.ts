// D162, a scorecard defect: the compiler reads lib.d.ts and the code runs lib.js. mast's
// edges go to lib.js, where the functions are, and the scorecard counts them as wrong.
import { parse, Lexer } from './lib.js';
import * as lib from './lib.js';
export function named(): unknown { return [parse('a'), new Lexer()]; }
export function viaNamespace(): unknown { return [lib.parse('a'), new lib.Lexer()]; }
