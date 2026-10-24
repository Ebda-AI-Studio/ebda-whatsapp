/** Meta Cloud API error codes we act on. Retryable = the same send may succeed later. */
export const META_ERROR_HINTS: Record<number, { retryable: boolean; hint: string }> = {
  1: { retryable: true, hint: 'Unknown API error' },
  2: { retryable: true, hint: 'API service temporarily unavailable' },
  4: { retryable: true, hint: 'App-level rate limit' },
  80007: { retryable: true, hint: 'WABA rate limit' },
  130429: { retryable: true, hint: 'Throughput limit reached for this number' },
  131000: { retryable: true, hint: 'Generic Meta error' },
  131016: { retryable: true, hint: 'Service overloaded' },
  131056: { retryable: true, hint: 'Too many messages to the same recipient (pair rate limit)' },
  131026: { retryable: false, hint: 'Message undeliverable (number not on WhatsApp or blocked)' },
  131045: { retryable: false, hint: 'Phone number not registered or certificate invalid' },
  131047: { retryable: false, hint: 'More than 24 hours since the customer last messaged; use a template' },
  131049: { retryable: false, hint: 'Meta limited marketing messages to this user (frequency cap)' },
  131051: { retryable: false, hint: 'Unsupported message type' },
  131053: { retryable: false, hint: 'Media upload or download failed' },
  132000: { retryable: false, hint: 'Template parameter count mismatch' },
  132001: { retryable: false, hint: 'Template does not exist or is not approved' },
  2494051: { retryable: false, hint: 'Account has no valid payment method' },
};

export function isRetryable(code: number, httpStatus: number): boolean {
  const known = META_ERROR_HINTS[code];
  if (known) return known.retryable;
  return httpStatus >= 500 || httpStatus === 429;
}
