// The declared name of a default export is not a name the file exports: `dz` of
// this file, to an importer, is the one the star supplies (D167; D164 behind a star).
export default function dz(): void {}
export * from './impl';
