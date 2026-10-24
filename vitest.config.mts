import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: { META_APP_SECRET: 'test-secret', META_VERIFY_TOKEN: 'VT', META_SYSTEM_TOKEN: 'test-token' },
            },
          }),
        ],
        test: { name: 'workers', include: ['test/**/*.test.ts'], exclude: ['test/guards.test.ts'] },
      },
      { test: { name: 'node', environment: 'node', include: ['test/guards.test.ts'] } },
    ],
  },
});
