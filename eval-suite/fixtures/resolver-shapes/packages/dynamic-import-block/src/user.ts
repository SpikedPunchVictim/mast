import { run } from './local';

export async function main(flag: boolean): Promise<void> {
  if (flag) {
    const { run } = await import('./remote');
    void run;
    return;
  }
  run();
}
