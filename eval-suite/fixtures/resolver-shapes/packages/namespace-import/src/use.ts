// A call through `import * as ns` is a call of the module's name (checker-widening, s10).
import * as dom from './dom';
import * as viaBarrel from './barrel';
import * as other from './other';
export function calls(): void { dom.append(); dom.later(); viaBarrel.append(); }
export function news(): unknown { return [new dom.Widget('a'), new dom.Plain()]; }
// `dom` here is not the namespace.
export function localShadow(): void { const dom = other; dom.append(); new dom.Widget(); }
export function paramShadow(dom: typeof other): void { dom.append(); new dom.Widget(); }
export function callbackShadow(items: (typeof other)[]): void { items.forEach((dom) => { dom.append(); }); }
export function blockShadow(flag: boolean): void { if (flag) { const dom = other; dom.append(); } else { dom.append(); } }
// Not read: a member of something the namespace holds.
export function viaStatic(): unknown { return dom.Widget.create(); }
