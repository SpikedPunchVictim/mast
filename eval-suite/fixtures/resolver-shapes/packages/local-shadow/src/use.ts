import { Repo, pick } from './repo';
export function f(): void { const Repo = pick(); const r = new Repo(); r.find(); }
export function g(Repo: any): void { const r = new Repo(); r.find(); }
