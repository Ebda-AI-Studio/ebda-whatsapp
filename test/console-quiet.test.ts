import { expect, it, vi } from 'vitest';

// The workers project sets disableConsoleIntercept (vitest.config): console lines skip the worker -> runner RPC that failed main 44c28fe
// at teardown. Tests that read the audit lines through a spy must keep working.
it('a test that spies on console.log still sees the lines the code writes', () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  console.log(JSON.stringify({ audit: 'probe' }));
  expect(spy.mock.calls.some((c) => String(c[0]).includes('"audit":"probe"'))).toBe(true);
});
