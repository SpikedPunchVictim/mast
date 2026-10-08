import { WithCtor, NoCtor } from './cls';
export function makeWith(): WithCtor { return new WithCtor(); }
export function makeNo(): NoCtor { return new NoCtor(); }
