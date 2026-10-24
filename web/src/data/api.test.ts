import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiSource, connectRealtime, type SocketLike } from './api';

const STORE = '11111111-1111-4111-8111-111111111111';
const conv = { id: 1, contact: { waId: '201001234567', name: 'منى', optedOut: false }, lastMessage: null, unread: 1, assigneeUserId: null, tags: [], windowOpenUntil: null };

function fetchStub(routes: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key]!(init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  return { f, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('createApiSource', () => {
  it('lists conversations with the bearer token and validates the response', async () => {
    const { f, calls } = fetchStub({ '/conversations?filter=unread': () => ({ status: 200, body: { items: [conv], nextCursor: null } }) });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    expect(await src.listConversations('unread', '')).toEqual([conv]);
    expect(calls[0]!.url).toBe(`https://wa.test/api/v1/stores/${STORE}/conversations?filter=unread&limit=50`);
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer tok');
  });

  it('rejects a response that does not match the contract', async () => {
    const { f } = fetchStub({ '/conversations': () => ({ status: 200, body: { items: [{ id: 'x' }], nextCursor: null } }) });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    await expect(src.listConversations('all', '')).rejects.toThrow(/contract/);
  });

  it('maps API refusals (window_closed) to a typed error', async () => {
    const { f } = fetchStub({ '/messages': () => ({ status: 409, body: { error: 'window_closed' } }) });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    await expect(src.send(1, { type: 'text', clientId: '0b6f1c7e-1d2a-4f3b-9c8d-7e6f5a4b3c2d', text: 'x' })).rejects.toMatchObject({ code: 'window_closed' });
  });

  it('sends COD outcomes with keepalive so they survive the page closing', async () => {
    const { f, calls } = fetchStub({ '/cod-outcome': () => ({ status: 200, body: {} }) });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    await src.recordCodOutcome('201001234567', '#1048', 'confirmed');
    expect(calls[0]!.url).toBe(`https://wa.test/api/v1/stores/${STORE}/contacts/201001234567/orders/%231048/cod-outcome`);
    expect(calls[0]!.init?.keepalive).toBe(true);
  });

  it('uses search for a non-empty query', async () => {
    const { f, calls } = fetchStub({ '/search?q=': () => ({ status: 200, body: { items: [] } }), '/conversations': () => ({ status: 200, body: { items: [conv], nextCursor: null } }) });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    await src.listConversations('all', 'منى');
    expect(calls.some((c) => c.url.includes('/search?q=%D9%85%D9%86%D9%89'))).toBe(true);
  });
});

class FakeSocket implements SocketLike {
  static last: FakeSocket;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string, public protocols: string[]) { FakeSocket.last = this; }
  close() { this.closed = true; }
}

describe('connectRealtime', () => {
  it('passes the token as a subprotocol, delivers events in order and resyncs a gap', async () => {
    const got: number[] = [];
    const fetchEvents = vi.fn(async (after: number) => ({ items: [{ type: 'conversation.updated' as const, seq: after + 1, conversation: conv }], latestSeq: after + 1 }));
    const stop = connectRealtime({ url: 'wss://wa.test/ws', getToken: async () => 'tok', onEvent: (e) => got.push(e.seq), fetchEvents, socketImpl: FakeSocket as never, backoffMs: () => 0 });
    await vi.waitFor(() => expect(FakeSocket.last).toBeTruthy());
    expect(FakeSocket.last.protocols).toEqual(['bearer.tok']);
    FakeSocket.last.onopen?.();
    FakeSocket.last.onmessage?.({ data: JSON.stringify({ type: 'conversation.updated', seq: 1, conversation: conv }) });
    FakeSocket.last.onmessage?.({ data: JSON.stringify({ type: 'conversation.updated', seq: 3, conversation: conv }) });
    await vi.waitFor(() => expect(got).toEqual([1, 2, 3]));
    expect(fetchEvents).toHaveBeenCalledWith(1);
    stop();
    expect(FakeSocket.last.closed).toBe(true);
  });

  it('reconnects after the socket closes and resyncs from the last seq', async () => {
    const fetchEvents = vi.fn(async (after: number) => ({ items: [], latestSeq: after }));
    connectRealtime({ url: 'wss://wa.test/ws', getToken: async () => 'tok', onEvent: () => undefined, fetchEvents, socketImpl: FakeSocket as never, backoffMs: () => 0 });
    await vi.waitFor(() => expect(FakeSocket.last).toBeTruthy());
    const first = FakeSocket.last;
    first.onopen?.();
    first.onmessage?.({ data: JSON.stringify({ type: 'conversation.updated', seq: 5, conversation: conv }) });
    first.onclose?.();
    await vi.waitFor(() => expect(FakeSocket.last).not.toBe(first));
    FakeSocket.last.onopen?.();
    await vi.waitFor(() => expect(fetchEvents).toHaveBeenCalledWith(5));
  });
});
