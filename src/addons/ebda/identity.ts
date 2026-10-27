import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { WHATSAPP_SCOPES } from '../../core/identity/scopes';
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

// Integrator server token (identity contract v1.3 r2). Strict: sub = sid = the client id, exactly one store with role "integration", `client: true`,
// a scope, and no person claim at all.
const clientClaimsSchema = z.object({
  sub: z.string().regex(/^cli_[A-Za-z0-9]{10,64}$/),
  sid: z.string(),
  aud: z.string(),
  jti: z.string().min(1),
  stores: z.array(z.object({ id: z.string().uuid(), role: z.literal('integration') })).length(1),
  scope: z.string().min(1).max(500),
  client: z.literal(true),
}).refine((c) => c.sid === c.sub);
const PERSON_ONLY_CLAIMS = ['pa', 'auth_time', 'email'] as const;

export function createEbdaAccountsVerifier(opts: { jwksUrl: string; issuer: string; audience: string; fetchJwks?: typeof fetch }): IdentityVerifier {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl), {
    cacheMaxAge: JWKS_CACHE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    ...(opts.fetchJwks ? { [customFetch]: opts.fetchJwks } : {}),
  });
  return {
    async verify(token: string, vopts?: { integratorTokens?: boolean }): Promise<Principal> {
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
      // A client token is recognised by its marker claims, never by the shape that happens to parse. Anything that looks like one but is not
      // exactly one is refused, and so is every client token while the switch is off.
      const looksLikeClient = payload.client !== undefined || (Array.isArray(payload.stores) && payload.stores.some((s) => (s as { role?: unknown })?.role === 'integration'));
      if (looksLikeClient) {
        if (!vopts?.integratorTokens) throw new IdentityError(401, 'client tokens are not enabled');
        const k = clientClaimsSchema.safeParse(payload);
        if (!k.success || PERSON_ONLY_CLAIMS.some((n) => n in payload)) throw new IdentityError(401, 'invalid claims');
        const scopes = k.data.scope.split(' ').filter((x): x is (typeof WHATSAPP_SCOPES)[number] => (WHATSAPP_SCOPES as readonly string[]).includes(x));
        if (scopes.length === 0) throw new IdentityError(401, 'no usable scope');
        // Mapped to the store's staff level for the handlers behind the gate; the route map (scopes.ts) is what limits it, never this role.
        return { userId: k.data.sub, sessionId: k.data.sid, stores: [{ id: k.data.stores[0]!.id, role: 'staff' }], superAdmin: false, expiresAt: Number(payload.exp), integration: { clientId: k.data.sub, jti: k.data.jti, scopes } };
      }
      const c = claimsSchema.safeParse(payload);
      if (!c.success) throw new IdentityError(401, 'invalid claims');
      return { userId: c.data.sub, sessionId: c.data.sid, stores: c.data.stores, superAdmin: c.data.pa === 'super_admin', expiresAt: Number(payload.exp) };
    },
  };
}
