// Calls through a namespace another file exports, in its two forms (MAST_SPEC §10.3.1,
// rule 12). A member of a member is not read, and a parameter with the namespace's name
// is not the namespace.
import { helpers, viaFrom } from './index';
export function throughImportThenExport(): void { helpers.append(); helpers.later(); }
export function throughExportStarAs(): void { viaFrom.append(); }
export function memberOfAMember(): unknown { return helpers.Widget.create(); }
export function shadowed(helpers: { append(): void }): void { helpers.append(); }
