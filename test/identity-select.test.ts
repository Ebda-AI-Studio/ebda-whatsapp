import { describe, expect, it } from 'vitest';
import { selectVerifier } from '../src/identity-select';

const base = { IDENTITY_ISSUER: 'https://accounts.ebda.app', IDENTITY_JWKS_URL: 'https://accounts.ebda.app/.well-known/jwks.json', IDENTITY_AUDIENCE: 'whatsapp' };
const oidc = JSON.stringify({ issuer: 'https://login.client.example', jwksUrl: 'https://login.client.example/certs', audience: 'wa', stores: { fixed: '22222222-2222-4222-8222-222222222222' }, role: { claim: 'roles', owner: ['manager'], staff: [] } });

describe('identity mode', () => {
  it('defaults to the suite accounts service', () => {
    expect(selectVerifier(base).mode).toBe('ebda');
  });
  it('uses the tenant\'s own provider when IDENTITY_MODE=oidc', () => {
    expect(selectVerifier({ ...base, IDENTITY_MODE: 'oidc', IDENTITY_OIDC_CONFIG: oidc }).mode).toBe('oidc');
  });
  it('fails loud on oidc without a valid config, and on an unknown mode', () => {
    expect(() => selectVerifier({ ...base, IDENTITY_MODE: 'oidc' })).toThrow(/IDENTITY_OIDC_CONFIG/);
    expect(() => selectVerifier({ ...base, IDENTITY_MODE: 'oidc', IDENTITY_OIDC_CONFIG: '{}' })).toThrow(/invalid/);
    expect(() => selectVerifier({ ...base, IDENTITY_MODE: 'saml' })).toThrow(/IDENTITY_MODE/);
  });
});
