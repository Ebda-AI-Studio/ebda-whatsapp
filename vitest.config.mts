import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import react from '@vitejs/plugin-react';

// Test-only key, generated from a byte sequence (never a literal), not a secret.
const testKey = () => Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 101)).toString('base64');
const migrations = await readD1Migrations('./migrations/d1');

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            // The AI binding is remote-only; tests use a scripted fake provider and must never open a remote session.
            remoteBindings: false,
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: { TOPUPS_ENABLED: 'true', META_APP_SECRET: 'test-secret', META_VERIFY_TOKEN: 'VT', META_SYSTEM_TOKEN: 'test-token', EMBEDDED_SIGNUP_ENABLED: '1', META_APP_ID: 'app-1', EMBEDDED_SIGNUP_CONFIG_ID: 'cfg-1', TOKEN_ENC_KEY: testKey(), TEST_MIGRATIONS: migrations, BENCH: process.env.BENCH ?? '0', BENCH_BUDGET_MS: process.env.BENCH_BUDGET_MS ?? '150' },
            },
          }),
        ],
        // Integration tests run real workerd work with no timers to fake; the CI runner (shared ARM VM) is 7-12x slower than a laptop
        // (ordering 402 ms -> 5.0 s), so 5 s was a laptop budget. 20 s keeps 4x headroom over the slowest CI test (COD flow, 4.8 s).
        test: { name: 'workers', testTimeout: 20_000, setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.ts'], exclude: ['test/guards.test.ts', 'test/assets-config.test.ts', 'test/verify-prod.test.ts', 'test/white-label.test.ts'] },
      },
      { test: { name: 'node', environment: 'node', include: ['test/guards.test.ts', 'test/assets-config.test.ts', 'test/verify-prod.test.ts', 'test/white-label.test.ts'] } },
      { plugins: [react()], resolve: { alias: { '@brand': new URL('./web/brands/ebda/brand.ts', import.meta.url).pathname, '@brand-tokens': new URL('./web/brands/ebda/tokens.css', import.meta.url).pathname } }, test: { name: 'web', environment: 'jsdom', include: ['web/src/**/*.test.{ts,tsx}'] } },
    ],
  },
});
