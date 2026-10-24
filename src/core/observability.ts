import type { ErrorEvent } from '@sentry/cloudflare';

// A run of 8+ digits (ASCII, Arabic-Indic or Persian), optionally with +, spaces, dashes, dots or parentheses between them.
const DIGIT = '[0-9\\u0660-\\u0669\\u06f0-\\u06f9]';
const PHONE_LIKE = new RegExp(`\\+?${DIGIT}(?:[\\s\\-().]*${DIGIT}){7,}`, 'g');
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
