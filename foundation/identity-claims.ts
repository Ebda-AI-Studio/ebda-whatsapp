/**
 * Identity claims shared by Store and Chat: who a verified access token says is calling. Brand-neutral: any identity provider
 * (the suite accounts service or a tenant's own OIDC) maps to `Principal`. Types, the error and pure claim helpers only; signature
 * verification stays in each product (it needs its own JWKS/fetch).
 */
export type Principal = {
  userId: string;
  sessionId: string;
  stores: { id: string; role: 'owner' | 'staff' }[];
  superAdmin: boolean;
  /** When the access token expires (epoch seconds). Long-lived connections must not outlive it. */
  expiresAt: number;
  /** Set only for an integrator server token (identity contract v1.3 r2): a merchant's own server, never a person. */
  integration?: { clientId: string; jti: string; scopes: string[] };
};

export class IdentityError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
  }
}

export interface IdentityVerifier {
  /** Resolves the principal or throws IdentityError(401). `integratorTokens` is the deployment's switch (default false: client tokens refused). */
  verify(token: string, opts?: { integratorTokens?: boolean }): Promise<Principal>;
}

/** A claim by name or dotted path (`a.b.c`); undefined when any step is not an object. */
export function claimAt(payload: Record<string, unknown>, path: string): unknown {
  let cur: unknown = payload;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** A claim that may be one string or an array of strings, as a list. */
export const claimStrings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Owner wins over staff; null when the names map to neither. */
export function mapRole(names: string[], roles: { owner: readonly string[]; staff: readonly string[] }): 'owner' | 'staff' | null {
  return names.some((r) => roles.owner.includes(r)) ? 'owner' : names.some((r) => roles.staff.includes(r)) ? 'staff' : null;
}

/** An ID token (meant for a browser) is never an API credential, even when its audience matches. */
export const isIdToken = (payload: Record<string, unknown>): boolean => payload.nonce !== undefined || payload.at_hash !== undefined;
