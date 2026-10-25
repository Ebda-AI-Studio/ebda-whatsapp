import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenProvider, decodeStores, decodeSub } from './auth';

const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: object) => `${b64({ alg: 'ES256', typ: 'at+jwt' })}.${b64(claims)}.sig`;

afterEach(() => vi.restoreAllMocks());

describe('token provider (identity v1)', () => {
  it('fetches a whatsapp-audience token with credentials and caches it until a minute before expiry', async () => {
    let n = 0;
    const f = vi.fn(async () => { n++; return new Response(JSON.stringify({ access_token: jwt({ n }), expires_in: 900 }), { status: 200 }); });
    const p = createTokenProvider({ accountsUrl: 'https://accounts.ebda.app', fetchImpl: f as unknown as typeof fetch, now: () => 0, redirect: vi.fn() });
    const a = await p.getToken();
    const b = await p.getToken();
    expect(a).toBe(b);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]).toEqual(['https://accounts.ebda.app/token?aud=whatsapp', { credentials: 'include' }]);
  });

  it('refreshes after the cached token is within a minute of expiry', async () => {
    let t = 0;
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: jwt({}), expires_in: 900 }), { status: 200 }));
    const p = createTokenProvider({ accountsUrl: 'https://accounts.ebda.app', fetchImpl: f as unknown as typeof fetch, now: () => t, redirect: vi.fn() });
    await p.getToken();
    t = 841_000;
    await p.getToken();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('sends a signed-out user to the accounts login with a return URL', async () => {
    const redirect = vi.fn();
    const f = vi.fn(async () => new Response('', { status: 401 }));
    const p = createTokenProvider({ accountsUrl: 'https://accounts.ebda.app', fetchImpl: f as unknown as typeof fetch, now: () => 0, redirect, currentUrl: () => 'https://wa.ebda.app/?store=s1' });
    await expect(p.getToken()).rejects.toThrow(/signed out/);
    expect(redirect).toHaveBeenCalledWith('https://accounts.ebda.app/login?return=https%3A%2F%2Fwa.ebda.app%2F%3Fstore%3Ds1');
  });

  it('reads the stores claim for the store picker (display only; the server verifies)', () => {
    expect(decodeStores(jwt({ stores: [{ id: 's1', role: 'owner' }] }))).toEqual([{ id: 's1', role: 'owner' }]);
    expect(decodeStores('garbage')).toEqual([]);
  });

  it('reads the user id (sub)', () => {
    expect(decodeSub(jwt({ sub: 'u-1' }))).toBe('u-1');
    expect(decodeSub('x')).toBeNull();
  });
});
