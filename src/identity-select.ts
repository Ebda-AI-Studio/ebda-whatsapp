import { createEbdaAccountsVerifier } from './addons/ebda/identity';
import { createOidcVerifier, parseOidcConfig } from './core/identity/oidc';
import type { IdentityVerifier } from './core/identity/verifier';

type IdentityEnv = { IDENTITY_ISSUER: string; IDENTITY_JWKS_URL: string; IDENTITY_AUDIENCE: string; IDENTITY_MODE?: string; IDENTITY_OIDC_CONFIG?: string };

/**
 * Which identity provider this deployment trusts: `ebda` (default, accounts.ebda.app, contract v1) or `oidc` (a white-label
 * tenant's own provider, configured by IDENTITY_OIDC_CONFIG). A missing or broken config throws: no request is served unverified.
 */
export function selectVerifier(env: IdentityEnv): { mode: 'ebda' | 'oidc'; verifier: IdentityVerifier } {
  const mode = env.IDENTITY_MODE ?? 'ebda';
  if (mode === 'ebda') return { mode, verifier: createEbdaAccountsVerifier({ jwksUrl: env.IDENTITY_JWKS_URL, issuer: env.IDENTITY_ISSUER, audience: env.IDENTITY_AUDIENCE }) };
  if (mode === 'oidc') {
    if (!env.IDENTITY_OIDC_CONFIG) throw new Error('IDENTITY_MODE=oidc needs IDENTITY_OIDC_CONFIG');
    return { mode, verifier: createOidcVerifier(parseOidcConfig(env.IDENTITY_OIDC_CONFIG)) };
  }
  throw new Error(`IDENTITY_MODE must be "ebda" or "oidc", got "${mode}"`);
}
