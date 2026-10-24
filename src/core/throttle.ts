/** Meta's two send limits plus its frequency cap, enforced per WhatsApp number inside the workspace's DO. */
export const DEFAULT_TIER = 250;
export const DEFAULT_MPS = 80;
/** Unique business-initiated recipients are counted over a rolling 24 hours. */
export const TIER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Meta's current_limit names → unique recipients per rolling 24 h. */
export const TIER_LIMITS: Readonly<Record<string, number>> = {
  TIER_50: 50, TIER_250: 250, TIER_1K: 1_000, TIER_10K: 10_000, TIER_100K: 100_000, TIER_UNLIMITED: 1_000_000_000,
};

export type BucketDecision = { ok: true; tokens: number } | { ok: false; delayMs: number };

/** Token bucket: capacity = one second of throughput. Takes one token if available, else says how long until one is. */
export function bucketDecision(tokens: number, mps: number, now: number, tokensAt: number): BucketDecision {
  const have = Math.min(mps, tokens + (Math.max(0, now - tokensAt) / 1000) * mps);
  if (have >= 1) return { ok: true, tokens: have - 1 };
  return { ok: false, delayMs: Math.ceil(((1 - have) / mps) * 1000) };
}
