// D130: a default export, and a named export that has the name an importer gives the default.
export default class RealShape { area(): number { return 0; } }
export class Shape { area(): number { return 1; } }
