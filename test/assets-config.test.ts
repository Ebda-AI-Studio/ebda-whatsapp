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

it('serves the SPA with security headers: CSP limited to itself and the identity host, no framing, HSTS, nosniff', () => {
  const headers = readFileSync(join(import.meta.dirname, '..', 'web', 'public', '_headers'), 'utf8');
  expect(headers).toMatch(/^\/\*$/m);
  const csp = /Content-Security-Policy: (.+)$/m.exec(headers)?.[1] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("connect-src 'self' https://accounts.ebda.app");
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(headers).toMatch(/Strict-Transport-Security: max-age=\d{8,}/);
  expect(headers).toContain('X-Content-Type-Options: nosniff');
  expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin');
});
