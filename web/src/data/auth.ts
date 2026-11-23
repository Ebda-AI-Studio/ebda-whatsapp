// Identity contract v1: access tokens come from the brand's accounts service (refresh cookie lives there), audience "whatsapp".
const REFRESH_EARLY_MS = 60_000;

/** The message of the error thrown after the person has been handed to sign-in (the caller must not also show a failure). */
export const SIGNED_OUT = 'signed out';

type Opts = {
  accountsUrl: string;
  /** Names the product on the sign-in page (`product=`), so it can say which product the person is opening and return here. */
  product?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  redirect?: (url: string) => void;
  currentUrl?: () => string;
};

/**
 * The accounts service answers `{ success: true, data: { access_token, expires_in, ... } }` (the same envelope the store's
 * admin unwraps). Reading the token at the top level turned every signed-in visit into the "unreachable" gate, so the
 * envelope is the contract here, and it must say `success: true`; the bare OAuth shape (no `success`, no `data`) is still read, for a
 * brand whose token endpoint answers without one.
 */
export function readTokenBody(raw: unknown): { access_token: string; expires_in: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw as { success?: unknown; data?: unknown };
  // The envelope counts only when it says success: true; a body that names `success` with any other value is refused even if it
  // carries a token (a `{ success: false, data: { access_token } }` on a 200 must not sign anyone in).
  if ('success' in outer && outer.success !== true) return null;
  const enveloped = outer.data !== undefined;
  if (enveloped && outer.success !== true) return null;
  const body = (enveloped ? outer.data : raw) as { access_token?: unknown; expires_in?: unknown };
  if (!body || typeof body !== 'object') return null;
  if (typeof body.access_token !== 'string' || body.access_token === '') return null;
  if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) return null;
  return { access_token: body.access_token, expires_in: body.expires_in };
}

export function createTokenProvider(o: Opts) {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const redirect = o.redirect ?? ((url: string) => window.location.assign(url));
  const currentUrl = o.currentUrl ?? (() => window.location.href);
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  const loginUrl = () => `${o.accountsUrl}/login?${o.product ? `product=${encodeURIComponent(o.product)}&` : ''}return=${encodeURIComponent(currentUrl())}`;

  async function fetchToken(): Promise<string> {
    const res = await f(`${o.accountsUrl}/token?aud=whatsapp`, { credentials: 'include' });
    if (res.status === 401) {
      redirect(loginUrl());
      throw new Error(SIGNED_OUT);
    }
    if (!res.ok) throw new Error(`token endpoint ${res.status}`);
    const body = readTokenBody(await res.json());
    if (!body) throw new Error('token endpoint returned an invalid body');
    cached = { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return body.access_token;
  }

  return {
    async getToken(): Promise<string> {
      if (cached && now() < cached.expiresAt - REFRESH_EARLY_MS) return cached.token;
      inflight ??= fetchToken().finally(() => { inflight = null; });
      return inflight;
    },
    /** Where the shared sign-in lives for this product, returning here afterwards. */
    loginUrl,
  };
}

function claims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1] ?? '';
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The signed-in user id (sub), for "Mine" and assignee labels. Display only. */
export function decodeSub(token: string): string | null {
  const sub = claims(token)?.sub;
  return typeof sub === 'string' ? sub : null;
}

/** The signed-in email (display only), or null when the token has none. */
export function decodeEmail(token: string): string | null {
  const email = claims(token)?.email;
  return typeof email === 'string' && email.includes('@') ? email : null;
}

/** `ahmad@gmail.com` -> `a***@gmail.com`: enough to recognise the account, not enough to read it off a shared screen. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  return `${email[0]}***${email.slice(at)}`;
}

/** Reads the stores claim to choose a store. Display only: the Worker verifies every token. */
export function decodeStores(token: string): { id: string; role: 'owner' | 'staff' }[] {
  try {
    const part = token.split('.')[1] ?? '';
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { stores?: unknown };
    return Array.isArray(json.stores) ? (json.stores as { id: string; role: 'owner' | 'staff' }[]) : [];
  } catch {
    return [];
  }
}
