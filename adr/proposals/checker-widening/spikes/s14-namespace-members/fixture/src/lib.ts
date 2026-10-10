export namespace Support { export function exists(): boolean { return true; } }
export class Kit { static make(): Kit { return new Kit(); } run(): void {} }
export interface Shape { draw(): void }
