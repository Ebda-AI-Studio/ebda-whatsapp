import { SELF, createExecutionContext, env } from 'cloudflare:test';
import worker from '../src/index';
import { expect, it } from 'vitest';

// Ruling WA-404-1: an address the app does not serve answers with a REAL 404 and Ebda AI Studio's shared studio-pages page
// (the same renderer the Store hosts use), never the inbox shell with a 200 (a soft 404 that search engines would index).
it.each(['/zzz-nope', '/a/b/c', '/index.html.bak', '/auth'])('%s: a real 404 with the studio page, noindex, Arabic by default', async (path) => {
  const res = await SELF.fetch(`https://wa.test${path}`);
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toContain('text/html');
  expect(res.headers.get('x-robots-tag')).toContain('noindex');
  expect(res.headers.get('cache-control')).toBe('no-store');
  const html = await res.text();
  expect(html).toContain('<html lang="ar" dir="rtl">');
  expect(html).toContain('الصفحة اللي بتدوّر عليها مش موجودة.');
  expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
});

it('English when asked: Accept-Language or ?lang=en', async () => {
  const a = await SELF.fetch('https://wa.test/zzz-nope', { headers: { 'accept-language': 'en-US,en;q=0.9' } });
  expect(a.status).toBe(404);
  expect(await a.text()).toContain('<html lang="en" dir="ltr">');
  const b = await SELF.fetch('https://wa.test/zzz-nope?lang=en');
  expect(await b.text()).toContain('<html lang="en" dir="ltr">');
});

it('HEAD answers 404 with no body', async () => {
  const res = await SELF.fetch('https://wa.test/zzz-nope', { method: 'HEAD' });
  expect(res.status).toBe(404);
  expect(await res.text()).toBe('');
});

it('the page carries its own locked-down CSP (the Worker default would block its inline style)', async () => {
  const res = await SELF.fetch('https://wa.test/zzz-nope');
  const csp = res.headers.get('content-security-policy') ?? '';
  expect(csp).toContain("style-src 'unsafe-inline'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d{8,}/);
});

it('the 404 CSP lets the edge-added visit-count script load, and widens script-src by that one host only', async () => {
  // Measured on production: the edge adds <script src="https://static.cloudflareinsights.com/beacon.min.js/..."> to the 404 page too.
  const res = await SELF.fetch('https://wa.test/zzz-nope');
  const csp = res.headers.get('content-security-policy') ?? '';
  const scriptSrc = /(?:^|;\s*)script-src ([^;]+)/.exec(csp)?.[1]?.trim().split(/\s+/);
  expect(scriptSrc).toEqual(['https://help.ebda.app', 'https://static.cloudflareinsights.com']);
  expect(csp).toContain("default-src 'none'");
});

it('an unknown API path keeps the JSON 404 (a client never gets HTML)', async () => {
  const res = await SELF.fetch('https://wa.test/api/v1/nope');
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toContain('application/json');
});

it('a write to an unknown path is a JSON 404, not the page', async () => {
  const res = await SELF.fetch('https://wa.test/zzz-nope', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toContain('application/json');
});

it('the sign-in callback path is NOT a 404: the Worker hands the inbox shell (index.html) to it', async () => {
  const asked: string[] = [];
  const assets = { fetch: async (r: Request) => { asked.push(new URL(r.url).pathname); return new Response('<!doctype html>shell', { headers: { 'content-type': 'text/html' } }); } };
  const res = await worker.fetch(new Request('https://wa.test/auth/callback?code=x&state=y'), { ...env, ASSETS: assets } as typeof env, createExecutionContext());
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('shell');
  expect(asked).toEqual(['/']);
});
