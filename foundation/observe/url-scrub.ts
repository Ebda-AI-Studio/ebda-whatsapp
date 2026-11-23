/**
 * (F6, Ruling FDN-OBSERVE-1: canonical source = the Store's `sentry-url-scrub.ts`, moved here unchanged.)
 * Redacts the VALUES of free-text query parameters (search box, typeahead, lookups by email or
 * phone) from URLs before they leave our process: Sentry events, transactions and breadcrumbs
 * (every app), PostHog captures (every app) and the API's own log lines.
 *
 * Why (search program P0 Task 5 review, fix-the-class): a shopper pastes a phone or an email
 * into the storefront search box, it travels as `?search=01012345678` / `?q=…`, and the SDKs
 * record the full URL (`event.request.url` / `query_string`, navigation + fetch breadcrumbs,
 * span `url.full` / `http.query`, the transaction name). The search log drops such terms; the
 * URL copies of the same value must not reach a third party either.
 *
 * Keys only, values replaced by `[Filtered]` (Sentry's own placeholder); the rest of the URL
 * (path, page, sort, ids) stays readable for debugging. Pure, no SDK import, unit-tested.
 */

/** Query parameters whose value is free text a person typed (case-insensitive). */
export const SENSITIVE_QUERY_PARAMS = [
  'search',
  'q',
  'query',
  'term',
  'keyword',
  'keywords',
  'email',
  'phone',
  // One-time credentials in a link (password reset, email verification, cart restore, the
  // WhatsApp cart): not typed text, but equally never for a third party (Ruling PIXEL-CONSENT-1).
  'token',
  'restore',
  'watoken',
] as const;

export const REDACTED_QUERY_VALUE = '[Filtered]';

/** Lower-case name of the request header that carries a typed search term. */
const SEARCH_QUERY_HEADER_NAME = 'x-search-query';

