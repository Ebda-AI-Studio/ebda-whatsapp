import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { IdentityError, type IdentityVerifier, type Principal } from '../../core/identity/verifier';

// Identity contract v1 (business/ebda/plans/2026-10-24-ebda-identity-token-contract.md).
const JWKS_CACHE_MS = 10 * 60 * 1000;
// Bounds how often an unknown kid can trigger a refetch (one per 5 s per isolate).
export const JWKS_COOLDOWN_MS = 5 * 1000;
const CLOCK_SKEW_S = 60;
// Access tokens live 15 minutes; one extra minute covers skew.
const MAX_TOKEN_AGE = '16m';

const claimsSchema = z.object({
  sub: z.string().uuid(),
  sid: z.string().min(1),
  aud: z.string(), // one audience per token (contract v1); an array is rejected
  stores: z.array(z.object({ id: z.string().uuid(), role: z.enum(['owner', 'staff']) })),
  pa: z.string().optional(), // only "super_admin" grants anything; unknown values are ignored
});

export function createEbdaAccountsVerifier(opts: { jwksUrl: string; issuer: string; audience: string; fetchJwks?: typeof fetch }): IdentityVerifier {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl), {
    cacheMaxAge: JWKS_CACHE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    ...(opts.fetchJwks ? { [customFetch]: opts.fetchJwks } : {}),
  });
  return {
    async verify(token: string): Promise<Principal> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          algorithms: ['ES256'],
          issuer: opts.issuer,
          audience: opts.audience,
          clockTolerance: CLOCK_SKEW_S,
          typ: 'at+jwt',
          requiredClaims: ['exp', 'iat', 'sub', 'sid', 'jti'],
          maxTokenAge: MAX_TOKEN_AGE,
        }));
      } catch {
        throw new IdentityError(401, 'invalid token');
      }
      const c = claimsSchema.safeParse(payload);
      if (!c.success) throw new IdentityError(401, 'invalid claims');
      return { userId: c.data.sub, sessionId: c.data.sid, stores: c.data.stores, superAdmin: c.data.pa === 'super_admin', expiresAt: Number(payload.exp) };
    },
  };
}
