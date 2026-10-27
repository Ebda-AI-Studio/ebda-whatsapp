import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      BENCH: string;
      /** The workers project's testTimeout in ms (test/setup.ts names pending operations a moment before it). */
      VITEST_TEST_TIMEOUT: string;
      /** Absolute p95 ceiling in ms, set ONLY by scripts/bench-local.mjs (the product budget, 150, on a known machine); empty = the fixed-ratio budget only (test/helpers/bench.ts). */
      BENCH_ABSOLUTE_MS: string;
    }
  }
}
export {};
