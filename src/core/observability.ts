import type { ErrorEvent } from '@sentry/cloudflare';

const PHONE = /\+?\d{8,15}/g;
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'x-hub-signature-256']);

const mask = (s: string | undefined) => s?.replace(PHONE, '[phone]');

/** Sentry beforeSend: no bodies, no cookies, no auth or signature headers, no user, no phone numbers. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.headers) {
      event.request.headers = Object.fromEntries(Object.entries(event.request.headers).filter(([k]) => !SECRET_HEADERS.has(k.toLowerCase())));
    }
  }
  delete event.user;
  if (event.message) event.message = mask(event.message);
  for (const v of event.exception?.values ?? []) if (v.value) v.value = mask(v.value);
  return event;
}
