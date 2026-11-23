// InstaPay auto-confirm lifecycle (money path). Pure helpers only: storage and side effects stay in each product.
export type AutoState = 'pending_decision' | 'auto_confirmed' | 'needs_human' | 'reverted' | 'failed';
export type AutoEvent = 'decide_auto' | 'decide_human' | 'revert' | 'activation_failed';

const TABLE: Record<AutoState, Partial<Record<AutoEvent, AutoState>>> = {
  pending_decision: { decide_auto: 'auto_confirmed', decide_human: 'needs_human', activation_failed: 'failed' },
  auto_confirmed: { revert: 'reverted' },
  reverted: { revert: 'reverted' }, // a replayed tap is a no-op, not an error
  needs_human: {},
  failed: {},
};

export function nextAutoState(s: AutoState, e: AutoEvent): AutoState | 'illegal' {
  return TABLE[s]?.[e] ?? 'illegal';
}

export function autoConfirmKey(product: 'store' | 'chat', receiptOrRequestId: string): string {
  return `instapay-auto:${product}:${receiptOrRequestId}`;
}
/** idempotency key of the credit-removal ledger entry written by a revert (one removal per payment, however many taps) */
export function revertKey(product: 'store' | 'chat', receiptOrRequestId: string): string {
  return `instapay-revert:${product}:${receiptOrRequestId}`;
}

export const REVERT_GRACE_MS = 48 * 3600_000;
export function revertGraceUntil(now: number): number {
  return now + REVERT_GRACE_MS;
}

/** INSTAPAY-CAP-2: a FREE package (monthly price exactly 0, incl. `store-included`) has no month price to cap by, so its first auto-confirmed payment is this fixed 500 EGP (piastres). */
export const FREE_PLAN_FIRST_PAYMENT_CAP_MINOR = 50000;

/** First auto-confirmed payment is capped at ONE month of the chosen plan (Chat top-up: the Chat plan's monthly price). A free plan (price exactly 0) gets
 *  FREE_PLAN_FIRST_PAYMENT_CAP_MINOR (INSTAPAY-CAP-2). No plan price (null / missing / invalid) -> 0 -> always human (no plan = no automatic credit). */
export function firstPaymentCapMinor(a: { monthlyPriceMinor: number | null }): number {
  const p = a?.monthlyPriceMinor;
  if (p === 0) return FREE_PLAN_FIRST_PAYMENT_CAP_MINOR;
  return typeof p === 'number' && Number.isSafeInteger(p) && p > 0 ? p : 0;
}

/** INSTAPAY-CLEAN-1 (Ahmad: "so no one waits 48 hours"). Human-confirmed: clean at once unless reverted. Auto-confirmed: clean once it has appeared in a digest
 *  that was actually SENT to Ahmad (`digestSentAt`, stamped when the bridge confirmed the send; not older than the payment, not in the future) and has not
 *  been reverted. No extra waiting window. Until that digest is sent the payment is NOT clean, so a merchant's next payment above the first-payment cap
 *  waits for Ahmad instead of auto-confirming. */
export function isCleanPayment(p: { confirmedBy: 'human' | 'auto'; confirmedAt: number; digestSentAt: number | null; revertedAt: number | null }, now: number): boolean {
  if (p.revertedAt !== null) return false;
  if (p.confirmedBy === 'human') return true;
  if (p.confirmedBy !== 'auto') return false;
  const d = p.digestSentAt;
  if (typeof d !== 'number' || !Number.isFinite(d) || !Number.isFinite(p.confirmedAt) || !Number.isFinite(now)) return false;
  if (d < p.confirmedAt) return false; // a digest older than the payment cannot have listed it
  return d <= now; // a digest stamped in the future was not sent yet
}

/** Credits a revert removes for ONE payment (top-up and package credits alike): what that payment granted and nobody consumed, never more than
 *  the balance, never negative; consumed credits are not clawed back. Any invalid number -> 0 (leave it for the human). */
export function unusedCreditsToRemove(c: { granted: number; consumed: number; balance: number }): number {
  const ok = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!ok(c.granted) || !ok(c.consumed) || !ok(c.balance)) return 0;
  return Math.max(0, Math.min(c.granted - c.consumed, c.balance));
}
