// Calls through a namespace another file exports. None is read: nothing stored says a
// file exports a namespace (adr/proposals/checker-widening, "A namespace another file
// exports"). The two forms are here so that a rule for them shows as `lacks -> agree`.
import { helpers, viaFrom } from './index';
export function throughImportThenExport(): void { helpers.append(); helpers.later(); }
export function throughExportStarAs(): void { viaFrom.append(); }
export function memberOfAMember(): unknown { return helpers.Widget.create(); }
export function shadowed(helpers: { append(): void }): void { helpers.append(); }
