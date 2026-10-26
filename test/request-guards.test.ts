import { SELF, env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureCampaignLinks, newSignedCode, type LinkConfig } from '../src/core/campaigns/links';
import { type GuardLimits, requestGuards } from '../src/core/request-guards';
import { inboundPayload } from './helpers/payload';
import { sign } from './helpers/meta';
import { apiFor, storeId as W, useApiKey } from './helpers/api';

useApiKey();
const LINK_SECRET = 'guard-link-secret-for-tests-0123456789';
let prevLinks: LinkConfig | undefined;
beforeEach(() => { prevLinks = configureCampaignLinks({ signingSecret: () => LINK_SECRET }); });
afterEach(() => { if (prevLinks) configureCampaignLinks(prevLinks); });

const big = (n: number) => 'x'.repeat(n);
const streamOf = (n: number) => new ReadableStream<Uint8Array>({
  start(c) { const chunk = new TextEncoder().encode('x'.repeat(64 * 1024)); for (let i = 0; i < n; i += chunk.length) c.enqueue(chunk); c.close(); },
});
const post = (url: string, body: BodyInit, headers: Record<string, string>, extra: RequestInit = {}) =>
  SELF.fetch(url, { method: 'POST', headers, body, ...extra } as RequestInit);

// ---- body-size cap, with and without Content-Length
it('JSON API: a body over 1 MB is 413 payload_too_large, declared or chunked', async () => {
  const api = await apiFor(W(900));
  const headers = { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' };
  const url = `https://x/api/v1/stores/${W(900)}/conversations/1/messages`;
  const declared = await post(url, JSON.stringify({ pad: big(1024 * 1024 + 10) }), headers);
  expect(declared.status).toBe(413);
  expect(await declared.json()).toEqual({ error: 'payload_too_large' });
  const chunked = await post(url, streamOf(1024 * 1024 + 64 * 1024), headers, { duplex: 'half' } as RequestInit);
  expect(chunked.status).toBe(413);
  expect(await chunked.json()).toEqual({ error: 'payload_too_large' });
});

it('webhooks: over 256 KB is 413, declared or chunked; a normal signed body is unaffected', async () => {
  for (const path of ['/meta/webhook', '/kashier/webhook']) {
    const h = { 'content-type': 'application/json' };
    const raw = JSON.stringify({ pad: big(256 * 1024 + 10) });
    const declared = await post(`https://x${path}`, raw, h);
    expect(declared.status, path).toBe(413);
    expect(await declared.json()).toEqual({ error: 'payload_too_large' });
    const chunked = await post(`https://x${path}`, streamOf(256 * 1024 + 64 * 1024), h, { duplex: 'half' } as RequestInit);
    expect(chunked.status, `${path} chunked`).toBe(413);
  }
  const ok = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  expect((await post('https://x/meta/webhook', ok, { 'content-type': 'application/json', 'x-hub-signature-256': await sign(ok) })).status).toBe(200);
});

it('a JSON body just under the cap still goes through to the route', async () => {
  const api = await apiFor(W(901));
  const r = await post(`https://x/api/v1/stores/${W(901)}/conversations/1/messages`, JSON.stringify({ pad: big(900 * 1024) }), { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' });
  expect(r.status).toBe(400); // reached the route and failed its own validation
});

// ---- content type
it('a wrong content type on a body is 415 unsupported_media (API, webhooks); multipart only where uploads exist', async () => {
  const api = await apiFor(W(902));
  const auth = { authorization: `Bearer ${api.token}` };
  const bad = await post(`https://x/api/v1/stores/${W(902)}/conversations/1/messages`, '{"a":1}', { ...auth, 'content-type': 'text/plain' });
  expect(bad.status).toBe(415);
  expect(await bad.json()).toEqual({ error: 'unsupported_media' });
  const form = new FormData(); form.set('a', 'b');
  expect((await post(`https://x/api/v1/stores/${W(902)}/conversations/1/messages`, form, auth)).status).toBe(415); // multipart on a JSON route
  expect((await post('https://x/meta/webhook', 'a=b', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
  expect((await post('https://x/meta/webhook', '{}', {})).status).toBe(415); // no type at all, with a body
  // the Kashier webhook is judged by its HMAC, not its type: a non-JSON type reaches the route (401 bad signature), not a 415
  expect((await post('https://x/kashier/webhook', '{}', { 'content-type': 'text/plain' })).status).not.toBe(415);
  // authentication still comes first: no token is 401 and the wrong role is 403 before any type judgement
  expect((await post(`https://x/api/v1/stores/${W(902)}/conversations/1/messages`, '{}', { 'content-type': 'text/plain' })).status).toBe(401);
  // an upload route takes multipart (the route then judges the file itself)
  expect((await post(`https://x/api/v1/stores/${W(902)}/imports`, form, auth)).status).not.toBe(415);
  // a body-less POST/DELETE needs no content type
  expect((await SELF.fetch(`https://x/api/v1/stores/${W(902)}/me`, { headers: auth })).status).toBe(200);
});

// ---- public routes
// The limits are exercised on a tiny app with the real middleware and tiny buckets (no refill): deterministic whatever the machine load.
// The wiring into the real Worker is covered by the 413/415 tests above and the junk /t test below.
const mini = (burst: number, over: Partial<GuardLimits> = {}) => {
  const app = new Hono<{ Bindings: { META_APP_SECRET: string } }>();
  app.use('*', requestGuards({ webhook: { ratePerSec: 0.0001, burst }, link: { ratePerSec: 0.0001, burst, workspaceRatePerSec: 1000, workspaceBurst: 1000 }, ...over }));
  app.post('/meta/webhook', (c) => c.text('ok'));
  app.get('/t/:code', (c) => c.text('hit'));
  return app;
};
const MINI_ENV = { META_APP_SECRET: 'test-secret' };
const signedHook = async (app: ReturnType<typeof mini>, pn: string, signature?: string) => {
  const raw = inboundPayload(pn, [{ id: `wamid.${crypto.randomUUID()}` }]);
  return app.request('/meta/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? (await sign(raw)) }, body: raw }, MINI_ENV);
};

it('/meta/webhook: a flood on one phone_number_id gets 429 + Retry-After while another number still passes', async () => {
  const app = mini(5);
  const first = [];
  for (let i = 0; i < 8; i++) first.push((await signedHook(app, 'pn-flood')).status);
  expect(first).toEqual([200, 200, 200, 200, 200, 429, 429, 429]);
  const limited = await signedHook(app, 'pn-flood');
  expect(await limited.json()).toEqual({ error: 'rate_limited' });
  expect(limited.headers.get('retry-after')).toBeTruthy();
  expect((await signedHook(app, 'pn-calm')).status).toBe(200); // not starved by the flood
});

it('/meta/webhook: an UNSIGNED body naming a victim number cannot use up the victim\'s allowance', async () => {
  const app = mini(3);
  for (let i = 0; i < 20; i++) expect((await signedHook(app, 'pn-victim', 'sha256=' + '0'.repeat(64))).status).toBe(200); // the mini route has no auth: it answers, but must not COUNT
  for (let i = 0; i < 3; i++) expect((await signedHook(app, 'pn-victim')).status).toBe(200); // the victim's full burst is still there
  expect((await signedHook(app, 'pn-victim')).status).toBe(429);
});

it('/t/:code: a flood on one workspace is limited with 429, another workspace is not; a malformed code is never counted', async () => {
  const app = mini(4);
  const signed = new Map<string, string>();
  const code = (w: string) => signed.get(w)!;
  for (const w of [W(920), W(921)]) signed.set(w, await newSignedCode(w, LINK_SECRET));
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await app.request(`/t/${code(W(920))}`)).status);
  expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
  const limited = await app.request(`/t/${code(W(920))}`);
  expect(await limited.json()).toEqual({ error: 'rate_limited' });
  expect(limited.headers.get('retry-after')).toBeTruthy();
  expect((await app.request(`/t/${code(W(921))}`)).status).toBe(200);
  for (let i = 0; i < 20; i++) expect((await app.request('/t/garbage')).status).toBe(404); // refused at the edge (unsigned), never rate counted
  expect((await app.request(`/t/${code(W(921))}`)).status).toBe(200); // W(921)'s bucket still has its token
});

it('/t/:code: one client flooding a store\'s links cannot use up that store\'s allowance for other customers (keyed per client + workspace)', async () => {
  const app = mini(4);
  const signed = new Map<string, string>();
  const code = (w: string) => signed.get(w)!;
  for (const w of [W(930)]) signed.set(w, await newSignedCode(w, LINK_SECRET));
  const from = (ip: string) => ({ headers: { 'cf-connecting-ip': ip } });
  for (let i = 0; i < 10; i++) await app.request(`/t/${code(W(930))}`, from('203.0.113.9')); // the attacker exhausts its own share
  expect((await app.request(`/t/${code(W(930))}`, from('203.0.113.9'))).status).toBe(429);
  expect((await app.request(`/t/${code(W(930))}`, from('198.51.100.7'))).status).toBe(200); // a real customer's click still lands
});

it('/t/:code: many clients together still hit the store-wide cap, and IPv6 clients are keyed by their /64', async () => {
  const app = mini(4, { link: { ratePerSec: 0.001, burst: 2, workspaceRatePerSec: 0.001, workspaceBurst: 5 } });
  const signed = new Map<string, string>();
  const code = (w: string) => signed.get(w)!;
  for (const w of [W(940), W(941)]) signed.set(w, await newSignedCode(w, LINK_SECRET));
  const from = (ip: string) => ({ headers: { 'cf-connecting-ip': ip } });
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await app.request(`/t/${code(W(940))}`, from(`198.51.100.${i}`))).status); // 7 different clients
  expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
  expect(statuses.slice(5)).toEqual([429, 429]); // the store-wide cap holds against a spread flood
  // two addresses in one IPv6 /64 share one client share
  await app.request(`/t/${code(W(941))}`, from('2001:db8:1:2::a'));
  await app.request(`/t/${code(W(941))}`, from('2001:db8:1:2::b'));
  expect((await app.request(`/t/${code(W(941))}`, from('2001:db8:1:2::c'))).status).toBe(429);
});

it('/t/:code on the real Worker: a junk code is a 404 that never wakes a Durable Object', async () => {
  const get = vi.spyOn(env.WORKSPACE_DO, 'get');
  for (const junk of ['garbage', 'a.b', `${W(910)}.short`, '../../etc', `${W(911)}.${'A'.repeat(22)}`]) {
    expect((await SELF.fetch(`https://x/t/${encodeURIComponent(junk)}`, { redirect: 'manual' })).status, junk).toBe(404);
  }
  expect(get).not.toHaveBeenCalled();
  get.mockRestore();
});

it('normal traffic is unaffected: health, GET with no body', async () => {
  expect((await SELF.fetch('https://x/health')).status).toBe(200);
});
