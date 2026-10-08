import { helper, format, Client } from './barrel';
import { Legacy2, fmt2 } from './barrel2';
import { tool } from './barrel3';
export function use(c: Client): void { helper(); format(); c.send(); new Client(); }
export function use2(l: Legacy2): void { l.send(); fmt2(); }
export function use3(): void { tool(); }
