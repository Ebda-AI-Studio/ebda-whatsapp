import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNED_OUT, createTokenProvider, decodeStores, decodeSub, readTokenBody } from './auth';

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

  it('reads the token out of the accounts service envelope (the body production sends)', async () => {
    const token = jwt({ sub: 'u1' });
    // Shape measured on accounts.ebda.app: { success, data: { access_token, token_type, expires_in, expires_at } }.
    const real = { success: true, data: { access_token: token, token_type: 'Bearer', expires_in: 900, expires_at: 1_800_000_900 } };
    const f = vi.fn(async () => new Response(JSON.stringify(real), { status: 200 }));
    let t = 0;
    const redirect = vi.fn();
    const p = createTokenProvider({ accountsUrl: 'https://accounts.ebda.app', fetchImpl: f as unknown as typeof fetch, now: () => t, redirect });
    expect(await p.getToken()).toBe(token);
    t = 838_000;
    expect(await p.getToken()).toBe(token);
    expect(f).toHaveBeenCalledTimes(1);
    t = 841_000;
    await p.getToken();
    expect(f).toHaveBeenCalledTimes(2);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('refuses a 200 that carries no usable token, in or out of the envelope', () => {
    expect(readTokenBody({ access_token: 'a.b.c', expires_in: 900 })).toEqual({ access_token: 'a.b.c', expires_in: 900 });
    expect(readTokenBody({ success: true, data: { access_token: 'a.b.c', expires_in: 900 } })).toEqual({ access_token: 'a.b.c', expires_in: 900 });
    for (const bad of [null, 'x', {}, { success: true }, { success: true, data: {} }, { success: true, data: { access_token: '', expires_in: 900 } }, { data: { access_token: 'a.b.c', expires_in: '900' } }, { access_token: 'a.b.c', expires_in: 0 }, { success: false, error: { code: 'X' } }]) {
      expect(readTokenBody(bad)).toBeNull();
    }
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

  it('names the product in the login address when the brand has one, so the sign-in page can say Ebda Chat and return here', async () => {
    const redirect = vi.fn();
    const f = vi.fn(async () => new Response('', { status: 401 }));
    const p = createTokenProvider({ accountsUrl: 'https://accounts.ebda.app', product: 'chat', fetchImpl: f as unknown as typeof fetch, now: () => 0, redirect, currentUrl: () => 'https://wa.ebda.app/' });
    await expect(p.getToken()).rejects.toThrow(SIGNED_OUT);
    expect(redirect).toHaveBeenCalledWith('https://accounts.ebda.app/login?product=chat&return=https%3A%2F%2Fwa.ebda.app%2F');
  });

  it('a non-401 answer is an unreachable service, not a signed-out person (no redirect)', async () => {
    const redirect = vi.fn();
    const f = vi.fn(async () => new Response('', { status: 503 }));
    const p = createTokenProvider({ accountsUrl: 'https://accounts.ebda.app', fetchImpl: f as unknown as typeof fetch, now: () => 0, redirect });
    const err = await p.getToken().catch((e: Error) => e);
    expect((err as Error).message).not.toBe(SIGNED_OUT);
    expect(redirect).not.toHaveBeenCalled();
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
