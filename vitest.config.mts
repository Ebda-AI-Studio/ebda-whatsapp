import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import react from '@vitejs/plugin-react';

const migrations = await readD1Migrations('./migrations/d1');

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: { META_APP_SECRET: 'test-secret', META_VERIFY_TOKEN: 'VT', META_SYSTEM_TOKEN: 'test-token', TEST_MIGRATIONS: migrations },
            },
          }),
        ],
        test: { name: 'workers', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.ts'], exclude: ['test/guards.test.ts', 'test/assets-config.test.ts'] },
      },
      { test: { name: 'node', environment: 'node', include: ['test/guards.test.ts', 'test/assets-config.test.ts'] } },
      { plugins: [react()], test: { name: 'web', environment: 'jsdom', include: ['web/src/**/*.test.{ts,tsx}'] } },
    ],
  },
});
