import { vi } from 'vitest';

/**
 * A point a fake call stops at until the test releases it, so a test can act while a call is in flight without guessing the window
 * with a sleep (which misses under load). Plain flags, each side polling on its own timer: a promise resolved across the
 * test/Durable Object boundary carries the wrong I/O context, which workerd refuses.
 */
export function holdPoint() {
  const s = { reached: 0, released: false };
  return {
    /** Call inside the fake. */
    async hold() {
      s.reached++;
      while (!s.released) await new Promise((r) => setTimeout(r, 5));
    },
    async reached() {
      await vi.waitFor(() => { if (!s.reached) throw new Error('hold point not reached'); }, { timeout: 5_000, interval: 5 });
    },
    release() { s.released = true; },
    get count() { return s.reached; },
  };
}
