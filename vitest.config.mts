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
              bindings: { META_APP_SECRET: 'test-secret', META_VERIFY_TOKEN: 'VT', META_SYSTEM_TOKEN: 'test-token', EMBEDDED_SIGNUP_ENABLED: '1', META_APP_ID: 'app-1', TOKEN_ENC_KEY: testKey(), TEST_MIGRATIONS: migrations, BENCH: process.env.BENCH ?? '0' },
            },
          }),
        ],
        test: { name: 'workers', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.ts'], exclude: ['test/guards.test.ts', 'test/assets-config.test.ts', 'test/verify-prod.test.ts'] },
      },
      { test: { name: 'node', environment: 'node', include: ['test/guards.test.ts', 'test/assets-config.test.ts', 'test/verify-prod.test.ts'] } },
      { plugins: [react()], test: { name: 'web', environment: 'jsdom', include: ['web/src/**/*.test.{ts,tsx}'] } },
    ],
  },
});
