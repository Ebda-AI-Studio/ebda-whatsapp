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

  it('search finds a conversation beyond the first page', async () => {
    const old = { ...conv, id: 99, contact: { ...conv.contact, name: 'قديم' } };
    const { f } = fetchStub({
      '/search?q=': () => ({ status: 200, body: { items: [{ conversationId: 99, messageId: 1, snippet: 'x', at: 1 }] } }),
      'cursor=c2': () => ({ status: 200, body: { items: [old], nextCursor: null } }),
      '/conversations?filter=all&limit=50': () => ({ status: 200, body: { items: [conv], nextCursor: 'c2' } }),
    });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    expect((await src.listConversations('all', 'كلمة')).map((c) => c.id)).toEqual([99]);
  });

  it('turns COD outcomes on when /me reports the store link', async () => {
    const { f } = fetchStub({ '/me': () => ({ status: 200, body: { userId: 'u', storeId: STORE, role: 'owner', capabilities: { codOutcome: true } } }) });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    await src.loadCapabilities();
    expect(src.capabilities).toEqual({ codOutcome: true, numbers: false });
    expect(src.role).toBe('owner');
  });

  it('reads the numbers capability and the role from /me; staff until /me answers', async () => {
    const { f } = fetchStub({ '/me': () => ({ status: 200, body: { userId: 'u', storeId: STORE, role: 'staff', capabilities: { codOutcome: false, numbers: true } } }) });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    expect(src.role).toBe('staff');
    await src.loadCapabilities();
    expect(src.capabilities.numbers).toBe(true);
    expect(src.role).toBe('staff');
  });

  it('keeps COD outcomes off when /me says nothing or fails', async () => {
    const { f } = fetchStub({ '/me': () => ({ status: 500, body: {} }) });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    await src.loadCapabilities();
    expect(src.capabilities).toEqual({ codOutcome: false });
  });

  it('declares COD outcomes unavailable until the store route exists', () => {
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', userNames: {}, currentUserId: 'u' });
    expect(src.capabilities).toEqual({ codOutcome: false });
  });

  it('fetches media with the bearer token and returns a blob URL', async () => {
    const f = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL }));
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    expect(await src.mediaUrl!('/api/v1/stores/s/media/9')).toBe('blob:x');
    expect(new Headers((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('authorization')).toBe('Bearer tok');
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
    expect(FakeSocket.last.protocols).toEqual(['inbox.v1', 'bearer.tok']);
    FakeSocket.last.onopen?.();
    FakeSocket.last.onmessage?.({ data: JSON.stringify({ type: 'conversation.updated', seq: 1, conversation: conv }) });
    FakeSocket.last.onmessage?.({ data: JSON.stringify({ type: 'conversation.updated', seq: 3, conversation: conv }) });
    // first connect takes a baseline (reload) at seq 1; seq 3 then exposes a gap that is repaired with seq 2
    await vi.waitFor(() => expect(got).toEqual([2, 3]));
    expect(fetchEvents).toHaveBeenNthCalledWith(1, 0);
    expect(fetchEvents).toHaveBeenCalledWith(1);
    stop();
    expect(FakeSocket.last.closed).toBe(true);
  });

  it('a token failure while reconnecting schedules another attempt instead of dying', async () => {
    let calls = 0;
    const getToken = vi.fn(async () => { calls++; if (calls === 1) throw new Error('offline'); return 'tok'; });
    connectRealtime({ url: 'wss://wa.test/ws', getToken, onEvent: () => undefined, fetchEvents: async (a) => ({ items: [], latestSeq: a }), socketImpl: FakeSocket as never, backoffMs: () => 0 });
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledTimes(2));
  });

  it('on first connect and on a gap older than the buffer it asks the app to reload', async () => {
    const onReload = vi.fn();
    const fetchEvents = vi.fn(async (after: number) => (after === 0 ? { items: [], latestSeq: 40 } : { items: [{ type: 'conversation.updated' as const, seq: 900, conversation: conv }], latestSeq: 900 }));
    connectRealtime({ url: 'wss://wa.test/ws', getToken: async () => 'tok', onEvent: () => undefined, onReload, fetchEvents, socketImpl: FakeSocket as never, backoffMs: () => 0 });
    await vi.waitFor(() => expect(FakeSocket.last).toBeTruthy());
    FakeSocket.last.onopen?.();
    await vi.waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    FakeSocket.last.onmessage?.({ data: JSON.stringify({ type: 'conversation.updated', seq: 950, conversation: conv }) });
    await vi.waitFor(() => expect(onReload).toHaveBeenCalledTimes(2));
  });

  it('reconnects now when the page becomes visible or the network returns', async () => {
    connectRealtime({ url: 'wss://wa.test/ws', getToken: async () => 'tok', onEvent: () => undefined, fetchEvents: async (a) => ({ items: [], latestSeq: a }), socketImpl: FakeSocket as never, backoffMs: () => 60_000 });
    await vi.waitFor(() => expect(FakeSocket.last).toBeTruthy());
    const first = FakeSocket.last;
    first.onclose?.();
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(FakeSocket.last).not.toBe(first));
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
