import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

export const ISSUER = 'https://accounts.ebda.app';
export const JWKS_URL = 'https://accounts.ebda.app/.well-known/jwks.json';

export type TestKey = { kid: string; privateKey: CryptoKey; jwk: JWK };

export async function newKey(kid: string): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  return { kid, privateKey, jwk };
}

export type Claims = { sub?: string; sid?: string; aud?: string; iss?: string; stores?: { id: string; role: 'owner' | 'staff' }[]; pa?: string };

export async function mint(key: TestKey, claims: Claims = {}, opts: { expSeconds?: number; iatOffset?: number; typ?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000) + (opts.iatOffset ?? 0);
  const { aud = 'whatsapp', iss = ISSUER, ...rest } = claims;
  return new SignJWT({ sid: 'sess-1', stores: [], ...rest })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: opts.typ ?? 'at+jwt' })
    .setSubject(claims.sub ?? '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f')
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + (opts.expSeconds ?? 900))
    .setJti(crypto.randomUUID())
    .sign(key.privateKey);
}

/** A JWKS endpoint stub that counts fetches; `keys` can be swapped to simulate rotation. */
export function jwksServer(initial: TestKey[]) {
  const state = { keys: initial, fetches: 0 };
  const fetchJwks = (async () => {
    state.fetches++;
    return new Response(JSON.stringify({ keys: state.keys.map((k) => k.jwk) }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { state, fetchJwks };
}

export type ClientClaims = {
  clientId?: string; storeId: string; scope?: string; aud?: string; iss?: string;
  /** Claims to add (pa, auth_time, email...) or override. */
  extra?: Record<string, unknown>;
  /** Claims to leave out (client, scope...). */
  omit?: string[];
  role?: string;
};
/** An integrator token as accounts.ebda.app would mint it (identity contract v1.3 r2): sub = sid = client id, one store with role "integration", client: true. */
export async function mintClient(key: TestKey, c: ClientClaims, opts: { expSeconds?: number; typ?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const clientId = c.clientId ?? 'cli_01HZX3K9Q8T2M5N7P4R6V0W1YA';
  const claims: Record<string, unknown> = {
    sid: clientId, stores: [{ id: c.storeId, role: c.role ?? 'integration' }], scope: c.scope ?? 'conversations:read', client: true, ...(c.extra ?? {}),
  };
  for (const k of c.omit ?? []) delete claims[k];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: opts.typ ?? 'at+jwt' })
    .setSubject(clientId).setIssuer(c.iss ?? ISSUER).setAudience(c.aud ?? 'whatsapp')
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + (opts.expSeconds ?? 600)).setJti(crypto.randomUUID())
    .sign(key.privateKey);
}
