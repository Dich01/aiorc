// Minimal test harness: no Jest, no Vitest. Test files call test()/section()
// at import time; run.ts imports them all and then calls runAll().

type TestFn = () => void | Promise<void>;
interface Entry { kind: 'section' | 'test'; name: string; fn?: TestFn }

const queue: Entry[] = [];

export function section(name: string): void {
  queue.push({ kind: 'section', name });
}

export function test(name: string, fn: TestFn): void {
  queue.push({ kind: 'test', name, fn });
}

export async function runAll(): Promise<number> {
  let passed = 0;
  let failed = 0;
  for (const e of queue) {
    if (e.kind === 'section') { console.log(e.name); continue; }
    try {
      await e.fn!();
      passed += 1;
      console.log(`  ok   ${e.name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL ${e.name}`);
      console.error(err);
    }
  }
  console.log(`\n${passed} tests passed${failed ? `, ${failed} failed` : ''}`);
  return failed;
}
