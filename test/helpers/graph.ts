import { vi } from 'vitest';
import type { JWK } from 'jose';

export type GraphCall = { url: string; method: string; body: any; headers: Record<string, string> };
export type GraphReply = { status: number; json?: unknown; body?: BodyInit; headers?: Record<string, string> };
const JWKS_URL = 'https://accounts.ebda.app/.well-known/jwks.json';
const MEDIA_HOST = 'https://lookaside.fbsbx.com/';

/**
 * Stubs outbound Graph API calls. `responder` decides each response; every call is recorded.
 * `opts.jwks` also answers the identity JWKS fetch so route tests can sign in while Graph is stubbed.
 */
export function stubGraph(
  responder: (call: GraphCall, n: number) => GraphReply = (_c, n) => ({ status: 200, json: { messages: [{ id: `wamid.out${n}` }] } }),
  opts: { jwks?: JWK[]; delayMs?: number } = {},
) {
  const calls: GraphCall[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (opts.jwks && url === JWKS_URL) return new Response(JSON.stringify({ keys: opts.jwks }), { headers: { 'content-type': 'application/json' } });
    if (!url.startsWith('https://graph.facebook.com/') && !url.startsWith(MEDIA_HOST)) throw new Error(`unexpected outbound fetch: ${url}`);
    const raw = init?.body;
    const call: GraphCall = {
      url,
      method: String(init?.method ?? 'GET'),
      body: typeof raw === 'string' ? JSON.parse(raw) : raw instanceof FormData ? raw : null,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    // A real delay lets the DO's input gate open, as a real network call does, so overlapping runs can interleave.
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const r = responder(call, calls.length);
    if (r.body !== undefined) return new Response(r.body, { status: r.status, headers: r.headers });
    return new Response(JSON.stringify(r.json ?? null), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  return { calls, restore: () => spy.mockRestore() };
}
