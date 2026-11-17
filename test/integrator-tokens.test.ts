// @repo-guard
import { createExecutionContext, env } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { apiRoutes } from '../src/index';
import { createEbdaAccountsVerifier } from '../src/addons/ebda/identity';
import { DEFAULT_API_LIMITS, configureApiLimits } from '../src/core/api-rate';
import { clearIntegrationCache, configureIntegrationClock } from '../src/core/identity/integration';
import { createOidcVerifier, parseOidcConfig } from '../src/core/identity/oidc';
import { ROUTE_SCOPES, WHATSAPP_SCOPES } from '../src/core/identity/scopes';
import { IdentityError } from '../src/core/identity/verifier';
import { apiFor, apiKey, graphStub, storeId as W, useApiKey } from './helpers/api';
import { ISSUER, JWKS_URL, jwksServer, mintClient, newKey, type TestKey } from './helpers/issuer';

// Identity contract v1.3 r2 (DRAFT, awaiting approval by the accounts owner): integrator server tokens, product side.
useApiKey();
const STORE = W(3100);
const ALL = WHATSAPP_SCOPES.join(' ');
let k1: TestKey;
beforeAll(async () => { k1 = await newKey('k1'); });
beforeEach(() => { clearIntegrationCache(); configureIntegrationClock(null); });
let graph: ReturnType<typeof graphStub> | undefined;
afterEach(() => { graph?.restore(); vi.restoreAllMocks(); });

const verifierFor = () => createEbdaAccountsVerifier({ jwksUrl: JWKS_URL, issuer: ISSUER, audience: 'whatsapp', fetchJwks: jwksServer([k1]).fetchJwks });
const ON = { integratorTokens: true };
async function status(p: Promise<unknown>) {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(IdentityError);
  return (e as IdentityError).status;
}

