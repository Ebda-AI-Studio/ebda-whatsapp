import { SELF } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { JWKS_COOLDOWN_MS, createEbdaAccountsVerifier } from '../src/addons/ebda/identity';
import { IdentityError } from '../src/core/identity/verifier';
import { ISSUER, JWKS_URL, jwksServer, mint, newKey, type TestKey } from './helpers/issuer';

const STORE = '11111111-1111-4111-8111-111111111111';
let k1: TestKey;
beforeAll(async () => {
  k1 = await newKey('k1');
});

function verifierWith(keys: TestKey[]) {
  const server = jwksServer(keys);
  return { server, verifier: createEbdaAccountsVerifier({ jwksUrl: JWKS_URL, issuer: ISSUER, audience: 'whatsapp', fetchJwks: server.fetchJwks }) };
}

async function rejects(p: Promise<unknown>, status: number) {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(IdentityError);
  expect((err as IdentityError).status).toBe(status);
}

describe('EbdaAccountsVerifier', () => {
  it('accepts a valid token and returns the principal', async () => {
    const { verifier } = verifierWith([k1]);
    const p = await verifier.verify(await mint(k1, { stores: [{ id: STORE, role: 'owner' }] }));
    expect(p).toEqual({ userId: '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f', sessionId: 'sess-1', stores: [{ id: STORE, role: 'owner' }], superAdmin: false });
  });
  it('rejects HS256 (alg confusion)', async () => {
    const { verifier } = verifierWith([k1]);
    const forged = await new SignJWT({ sid: 's', stores: [] }).setProtectedHeader({ alg: 'HS256', kid: 'k1', typ: 'at+jwt' })
      .setSubject('6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f').setIssuer(ISSUER).setAudience('whatsapp').setIssuedAt().setExpirationTime('10m')
      .sign(new TextEncoder().encode(JSON.stringify(k1.jwk)));
    await rejects(verifier.verify(forged), 401);
  });
  it('rejects alg none', async () => {
    const { verifier } = verifierWith([k1]);
    const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const now = Math.floor(Date.now() / 1000);
    const token = `${enc({ alg: 'none', typ: 'at+jwt' })}.${enc({ sub: 'x', iss: ISSUER, aud: 'whatsapp', exp: now + 600, sid: 's', stores: [] })}.`;
    await rejects(verifier.verify(token), 401);
  });
  it('rejects a wrong issuer', async () => {
    const { verifier } = verifierWith([k1]);
    await rejects(verifier.verify(await mint(k1, { iss: 'https://evil.example' })), 401);
  });
  it('rejects a wrong audience (store)', async () => {
    const { verifier } = verifierWith([k1]);
    await rejects(verifier.verify(await mint(k1, { aud: 'store' })), 401);
  });
  it('rejects an expired token beyond 60 s skew', async () => {
    const { verifier } = verifierWith([k1]);
    await rejects(verifier.verify(await mint(k1, {}, { iatOffset: -1000, expSeconds: 900 })), 401);
  });
  it('accepts 30 s clock skew', async () => {
    const { verifier } = verifierWith([k1]);
    await expect(verifier.verify(await mint(k1, {}, { iatOffset: -930, expSeconds: 900 }))).resolves.toBeTruthy();
  });
  it('rejects a token without the at+jwt type', async () => {
    const { verifier } = verifierWith([k1]);
    await rejects(verifier.verify(await mint(k1, {}, { typ: 'JWT' })), 401);
  });
  it('refetches once on unknown kid and not again for a garbage kid within the cooldown', async () => {
    const { verifier, server } = verifierWith([k1]);
    await verifier.verify(await mint(k1));
    expect(server.state.fetches).toBe(1);
    const k2 = await newKey('k2');
    server.state.keys = [k1, k2];
    const token2 = await mint(k2);
    vi.useFakeTimers({ now: Date.now() + JWKS_COOLDOWN_MS + 1000, toFake: ['Date'] });
    await verifier.verify(token2);
    expect(server.state.fetches).toBe(2);
    const k3 = await newKey('k3');
    const token3 = await mint(k3);
    await rejects(verifier.verify(token3), 401);
    vi.useRealTimers();
    expect(server.state.fetches).toBe(2);
  });
});

describe('GET /api/v1/stores/:storeId/me', () => {
  function stubJwks(keys: TestKey[]) {
    const real = globalThis.fetch;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === JWKS_URL) return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), { headers: { 'content-type': 'application/json' } });
      return real(input, init);
    });
  }
  const get = (token?: string, store = STORE) =>
    SELF.fetch(`https://x/api/v1/stores/${store}/me`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

  it('is 401 without a token', async () => {
    expect((await get()).status).toBe(401);
  });
  it('is 403 when the store is not in the token', async () => {
    stubJwks([k1]);
    expect((await get(await mint(k1, { stores: [{ id: '22222222-2222-4222-8222-222222222222', role: 'owner' }] }))).status).toBe(403);
  });
  it('is 200 for a member of the store', async () => {
    stubJwks([k1]);
    const r = await get(await mint(k1, { stores: [{ id: STORE, role: 'staff' }] }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ storeId: STORE, role: 'staff' });
  });
  it('is 200 for a super admin on any store', async () => {
    stubJwks([k1]);
    expect((await get(await mint(k1, { pa: 'super_admin' }))).status).toBe(200);
  });
});
