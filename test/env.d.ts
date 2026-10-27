import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      BENCH: string;
      /** Absolute p95 ceiling in ms, set ONLY by scripts/bench-local.mjs (the product budget, 150, on a known machine); empty = the fixed-ratio budget only (test/helpers/bench.ts). */
      BENCH_ABSOLUTE_MS: string;
    }
  }
}
export {};
