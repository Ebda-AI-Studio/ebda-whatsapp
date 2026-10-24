import { vi } from 'vitest';

export type GraphCall = { url: string; body: any };

/** Stubs outbound Graph API calls. `responder` decides each response; every call is recorded. */
export function stubGraph(responder: (call: GraphCall, n: number) => { status: number; json: unknown } = (_c, n) => ({ status: 200, json: { messages: [{ id: `wamid.out${n}` }] } })) {
  const calls: GraphCall[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://graph.facebook.com/')) throw new Error(`unexpected outbound fetch: ${url}`);
    const call = { url, body: JSON.parse(String(init?.body ?? 'null')) };
    calls.push(call);
    const r = responder(call, calls.length);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  return { calls, restore: () => spy.mockRestore() };
}
