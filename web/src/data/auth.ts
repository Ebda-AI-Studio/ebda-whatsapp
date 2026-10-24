// Identity contract v1: access tokens come from accounts.ebda.app (refresh cookie lives there), audience "whatsapp".
const REFRESH_EARLY_MS = 60_000;

type Opts = {
  accountsUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  redirect?: (url: string) => void;
  currentUrl?: () => string;
};

export function createTokenProvider(o: Opts) {
  const f = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const redirect = o.redirect ?? ((url: string) => window.location.assign(url));
  const currentUrl = o.currentUrl ?? (() => window.location.href);
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const res = await f(`${o.accountsUrl}/token?aud=whatsapp`, { credentials: 'include' });
    if (res.status === 401) {
      redirect(`${o.accountsUrl}/login?return=${encodeURIComponent(currentUrl())}`);
      throw new Error('signed out');
    }
    if (!res.ok) throw new Error(`token endpoint ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') throw new Error('token endpoint returned an invalid body');
    cached = { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return body.access_token;
  }

  return {
    async getToken(): Promise<string> {
      if (cached && now() < cached.expiresAt - REFRESH_EARLY_MS) return cached.token;
      inflight ??= fetchToken().finally(() => { inflight = null; });
      return inflight;
    },
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
