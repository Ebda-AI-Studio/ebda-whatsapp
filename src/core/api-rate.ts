import { Buckets } from './request-guards';

/**
 * F4: rate limits on the authenticated API, after the caller is known (so an unauthenticated request never spends anybody's allowance):
 * one bucket per workspace (everything its staff, its inbox and its servers do together) and a tighter one per integrator CLIENT (keyed by the
 * client id, not the token: a client re-mints its token every few minutes). STALENESS CLASS: BOUNDED-stale, per isolate, the same residual as
 * the public-route buckets in request-guards.ts (up to isolates x rate; it sheds a runaway script or a leaked token, it guards no money or
 * permission). Defaults sit far above the busiest real inbox (a few requests a second) and a polite integration (a send per second).
 */
export type ApiLimits = { workspace: { ratePerSec: number; burst: number }; integration: { ratePerSec: number; burst: number } };
export const DEFAULT_API_LIMITS: ApiLimits = { workspace: { ratePerSec: 20, burst: 100 }, integration: { ratePerSec: 5, burst: 30 } };

let limits = DEFAULT_API_LIMITS;
let workspaceBuckets = new Buckets(limits.workspace.ratePerSec, limits.workspace.burst);
let integrationBuckets = new Buckets(limits.integration.ratePerSec, limits.integration.burst);

/** Replaces the limits (and empties the buckets). Returns the previous limits so a test can put them back. */
export function configureApiLimits(next: ApiLimits): ApiLimits {
  const prev = limits;
  limits = next;
  workspaceBuckets = new Buckets(next.workspace.ratePerSec, next.workspace.burst);
  integrationBuckets = new Buckets(next.integration.ratePerSec, next.integration.burst);
  return prev;
}

/** 0 = go on; otherwise the seconds the caller must wait. An integrator client is checked first so a flooding client cannot drain its workspace's bucket. */
export function takeApiToken(storeId: string, integrationClientId: string | null): number {
  const wait = integrationClientId ? integrationBuckets.take(`${storeId}|${integrationClientId}`) : 0;
  return wait || workspaceBuckets.take(storeId);
}