describe('verifier: integrator tokens', () => {
  it('accepts a client token with a scope (fixed vector), as an integration principal with no person powers', async () => {
    const p = await verifierFor().verify(await mintClient(k1, { storeId: STORE, scope: 'messages:send conversations:read' }), ON);
    expect(p).toMatchObject({ userId: 'cli_01HZX3K9Q8T2M5N7P4R6V0W1YA', sessionId: 'cli_01HZX3K9Q8T2M5N7P4R6V0W1YA', superAdmin: false, stores: [{ id: STORE, role: 'staff' }] });
    expect(p.integration).toEqual({ clientId: 'cli_01HZX3K9Q8T2M5N7P4R6V0W1YA', jti: expect.any(String), scopes: ['messages:send', 'conversations:read'] });
  });
  it('accepts the accounts side\'s pinned example token shape (ebda-store docs/contracts/identity-client-token-v1.3.example.json, matching r2)', async () => {
    // The pinned payload, re-signed with the test key and given a live time window; every other claim is copied as published.
    const now = Math.floor(Date.now() / 1000);
    const vector = { iss: ISSUER, aud: 'whatsapp', sub: 'cli_AAAAAAAAAAAAAAAAAAAAAAAAAA', sid: 'cli_AAAAAAAAAAAAAAAAAAAAAAAAAA', jti: '00000000-0000-4000-8000-0000000000c3', iat: now, nbf: now, exp: now + 600, scope: 'messages:send contacts:read', client: true, stores: [{ id: '11111111-1111-4111-8111-111111111111', role: 'integration' }] };
    const token = await new SignJWT(vector).setProtectedHeader({ alg: 'ES256', kid: k1.kid, typ: 'at+jwt' }).sign(k1.privateKey);
    const p = await verifierFor().verify(token, ON);
    expect(p).toMatchObject({ userId: vector.sub, sessionId: vector.sid, superAdmin: false, stores: [{ id: vector.stores[0]!.id, role: 'staff' }] });
    expect(p.integration).toEqual({ clientId: vector.sub, jti: vector.jti, scopes: ['messages:send', 'contacts:read'] });
  });
  it('is refused while the switch is off (default), whatever else is valid', async () => {
    expect(await status(verifierFor().verify(await mintClient(k1, { storeId: STORE })))).toBe(401);
    expect(await status(verifierFor().verify(await mintClient(k1, { storeId: STORE }), { integratorTokens: false }))).toBe(401);
  });
  it('is refused without client:true, with client:false, and with a role "integration" on a person-looking token', async () => {
    for (const c of [{ omit: ['client'] }, { extra: { client: false } }, { extra: { client: 'true' } }]) {
      expect(await status(verifierFor().verify(await mintClient(k1, { storeId: STORE, ...c }), ON)), JSON.stringify(c)).toBe(401);
    }
  });
  it('is refused when pa, auth_time or email is present (a client token carries no person claim)', async () => {
    for (const extra of [{ pa: 'super_admin' }, { pa: 'x' }, { auth_time: 1 }, { email: 'a@b.c' }]) {
      expect(await status(verifierFor().verify(await mintClient(k1, { storeId: STORE, extra }), ON)), JSON.stringify(extra)).toBe(401);
    }
  });
  it('is refused with no scope, only unknown scopes (orders:events is unissuable), a wrong audience, sub != sid, a non-client id or two stores', async () => {
    const bad = [
      { omit: ['scope'] }, { scope: '' }, { scope: 'orders:events' }, { scope: 'admin:all wallet:topup' }, { aud: 'store' },
      { extra: { sid: 'cli_other' } }, { clientId: '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f' },
      { extra: { stores: [{ id: STORE, role: 'integration' }, { id: W(3101), role: 'integration' }] } },
      { role: 'owner' }, { role: 'staff' },
    ];
    for (const c of bad) expect(await status(verifierFor().verify(await mintClient(k1, { storeId: STORE, ...c }), ON)), JSON.stringify(c)).toBe(401);
  });
  it('keeps only the scopes it knows when a token lists more', async () => {
    const p = await verifierFor().verify(await mintClient(k1, { storeId: STORE, scope: 'contacts:read admin:all' }), ON);
    expect(p.integration!.scopes).toEqual(['contacts:read']);
  });
  it('a person token that carries client or role "integration" is refused too', async () => {
    const person = (extra: Record<string, unknown>) => new SignJWT({ sid: 's1', stores: [{ id: STORE, role: 'owner' }], ...extra })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'at+jwt' }).setSubject('6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f').setIssuer(ISSUER).setAudience('whatsapp')
      .setIssuedAt().setExpirationTime('10m').setJti(crypto.randomUUID()).sign(k1.privateKey);
    expect(await status(verifierFor().verify(await person({ client: true }), ON))).toBe(401);
    expect(await status(verifierFor().verify(await person({ client: true }), { integratorTokens: false }))).toBe(401);
    expect(await status(verifierFor().verify(await person({ stores: [{ id: STORE, role: 'integration' }], scope: 'contacts:read' }), ON))).toBe(401);
  });
  it('the generic OIDC verifier never accepts a client token, switch or not', async () => {
    const ISS = 'https://login.client.example/realms/main';
    const cfg = parseOidcConfig(JSON.stringify({ issuer: ISS, jwksUrl: `${ISS}/certs`, audience: 'wa', stores: { fixed: STORE }, role: { claim: 'roles', owner: ['manager'], staff: [] } }));
    const jwk = { ...k1.jwk };
    const v = createOidcVerifier(cfg, { fetchJwks: (async () => new Response(JSON.stringify({ keys: [jwk] }))) as unknown as typeof fetch });
    const now = Math.floor(Date.now() / 1000);
    const t = await new SignJWT({ sid: 's', roles: ['manager'], client: true }).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setSubject('cli_x').setIssuer(ISS).setAudience('wa').setIssuedAt(now).setExpirationTime(now + 300).setJti('j').sign(k1.privateKey);
    expect(await status(v.verify(t, ON))).toBe(401);
  });
});

