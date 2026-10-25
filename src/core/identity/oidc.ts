import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { IdentityError, type IdentityVerifier, type Principal } from './verifier';

/**
 * A generic OpenID Connect access-token verifier for white-label tenants that bring their own identity provider. Everything
 * provider-specific is data (issuer, JWKS, audience, claim paths, role names), validated once at boot; asymmetric
 * signatures only.
 */
const ASYMMETRIC = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'EdDSA'] as const;
const https = z.string().url().refine((u) => u.startsWith('https://'), 'must be https');
const claimPath = z.string().regex(/^[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*$/, 'a claim name or dotted path');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const oidcConfig = z.object({
  issuer: https,
  jwksUrl: https,
  audience: z.string().min(1),
  algorithms: z.array(z.enum(ASYMMETRIC)).min(1).default(['RS256', 'ES256']),
  userIdClaim: claimPath.default('sub'),
  /** Providers without `sid` fall back to the token id. */
  sessionIdClaim: claimPath.default('sid'),
  /** One workspace for the whole tenant (the usual white-label case), or the workspace ids carried in a claim. */
  stores: z.union([z.object({ fixed: z.string().regex(UUID) }), z.object({ claim: claimPath })]),
  /** The provider's role names that mean owner / staff; the claim may hold a string or an array. Owner wins over staff. */
  role: z.object({ claim: claimPath, owner: z.array(z.string().min(1)).max(20), staff: z.array(z.string().min(1)).max(20) })
    .refine((r) => r.owner.length + r.staff.length > 0, 'map at least one role'),
  superAdmin: z.object({ claim: claimPath, value: z.string().min(1) }).optional(),
  maxTokenAge: z.string().regex(/^\d+[smh]$/).default('1h'),
});
export type OidcConfig = z.infer<typeof oidcConfig>;

/** Parses IDENTITY_OIDC_CONFIG (JSON). Throws with the reason: a broken identity config must stop the Worker, not let anyone in. */
export function parseOidcConfig(json: string): OidcConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('IDENTITY_OIDC_CONFIG is not valid JSON');
  }
  const parsed = oidcConfig.safeParse(raw);
  if (!parsed.success) throw new Error(`IDENTITY_OIDC_CONFIG is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

function claimAt(payload: JWTPayload, path: string): unknown {
  let cur: unknown = payload;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
const asStrings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const JWKS_CACHE_MS = 10 * 60 * 1000;
const JWKS_COOLDOWN_MS = 5 * 1000;
const CLOCK_SKEW_S = 60;

export function createOidcVerifier(cfg: OidcConfig, opts: { fetchJwks?: typeof fetch } = {}): IdentityVerifier {
  const jwks = createRemoteJWKSet(new URL(cfg.jwksUrl), {
    cacheMaxAge: JWKS_CACHE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    ...(opts.fetchJwks ? { [customFetch]: opts.fetchJwks } : {}),
  });
  return {
    async verify(token: string): Promise<Principal> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          algorithms: [...cfg.algorithms],
          issuer: cfg.issuer,
          audience: cfg.audience,
          clockTolerance: CLOCK_SKEW_S,
          requiredClaims: ['exp', 'iat'],
          maxTokenAge: cfg.maxTokenAge,
        }));
      } catch {
        throw new IdentityError(401, 'invalid token');
      }
      const userId = claimAt(payload, cfg.userIdClaim);
      const sessionId = claimAt(payload, cfg.sessionIdClaim) ?? payload.jti;
      if (typeof userId !== 'string' || !userId || typeof sessionId !== 'string' || !sessionId) throw new IdentityError(401, 'invalid claims');

      const held = asStrings(claimAt(payload, cfg.role.claim));
      const role = held.some((r) => cfg.role.owner.includes(r)) ? 'owner' : held.some((r) => cfg.role.staff.includes(r)) ? 'staff' : null;
      const ids = 'fixed' in cfg.stores ? [cfg.stores.fixed] : asStrings(claimAt(payload, cfg.stores.claim)).filter((id) => UUID.test(id));
      const superAdmin = cfg.superAdmin ? asStrings(claimAt(payload, cfg.superAdmin.claim)).includes(cfg.superAdmin.value) : false;
      return { userId, sessionId, stores: role ? ids.map((id) => ({ id: id.toLowerCase(), role })) : [], superAdmin, expiresAt: Number(payload.exp) };
    },
  };
}
