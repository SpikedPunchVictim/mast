import * as lib from './lib';
export function a(): void { lib.Support.exists(); lib.Kit.make(); }
export function b(k: lib.Kit, s: lib.Shape): void { k.run(); s.draw(); }
export class H { constructor(private readonly k: lib.Kit) {} go(): void { this.k.run(); } }
