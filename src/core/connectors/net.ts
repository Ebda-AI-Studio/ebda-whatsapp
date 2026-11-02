/**
 * The one place a connector talks to the outside. Every call re-checks the destination (https on 443, no IP literal or internal
 * name, the operator's allowlist when one is set), follows no redirect, is bounded in time and in response size.
 */
import type { Env } from '../../env';
import { agentConfig } from '../ai/config';
import { publicHttpsHost } from '../ai/provider';
import { ConnectorError } from './types';
import { fetchWithTimeout } from '../net/fetch-with-timeout';

export const CONNECTOR_TIMEOUT_MS = 8_000;
export const CONNECTOR_MAX_BYTES = 32 * 1024;

/** The cleaned URL (no trailing slash) or null. With an operator allowlist (`AGENT_ALLOWED_HOSTS`) set, the host must be on it. */
export function validConnectorUrl(raw: string, allowedHosts: readonly string[]): string | null {
  const parts = publicHttpsHost(raw);
  if (!parts) return null;
  const list = allowedHosts.map((h) => h.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean);
  if (list.length && !list.includes(parts.host)) return null;
  return `https://${parts.host}${parts.url.pathname.replace(/\/+$/, '')}`;
}

export const connectorHostAllowed = (env: Env, raw: string): string | null => validConnectorUrl(raw, agentConfig().allowedHosts(env));

export type FetchInit = { method: 'POST'; headers: Record<string, string>; body: string };

/** POSTs and returns the status plus the body text (at most 32 KB). Throws a `ConnectorError` with a fixed code. */
export async function connectorFetch(env: Env, url: string, init: FetchInit, o: { deadline: number; timeoutMs?: number }): Promise<{ status: number; text: string }> {
  const target = connectorHostAllowed(env, url);
  if (!target) throw new ConnectorError('blocked_host');
  const remaining = o.deadline - Date.now();
  if (remaining <= 0) throw new ConnectorError('timeout');
  try {
    const res = await fetchWithTimeout(target, { ...init, redirect: 'manual' }, { label: 'connector.post', timeoutMs: Math.min(o.timeoutMs ?? CONNECTOR_TIMEOUT_MS, remaining) });
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel().catch(() => {});
      throw new ConnectorError('redirect');
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > CONNECTOR_MAX_BYTES) {
      void res.body?.cancel().catch(() => {});
      throw new ConnectorError('too_large');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CONNECTOR_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ConnectorError('too_large');
      }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    return { status: res.status, text: new TextDecoder().decode(all) };
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network');
  }
}
