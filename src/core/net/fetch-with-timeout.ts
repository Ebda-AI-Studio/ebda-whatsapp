/**
 * Ruling PERF-TIMEOUTS-1: every outbound HTTP call to a third party (Meta Graph and the WhatsApp Cloud API, Kashier, the AI
 * provider, Telegram, a merchant connector) goes through THIS helper, so no request can hold a Worker or queue slot open on a
 * stalled upstream. A raw global `fetch(` anywhere else under src/ fails `test/no-raw-fetch.test.ts`; `env.X.fetch(...)`
 * (service bindings, assets, Durable Object stubs) is not a third-party call and stays as it is.
 *
 * Defaults by class: `payment` 10 s, `ai` 30 s, `default` 8 s. A call whose own limit was already chosen on purpose (a Meta
 * send, a media upload) passes `timeoutMs` so its behaviour does not change. A caller's own `signal` is honoured: whichever
 * fires first wins. The timer covers the headers and the body read, because the signal stays attached until the body is consumed.
 *
 * On timeout it throws `FetchTimeoutError` (`name === 'TimeoutError'`, the same name as the platform's own
 * `AbortSignal.timeout` rejection, so the existing `err.name === 'TimeoutError'` checks keep working) and logs the label and
 * the limit only: never the URL, headers or body, which carry tokens and customer phone numbers.
 */
export type FetchClass = 'payment' | 'ai' | 'default';

export const FETCH_TIMEOUT_MS: Readonly<Record<FetchClass, number>> = { payment: 10_000, ai: 30_000, default: 8_000 };

export interface FetchTimeoutOptions {
  /** Short, stable, PII-free name of the call (`meta.send`, `kashier.refund`); the only thing logged on a timeout. */
  label: string;
  class?: FetchClass;
  /** Overrides the class default. */
  timeoutMs?: number;
}

export class FetchTimeoutError extends Error {
  constructor(readonly label: string, readonly timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export async function fetchWithTimeout(
  url: string | URL | Request,
  init: RequestInit | undefined,
  opts: FetchTimeoutOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const ms = opts.timeoutMs ?? FETCH_TIMEOUT_MS[opts.class ?? 'default'];
  const timeout = AbortSignal.timeout(ms);
  const caller = init?.signal ?? undefined;
  const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (err) {
    if (timeout.aborted && !caller?.aborted) {
      console.warn(JSON.stringify({ event: 'outbound_fetch_timeout', label: opts.label, timeoutMs: ms }));
      throw new FetchTimeoutError(opts.label, ms);
    }
    throw err;
  }
}
