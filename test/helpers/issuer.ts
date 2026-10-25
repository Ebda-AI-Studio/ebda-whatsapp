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
