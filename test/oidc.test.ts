import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createOidcVerifier, parseOidcConfig } from '../src/core/identity/oidc';
import { IdentityError } from '../src/core/identity/verifier';

// A white-label client's own identity provider (Keycloak, Azure AD, Auth0...): RS256, its own claims and role names.
const ISS = 'https://login.client.example/realms/main';
const JWKS = `${ISS}/protocol/openid-connect/certs`;
const WS = '22222222-2222-4222-8222-222222222222';
let key: { privateKey: CryptoKey; jwk: JWK };
let other: { privateKey: CryptoKey; jwk: JWK };

beforeAll(async () => {
  const mk = async (kid: string) => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } };
  };
  key = await mk('c1');
  other = await mk('evil');
});

const fetchJwks = (async () => new Response(JSON.stringify({ keys: [key.jwk] }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

const config = parseOidcConfig(JSON.stringify({
  issuer: ISS, jwksUrl: JWKS, audience: 'wa-client',
  stores: { fixed: WS },
  role: { claim: 'realm_access.roles', owner: ['manager'], staff: ['frontdesk', 'agent'] },
  superAdmin: { claim: 'platform_role', value: 'operator' },
}));

async function token(claims: Record<string, unknown>, opts: { k?: typeof key; alg?: string; aud?: string; iss?: string; exp?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: 'kc-session', ...claims })
    .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: (opts.k ?? key).jwk.kid as string })
    .setSubject('user-42').setIssuer(opts.iss ?? ISS).setAudience(opts.aud ?? 'wa-client')
    .setIssuedAt(now).setExpirationTime(now + (opts.exp ?? 300)).setJti(crypto.randomUUID())
    .sign((opts.k ?? key).privateKey);
}

async function status(p: Promise<unknown>) {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(IdentityError);
  return (e as IdentityError).status;
}

describe('generic OIDC verifier', () => {
  const v = () => createOidcVerifier(config, { fetchJwks });

  it('maps the provider\'s role names and nested claim onto the workspace', async () => {
    const p = await v().verify(await token({ realm_access: { roles: ['offline_access', 'frontdesk'] } }));
    expect(p).toMatchObject({ userId: 'user-42', sessionId: 'kc-session', stores: [{ id: WS, role: 'staff' }], superAdmin: false });
  });

  it('owner wins when the user holds both roles; super admin only for the exact value', async () => {
    const p = await v().verify(await token({ realm_access: { roles: ['agent', 'manager'] }, platform_role: 'operator' }));
    expect(p.stores).toEqual([{ id: WS, role: 'owner' }]);
    expect(p.superAdmin).toBe(true);
    const q = await v().verify(await token({ realm_access: { roles: ['manager'] }, platform_role: 'operator-ish' }));
    expect(q.superAdmin).toBe(false);
  });

  it('a user with none of the mapped roles gets no workspace access', async () => {
    const p = await v().verify(await token({ realm_access: { roles: ['offline_access'] } }));
    expect(p.stores).toEqual([]);
  });

  it('falls back to jti when the provider issues no sid', async () => {
    const now = Math.floor(Date.now() / 1000);
    const t = await new SignJWT({ realm_access: { roles: ['manager'] } }).setProtectedHeader({ alg: 'RS256', kid: 'c1' })
      .setSubject('user-42').setIssuer(ISS).setAudience('wa-client').setIssuedAt(now).setExpirationTime(now + 300).setJti('jti-1').sign(key.privateKey);
    expect((await v().verify(t)).sessionId).toBe('jti-1');
  });

  it('rejects wrong issuer, wrong audience, expired, an unknown key, and HS256 / none', async () => {
    const roles = { realm_access: { roles: ['manager'] } };
    expect(await status(v().verify(await token(roles, { iss: 'https://evil.example' })))).toBe(401);
    expect(await status(v().verify(await token(roles, { aud: 'other-app' })))).toBe(401);
    expect(await status(v().verify(await token(roles, { exp: -120 })))).toBe(401);
    expect(await status(v().verify(await token(roles, { k: other })))).toBe(401);
    const hs = await new SignJWT(roles).setProtectedHeader({ alg: 'HS256', kid: 'c1' }).setSubject('u').setIssuer(ISS).setAudience('wa-client').setIssuedAt().setExpirationTime('5m')
      .sign(new TextEncoder().encode(JSON.stringify(key.jwk)));
    expect(await status(v().verify(hs))).toBe(401);
    const none = `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa(JSON.stringify({ sub: 'u', iss: ISS, aud: 'wa-client', exp: 9e9 }))}.`;
    expect(await status(v().verify(none))).toBe(401);
  });

  it('refuses a config that is not https, allows a symmetric algorithm, or maps nothing', () => {
    const base = { issuer: ISS, jwksUrl: JWKS, audience: 'a', stores: { fixed: WS }, role: { claim: 'roles', owner: ['o'], staff: [] } };
    expect(() => parseOidcConfig(JSON.stringify({ ...base, jwksUrl: 'http://login.client.example/certs' }))).toThrow();
    expect(() => parseOidcConfig(JSON.stringify({ ...base, algorithms: ['HS256'] }))).toThrow();
    expect(() => parseOidcConfig(JSON.stringify({ ...base, role: { claim: 'roles', owner: [], staff: [] } }))).toThrow();
    expect(() => parseOidcConfig('not json')).toThrow();
    expect(parseOidcConfig(JSON.stringify(base)).algorithms).toEqual(['RS256', 'ES256']);
  });

  const WS2 = '33333333-3333-4333-8333-333333333333';
  const claimCfg = () => parseOidcConfig(JSON.stringify({ issuer: ISS, jwksUrl: JWKS, audience: 'wa-client', stores: { claim: 'tenants' }, role: { claim: 'roles', owner: ['manager'], staff: ['agent'] } }));

  it('claim mode: a role per workspace, so an owner of one is not an owner of another', async () => {
    const p = await createOidcVerifier(claimCfg(), { fetchJwks }).verify(await token({ tenants: [{ id: WS, role: 'manager' }, { id: WS2, role: 'agent' }, { id: 'not-a-uuid', role: 'manager' }, { id: WS2.replace('3333', '4444'), role: 'guest' }] }));
    expect(p.stores).toEqual([{ id: WS, role: 'owner' }, { id: WS2, role: 'staff' }]);
  });

  it('claim mode: a plain list with the global role only when it names exactly one workspace', async () => {
    const one = await createOidcVerifier(claimCfg(), { fetchJwks }).verify(await token({ tenants: [WS], roles: 'manager' }));
    expect(one.stores).toEqual([{ id: WS, role: 'owner' }]);
    const many = await createOidcVerifier(claimCfg(), { fetchJwks }).verify(await token({ tenants: [WS, WS2], roles: 'manager' }));
    expect(many.stores).toEqual([]);
  });

  it('refuses an ID token presented as an access token, and checks typ when configured', async () => {
    const roles = { realm_access: { roles: ['manager'] } };
    expect(await status(v().verify(await token({ ...roles, nonce: 'n-1' })))).toBe(401);
    expect(await status(v().verify(await token({ ...roles, at_hash: 'h' })))).toBe(401);
    const typed = createOidcVerifier(parseOidcConfig(JSON.stringify({ issuer: ISS, jwksUrl: JWKS, audience: 'wa-client', tokenType: 'at+jwt', stores: { fixed: WS }, role: { claim: 'realm_access.roles', owner: ['manager'], staff: [] } })), { fetchJwks });
    expect(await status(typed.verify(await token(roles)))).toBe(401); // no typ header
  });
});
