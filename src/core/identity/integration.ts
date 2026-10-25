/**
 * Revocation check for integrator tokens: EVERY request with one asks `Accounts.isRevoked(clientId)` and fails closed (unavailable = 503).
 *
 * Cache (per isolate): only an "ok" answer is remembered, for at most 30 s. Staleness class: BOUNDED-stale. Residual window: a client revoked
 * just after an "ok" check can still be served by an isolate that remembers it for up to 30 s (the token itself lives 10 minutes anyway). A
 * revoked or unavailable answer is never cached, so the next request asks again. Nothing here is a permission cache: the token's scopes are
 * re-read from the (verified) token on every request.
 */
import type { Env } from '../../env';
import { sessionState, type SessionState } from './session';

export const REVOCATION_CACHE_MS = 30_000;
const MAX_ENTRIES = 1_000;
const okUntil = new Map<string, number>();
let clock: () => number = Date.now;

/** Tests only. */
export const configureIntegrationClock = (c: (() => number) | null): void => { clock = c ?? Date.now; };
export const clearIntegrationCache = (): void => okUntil.clear();

export async function integrationState(env: Env, clientId: string): Promise<SessionState> {
  const now = clock();
  const until = okUntil.get(clientId);
  if (until !== undefined && until > now) return 'ok';
  const s = await sessionState(env, clientId);
  if (s === 'ok') {
    if (okUntil.size >= MAX_ENTRIES) for (const [k, v] of okUntil) if (v <= now) okUntil.delete(k);
    if (okUntil.size >= MAX_ENTRIES) okUntil.clear();
    okUntil.set(clientId, now + REVOCATION_CACHE_MS);
  } else {
    okUntil.delete(clientId);
  }
  return s;
}
