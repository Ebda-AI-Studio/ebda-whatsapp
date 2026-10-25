import { z } from 'zod';
import type { OidcWebConfig } from '../../brands/types';

/**
 * Browser sign-in against a tenant's own OpenID Connect provider: Authorization Code + PKCE (S256), state and nonce.
 * Tokens live in this closure only. The one thing written to sessionStorage is the sign-in transaction (state, nonce, PKCE verifier,
 * return path) between the redirect out and the callback; it is deleted the moment the callback is read, so it is single use.
 * The bearer for the API is always the ACCESS token; the ID token is read once for the nonce/claims check and dropped.
 */
export const CALLBACK_PATH = '/auth/callback';
const TXN_KEY = 'oidc:txn';
const REFRESH_EARLY_MS = 60_000;
const CLOCK_SKEW_MS = 60_000;

export type SignInErrorCode = 'denied' | 'state' | 'nonce' | 'token' | 'discovery' | 'missing_id_token' | 'claims';
export class OidcSignInError extends Error {
  constructor(public readonly code: SignInErrorCode) {
    super(`sign-in failed: ${code}`);
  }
}

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (n: number): string => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** RFC 7636 S256: BASE64URL(SHA-256(ASCII(verifier))). */
export async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32); // 43 characters
  return { verifier, challenge: await challengeFor(verifier) };
}

/** Only a same-origin path survives the round trip (no `//host`, no scheme, no backslash tricks, never the callback itself). */
export function safeReturnPath(p: string): string {
  if (!/^\/(?![/\\])[^\u0000-\u001f]*$/.test(p) || p.startsWith(CALLBACK_PATH)) return '/';
  return p;
}

const https = z.string().url().refine((u) => u.startsWith('https://'));
const discoveryDoc = z.object({
  issuer: z.string(),
  authorization_endpoint: https,
  token_endpoint: https,
  code_challenge_methods_supported: z.array(z.string()).optional(),
}).loose();
const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().positive().default(300),
  id_token: z.string().optional(),
  refresh_token: z.string().optional(),
}).loose();

