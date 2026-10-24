import type { ErrorEvent } from '@sentry/cloudflare';

// A run of 8+ digits (ASCII, Arabic-Indic or Persian), optionally with +, spaces, dashes, dots or parentheses between them.
const DIGIT = '[0-9\\u0660-\\u0669\\u06f0-\\u06f9]';
// Separators include Unicode format characters (\p{Cf}: bidi marks, zero-width joiners) so they cannot split a number past the mask.
const PHONE_LIKE = new RegExp(`\\+?${DIGIT}(?:[\\s\\-().\\p{Cf}]*${DIGIT}){7,}`, 'gu');
// Allowlist: anything else (auth, cookies, signatures, client IPs) never leaves the worker.
const SAFE_HEADERS = new Set(['user-agent', 'content-type', 'content-length', 'cf-ray', 'accept']);

export const maskPhones = (s: string | undefined) => s?.replace(PHONE_LIKE, '[phone]');

function scrubUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    // The segment after /contacts/ is a phone number by position, whatever its encoding.
    const path = u.pathname.replace(/(\/contacts\/)[^/]+/, '$1__PHONE__');
    return maskPhones(decodeURI(`${u.origin}${path}`))?.replace('__PHONE__', '[phone]');
  } catch {
    return undefined;
  }
}

/** Sentry beforeSend: no bodies, cookies, query strings, extra/contexts/tags or non-allowlisted headers; no user; phones masked. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.headers) {
      event.request.headers = Object.fromEntries(Object.entries(event.request.headers).filter(([k]) => SAFE_HEADERS.has(k.toLowerCase())));
    }
    if (event.request.url) {
      const url = scrubUrl(event.request.url);
      if (url) event.request.url = url;
      else delete event.request.url;
    }
  }
  delete event.user;
  delete event.extra;
  delete event.tags;
  delete event.contexts;
  if (event.message) event.message = maskPhones(event.message);
  for (const v of event.exception?.values ?? []) if (v.value) v.value = maskPhones(v.value);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(({ data: _data, message, ...rest }) => ({ ...rest, ...(message ? { message: maskPhones(message) } : {}) }));
  }
  return event;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/**
 * What may be logged about a caught value: its class (and a short machine code if it has one), never its text. Error
 * messages routinely echo input (a phone number, an e-mail, a body), and `throw "string"` has no class at all.
 */
export function errClass(err: unknown): string {
  const name = err instanceof Error ? (err.constructor?.name || err.name || 'Error') : err === null ? 'null' : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' || (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) ? `${name}:${code}` : name;
}

/** An error's text for storage next to a task (operators read it): phones and e-mails masked, bounded. Never for logs. */
export function safeMessage(err: unknown, max = 200): string {
  const raw = String((err as { message?: unknown } | null)?.message ?? err);
  return (maskPhones(raw) ?? '').replace(EMAIL, '[email]').slice(0, max);
}
