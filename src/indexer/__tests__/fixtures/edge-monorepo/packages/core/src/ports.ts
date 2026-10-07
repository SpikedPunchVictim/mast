export interface Store {
  get(key: string): string | undefined;
}

export type Handler = (input: string) => void;
