import { expect, it, vi } from 'vitest';
import { createApiSource } from './api';
import { usableByStores } from './shared-templates';

const STORE = '11111111-1111-4111-8111-111111111111';
function source(answer: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const r = answer(String(input), init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  return { src: createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' }), calls };
}

it('talks to /api/v1/operator/shared-templates (never a store route) and validates the answers', async () => {
  const t = { name: 'a_b', language: 'ar', category: 'UTILITY', status: 'APPROVED', bodyText: 'x', paramCount: 0, rejectedReason: null };
  const { src, calls } = source((url) => (url.endsWith('/sync') ? { status: 200, body: { upserted: 2, removed: 1 } } : url.endsWith('/shared-templates') ? { status: 200, body: { items: [t] } } : { status: 404, body: {} }));
  expect(await src.sharedTemplates!.list()).toEqual([t]);
  expect(await src.sharedTemplates!.sync()).toEqual({ upserted: 2, removed: 1 });
  expect(calls.map((c) => c.url)).toEqual(['https://wa.test/api/v1/operator/shared-templates', 'https://wa.test/api/v1/operator/shared-templates/sync']);
  expect(calls[1]!.init?.method).toBe('POST');
});

it('submit posts the template, and a 404 (no platform number / switch off) surfaces as a status the panel can explain', async () => {
  const ok = source(() => ({ status: 201, body: { name: 'a_b', language: 'ar', status: 'PENDING' } }));
  const input = { name: 'a_b', language: 'ar' as const, category: 'UTILITY' as const, components: [{ type: 'BODY' as const, text: 'hi' }] };
  expect(await ok.src.sharedTemplates!.submit(input)).toMatchObject({ status: 'PENDING' });
  expect(JSON.parse(String(ok.calls[0]!.init?.body))).toEqual(input);
  const gone = source(() => ({ status: 404, body: { error: 'not_found' } }));
  await expect(gone.src.sharedTemplates!.list()).rejects.toMatchObject({ status: 404 });
});

it('usable by stores = approved and not marketing (the server\'s send rule)', () => {
  expect(usableByStores({ status: 'APPROVED', category: 'UTILITY' })).toBe(true);
  expect(usableByStores({ status: 'APPROVED', category: 'AUTHENTICATION' })).toBe(true);
  expect(usableByStores({ status: 'APPROVED', category: 'MARKETING' })).toBe(false);
  expect(usableByStores({ status: 'PENDING', category: 'UTILITY' })).toBe(false);
});
