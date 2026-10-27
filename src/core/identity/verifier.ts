/** Who is calling, as proven by a verified access token. Brand-neutral: any identity provider maps to this. */
export type Principal = {
  userId: string;
  sessionId: string;
  stores: { id: string; role: 'owner' | 'staff' }[];
  superAdmin: boolean;
  /** When the access token expires (epoch seconds). Long-lived connections must not outlive it. */
  expiresAt: number;
  /** Set only for an integrator server token (identity contract v1.3 r2): a merchant's own server, never a person. */
  integration?: { clientId: string; jti: string; scopes: string[]; /** When the token was issued (epoch seconds): a revoke-all refuses every token issued at or before it. */ issuedAt: number };
};

export class IdentityError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
  }
}

export interface IdentityVerifier {
  /**
   * Resolves the principal or throws IdentityError(401). `integratorTokens` is the deployment's switch: while it is false (the default)
   * any client token (`client` claim or role "integration") is refused.
   */
  verify(token: string, opts?: { integratorTokens?: boolean }): Promise<Principal>;
}
