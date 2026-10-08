import { Client as RealClient } from './real';
// a private class of the same name as the one re-exported under a rename
class Legacy { send(): void {} }
void Legacy;
export { RealClient as Legacy2 };
function internalFmt(): string { return ''; }
function fmt(): string { return 'private'; }
void fmt;
export { internalFmt as fmt2 };
