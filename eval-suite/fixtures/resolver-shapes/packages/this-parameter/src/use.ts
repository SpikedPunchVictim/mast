import type { Context } from './types';
import { Client } from './types';

export function run(this: Context): void {
  this.getInput();
  // an arrow has the function's `this`
  [1].forEach(() => this.getInput());
  // a member of a member is not read
  this.helpers.request();
}

export class Node {
  constructor(private readonly helpers: Client) {}
  getInput(): string {
    return '';
  }
  // `this` is the parameter's type, not the class the method is written in (D170)
  execute(this: Context): void {
    this.getInput();
    this.helpers.request();
  }
  plain(): void {
    this.getInput();
    this.helpers.request();
  }
  static make(): Node {
    return new Node(new Client());
  }
  // written with `typeof` the class: `this` is the class
  static build<T extends Node>(this: { new (helpers: Client): T } & typeof Node): Node {
    return this.make();
  }
}
