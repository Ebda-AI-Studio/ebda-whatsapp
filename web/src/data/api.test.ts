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

describe('createApiSource bot settings', () => {
  const bot = {
    menu: { enabled: true, items: [] },
    hours: { enabled: false, timezone: 'Africa/Cairo', week: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }, awayMessage: { ar: 'م', en: 'c' }, ordersWhileClosed: true },
    location: null,
  };
  it('reads the merchant part of the store-link settings and saves it with PATCH', async () => {
    const { f, calls } = fetchStub({ '/store-link/settings': () => ({ status: 200, body: { orderConfirmations: true, orderingBot: true, otpViaWhatsApp: false, catalogId: null, ...bot } }) });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    expect(await src.botSettings!()).toEqual(bot);
    await src.saveBotSettings!(bot as never);
    expect(calls[1]!.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual(bot);
  });
});

describe('createApiSource catalog', () => {
  const mk = (routes: Parameters<typeof fetchStub>[0]) => {
    const { f, calls } = fetchStub(routes);
    return { calls, src: createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' }) };
  };
  it('reads the status and provisions with POST (name optional)', async () => {
    const { src, calls } = mk({ '/store-link/catalog/provision': () => ({ status: 200, body: { catalogId: '123456789' } }), '/store-link/catalog': () => ({ status: 200, body: { catalogId: null, lastSyncAt: null } }) });
    expect(await src.catalog!.status()).toEqual({ catalogId: null, lastSyncAt: null });
    expect(await src.catalog!.provision()).toEqual({ catalogId: '123456789' });
    expect(calls[1]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({});
  });
  it('a refusal carries the server reason', async () => {
    const { src } = mk({ '/store-link/catalog/provision': () => ({ status: 403, body: { error: 'forbidden', message: 'missing_permission' } }) });
    await expect(src.catalog!.provision()).rejects.toMatchObject({ status: 403, detail: 'missing_permission' });
  });
});

describe('createApiSource bot results', () => {
  it('asks for the last N Cairo days, today included, and validates the answer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T22:30:00Z')); // already the 25th in Cairo
    const body = { from: '2026-10-19', to: '2026-10-25', days: [], steps: [{ step: 'conversation', total: 3, series: [] }] };
    const { f, calls } = fetchStub({ '/bot/funnel': () => ({ status: 200, body }) });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    expect(await src.botFunnel!(7)).toEqual(body);
    expect(calls[0]!.url).toBe(`https://wa.test/api/v1/stores/${STORE}/bot/funnel?from=2026-10-19&to=2026-10-25`);
    vi.useRealTimers();
    const bad = fetchStub({ '/bot/funnel': () => ({ status: 200, body: { nope: 1 } }) });
    const src2 = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: bad.f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    await expect(src2.botFunnel!(30)).rejects.toThrow(/contract/);
  });
});

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

  it('a query is ONE server call with q, filter and the abort signal (no paging, no client-side matching)', async () => {
    const old = { ...conv, id: 99, contact: { ...conv.contact, name: 'قديم' } };
    const { f, calls } = fetchStub({ '/conversations?': () => ({ status: 200, body: { items: [old], nextCursor: null } }) });
    const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
    const ctl = new AbortController();
    expect((await src.listConversations('unread', ' كلمة ', ctl.signal)).map((c) => c.id)).toEqual([99]);
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]!.url);
    expect(u.pathname.endsWith('/conversations')).toBe(true);
    expect(u.searchParams.get('q')).toBe('كلمة');
    expect(u.searchParams.get('filter')).toBe('unread');
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(ctl.signal);
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

describe('connectRealtime: stop', () => {
  it('after stop() nothing more is delivered, and a token fetch still in flight never opens a socket', async () => {
    const got: number[] = [];
    FakeSocket.last = undefined as never;
    let release!: (t: string) => void;
    const token = new Promise<string>((r) => { release = r; });
    const stop = connectRealtime({ url: 'wss://wa.test/ws', getToken: () => token, onEvent: (e) => got.push(e.seq), fetchEvents: async (a) => ({ items: [], latestSeq: a }), socketImpl: FakeSocket as never, backoffMs: () => 0 });
    stop();
    release('tok');
    await Promise.resolve(); await Promise.resolve();
    expect(FakeSocket.last).toBeUndefined();
    expect(got).toEqual([]);
  });
  it('an event that arrives after stop() is dropped (signed-out screens must not keep receiving messages)', async () => {
    const got: number[] = [];
    const stop = connectRealtime({ url: 'wss://wa.test/ws', getToken: async () => 'tok', onEvent: (e) => got.push(e.seq), fetchEvents: async (a) => ({ items: [], latestSeq: a || 1 }), socketImpl: FakeSocket as never, backoffMs: () => 0 });
    await vi.waitFor(() => expect(FakeSocket.last).toBeTruthy());
    const sock = FakeSocket.last;
    sock.onopen?.();
    sock.onmessage?.({ data: JSON.stringify({ type: 'conversation.updated', seq: 2, conversation: conv }) });
    stop();
    sock.onmessage?.({ data: JSON.stringify({ type: 'conversation.updated', seq: 3, conversation: conv }) });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).not.toContain(3);
    expect(sock.closed).toBe(true);
  });
});
