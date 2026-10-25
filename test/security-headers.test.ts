import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

// The Worker answers /api, /meta, /health and /t itself (run_worker_first), so the static _headers file does not cover them.
it.each(['/health', '/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1', '/api/v1/stores/x/conversations', '/t/nope'])('%s carries security headers', async (path) => {
  const res = await SELF.fetch(`https://wa.test${path}`, { redirect: 'manual' });
  expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d{8,}/);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
});

