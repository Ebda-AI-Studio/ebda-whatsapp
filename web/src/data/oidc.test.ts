import { afterEach, describe, expect, it, vi } from 'vitest';
import { OidcSignInError, challengeFor, createOidcSession, pkcePair, safeReturnPath } from './oidc';

const ISS = 'https://login.client.example/realms/main';
const CLIENT = 'wa-web';
const ORIGIN = 'https://wa.client.example';
const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims: object) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;

const DISCOVERY = {
  issuer: ISS,
  authorization_endpoint: `${ISS}/protocol/openid-connect/auth`,
  token_endpoint: `${ISS}/protocol/openid-connect/token`,
  code_challenge_methods_supported: ['S256', 'plain'],
};

function memoryStorage() {
  const m = new Map<string, string>();
  const writes: string[] = [];
  return {
    api: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { writes.push(v); m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } },
    m, writes,
  };
}

/** A scripted provider: discovery, then token endpoint answers (code and refresh grants), recording every request. */
function provider(opts: { discovery?: object; token?: (body: URLSearchParams, n: number) => object; status?: number } = {}) {
  const calls: { url: string; body: URLSearchParams | null }[] = [];
  let tokenCalls = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? new URLSearchParams(String(init.body)) : null;
    calls.push({ url, body });
    if (url === `${ISS}/.well-known/openid-configuration`) return new Response(JSON.stringify(opts.discovery ?? DISCOVERY), { status: 200 });
    if (url === DISCOVERY.token_endpoint) {
      const n = ++tokenCalls;
      return new Response(JSON.stringify(opts.token ? opts.token(body!, n) : {}), { status: opts.status ?? 200 });
    }
    return new Response('nope', { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function setup(o: { cfg?: Partial<{ refresh: boolean; audience: string }>; prov?: ReturnType<typeof provider>; t?: { now: number } } = {}) {
  const session = memoryStorage();
  const redirects: string[] = [];
  const replaced: string[] = [];
  const t = o.t ?? { now: 1_000_000_000_000 };
  const prov = o.prov ?? provider();
  const s = createOidcSession({
    oidc: { issuer: ISS, clientId: CLIENT, ...o.cfg },
    origin: ORIGIN,
    fetchImpl: prov.fetchImpl,
    now: () => t.now,
    session: session.api,
    redirect: (u) => { redirects.push(u); },
    replaceUrl: (p) => { replaced.push(p); },
  });
  return { s, session, redirects, replaced, prov, t };
}

const idToken = (extra: object = {}, t = 1_000_000_000_000) =>
  jwt({ iss: ISS, aud: CLIENT, sub: 'u1', exp: Math.floor(t / 1000) + 300, ...extra });

/** Starts sign-in, then returns the callback query a provider would send back (with the nonce it was given). */
async function signInStart(h: ReturnType<typeof setup>, returnTo = '/inbox') {
  await h.s.startSignIn(returnTo);
  const url = new URL(h.redirects.at(-1)!);
  return { url, state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce')! };
}

afterEach(() => vi.restoreAllMocks());

describe('PKCE (RFC 7636)', () => {
  it('S256 challenge matches the RFC appendix B vector', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('the verifier is 43 url-safe characters from 32 random bytes, and its challenge is derived from it', async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(await challengeFor(verifier));
    expect((await pkcePair()).verifier).not.toBe(verifier);
  });
});

describe('starting sign-in', () => {
  it('redirects to the discovered authorization endpoint with code + S256, state, nonce and the exact redirect uri', async () => {
    const h = setup();
    const { url } = await signInStart(h);
    expect(`${url.origin}${url.pathname}`).toBe(DISCOVERY.authorization_endpoint);
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe(CLIENT);
    expect(q.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('scope')).toBe('openid');
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(22);
    expect(q.get('nonce')!.length).toBeGreaterThanOrEqual(22);
    expect(q.get('code_verifier')).toBeNull(); // the verifier never leaves the browser until the token call
  });
  it('asks for offline_access only when the brand allows refresh, and sends audience only when configured', async () => {
    const plain = await signInStart(setup());
    expect(plain.url.searchParams.get('scope')).not.toContain('offline_access');
    expect(plain.url.searchParams.get('audience')).toBeNull();
    const both = await signInStart(setup({ cfg: { refresh: true, audience: 'wa-api' } }));
    expect(both.url.searchParams.get('scope')).toContain('offline_access');
    expect(both.url.searchParams.get('audience')).toBe('wa-api');
  });
  it('refuses a provider whose discovery names another issuer, an http or cross-origin endpoint, or no S256', async () => {
    for (const bad of [
      { ...DISCOVERY, issuer: 'https://evil.example' },
      { ...DISCOVERY, authorization_endpoint: 'http://login.client.example/auth' },
      { ...DISCOVERY, token_endpoint: 'https://token.other.example/token' },
      { ...DISCOVERY, code_challenge_methods_supported: ['plain'] },
    ]) {
      const h = setup({ prov: provider({ discovery: bad }) });
      await expect(h.s.startSignIn('/')).rejects.toMatchObject({ code: 'discovery' });
      expect(h.redirects).toEqual([]);
    }
  });
  it('keeps only the transaction in sessionStorage, never a token', async () => {
    const h = setup();
    await signInStart(h);
    expect(h.session.writes).toHaveLength(1);
    expect(JSON.parse(h.session.writes[0]!)).toHaveProperty('verifier');
  });
});

describe('the callback', () => {
  async function complete(h: ReturnType<typeof setup>, query: (s: { state: string; nonce: string }) => string, tokenBody?: (nonce: string) => object) {
    const start = await signInStart(h);
    tokenResponder.current = (_b, _n) => tokenBody ? tokenBody(start.nonce) : { access_token: 'AT-1', token_type: 'Bearer', expires_in: 600, id_token: idToken({ nonce: start.nonce }) };
    return h.s.handleCallback(query(start));
  }
  const tokenResponder: { current: (b: URLSearchParams, n: number) => object } = { current: () => ({}) };
  const harness = (cfg: Parameters<typeof setup>[0] = {}) => setup({ ...cfg, prov: provider({ token: (b, n) => tokenResponder.current(b, n) }) });

  it('exchanges the code with the verifier, keeps the ACCESS token in memory and returns the stored path', async () => {
    const h = harness();
    const r = await complete(h, (s) => `?code=C1&state=${s.state}`);
    expect(r).toEqual({ returnTo: '/inbox' });
    const call = h.prov.calls.find((c) => c.url === DISCOVERY.token_endpoint)!;
    expect(Object.fromEntries(call.body!)).toMatchObject({ grant_type: 'authorization_code', code: 'C1', client_id: CLIENT, redirect_uri: `${ORIGIN}/auth/callback` });
    expect(call.body!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await h.s.getToken()).toBe('AT-1');
    expect(h.session.m.size).toBe(0); // the transaction is deleted at the callback
  });

  it('a state that does not match is refused and nothing is exchanged', async () => {
    const h = harness();
    await expect(complete(h, () => '?code=C1&state=forged')).rejects.toMatchObject({ code: 'state' });
    expect(h.prov.calls.some((c) => c.url === DISCOVERY.token_endpoint)).toBe(false);
  });
  it('a callback with no stored transaction (replay, other tab) is refused', async () => {
    const h = harness();
    await expect(h.s.handleCallback('?code=C1&state=x')).rejects.toMatchObject({ code: 'state' });
  });
  it('the transaction is single use: replaying the same callback fails', async () => {
    const h = harness();
    let q = '';
    await complete(h, (s) => (q = `?code=C1&state=${s.state}`));
    await expect(h.s.handleCallback(q)).rejects.toMatchObject({ code: 'state' });
  });
  it('an error response from the provider is refused with its own code', async () => {
    const h = harness();
    await expect(complete(h, (s) => `?error=access_denied&state=${s.state}`)).rejects.toMatchObject({ code: 'denied' });
  });
  it('the ID token nonce must equal the one sent; a different or missing nonce is refused', async () => {
    for (const claims of [{ nonce: 'someone-elses' }, {}]) {
      const h = harness();
      await expect(complete(h, (s) => `?code=C&state=${s.state}`, () => ({ access_token: 'AT', expires_in: 600, id_token: idToken(claims) }))).rejects.toMatchObject({ code: 'nonce' });
      await expect(h.s.getToken()).rejects.toThrow(); // nothing was kept
    }
  });
  it('refuses a token response with no ID token, and an ID token for another issuer, audience or one already expired', async () => {
    const run = (mk: (nonce: string) => object, code: string) => async () => {
      const h = harness();
      await expect(complete(h, (s) => `?code=C&state=${s.state}`, mk)).rejects.toMatchObject({ code });
    };
    await run(() => ({ access_token: 'AT', expires_in: 600 }), 'missing_id_token')();
    await run((n) => ({ access_token: 'AT', expires_in: 600, id_token: idToken({ nonce: n, iss: 'https://evil.example' }) }), 'claims')();
    await run((n) => ({ access_token: 'AT', expires_in: 600, id_token: idToken({ nonce: n, aud: 'other-client' }) }), 'claims')();
    await run((n) => ({ access_token: 'AT', expires_in: 600, id_token: idToken({ nonce: n, exp: 5 }) }), 'claims')();
  });
  it('a failed token call is a token error', async () => {
    const h = setup({ prov: provider({ status: 400, token: () => ({ error: 'invalid_grant' }) }) });
    const start = await signInStart(h);
    await expect(h.s.handleCallback(`?code=C&state=${start.state}`)).rejects.toMatchObject({ code: 'token' });
  });
  it('an open-redirect style return path is replaced by /', async () => {
    expect(safeReturnPath('//evil.example/x')).toBe('/');
    expect(safeReturnPath('https://evil.example')).toBe('/');
    expect(safeReturnPath('/\\evil.example')).toBe('/');
    expect(safeReturnPath('/auth/callback?code=1')).toBe('/');
    expect(safeReturnPath('/inbox?store=abc')).toBe('/inbox?store=abc');
  });

  describe('tokens and storage', () => {
    it('the access token and the ID token are never written to localStorage, sessionStorage or cookies', async () => {
      // Every browser store the page could reach is replaced by a recorder (localStorage, sessionStorage); cookies and IndexedDB are read/trapped too.
      const written: string[] = [];
      const recorder = () => ({ getItem: () => null, removeItem: () => {}, clear: () => {}, key: () => null, length: 0, setItem: (_k: string, v: string) => { written.push(v); } });
      vi.stubGlobal('localStorage', recorder());
      vi.stubGlobal('sessionStorage', recorder());
      const idb = vi.fn(() => { throw new Error('indexedDB must not be used'); });
      vi.stubGlobal('indexedDB', { open: idb });
      const h = harness();
      const idt = { v: '' };
      await complete(h, (s) => `?code=C&state=${s.state}`, (n) => ({ access_token: 'AT-SECRET', refresh_token: 'RT-SECRET', expires_in: 600, id_token: (idt.v = idToken({ nonce: n })) }));
      await h.s.getToken();
      const everything = [...written, ...h.session.writes, document.cookie].join('|');
      for (const secret of ['AT-SECRET', 'RT-SECRET', idt.v]) expect(everything).not.toContain(secret);
      expect(written).toEqual([]); // the injected session store is the only writer, and it saw the transaction only
      expect(idb).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
    it('the bearer is the ACCESS token, never the ID token', async () => {
      const h = harness();
      const idt = { v: '' };
      await complete(h, (s) => `?code=C&state=${s.state}`, (n) => ({ access_token: 'AT-ONLY', expires_in: 600, id_token: (idt.v = idToken({ nonce: n })) }));
      const bearer = `Bearer ${await h.s.getToken()}`;
      expect(bearer).toBe('Bearer AT-ONLY');
      expect(bearer).not.toContain(idt.v);
    });
  });

  describe('expiry and refresh', () => {
    const grant = (n: string, extra: object = {}) => ({ access_token: 'AT-1', expires_in: 600, id_token: idToken({ nonce: n }), ...extra });

    it('without a refresh grant an expired token means signing in again, not a silent call', async () => {
      const h = harness();
      await complete(h, (s) => `?code=C&state=${s.state}`, (n) => grant(n, { refresh_token: 'RT-1' })); // refresh not allowed by the brand
      h.t.now += 600_000;
      const before = h.redirects.length;
      await expect(h.s.getToken()).rejects.toThrow('signed out');
      expect(h.redirects.length).toBe(before + 1);
      expect(h.prov.calls.filter((c) => c.body?.get('grant_type') === 'refresh_token')).toHaveLength(0);
    });
    it('with refresh allowed and a refresh token issued, it refreshes in memory (grant_type=refresh_token)', async () => {
      const h = harness({ cfg: { refresh: true } });
      await complete(h, (s) => `?code=C&state=${s.state}`, (n) => grant(n, { refresh_token: 'RT-1' }));
      tokenResponder.current = () => ({ access_token: 'AT-2', expires_in: 600 });
      h.t.now += 600_000;
      expect(await h.s.getToken()).toBe('AT-2');
      const r = h.prov.calls.filter((c) => c.body?.get('grant_type') === 'refresh_token');
      expect(r).toHaveLength(1);
      expect(Object.fromEntries(r[0]!.body!)).toMatchObject({ refresh_token: 'RT-1', client_id: CLIENT });
    });
    it('a failed refresh falls back to signing in again', async () => {
      const h = harness({ cfg: { refresh: true } });
      await complete(h, (s) => `?code=C&state=${s.state}`, (n) => grant(n, { refresh_token: 'RT-1' }));
      tokenResponder.current = () => { throw new Error('boom'); };
      h.t.now += 600_000;
      const before = h.redirects.length;
      await expect(h.s.getToken()).rejects.toThrow('signed out');
      expect(h.redirects.length).toBe(before + 1);
    });
    it('a token still fresh is returned without any call', async () => {
      const h = harness();
      await complete(h, (s) => `?code=C&state=${s.state}`);
      const n = h.prov.calls.length;
      await h.s.getToken();
      expect(h.prov.calls.length).toBe(n);
    });
  });
});

describe('signed out', () => {
  it('getToken with no token starts sign-in (redirect) and throws, so no request goes out unauthenticated', async () => {
    const h = setup();
    await expect(h.s.getToken()).rejects.toThrow('signed out');
    expect(h.redirects).toHaveLength(1);
  });
  it('OidcSignInError carries a stable code', () => {
    expect(new OidcSignInError('state').code).toBe('state');
  });
});