describe('API: what an integrator token may do', () => {
  // These tests make dozens of calls with one client id; the rate limit (test/api-rate-limit.test.ts) is not what they are about.
  let prevLimits = DEFAULT_API_LIMITS;
  beforeEach(() => { prevLimits = configureApiLimits({ workspace: { ratePerSec: 1e6, burst: 1e6 }, integration: { ratePerSec: 1e6, burst: 1e6 } }); });
  afterEach(() => { configureApiLimits(prevLimits); });
  const live = { INTEGRATOR_TOKENS_ENABLED: 'true', ACCOUNTS: { isRevoked: async () => false } };
  const call = async (token: string, method: string, path: string, over: Record<string, unknown> = {}, body?: unknown) =>
    worker.fetch(new Request(`https://x/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
      { ...env, ...live, ...over } as typeof env, createExecutionContext());
  const tok = (c: Partial<Parameters<typeof mintClient>[1]> = {}) => mintClient(apiKey(), { storeId: STORE, ...c });
  beforeEach(async () => { await apiFor(STORE); });

  it('a client token with the right scope reads and sends where its scope allows', async () => {
    expect((await call(await tok({ scope: 'conversations:read' }), 'GET', `/stores/${STORE}/conversations`)).status).toBe(200);
    expect((await call(await tok({ scope: 'templates:read' }), 'GET', `/stores/${STORE}/templates`)).status).toBe(200);
    expect((await call(await tok({ scope: 'contacts:read' }), 'GET', `/stores/${STORE}/contacts`)).status).toBe(200);
    expect((await call(await tok({ scope: 'campaigns:read' }), 'GET', `/stores/${STORE}/campaigns`)).status).toBe(200);
    expect((await call(await tok({ scope: 'messages:send' }), 'POST', `/stores/${STORE}/conversations/999/messages`, {}, { type: 'text', clientId: crypto.randomUUID(), text: 'x' })).status).toBe(404); // past the gate: the conversation does not exist
  });
  it('403 for a scope it was not granted', async () => {
    const t = await tok({ scope: 'templates:read' });
    expect((await call(t, 'GET', `/stores/${STORE}/conversations`)).status).toBe(403);
    expect((await call(t, 'POST', `/stores/${STORE}/conversations/1/messages`, {}, { type: 'text', clientId: crypto.randomUUID(), text: 'x' })).status).toBe(403);
  });
  it('403 on every owner-only and person-only surface, even with every scope', async () => {
    const t = await tok({ scope: ALL });
    const s = `/stores/${STORE}`;
    const surfaces: [string, string][] = [
      ['POST', `${s}/numbers/connect`], ['POST', `${s}/numbers/pn-1/disconnect`], ['GET', `${s}/numbers`],
      ['POST', `${s}/wallet/topups`], ['GET', `${s}/wallet`], ['POST', `${s}/wallet/refund-requests`],
      ['POST', `${s}/packages/p1/checkout`], ['GET', `${s}/packages`],
      ['DELETE', `${s}/contacts/201001234567`], ['PUT', `${s}/agent`], ['GET', `${s}/agent`], ['PATCH', `${s}/store-link/settings`], ['GET', `${s}/store-link/settings`],
      ['PUT', `${s}/connectors/c1`], ['GET', `${s}/connectors`], ['POST', `${s}/shared-number/join`],
      ['POST', `${s}/templates`], ['POST', `${s}/templates/sync`], ['POST', `${s}/templates/install-defaults`], ['POST', `${s}/templates/cod-v2/resubmit`], ['PUT', `${s}/templates/x/ar`], ['DELETE', `${s}/templates/x/ar`], ['POST', `${s}/campaigns`], ['POST', `${s}/imports`],
      ['POST', `${s}/conversations/1/assign`], ['POST', `${s}/conversations/1/notes`],
    ];
    for (const [m, p] of surfaces) expect((await call(t, m, p, {}, m === 'GET' || m === 'DELETE' ? undefined : {})).status, `${m} ${p}`).toBe(403);
  });
  it('403 on the operator console', async () => {
    expect((await call(await tok({ scope: ALL }), 'GET', '/operator/pricing-settings')).status).toBe(403);
    expect((await call(await tok({ scope: ALL }), 'POST', '/operator/shared-templates/sync', {}, {})).status).toBe(403);
  });
  it('a WebSocket upgrade is refused for a server token (a socket would outlive a revocation); /events is the way to follow', async () => {
    const t = await tok({ scope: ALL });
    const r = await worker.fetch(new Request(`https://x/api/v1/stores/${STORE}/ws`, { headers: { authorization: `Bearer ${t}`, upgrade: 'websocket' } }), { ...env, ...live } as typeof env, createExecutionContext());
    expect(r.status).toBe(403);
    const viaProtocol = await worker.fetch(new Request(`https://x/api/v1/stores/${STORE}/ws`, { headers: { 'sec-websocket-protocol': `inbox.v1, bearer.${t}`, upgrade: 'websocket' } }), { ...env, ...live } as typeof env, createExecutionContext());
    expect(viaProtocol.status).toBe(403);
    expect((await call(await tok({ scope: 'conversations:read' }), 'GET', `/stores/${STORE}/events?after=0`)).status).toBe(200);
  });
  it('a route nobody mapped is 403, not 404 (default deny)', async () => {
    expect((await call(await tok({ scope: ALL }), 'GET', `/stores/${STORE}/definitely-not-a-route`)).status).toBe(403);
  });
  it('401 without client:true, with pa, and with the switch off; 403 for another store', async () => {
    expect((await call(await tok({ omit: ['client'] }), 'GET', `/stores/${STORE}/conversations`)).status).toBe(401);
    expect((await call(await tok({ extra: { pa: 'super_admin' } }), 'GET', `/stores/${STORE}/conversations`)).status).toBe(401);
    expect((await call(await tok(), 'GET', `/stores/${STORE}/conversations`, { INTEGRATOR_TOKENS_ENABLED: undefined })).status).toBe(401);
    expect((await call(await tok(), 'GET', `/stores/${W(3199)}/conversations`)).status).toBe(403);
  });
  it('a revoked client is 401; an unreachable accounts service is 503 (fail closed)', async () => {
    expect((await call(await tok(), 'GET', `/stores/${STORE}/conversations`, { ACCOUNTS: { isRevoked: async () => true } })).status).toBe(401);
    expect((await call(await tok(), 'GET', `/stores/${STORE}/conversations`, { ACCOUNTS: { isRevoked: async () => { throw new Error('down'); } } })).status).toBe(503);
    expect((await call(await tok(), 'GET', `/stores/${STORE}/conversations`, { ACCOUNTS: undefined })).status).toBe(503);
  });
  it('the revocation answer is cached for at most 30 s per isolate (BOUNDED-stale); a revoked answer is never cached', async () => {
    let revoked = false;
    const isRevoked = vi.fn(async () => revoked);
    const over = { ACCOUNTS: { isRevoked } };
    let t = 1_000_000;
    configureIntegrationClock(() => t);
    const token = await tok();
    expect((await call(token, 'GET', `/stores/${STORE}/conversations`, over)).status).toBe(200);
    t += 29_000;
    revoked = true; // revoked now, but the 'ok' answer from 29 s ago is still honoured: the documented residual window
    expect((await call(token, 'GET', `/stores/${STORE}/conversations`, over)).status).toBe(200);
    expect(isRevoked).toHaveBeenCalledTimes(1);
    t += 2_000; // 31 s after the check
    expect((await call(token, 'GET', `/stores/${STORE}/conversations`, over)).status).toBe(401);
    expect(isRevoked).toHaveBeenCalledTimes(2);
    revoked = false;
    expect((await call(token, 'GET', `/stores/${STORE}/conversations`, over)).status).toBe(200); // the 401 was not cached
    expect(isRevoked).toHaveBeenCalledTimes(3);
  });
  it('every write emits { clientId, jti, storeId, scope } and nothing else; reads emit nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const token = await tok({ scope: 'messages:send' });
    await call(token, 'POST', `/stores/${STORE}/conversations/999/messages`, {}, { type: 'text', clientId: crypto.randomUUID(), text: 'secret body 201001234567' });
    const audits = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('integration_write'));
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!)).toEqual({ audit: 'integration_write', clientId: 'cli_01HZX3K9Q8T2M5N7P4R6V0W1YA', jti: expect.any(String), storeId: STORE, scope: 'messages:send' });
    expect(audits[0]).not.toContain('secret body');
    expect(audits[0]).not.toContain('201001234567');
    log.mockClear();
    await call(await tok({ scope: 'conversations:read' }), 'GET', `/stores/${STORE}/conversations`);
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.includes('integration_write'))).toBe(false);
  });
  it('person tokens are unaffected: an owner still reaches owner routes, and the switch does not matter to them', async () => {
    const owner = await apiFor(STORE);
    const r = await worker.fetch(new Request(`https://x/api/v1/stores/${STORE}/conversations`, { headers: { authorization: `Bearer ${owner.token}` } }), { ...env, INTEGRATOR_TOKENS_ENABLED: undefined } as typeof env, createExecutionContext());
    expect(r.status).toBe(200);
  });
});