function claimsOf(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split('.')[1] ?? '';
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Txn = { state: string; nonce: string; verifier: string; returnTo: string };
type Opts = {
  oidc: OidcWebConfig;
  /** This page's origin (the redirect uri is `<origin>/auth/callback`). */
  origin: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  session?: SessionStore;
  redirect?: (url: string) => void;
  replaceUrl?: (path: string) => void;
};

export function createOidcSession(o: Opts) {
  const f = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = o.now ?? Date.now;
  const store = o.session ?? sessionStorage;
  const redirect = o.redirect ?? ((url: string) => window.location.assign(url));
  const replaceUrl = o.replaceUrl ?? ((p: string) => window.history.replaceState(null, '', p));
  const redirectUri = `${o.origin}${CALLBACK_PATH}`;
  const issuerOrigin = new URL(o.oidc.issuer).origin;

  let access: { token: string; expiresAt: number } | null = null;
  let refreshToken: string | null = null;
  let endpoints: Promise<{ authorize: string; token: string }> | null = null;
  let inflight: Promise<string> | null = null;

  /** Discovery, pinned: same issuer string, https, and both endpoints on the issuer's origin (so the CSP needs that one origin). */
  function discover(): Promise<{ authorize: string; token: string }> {
    endpoints ??= (async () => {
      try {
        const res = await f(`${o.oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
        const doc = discoveryDoc.parse(await res.json());
        const sameOrigin = (u: string) => new URL(u).origin === issuerOrigin;
        const s256 = !doc.code_challenge_methods_supported || doc.code_challenge_methods_supported.includes('S256');
        if (!res.ok || doc.issuer !== o.oidc.issuer || !sameOrigin(doc.authorization_endpoint) || !sameOrigin(doc.token_endpoint) || !s256) throw new Error('rejected');
        return { authorize: doc.authorization_endpoint, token: doc.token_endpoint };
      } catch {
        endpoints = null;
        throw new OidcSignInError('discovery');
      }
    })();
    return endpoints;
  }

  async function startSignIn(returnTo: string): Promise<void> {
    const ep = await discover();
    const { verifier, challenge } = await pkcePair();
    const txn: Txn = { state: randomToken(16), nonce: randomToken(16), verifier, returnTo: safeReturnPath(returnTo) };
    store.setItem(TXN_KEY, JSON.stringify(txn));
    const url = new URL(ep.authorize);
    const q = url.searchParams;
    q.set('response_type', 'code');
    q.set('client_id', o.oidc.clientId);
    q.set('redirect_uri', redirectUri);
    q.set('scope', o.oidc.refresh ? 'openid offline_access' : 'openid');
    q.set('state', txn.state);
    q.set('nonce', txn.nonce);
    q.set('code_challenge', challenge);
    q.set('code_challenge_method', 'S256');
    if (o.oidc.audience) q.set('audience', o.oidc.audience);
    redirect(url.toString());
  }

  async function tokenCall(tokenEndpoint: string, body: Record<string, string>): Promise<z.infer<typeof tokenResponse>> {
    const res = await f(tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body).toString() });
    const json = (await res.json().catch(() => null)) as unknown;
    const parsed = tokenResponse.safeParse(json);
    if (!res.ok || !parsed.success || (parsed.data.token_type && parsed.data.token_type.toLowerCase() !== 'bearer')) throw new OidcSignInError('token');
    return parsed.data;
  }

  function keep(t: z.infer<typeof tokenResponse>): void {
    access = { token: t.access_token, expiresAt: now() + t.expires_in * 1000 };
    if (o.oidc.refresh && t.refresh_token) refreshToken = t.refresh_token;
  }

  /** Reads the provider's answer. Throws OidcSignInError (the page shows an error, it never loops back to the provider by itself). */
  async function handleCallback(search: string): Promise<{ returnTo: string }> {
    const params = new URLSearchParams(search);
    const raw = store.getItem(TXN_KEY);
    store.removeItem(TXN_KEY); // single use, whatever happens next
    let txn: Txn | null = null;
    try { txn = raw ? (JSON.parse(raw) as Txn) : null; } catch { txn = null; }
    const state = params.get('state');
    if (!txn || !state || state !== txn.state) throw new OidcSignInError('state');
    if (params.get('error')) throw new OidcSignInError('denied');
    const code = params.get('code');
    if (!code) throw new OidcSignInError('token');
    const ep = await discover();
    const t = await tokenCall(ep.token, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: o.oidc.clientId, code_verifier: txn.verifier });
    if (!t.id_token) throw new OidcSignInError('missing_id_token');
    const c = claimsOf(t.id_token);
    if (!c) throw new OidcSignInError('claims');
    if (c.nonce !== txn.nonce) throw new OidcSignInError('nonce');
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (c.iss !== o.oidc.issuer || !aud.includes(o.oidc.clientId) || typeof c.exp !== 'number' || c.exp * 1000 + CLOCK_SKEW_MS <= now()) throw new OidcSignInError('claims');
    keep(t); // the ID token goes no further than this function
    replaceUrl(txn.returnTo);
    return { returnTo: txn.returnTo };
  }

  async function renew(): Promise<string> {
    if (o.oidc.refresh && refreshToken) {
      try {
        const ep = await discover();
        const t = await tokenCall(ep.token, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: o.oidc.clientId });
        keep(t);
        return t.access_token;
      } catch {
        refreshToken = null; // fall through to signing in again
      }
    }
    access = null;
    await startSignIn(`${location.pathname}${location.search}`);
    throw new Error('signed out');
  }

  return {
    startSignIn,
    handleCallback,
    async getToken(): Promise<string> {
      if (access && now() < access.expiresAt - REFRESH_EARLY_MS) return access.token;
      inflight ??= renew().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
