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
              // The production ACCOUNTS binding targets the ebda-accounts Worker. Tests get a stand-in whose isRevoked always fails, which
              // the code treats exactly like an unreachable accounts service (fail closed); tests that need a working check inject their own.
              workers: [{
                name: 'ebda-accounts', modules: true, compatibilityDate: '2026-10-24',
                script: "import { WorkerEntrypoint } from 'cloudflare:workers'; export class Accounts extends WorkerEntrypoint { async isRevoked() { throw new Error('accounts service is not available in tests'); } } export default { fetch() { return new Response(null, { status: 404 }); } };",
              }, {
                // WA-LINK-ON-1: wrangler.jsonc binds STORE_BRIDGE to ebda-api, and workerd refuses to start with a binding to a missing service.
                // test/setup.ts then removes STORE_BRIDGE / STORE_EVENTS from env so the default test world stays link-off.
                name: 'ebda-api', modules: true, compatibilityDate: '2026-10-24',
                script: "import { WorkerEntrypoint } from 'cloudflare:workers'; export class WhatsAppBridge extends WorkerEntrypoint {} export default { fetch() { return new Response(null, { status: 404 }); } };",
              }],
              bindings: { REQUIRED_SECRETS: '', TOPUPS_ENABLED: 'true', PACKAGE_CHECKOUT_ENABLED: 'true', KASHIER_REFUNDS_ENABLED: 'true', INSTAPAY_BILLING_ENABLED: 'true', SUPPORT_EMAIL: 'ahlan@ebda.app', AI_PRICE_INPUT_USD_PER_M: '0.293', AI_PRICE_OUTPUT_USD_PER_M: '2.253', EBDA_INSTAPAY_HANDLE: 'ebda@instapay', EBDA_INSTAPAY_PAYEE_NAME: 'Ebda AI Studio', EBDA_INSTAPAY_QR_URL: 'https://media.ebda.app/platform/instapay-qr.jpg', META_APP_SECRET: 'test-secret', META_VERIFY_TOKEN: 'VT', META_SYSTEM_TOKEN: 'test-token', EMBEDDED_SIGNUP_ENABLED: '1', META_APP_ID: 'app-1', EMBEDDED_SIGNUP_CONFIG_ID: 'cfg-1', TOKEN_ENC_KEY: testKey(), ERASURE_HMAC_KEY: 'test-erasure-hmac-key-0123456789abcdef', TEST_MIGRATIONS: migrations, BENCH: process.env.BENCH ?? '0', VITEST_TEST_TIMEOUT: process.env.VITEST_TEST_TIMEOUT ?? '20000', BENCH_ABSOLUTE_MS: process.env.BENCH_ABSOLUTE_MS ?? '' },
            },
          }),
        ],
        // Integration tests run real workerd work with no timers to fake; the CI runner (shared ARM VM) is 7-12x slower than a laptop
        // (ordering 402 ms -> 5.0 s), so 5 s was a laptop budget. 20 s keeps 4x headroom over the slowest CI test (COD flow, 4.8 s).
        // CI (the shared VM, which can stall under host memory pressure) passes VITEST_TEST_TIMEOUT=60000; locally 20 s, so real slowness still shows here.
        // Console lines go straight to workerd's stdout, not through the worker -> runner RPC: under CI I/O pressure a line still in that RPC
        // when a file closed failed the run (EnvironmentTeardownError "Closing rpc while onUserConsoleLog was pending", main 44c28fe). Spies still see every call.
        test: { name: 'workers', disableConsoleIntercept: true, testTimeout: Number(process.env.VITEST_TEST_TIMEOUT ?? 20_000), setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.ts'], exclude: ['test/vendored-artifacts.test.ts', 'test/guards.test.ts', 'test/assets-config.test.ts', 'test/verify-prod.test.ts', 'test/white-label.test.ts', 'test/ci-test-runner.test.ts', 'test/migrations-additive.test.ts', 'test/deploy-workflow.test.ts', 'test/no-raw-fetch.test.ts', 'test/deploy-change-label.test.ts', 'test/ci-workflow.test.ts', 'test/vat-zero-legal.test.ts', 'test/alert-runbooks.test.ts', 'test/backup-offsite.test.ts', 'test/web-styles.test.ts', 'test/web-motion.test.ts', 'test/migration-0020.test.ts', 'test/refund-writers.test.ts', 'test/foundation-parity.test.ts'] },
      },
      { test: { name: 'node', environment: 'node', include: ['test/vendored-artifacts.test.ts', 'test/guards.test.ts', 'test/assets-config.test.ts', 'test/verify-prod.test.ts', 'test/white-label.test.ts', 'test/ci-test-runner.test.ts', 'test/migrations-additive.test.ts', 'test/deploy-workflow.test.ts', 'test/no-raw-fetch.test.ts', 'test/deploy-change-label.test.ts', 'test/ci-workflow.test.ts', 'test/vat-zero-legal.test.ts', 'test/alert-runbooks.test.ts', 'test/backup-offsite.test.ts', 'test/web-styles.test.ts', 'test/web-motion.test.ts', 'test/migration-0020.test.ts', 'test/refund-writers.test.ts', 'test/foundation-parity.test.ts'] } },
      { plugins: [react()], resolve: { alias: { '@brand': new URL('./web/brands/ebda/brand.ts', import.meta.url).pathname, '@brand-tokens': new URL('./web/brands/ebda/tokens.css', import.meta.url).pathname } }, test: { name: 'web', environment: 'jsdom', testTimeout: Number(process.env.VITEST_TEST_TIMEOUT ?? 20_000), // same budget as workers: CI sets asyncUtilTimeout 20 s but the web project kept vitest's 5 s, so a slow-VM findBy was killed at 5003 ms (WalletScreen polling tests, PR #55 run 42656430806)
         setupFiles: ['./web/src/test-setup.ts'], include: ['web/src/**/*.test.{ts,tsx}'] } },
    ],
  },
});
