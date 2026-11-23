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
/** A sign-in that has not come back within this long is abandoned: its transaction is refused and cleared. */
const TXN_MAX_AGE_MS = 10 * 60_000;

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
  end_session_endpoint: z.string().optional(),
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
type Txn = { state: string; nonce: string; verifier: string; returnTo: string; at: number };
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
  let idTokenHint: string | null = null; // memory only, kept for RP-initiated logout (id_token_hint) and nothing else
  let signedOut = false;
  /** Bumped by signOut(): an exchange or refresh that began before it must not store its result (it would sign the person back in). */
  let generation = 0;
  let endpoints: Promise<{ authorize: string; token: string; endSession: string | null }> | null = null;
  let inflight: Promise<string> | null = null;

  /** Discovery, pinned: same issuer string, https, and both endpoints on the issuer's origin (so the CSP needs that one origin). */
  function discover(): Promise<{ authorize: string; token: string; endSession: string | null }> {
    endpoints ??= (async () => {
      try {
        const res = await f(`${o.oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
        const doc = discoveryDoc.parse(await res.json());
        const sameOrigin = (u: string) => new URL(u).origin === issuerOrigin;
        const s256 = !doc.code_challenge_methods_supported || doc.code_challenge_methods_supported.includes('S256');
        if (!res.ok || doc.issuer !== o.oidc.issuer || !sameOrigin(doc.authorization_endpoint) || !sameOrigin(doc.token_endpoint) || !s256) throw new Error('rejected');
        // The logout endpoint is followed only if it is https and on the pinned issuer's origin; anything else is treated as absent.
        let endSession: string | null = null;
        try { if (doc.end_session_endpoint && doc.end_session_endpoint.startsWith('https://') && sameOrigin(doc.end_session_endpoint)) endSession = doc.end_session_endpoint; } catch { endSession = null; }
        return { authorize: doc.authorization_endpoint, token: doc.token_endpoint, endSession };
      } catch {
        endpoints = null;
        throw new OidcSignInError('discovery');
      }
    })();
    return endpoints;
  }

  async function startSignIn(returnTo: string, opts: { prompt?: 'select_account' | 'login' } = {}): Promise<void> {
    const ep = await discover();
    const { verifier, challenge } = await pkcePair();
    const txn: Txn = { state: randomToken(16), nonce: randomToken(16), verifier, returnTo: safeReturnPath(returnTo), at: now() };
    signedOut = false;
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
    if (opts.prompt) q.set('prompt', opts.prompt); // 'use another account': the provider shows its account picker / login even when it still holds a session
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
    const g = generation;
    const params = new URLSearchParams(search);
    const raw = store.getItem(TXN_KEY);
    store.removeItem(TXN_KEY); // single use, whatever happens next
    let txn: Txn | null = null;
    try { txn = raw ? (JSON.parse(raw) as Txn) : null; } catch { txn = null; }
    const state = params.get('state');
    if (!txn || !state || state !== txn.state || typeof txn.at !== 'number' || now() - txn.at > TXN_MAX_AGE_MS || txn.at > now() + CLOCK_SKEW_MS) throw new OidcSignInError('state');
    // RFC 9207 (mix-up defence): when the provider names its issuer in the answer, it must be the one we started with.
    if (params.has('iss') && params.get('iss') !== o.oidc.issuer) throw new OidcSignInError('state');
    if (params.get('error')) throw new OidcSignInError('denied');
    const code = params.get('code');
    if (!code) throw new OidcSignInError('token');
    const ep = await discover();
    const t = await tokenCall(ep.token, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: o.oidc.clientId, code_verifier: txn.verifier });
    if (g !== generation) throw new OidcSignInError('state'); // signed out while the code was being exchanged
    if (!t.id_token) throw new OidcSignInError('missing_id_token');
    const c = claimsOf(t.id_token);
    if (!c) throw new OidcSignInError('claims');
    if (c.nonce !== txn.nonce) throw new OidcSignInError('nonce');
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    // Several audiences: the authorised party (azp) must be us (OIDC Core 3.1.3.7 step 5).
    if (aud.length > 1 && c.azp !== o.oidc.clientId) throw new OidcSignInError('claims');
    if (c.iss !== o.oidc.issuer || !aud.includes(o.oidc.clientId) || typeof c.exp !== 'number' || c.exp * 1000 + CLOCK_SKEW_MS <= now()) throw new OidcSignInError('claims');
    keep(t);
    idTokenHint = t.id_token; // memory only; used for nothing but id_token_hint at sign-out
    signedOut = false;
    replaceUrl(txn.returnTo);
    return { returnTo: txn.returnTo };
  }

  async function renew(): Promise<string> {
    const g = generation;
    if (o.oidc.refresh && refreshToken) {
      try {
        const ep = await discover();
        const t = await tokenCall(ep.token, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: o.oidc.clientId });
        if (g !== generation) throw new Error('signed out'); // signOut() ran meanwhile: keep nothing
        keep(t);
        return t.access_token;
      } catch {
        if (g === generation) refreshToken = null; // fall through to signing in again
      }
    }
    if (g !== generation || signedOut) throw new Error('signed out'); // signed out here: only an explicit sign-in starts another one
    access = null;
    await startSignIn(`${location.pathname}${location.search}`);
    throw new Error('signed out');
  }

  /**
   * Signs out of this page AND, when the provider supports it, of the provider's own session (otherwise the next person on a shared PC is
   * signed straight back in as the previous one). Tokens, refresh token, ID token and any pending transaction are cleared first.
   * Returns 'redirected' (going to the provider's end_session_endpoint) or 'local' (nothing more we can do: tell the person to sign out at the provider).
   */
  async function signOut(): Promise<'redirected' | 'local'> {
    const hint = idTokenHint;
    generation++;
    access = null; refreshToken = null; idTokenHint = null; inflight = null; signedOut = true;
    store.removeItem(TXN_KEY);
    let endSession: string | null = null;
    try { endSession = (await discover()).endSession; } catch { endSession = null; }
    if (!endSession || !hint) return 'local';
    const url = new URL(endSession);
    url.searchParams.set('id_token_hint', hint);
    url.searchParams.set('post_logout_redirect_uri', `${o.origin}/`);
    url.searchParams.set('client_id', o.oidc.clientId);
    redirect(url.toString());
    return 'redirected';
  }

  // An abandoned sign-in leaves its transaction behind; drop it rather than keep a verifier around.
  try {
    const raw = store.getItem(TXN_KEY);
    const at = raw ? (JSON.parse(raw) as Partial<Txn>).at : undefined;
    if (raw && (typeof at !== 'number' || now() - at > TXN_MAX_AGE_MS)) store.removeItem(TXN_KEY);
  } catch { store.removeItem(TXN_KEY); }

  return {
    startSignIn,
    signOut,
    handleCallback,
    async getToken(): Promise<string> {
      if (access && now() < access.expiresAt - REFRESH_EARLY_MS) return access.token;
      inflight ??= renew().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
