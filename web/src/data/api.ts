import type { z } from 'zod';
import {
  apiError, customerOrdersResponse, eventsResponse, getMessagesResponse, listConversationsResponse, listTemplatesResponse,
  messageDto, realtimeEvent, searchResponse, type RealtimeEvent, type SendMessageRequest,
} from '../../../src/core/api/contract';
import type { InboxSource } from './source';

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

type Opts = {
  baseUrl: string; storeId: string; getToken: () => Promise<string>;
  fetchImpl?: typeof fetch; userNames: Record<string, string>; currentUserId: string;
};

/** The live inbox source: every response is validated against the shared contract. */
export function createApiSource(o: Opts): InboxSource & { fetchEvents: (after: number) => Promise<z.infer<typeof eventsResponse>>; emit: (e: RealtimeEvent) => void } {
  const f = o.fetchImpl ?? fetch;
  const root = `${o.baseUrl}/api/v1/stores/${o.storeId}`;

  async function call<S extends z.ZodTypeAny>(path: string, schema: S, init: RequestInit = {}): Promise<z.infer<S>> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await o.getToken()}`);
    if (init.body) headers.set('content-type', 'application/json');
    const res = await f(`${root}${path}`, { ...init, headers });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = apiError.safeParse(json);
      throw new ApiError(err.success ? err.data.error : 'invalid_request', res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new Error(`response does not match the contract: ${path}`);
    return parsed.data;
  }

  const listeners = new Set<(e: RealtimeEvent) => void>();

  return {
    kind: 'live',
    currentUserId: o.currentUserId,
    userNames: o.userNames,
    async listConversations(filter, q) {
      const query = q.trim();
      if (query) {
        const hits = await call(`/search?q=${encodeURIComponent(query)}&limit=50`, searchResponse);
        const ids = new Set(hits.items.map((h) => h.conversationId));
        const all = await call(`/conversations?filter=${filter}&limit=50`, listConversationsResponse);
        return all.items.filter((c) => ids.has(c.id) || (c.contact.name ?? '').includes(query));
      }
      return (await call(`/conversations?filter=${filter}&limit=50`, listConversationsResponse)).items;
    },
    async getMessages(id) {
      return (await call(`/conversations/${id}/messages?limit=50`, getMessagesResponse)).items.slice().sort((a, b) => a.at - b.at);
    },
    async send(id, req: SendMessageRequest) {
      return call(`/conversations/${id}/messages`, messageDto, { method: 'POST', body: JSON.stringify(req) });
    },
    async markRead(id) {
      await f(`${root}/conversations/${id}/read`, { method: 'POST', headers: { authorization: `Bearer ${await o.getToken()}` } });
    },
    async orders(waId) {
      return call(`/contacts/${encodeURIComponent(waId)}/orders`, customerOrdersResponse);
    },
    async templates() {
      return (await call('/templates', listTemplatesResponse)).items;
    },
    async recordCodOutcome(waId, orderNumber, outcome) {
      const headers = { authorization: `Bearer ${await o.getToken()}`, 'content-type': 'application/json' };
      const res = await f(`${root}/contacts/${encodeURIComponent(waId)}/orders/${encodeURIComponent(orderNumber)}/cod-outcome`, {
        method: 'POST', headers, keepalive: true, body: JSON.stringify({ outcome, idempotencyKey: crypto.randomUUID() }),
      });
      if (!res.ok) throw new ApiError('invalid_request', res.status);
    },
    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
    fetchEvents: (after) => call(`/events?after=${after}`, eventsResponse),
    emit: (e) => listeners.forEach((l) => l(e)),
  };
}

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

type RealtimeOpts = {
  url: string;
  getToken: () => Promise<string>;
  onEvent: (e: RealtimeEvent) => void;
  fetchEvents: (after: number) => Promise<{ items: RealtimeEvent[]; latestSeq: number }>;
  socketImpl?: new (url: string, protocols: string[]) => SocketLike;
  backoffMs?: (attempt: number) => number;
};

/**
 * Realtime with gap repair: events arrive in seq order; a gap (or a reconnect) triggers GET /events?after=<last seq>.
 * Browsers cannot set headers on a WebSocket, so the token travels as the `bearer.<token>` subprotocol.
 */
export function connectRealtime(o: RealtimeOpts): () => void {
  const Socket = o.socketImpl ?? (WebSocket as unknown as new (url: string, protocols: string[]) => SocketLike);
  const backoff = o.backoffMs ?? ((n: number) => Math.min(30_000, 500 * 2 ** n) * (0.5 + Math.random() / 2));
  let lastSeq = 0;
  let stopped = false;
  let attempt = 0;
  let socket: SocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const deliver = (e: RealtimeEvent) => {
    if (e.seq <= lastSeq) return;
    lastSeq = e.seq;
    o.onEvent(e);
  };
  const resync = () =>
    o.fetchEvents(lastSeq).then((r) => {
      for (const e of r.items.sort((a, b) => a.seq - b.seq)) deliver(e);
    }).catch(() => undefined);

  const open = async () => {
    if (stopped) return;
    // The server echoes "inbox.v1"; the token rides alongside because browsers cannot set WebSocket headers.
    const s = new Socket(o.url, ['inbox.v1', `bearer.${await o.getToken()}`]);
    socket = s;
    s.onopen = () => {
      const hadState = lastSeq > 0;
      attempt = 0;
      if (hadState) chain = chain.then(resync);
    };
    s.onmessage = (msg) => {
      const parsed = realtimeEvent.safeParse(JSON.parse(msg.data));
      if (!parsed.success) return;
      const e = parsed.data;
      chain = chain.then(async () => {
        if (lastSeq > 0 && e.seq > lastSeq + 1) await resync();
        deliver(e);
      });
    };
    s.onclose = () => {
      if (stopped) return;
      timer = setTimeout(() => void open(), backoff(attempt++));
    };
  };
  void open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
}
