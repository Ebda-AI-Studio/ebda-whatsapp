import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// wrangler.jsonc allows comments; strip line comments before parsing.
const cfg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

it('serves the inbox SPA from web/dist with deep-link fallback', () => {
  expect(cfg.assets).toMatchObject({ directory: 'web/dist', binding: 'ASSETS', not_found_handling: 'single-page-application' });
});

it('keeps the API, Meta webhook, health and tracked links (/t/*) on the Worker', () => {
  expect(cfg.assets.run_worker_first).toEqual(['/api/*', '/meta/*', '/health', '/t/*']);
});
