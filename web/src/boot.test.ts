import { describe, expect, it } from 'vitest';
import { accountsUrlFor, chooseMode, pickStore, signInMode } from './boot';

describe('boot', () => {
  it('a production build always runs live, even with ?sample=1', () => {
    expect(chooseMode({ dev: false }, '?sample=1')).toBe('live');
    expect(chooseMode({ dev: false }, '')).toBe('live');
  });
  it('the dev server defaults to labelled sample data; ?live=1 opts into the API', () => {
    expect(chooseMode({ dev: true }, '')).toBe('sample');
    expect(chooseMode({ dev: true }, '?live=1')).toBe('live');
  });
  it('picks the store from ?store= only if the token lists it, else the first store', () => {
    const stores = [{ id: 'a', role: 'owner' as const }, { id: 'b', role: 'staff' as const }];
    expect(pickStore(stores, '?store=b')).toBe('b');
    expect(pickStore(stores, '?store=zzz')).toBe('a');
    expect(pickStore([], '')).toBeNull();
  });
});

describe('sign-in address', () => {
  it('the build-time override wins, then the brand\'s own; none at all is null (the page then says sign-in is not configured, not a blank screen)', () => {
    expect(accountsUrlFor('https://login.example', 'https://brand.example')).toBe('https://login.example');
    expect(accountsUrlFor(undefined, 'https://brand.example')).toBe('https://brand.example');
    expect(accountsUrlFor('', null)).toBeNull();
    expect(accountsUrlFor(undefined, null)).toBeNull();
  });
});

describe('which sign-in this build uses', () => {
  const oidc = { issuer: 'https://login.client.example', clientId: 'c' };
  it('accounts service, own OIDC provider, or none (never a blank page)', () => {
    expect(signInMode('https://accounts.example', null)).toBe('accounts');
    expect(signInMode(null, oidc)).toBe('oidc');
    expect(signInMode(null, null)).toBe('none');
    expect(signInMode(null, undefined)).toBe('none');
  });
  it('a brand that names both is a configuration error, not a silent pick', () => {
    expect(() => signInMode('https://accounts.example', oidc)).toThrow(/one sign-in/);
  });
});
