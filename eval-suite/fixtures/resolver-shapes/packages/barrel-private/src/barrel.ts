// private helper of this module, not exported; the public `helper` comes from ./real
function helper(): number { return 2; }
function format(): string { return String(helper()); }
class Client { send(): void { format(); } }
void Client;
export * from './real';
