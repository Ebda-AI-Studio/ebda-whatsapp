import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      BENCH: string;
      /** p95 budget for the opt-in benches: 150 ms on a quiet machine (the product budget); the nightly CI job passes a runner-sized one. */
      BENCH_BUDGET_MS: string;
    }
  }
}
export {};