/**
 * Routes (from Hono's table) that have no scope decision. A method-ALL handler serves every method, so it needs a decision for each; a wildcard
 * can serve unlisted routes. The only ALL entries allowed to skip a decision are the two auth middlewares and the feature-switch guards below
 * (each only answers 404 while its switch is off, then calls next()): listing them here is a deliberate, reviewed act.
 */
type R = { method: string; path: string };
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MIDDLEWARE = new Set([
  '/stores/:storeId/*', '/operator/*', // authentication
  '/stores/:storeId/numbers', '/stores/:storeId/numbers/*', '/stores/:storeId/packages', '/stores/:storeId/packages/*', '/stores/:storeId/shared-number', '/stores/:storeId/shared-number/*', // switch guards
]);
export function undecided(routes: R[], map: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const r of routes) {
    if (!r.path.startsWith('/stores/:storeId/')) continue;
    if (r.method === 'ALL' && MIDDLEWARE.has(r.path)) continue;
    if (r.path.includes('*')) { out.push(`${r.method} ${r.path}`); continue; }
    for (const m of r.method === 'ALL' ? METHODS : [r.method]) if (!(`${m} ${r.path}` in map)) out.push(`${m} ${r.path}`);
  }
  return out;
}

describe('the route scope map is complete', () => {
  const SCOPES = new Set<string>(WHATSAPP_SCOPES);
  const table = apiRoutes.routes as R[];
  const real = table.filter((r) => r.method !== 'ALL' && r.path.startsWith('/stores/:storeId/')).map((r) => `${r.method} ${r.path}`);

  it('walks every store route, method-ALL handlers and wildcard handlers included: each needs a scope decision in the single map', () => {
    expect(real.length).toBeGreaterThan(60);
    expect(undecided(table, ROUTE_SCOPES), 'routes with no scope decision (add them to src/core/identity/scopes.ts)').toEqual([]);
  });
  it('the walk itself flags an ALL handler without a decision for every method, an unknown wildcard, and an unmapped route', () => {
    expect(undecided([{ method: 'ALL', path: '/stores/:storeId/export' }], ROUTE_SCOPES)).toEqual(METHODS.map((m) => `${m} /stores/:storeId/export`));
    expect(undecided([{ method: 'GET', path: '/stores/:storeId/*' }], ROUTE_SCOPES)).toEqual(['GET /stores/:storeId/*']);
    expect(undecided([{ method: 'ALL', path: '/stores/:storeId/files/*' }], ROUTE_SCOPES)).toEqual(['ALL /stores/:storeId/files/*']);
    expect(undecided([{ method: 'GET', path: '/stores/:storeId/new-thing' }], ROUTE_SCOPES)).toEqual(['GET /stores/:storeId/new-thing']);
    expect(undecided([{ method: 'GET', path: '/stores/:storeId/me' }, { method: 'ALL', path: '/stores/:storeId/*' }], ROUTE_SCOPES)).toEqual([]);
  });
  it('has no stale entries, and every entry is a known scope, "any" or "person_only"', () => {
    expect(Object.keys(ROUTE_SCOPES).filter((k) => !real.includes(k)), 'map entries with no route').toEqual([]);
    for (const [k, v] of Object.entries(ROUTE_SCOPES)) expect(v === 'any' || v === 'person_only' || SCOPES.has(v), k).toBe(true);
  });
  it('never offers orders:events (unissuable), and keeps the contract\'s person-only surfaces person-only', () => {
    expect(SCOPES.has('orders:events')).toBe(false);
    for (const k of ['POST /stores/:storeId/numbers/connect', 'POST /stores/:storeId/numbers/:phoneNumberId/disconnect', 'POST /stores/:storeId/wallet/topups', 'POST /stores/:storeId/wallet/refund-requests',
      'POST /stores/:storeId/packages/:packageId/checkout', 'DELETE /stores/:storeId/contacts/:waId', 'PUT /stores/:storeId/agent', 'PUT /stores/:storeId/connectors/:connectorId', 'PATCH /stores/:storeId/store-link/settings',
      'GET /stores/:storeId/ws']) {
      expect(ROUTE_SCOPES[k], k).toBe('person_only');
    }
  });
});
