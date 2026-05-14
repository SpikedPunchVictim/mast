/** Greets by name. */
export function greet(name: string): string {
  return `Hello, ${name}`;
}

export const add = (a: number, b: number): number => a + b;

function internal(): void {
  // not exported
}

export interface Greeter {
  greet(name: string): string;
}

export type Greeting = string;

export class AuthService {
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  /** Validate a token. */
  validate(token: string): boolean {
    return token === this.secret;
  }

  private hash(value: string): string {
    return value;
  }
}
