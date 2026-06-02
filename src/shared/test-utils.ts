export type TestFn = () => Promise<void> | void;

export function createTestRunner(): {
  test: (name: string, fn: TestFn) => void;
  run: () => Promise<void>;
} {
  const tests: { name: string; fn: TestFn }[] = [];

  const test = (name: string, fn: TestFn) => {
    tests.push({ name, fn });
  };

  const run = async () => {
    let pass = 0;
    let fail = 0;

    for (const { name, fn } of tests) {
      try {
        await fn();
        console.log(`  ✓ ${name}`);
        pass++;
      } catch (e) {
        console.log(`  ✗ ${name}\n    ${(e as Error).message}`);
        fail++;
      }
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exit(1);
  };

  return { test, run };
}
