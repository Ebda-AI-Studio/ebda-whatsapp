import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { createOidcVerifier, parseOidcConfig } from '../src/core/identity/oidc';
import { requireStoreAccess, requireSuperAdmin, type AuthVars } from '../src/core/identity/middleware';

// The browser sends the ACCESS token it got from the tenant's provider. These tests run it through the real bearer middleware (the same
// one src/index.ts mounts) with a test issuer, so "access token in, ID token out" is proven at the HTTP edge and not only in the verifier.
const ISS = 'https://login.client.example/realms/main';
const WS = '22222222-2222-4222-8222-222222222222';
let key: { privateKey: CryptoKey; jwk: JWK };
beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  key = { privateKey, jwk: { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' } };
});

const cfg = parseOidcConfig(JSON.stringify({
  issuer: ISS, jwksUrl: `${ISS}/protocol/openid-connect/certs`, audience: 'wa-api', stores: { fixed: WS },
  role: { claim: 'realm_access.roles', owner: ['manager'], staff: ['agent'] }, superAdmin: { claim: 'platform_role', value: 'operator' },
}));
const fetchJwks = (async () => new Response(JSON.stringify({ keys: [key.jwk] }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

const app = () => {
  const verifier = createOidcVerifier(cfg, { fetchJwks });
  const a = new Hono<{ Bindings: Env; Variables: AuthVars }>();
  a.use('/stores/:storeId/*', requireStoreAccess(() => verifier));
  a.use('/operator/*', requireSuperAdmin(() => verifier));
  a.get('/stores/:storeId/ping', (c) => c.json({ role: c.get('storeRole') }));
  a.get('/operator/ping', (c) => c.json({ ok: true }));
  return a;
};

async function mint(claims: Record<string, unknown>, aud = 'wa-api') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: 's1', realm_access: { roles: ['manager'] }, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('u1').setIssuer(ISS).setAudience(aud)
    .setIssuedAt(now).setExpirationTime(now + 300).setJti(crypto.randomUUID()).sign(key.privateKey);
}
const call = (path: string, token: string) => app().request(path, { headers: { authorization: `Bearer ${token}` } });

describe('OIDC tenant: what the browser sends', () => {
  it('an access token from the tenant\'s issuer passes on a store route', async () => {
    const r = await call(`/stores/${WS}/ping`, await mint({}));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ role: 'owner' });
  });
  it('the ID token of the same sign-in (nonce / at_hash, audience = the web client) is refused', async () => {
    expect((await call(`/stores/${WS}/ping`, await mint({ nonce: 'n-1' }, 'wa-api'))).status).toBe(401);
    expect((await call(`/stores/${WS}/ping`, await mint({ at_hash: 'abc' }, 'wa-api'))).status).toBe(401);
    expect((await call(`/stores/${WS}/ping`, await mint({ nonce: 'n-1' }, 'wa-web'))).status).toBe(401); // client audience: wrong audience as well
  });
  it('an access token cannot reach another workspace, and a non-operator cannot reach operator routes', async () => {
    expect((await call('/stores/33333333-3333-4333-8333-333333333333/ping', await mint({}))).status).toBe(403);
    expect((await call('/operator/ping', await mint({}))).status).toBe(403);
    expect((await call('/operator/ping', await mint({ platform_role: 'operator' }))).status).toBe(200);
  });
});
