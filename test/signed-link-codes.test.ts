import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureCampaignLinks, linkCodeKeyFingerprint, newSignedCode, parseCode, verifyCode } from '../src/core/campaigns/links';
import { requestGuards } from '../src/core/request-guards';
import { seedNumber } from './helpers/workspace';

const SECRET = 'link-secret-for-tests-0123456789abcdef';
const WS = '00000000-0000-4000-8000-000000009501';
afterEach(() => vi.restoreAllMocks());

describe('signed link codes (WA-LINK-2)', () => {
  it('a new code is <ws>.<22>.<22> and verifies with its secret only', async () => {
    const code = await newSignedCode(WS, SECRET);
    expect(code).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(parseCode(code)?.workspaceId).toBe(WS);
    expect(await verifyCode(code, SECRET)).toBe(true);
    expect(await verifyCode(code, 'another-secret-another-secret-xx')).toBe(false);
  });

  it('a tampered workspace, random part or MAC fails; so does an unsigned (old-format) or malformed code', async () => {
    const code = await newSignedCode(WS, SECRET);
    const [w, r, m] = code.split('.') as [string, string, string];
    const flip = (s: string) => s.slice(0, -1) + (s.at(-1) === 'A' ? 'B' : 'A');
    for (const bad of [`00000000-0000-4000-8000-000000009502.${r}.${m}`, `${w}.${flip(r)}.${m}`, `${w}.${r}.${flip(m)}`, `${w}.${r}`, `${w}.${r}.${m}x`, '', 'x.y.z']) {
      expect(await verifyCode(bad, SECRET), bad).toBe(false);
    }
  });

  it('the link-code key is its own (versioned HKDF label), not the raw secret the proof links use', async () => {
    const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const proofMac = new Uint8Array(await crypto.subtle.sign('HMAC', raw, new TextEncoder().encode('probe')));
    const linkMac = await linkCodeKeyFingerprint(SECRET, 'probe');
    expect(Buffer.from(linkMac).toString('hex')).not.toBe(Buffer.from(proofMac).toString('hex'));
  });
});

describe('the guard rejects unsigned codes before any bucket or Durable Object', () => {
  const app = () => {
    const a = new Hono<{ Bindings: typeof env }>();
    a.use('*', requestGuards({ webhook: { ratePerSec: 1, burst: 1 }, link: { ratePerSec: 0.0001, burst: 1, workspaceRatePerSec: 0.0001, workspaceBurst: 1 } }));
    a.get('/t/:code', (c) => c.text('route'));
    return a;
  };
  it('an unsigned code is a 404 with the same body as a malformed one, never reaching the route; a signed one still passes', async () => {
    const prev = configureCampaignLinks({ signingSecret: () => SECRET });
    try {
      const a = app();
      const unsigned = await a.request(`/t/${WS}.${'A'.repeat(22)}.${'B'.repeat(22)}`, {}, env);
      const malformed = await a.request('/t/garbage', {}, env);
      expect(unsigned.status).toBe(404);
      expect(malformed.status).toBe(404);
      expect(await unsigned.text()).toBe(await malformed.text());
      for (let i = 0; i < 5; i++) await a.request(`/t/${WS}.${'A'.repeat(22)}.${'C'.repeat(22)}`, {}, env); // forged: spends no bucket
      const good = await a.request(`/t/${await newSignedCode(WS, SECRET)}`, {}, env);
      expect(await good.text()).toBe('route'); // the store's one-token bucket is still full
    } finally {
      configureCampaignLinks(prev);
    }
  });
});

describe('every way in checks the MAC', () => {
  it('a HEAD (or any method) with an unsigned code is refused at the edge, and the track route verifies the MAC itself too', async () => {
    const prev = configureCampaignLinks({ signingSecret: () => SECRET });
    try {
      const { SELF } = await import('cloudflare:test');
      await seedNumber('pn-sig-9501', WS); // a registered workspace: without the MAC check the route WOULD reach its Durable Object
      const unsigned = `${WS}.${'A'.repeat(22)}.${'B'.repeat(22)}`;
      const spy = vi.spyOn(env.WORKSPACE_DO, 'get');
      for (const method of ['HEAD', 'GET', 'POST']) expect((await SELF.fetch(`https://x/t/${unsigned}`, { method, redirect: 'manual' })).status, method).toBe(404);
      expect(spy).not.toHaveBeenCalled();
      // defense in depth: the route alone (no guard in front) refuses an unsigned code before touching a Durable Object
      const { trackRoutes } = await import('../src/routes/track');
      expect((await trackRoutes.request(`/t/${unsigned}`, { method: 'HEAD' }, env)).status).toBe(404);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      configureCampaignLinks(prev);
    }
  });
});
