import type { ErrorEvent } from '@sentry/cloudflare';

const PHONE = /\+?\d{8,15}/g;
// Allowlist: anything else (auth, cookies, signatures, client IPs) never leaves the worker.
const SAFE_HEADERS = new Set(['user-agent', 'content-type', 'content-length', 'cf-ray', 'accept']);

const mask = (s: string | undefined) => s?.replace(PHONE, '[phone]');

/** Sentry beforeSend: no bodies, cookies, query strings or non-allowlisted headers; no user; phone numbers masked. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.headers) {
      event.request.headers = Object.fromEntries(Object.entries(event.request.headers).filter(([k]) => SAFE_HEADERS.has(k.toLowerCase())));
    }
    if (event.request.url) {
      try {
        const u = new URL(event.request.url);
        u.search = '';
        u.hash = '';
        event.request.url = mask(decodeURI(u.toString()));
      } catch {
        delete event.request.url;
      }
    }
  }
  delete event.user;
  if (event.message) event.message = mask(event.message);
  for (const v of event.exception?.values ?? []) if (v.value) v.value = mask(v.value);
  return event;
}
