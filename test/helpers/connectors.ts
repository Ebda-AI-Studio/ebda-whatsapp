import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import type { ConnectorCtx } from '../../src/core/connectors/types';
import { stubGraph } from './graph';
import { jwks } from './api';

/** The identity keys exist only in files that called useApiKey(). */
const keys = () => { try { return jwks(); } catch { return undefined; } };

export type ConnCall = { url: string; headers: Record<string, string>; raw: string; json: any };
export type ConnReply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
/** Resolves to a reply, or throws to simulate the network failing. May await (hold points). */
export type ConnHandler = (call: ConnCall, n: number, signal: AbortSignal | undefined) => Promise<ConnReply> | ConnReply;

/** A fetch that never answers on its own: it fails when the call's signal fires (how a real fetch behaves past its deadline). */
export const hangs = (signal: AbortSignal | undefined): Promise<never> => new Promise((_, reject) => {
  const fail = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
  if (signal?.aborted) fail();
  else signal?.addEventListener('abort', fail, { once: true });
});

/**
 * Stubs every outbound call: Meta/JWKS as the other tests do, and anything on `host` goes to `handler` (the client's system).
 * One place, because the product has one outbound helper for connectors.
 */
export function stubClient(handler: ConnHandler, host = 'hooks.acme-client.com') {
  const calls: ConnCall[] = [];
  const g = stubGraph(undefined, {
    ...(keys() ? { jwks: keys()! } : {}),
    other: (url, init) => {
      if (new URL(url).hostname !== host) return undefined;
      const raw = typeof init?.body === 'string' ? init.body : '';
      const call: ConnCall = { url, headers: Object.fromEntries(new Headers(init?.headers).entries()), raw, json: raw ? JSON.parse(raw) : null };
      calls.push(call);
      return (async () => {
        const r = await handler(call, calls.length, init?.signal ?? undefined);
        return new Response(r.text ?? JSON.stringify(r.json ?? null), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
      })();
    },
  });
  return { calls, graph: g };
}

export const ctxOf = (over: Partial<ConnectorCtx> = {}): ConnectorCtx => ({
  workspaceId: 'ws-1', buyerKey: 'bk'.repeat(32), conversationId: 7, idempotencyKey: 'idem-1', deadline: Date.now() + 10_000, buyerPhone: () => '+201001234567', ...over,
});

export async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const testEnv = env;
export const spyLogs = () => [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
export const logText = (spies: ReturnType<typeof spyLogs>) => spies.flatMap((l) => l.mock.calls).map((c) => JSON.stringify(c)).join('\n');