const SENSITIVE = new Set<string>(SENSITIVE_QUERY_PARAMS);
// `?key=value` / `&key=value` anywhere in a string (absolute or relative URL, a log message);
// also a bare query string `key=value&…` at the very start. A value stops at a DOUBLE quote so a
// PostHog `$elements_chain` string (`a:attr__href="/search?q=abc"nth-child="1"`) is not swallowed
// whole by its first `key="` pair, which would hide the inner `?q=`. Never at an apostrophe:
// `encodeURIComponent` leaves `'` raw, and Franco-Arabic search terms use it as a letter (`3'` =
// غ, `7'` = خ), so `?q=O'Brien%2001012345678` must redact whole. A raw `"` cannot occur inside a
// value (encodeURIComponent / URLSearchParams / the WHATWG URL parser all encode it).
const PARAM_RE = /(^|[?&])([^=&#?\s]+)=([^&#\s"]*)/g;

/** Lower-cased, decoded key with any array suffix (`q[]`, `q[0]`) removed. */
function normalizeKey(key: string): string {
  let k: string;
  try {
    k = decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    k = key;
  }
  return k.toLowerCase().replace(/\[[^\]]*\]$/, '');
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE.has(normalizeKey(key));
}

/**
 * True when a query string (or parsed params) holds a sensitive key. Ad pixels read
 * the page URL themselves and send it to their network, so none may load or fire on such a URL
 * (Ruling PIXEL-CONSENT-1). Keys only, same list and normalisation as the scrubbers.
 */
export function urlCarriesSensitiveQuery(
  search: string | { keys(): Iterable<string> } | null | undefined
): boolean {
  if (!search) return false;
  const keys: Iterable<string> =
    typeof search === 'string'
      ? Array.from(search.replace(/^\?/, '').split('&'), pair => pair.split('=')[0] ?? '')
      : search.keys();
  for (const key of keys) if (key && isSensitiveKey(key)) return true;
  return false;
}

/**
 * SEC-8: secrets that travel IN the path, not the query. The Bosta webhook is
 * `/webhooks/shipping/bosta/:storeId/:token` (the per-store secret is the last segment), and
 * request logs, Workers Logs, Logpush and Sentry would otherwise keep it for 30 days.
 * Two rules, path-only (rule 2 only when `anyLongSegment`, the default: API request logs. Sentry and
 * PostHog strings get rule 1 only, so ordinary long product slugs stay readable in analytics) (a `/` must precede the segment and a delimiter must follow it):
 *   1. the segment after `/shipping/bosta/<storeId>/` is always masked;
 *   2. any other 24+ char token-looking segment (letters/digits/_/-, at least one digit,
 *      not a UUID) is masked. Slugs without digits and UUID ids stay readable.
 */
const BOSTA_TOKEN_RE = /(\/shipping\/bosta\/[^/?#\s"']+\/)[^/?#\s"']+/gi;
/**
 * The guest order-status link (Ruling WA-COD-V2-2) is a bearer secret in the path: `/public/order-status/<token>` (API) and `/o/<token>`
 * (storefront page). Masked whatever the path looks like, and by SHAPE too (<uuid>.<uuid>.<exp>.<43-char mac>), so a router-relative
 * `/<token>` in a log line is hidden as well.
 */
const ORDER_STATUS_PATH_RE =
  /(\/public\/order-status\/|(?:https?:\/\/[^/\s"']+|^|[\s"'(])\/o\/)[^/?#\s"']+/gi;
const ORDER_STATUS_SHAPE_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d{1,12}\.[A-Za-z0-9_-]{43}/gi;
const LONG_SEGMENT_RE = /(\/)([A-Za-z0-9_-]{24,})(?=[/?#\s"']|$)/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function redactPathSecrets(
  text: string,
  opts: { anyLongSegment?: boolean } = { anyLongSegment: true }
): string {
  if (typeof text !== 'string' || !text.includes('/')) return text;
  const bosta = text
    .replace(BOSTA_TOKEN_RE, `$1${REDACTED_QUERY_VALUE}`)
    .replace(ORDER_STATUS_PATH_RE, `$1${REDACTED_QUERY_VALUE}`)
    .replace(ORDER_STATUS_SHAPE_RE, REDACTED_QUERY_VALUE);
  if (!opts.anyLongSegment) return bosta;
  return bosta.replace(LONG_SEGMENT_RE, (whole, slash: string, seg: string) =>
    UUID_RE.test(seg) || !/\d/.test(seg) ? whole : `${slash}${REDACTED_QUERY_VALUE}`
  );
}

/** Replace the value of every sensitive query parameter in `text` with `[Filtered]`. */
export function redactSensitiveQuery(text: string): string {
  if (typeof text !== 'string') return text;
  const withPath = text.includes('/') ? redactPathSecrets(text, { anyLongSegment: false }) : text;
  if (!withPath.includes('=')) return withPath;
  return withPath.replace(PARAM_RE, (whole, lead: string, key: string, value: string) => {
    if (!value || !isSensitiveKey(key)) return whole;
    return `${lead}${key}=${REDACTED_QUERY_VALUE}`;
  });
}

const MAX_DEPTH = 16;

/**
 * Write `next` into `container[key]`; if the container is frozen / read-only, switch to a
 * shallow copy (copy-on-write) and write there. Returns the container to keep using.
 */
function put<C extends object>(container: C, key: string | number, next: unknown, original: C): C {
  if (container === original && (Object.isFrozen(container) || !isWritable(container, key))) {
    container = (Array.isArray(container) ? [...container] : { ...container }) as C;
  }
  (container as Record<string | number, unknown>)[key] = next;
  return container;
}

function isWritable(obj: object, key: string | number): boolean {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return !d || d.writable === true || typeof d.set === 'function';
}

const SCRUBBED_HEADERS = new Set([
  SEARCH_QUERY_HEADER_NAME,
  'x-hop-timing',
  'x-ebda-client-ip',
  'x-ebda-ssr-auth',
]);
function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSensitiveQuery(value);
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    // `query_string` as `[key, value][]` pairs.
    if (
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string' &&
      isSensitiveKey(value[0])
    ) {
      return put(value, 1, REDACTED_QUERY_VALUE, value);
    }
    let out: unknown[] = value;
    for (let i = 0; i < value.length; i++) {
      const next = scrubValue(value[i], depth + 1, seen);
      if (next !== value[i]) out = put(out, i, next, value);
    }
    return out;
  }
  const obj = value as Record<string, unknown>;
  let out: Record<string, unknown> = obj;
  for (const key of Object.keys(obj)) {
    // The typed search term rides in this request header (Ruling SEARCH-URL-1 / SEARCH-P2-9);
    // an SDK that records request headers must not carry it to Sentry or PostHog.
    // `x-hop-timing` carries the operator token (HOP_TIMING_TOKEN) of the API's per-hop timing log.
    // `x-ebda-client-ip` / `x-ebda-ssr-auth`: the shopper address a storefront render forwards and its HMAC
    // (Ruling RL-SSR-IP-6); the API's Sentry wrapper sees the raw request before worker.ts strips them.
    if (SCRUBBED_HEADERS.has(key.toLowerCase()) && obj[key]) {
      out = put(out, key, REDACTED_QUERY_VALUE, obj);
      continue;
    }
    const next = scrubValue(obj[key], depth + 1, seen);
    if (next !== obj[key]) out = put(out, key, next, obj);
  }
  // `query_string` as an object (`{ search: '…' }`).
  const qs = out.query_string;
  if (qs && typeof qs === 'object' && !Array.isArray(qs)) {
    const q = qs as Record<string, unknown>;
    let q2: Record<string, unknown> = q;
    for (const key of Object.keys(q)) {
      if (isSensitiveKey(key) && q[key]) q2 = put(q2, key, REDACTED_QUERY_VALUE, q);
    }
    if (q2 !== q) out = put(out, 'query_string', q2, obj);
  }
  return out;
}

/**
 * Scrub a Sentry event / transaction (every string, at any depth: request URL and query
 * string, breadcrumbs, spans, contexts, extra, transaction name). Use as `beforeSend` and
 * `beforeSendTransaction`. Mutates in place where it can; a frozen object is copied instead
 * (copy-on-write), so use the RETURN value.
 */
export function scrubSentryEvent<T>(event: T): T {
  return scrubValue(event, 0, new WeakSet()) as T;
}

/** `beforeBreadcrumb`: scrub navigation / fetch / xhr / console breadcrumbs. */
export function scrubSentryBreadcrumb<T>(breadcrumb: T): T {
  return scrubValue(breadcrumb, 0, new WeakSet()) as T;
}

/**
 * PostHog `before_send`: scrub a capture result (`$current_url`, `$referrer`,
 * `$initial_current_url` / `$initial_referrer` in `$set_once`, custom URL props, exception
 * values). A `/search?q=<phone>` pageview leaves as `/search?q=[Filtered]`. Null passes through
 * (an earlier hook dropped the event).
 */
export function scrubPostHogCapture<T>(capture: T | null): T | null {
  return capture == null ? capture : (scrubValue(capture, 0, new WeakSet()) as T);
}
