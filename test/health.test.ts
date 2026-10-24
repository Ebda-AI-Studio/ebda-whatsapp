import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('GET /health returns ok and the commit', async () => {
  const res = await SELF.fetch('https://x/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, service: 'ebda-wa', commit: 'dev' });
});
