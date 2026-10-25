import { readFileSync, readdirSync } from 'node:fs';
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
  const headers = readFileSync(join(import.meta.dirname, '..', 'web', 'brands', 'ebda', 'public', '_headers'), 'utf8');
  expect(headers).toMatch(/^\/\*$/m);
  const csp = /Content-Security-Policy: (.+)$/m.exec(headers)?.[1] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self' https://connect.facebook.net;");
  expect(csp).toContain('frame-src https://*.facebook.com');
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("connect-src 'self' https://accounts.ebda.app");
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(headers).toMatch(/Strict-Transport-Security: max-age=\d{8,}/);
  expect(headers).toContain('X-Content-Type-Options: nosniff');
  expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin');
});

it('every brand ships its own _headers with the same base policy, and only the suite brand names its accounts host', () => {
  const brands = readdirSync(join(import.meta.dirname, '..', 'web', 'brands'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  expect(brands).toEqual(expect.arrayContaining(['ebda', 'demo']));
  for (const b of brands) {
    const h = readFileSync(join(import.meta.dirname, '..', 'web', 'brands', b, 'public', '_headers'), 'utf8');
    const csp = /Content-Security-Policy: (.+)$/m.exec(h)?.[1] ?? '';
    for (const part of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'"]) expect(csp, b).toContain(part);
    expect(h, b).toMatch(/Strict-Transport-Security: max-age=\d{8,}/);
    if (b !== 'ebda') expect(h, b).not.toMatch(/ebda/i);
  }
});

it('every guide the inbox links to exists in docs/help in both languages (the help site publishes <host>/<lang>/<slug>)', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'components', 'NumbersScreen.tsx'), 'utf8');
  const slugs = [...src.matchAll(/guide: '([a-z0-9-]+)'/g)].map((m) => m[1]);
  expect(slugs.length).toBeGreaterThan(0);
  for (const lang of ['ar', 'en']) {
    const files = readdirSync(join(import.meta.dirname, '..', 'docs', 'help', lang)).map((f) => f.replace(/^\d+-/, '').replace(/\.md$/, ''));
    for (const slug of slugs) expect(files, `${lang}: ${slug}`).toContain(slug);
  }
});
