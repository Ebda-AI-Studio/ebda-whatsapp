/**
 * Sentry `beforeSend` / `beforeSendTransaction` for every Ebda product (F6, Ruling FDN-OBSERVE-1). The strictest of the two products wins:
 * Ebda Chat's allowlist scrub (no bodies, cookies, query string, extra/contexts/tags/user, only allowlisted headers) PLUS the Store's
 * secret-in-URL / path-token redaction on every remaining string, PLUS phone and e-mail masking on every free-text field.
 *
 * Structural types only: no `@sentry/*` import, so the same module serves the Cloudflare, browser and Node SDKs. Never mutates its
 * argument (a frozen event is legal input); use the RETURN value.
 */
import { maskPhones, redactEmails } from './mask';
import { redactPathSecrets, scrubSentryEvent } from './url-scrub';

type Dict = Record<string, unknown>;
export interface EventLike {
  message?: string;
  transaction?: string;
  request?: { url?: string; data?: unknown; cookies?: unknown; query_string?: unknown; headers?: Record<string, string> } & Dict;
  user?: unknown;
  extra?: unknown;
  tags?: unknown;
  contexts?: unknown;
  exception?: { values?: Array<{ value?: string } & Dict> };
  breadcrumbs?: Array<{ message?: string; data?: unknown } & Dict>;
  spans?: unknown;
  [k: string]: unknown;
}

export interface ScrubEventOptions {
  /** Path segments whose NEXT segment is a phone number by position (`/contacts/<phone>`). Default `['contacts']`. */
  phonePathSegments?: readonly string[];
  /** Request headers allowed through (lower-case). Default: user-agent, content-type, content-length, cf-ray, accept. */
  safeHeaders?: Iterable<string>;
}

const SAFE_HEADERS = ['user-agent', 'content-type', 'content-length', 'cf-ray', 'accept'];

/** Free text out: phones, e-mails and path-borne secrets hidden. */
export function scrubText(s: string): string {
  return redactEmails(maskPhones(redactPathSecrets(s, { anyLongSegment: true })), 8192); // 8192 = Sentry's own message limit
}

/** A request URL without query or fragment, a phone-by-position path segment masked, then every free-text mask. `undefined` if unparseable. */
export function scrubRequestUrl(url: string, phonePathSegments: readonly string[] = ['contacts']): string | undefined {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    const path = phonePathSegments.reduce((p, seg) => p.replace(new RegExp(`(/${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/)[^/]+`), '$1__PHONE__'), u.pathname);
    return scrubText(decodeURI(`${u.origin}${path}`)).replace('__PHONE__', '[phone]');
  } catch {
    return undefined;
  }
}

export function scrubEvent<T extends EventLike>(input: T, opts: ScrubEventOptions = {}): T {
  const safe = new Set([...(opts.safeHeaders ?? SAFE_HEADERS)].map((h) => h.toLowerCase()));
  // The Store's deep scrub first: query values, one-time tokens, path secrets and the x-ebda-* headers wherever they sit, at any depth.
  const event = { ...(scrubSentryEvent(input) as EventLike) };
  if (event.request) {
    const { data: _d, cookies: _c, query_string: _q, ...request } = event.request;
    if (request.headers) request.headers = Object.fromEntries(Object.entries(request.headers).filter(([k]) => safe.has(k.toLowerCase())));
    if (request.url) {
      const url = scrubRequestUrl(request.url, opts.phonePathSegments);
      if (url) request.url = url;
      else delete request.url;
    }
    event.request = request;
  }
  delete event.user;
  delete event.extra;
  delete event.tags;
  delete event.contexts;
  delete event.spans; // span data carries URLs, SQL and query strings; the transaction name and timings stay
  if (event.message) event.message = scrubText(event.message);
  if (event.transaction) event.transaction = scrubText(event.transaction);
  if (event.exception?.values) event.exception = { ...event.exception, values: event.exception.values.map((v) => (v.value ? { ...v, value: scrubText(v.value) } : v)) };
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(({ data: _data, message, ...rest }) => ({ ...rest, ...(message ? { message: scrubText(message) } : {}) }));
  }
  return event as T;
}
