/** Who is calling, as proven by a verified access token. Brand-neutral: any identity provider maps to this. */
export type Principal = {
  userId: string;
  sessionId: string;
  stores: { id: string; role: 'owner' | 'staff' }[];
  superAdmin: boolean;
};

export class IdentityError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
  }
}

export interface IdentityVerifier {
  /** Resolves the principal or throws IdentityError(401). */
  verify(token: string): Promise<Principal>;
}
