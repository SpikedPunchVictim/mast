export interface Context {
  getInput(): string;
  helpers: { request(): void };
}
export class Client {
  request(): void {}
}
