/**
 * AI credit packs (self-service A9, Chat half): a merchant buys more AI credits by card when a package's monthly credits run out.
 *
 * Price (Ruling CREDIT-PACK-PRICE-1): per credit, the DEAREST per-credit rate among the active paid monthly packages, rounded up to a whole piaster, times the pack size.
 * A pack therefore never undercuts upgrading, and no new price table exists to drift: change a package price and the packs follow. Cost if wrong: a pack priced too high or
 * too low until Ahmad sets another rule; no stored price is affected (an order keeps the amount it was created with, and the webhook checks that exact amount).
 *
 * Money rules: whole piastres; the credit is written ONLY from a verified provider webhook (or the provider's inquiry) as ONE append-only credit-ledger row with ref
 * `credit-pack:<transaction id>`, and the order is first bound to that one transaction id, so a redelivered webhook, a repair racing it, or a second payment on the same order
 * credits at most once. The order id is `cp_<confirmation id>`: the single-use confirmation is the idempotency key, so a double click is one order.
 */
import type { Env } from '../../env';
import { sessionState } from '../identity/session';
import { alert } from '../observability';
import { frozenForOffboarding, refuseIfOffboarded } from '../ops/offboarded';
import { paymentProvider, topupsEnabled, type ParsedWebhook, type PaymentProvider } from './payments';
import { consumeConfirmation, type Consumed } from './confirmation';
import { drainKeyset, type PassOpts } from './drain';

/** Pack sizes in credits. One credit pays for one AI turn (credits.ts). */
export const CREDIT_PACKS = [100, 500, 1000] as const;
export const REPAIR_AFTER_MS = 15 * 60_000;
export const EXPIRE_AFTER_MS = 7 * 86_400_000;

export type CreditPack = { id: string; credits: number; priceMinor: number };
export type CreditOrderRow = { order_id: string; workspace_id: string; credits: number; amount_minor: number; currency: string; state: 'pending' | 'paid' | 'failed' | 'expired'; created_at: number; transaction_id: string | null };
const COLS = 'order_id, workspace_id, credits, amount_minor, currency, state, created_at, transaction_id';
const stubOf = (env: Env, ws: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));

export async function creditPacks(env: Env): Promise<CreditPack[]> {
  const unit = (await env.DB.prepare('SELECT max((price_minor + ai_credits - 1) / ai_credits) AS unit FROM packages WHERE active = 1 AND price_minor > 0 AND ai_credits > 0 AND period_months = 1').first<{ unit: number | null }>())?.unit ?? null;
  if (!unit || !Number.isSafeInteger(unit) || unit <= 0) return [];
  return CREDIT_PACKS.map((credits) => ({ id: `credits-${credits}`, credits, priceMinor: unit * credits }));
}

/** What the merchant is shown and what the confirmation binds to. */
export const packPayload = (p: CreditPack) => ({ packId: p.id, credits: p.credits, priceMinor: p.priceMinor });

export const creditCheckoutOn = (env: Env): boolean => topupsEnabled(env) && paymentProvider(env)?.confirmationReady() === true;

export type StartCreditPack =
  | { ok: true; orderId: string; credits: number; amountMinor: number; checkoutUrl: string }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'session_revoked' | 'unknown_pack' | 'offboarding' | Exclude<Consumed, 'ok'> };

export async function startCreditPack(env: Env, a: { workspaceId: string; userId: string; sessionId: string; packId: string; confirmId: string; token: string }, now = Date.now()): Promise<StartCreditPack> {
  if (await frozenForOffboarding(env, a.workspaceId)) return { ok: false, reason: 'offboarding' };
  if (!topupsEnabled(env)) return { ok: false, reason: 'disabled' };
  const provider = paymentProvider(env);
  // Without the Kashier secret key every webhook would be refused: never let a merchant pay for credits that could not arrive.
  if (!provider || !provider.confirmationReady()) return { ok: false, reason: 'unavailable' };
  const pack = (await creditPacks(env)).find((p) => p.id === a.packId);
  if (!pack) return { ok: false, reason: 'unknown_pack' };
  const session = await sessionState(env, a.sessionId);
  if (session === 'revoked') return { ok: false, reason: 'session_revoked' };
  if (session === 'unavailable') return { ok: false, reason: 'unavailable' };
  // The price is recomputed NOW: a pack whose price moved since the preview does not match the confirmed payload and is refused.
  const c = await consumeConfirmation(env, { workspaceId: a.workspaceId, userId: a.userId, action: 'credit_pack', confirmId: a.confirmId, token: a.token, payload: packPayload(pack) }, now);
  if (c !== 'ok') return { ok: false, reason: c };
  const orderId = `cp_${a.confirmId}`;
  await env.DB.prepare("INSERT INTO credit_orders (order_id, workspace_id, credits, amount_minor, currency, state, created_by, created_at) VALUES (?, ?, ?, ?, 'EGP', 'pending', ?, ?)")
    .bind(orderId, a.workspaceId, pack.credits, pack.priceMinor, a.userId, now).run();
  try {
    const { checkoutUrl } = await provider.createSession({ orderId, totalMinor: pack.priceMinor, currency: 'EGP' });
    // Only the provider's own checkout origin is ever handed to a merchant's browser.
    if (new URL(checkoutUrl).origin !== new URL(env.KASHIER_CHECKOUT_URL ?? 'https://checkout.kashier.io').origin) throw new Error('unexpected checkout origin');
    return { ok: true, orderId, credits: pack.credits, amountMinor: pack.priceMinor, checkoutUrl };
  } catch {
    // Queue-then-send fails fast: the row is closed, never left as an orphan `pending`.
    await env.DB.prepare("UPDATE credit_orders SET state = 'failed' WHERE order_id = ? AND state = 'pending'").bind(orderId).run();
    return { ok: false, reason: 'unavailable' };
  }
}

export const findCreditOrder = (env: Env, orderId: string): Promise<CreditOrderRow | null> => env.DB.prepare(`SELECT ${COLS} FROM credit_orders WHERE order_id = ?`).bind(orderId).first<CreditOrderRow>();
export const getCreditOrder = (env: Env, workspaceId: string, orderId: string): Promise<CreditOrderRow | null> => env.DB.prepare(`SELECT ${COLS} FROM credit_orders WHERE order_id = ? AND workspace_id = ?`).bind(orderId, workspaceId).first<CreditOrderRow>();

/**
 * Adds the pack's credits once for this payment. The order is first bound to ONE provider transaction (set only while empty): a second SUCCESS carrying another
 * transaction id is `conflict` and adds nothing. Throws when the workspace could not be reached (the caller answers 5xx and the delivery is retried).
 */
export async function creditPackPaid(env: Env, row: CreditOrderRow, transactionId: string, now: number): Promise<'credited' | 'duplicate' | 'conflict' | 'offboarded'> {
  if (await refuseIfOffboarded(env, row.workspace_id, 'credit_pack', row.order_id, now)) return 'offboarded';
  const claim = await env.DB.prepare('UPDATE credit_orders SET transaction_id = ? WHERE order_id = ? AND transaction_id IS NULL').bind(transactionId, row.order_id).run();
  if (claim.meta.changes !== 1) {
    const cur = await env.DB.prepare('SELECT transaction_id FROM credit_orders WHERE order_id = ?').bind(row.order_id).first<{ transaction_id: string | null }>();
    if (cur?.transaction_id !== transactionId) return 'conflict';
  }
  const r = await stubOf(env, row.workspace_id).postAiCredits({ kind: 'purchase', amount: row.credits, ref: `credit-pack:${transactionId}`, note: `credit pack ${row.order_id}` }, now);
  if (!r.ok && r.reason !== 'duplicate') throw new Error(`credit pack refused: ${r.reason}`);
  await env.DB.prepare("UPDATE credit_orders SET state = 'paid', paid_at = coalesce(paid_at, ?) WHERE order_id = ? AND state IN ('pending', 'expired', 'failed')").bind(now, row.order_id).run();
  return r.ok ? 'credited' : 'duplicate';
}

/** A CONFIRMED webhook for a credit order (the caller already asked the provider what the signed transaction really is). Returns the resolution word. */
export async function applyCreditWebhook(env: Env, row: CreditOrderRow, ev: ParsedWebhook, now: number): Promise<string> {
  if (ev.event === 'refund') {
    // Taking credits back is a person's decision (some may be spent): raise it, never claw back automatically.
    if (ev.status === 'SUCCESS') alert('credit_pack_refunded', { workspace: row.workspace_id, orderId: row.order_id });
    return ev.status === 'SUCCESS' ? 'refund_manual' : 'ignored';
  }
  if (ev.event !== 'pay') return 'ignored';
  if (ev.status === 'FAILURE') {
    await env.DB.prepare("UPDATE credit_orders SET state = 'failed' WHERE order_id = ? AND state = 'pending'").bind(row.order_id).run();
    return 'failed';
  }
  if (ev.status !== 'SUCCESS') return 'ignored';
  if (ev.currency !== row.currency || ev.amountMinor !== row.amount_minor) {
    alert('credit_pack_amount_mismatch', { workspace: row.workspace_id });
    return 'amount_mismatch';
  }
  const c = await creditPackPaid(env, row, ev.transactionId, now);
  if (c === 'conflict') {
    alert('duplicate_success', { kind: 'credit_pack', workspace: row.workspace_id, eventKey: ev.eventKey });
    return 'duplicate_success';
  }
  if (c === 'offboarded') return 'offboarded_manual_refund';
  return c === 'duplicate' ? 'duplicate' : 'credited';
}

/** Daily: ask the provider about credit orders still pending after REPAIR_AFTER_MS (a lost webhook); credit what was paid, close what failed or is a week old. */
export async function repairCreditOrders(env: Env, provider: PaymentProvider | null = paymentProvider(env), now = Date.now(), opts: PassOpts = {}): Promise<{ checked: number; credited: number }> {
  if (!topupsEnabled(env) || !provider) return { checked: 0, credited: 0 };
  const size = opts.page ?? 200;
  let credited = 0;
  const { handled } = await drainKeyset<CreditOrderRow, [number, string]>({
    name: 'repair_credit_orders', pageSize: size, ...(opts.maxBatches ? { maxBatches: opts.maxBatches } : {}),
    page: async (after) => (await env.DB.prepare(`SELECT ${COLS} FROM credit_orders WHERE state = 'pending' AND created_at < ?1 ${after ? 'AND (created_at > ?2 OR (created_at = ?2 AND order_id > ?3))' : ''} ORDER BY created_at, order_id LIMIT ${size}`)
      .bind(now - REPAIR_AFTER_MS, ...(after ?? [])).all<CreditOrderRow>()).results,
    cursorOf: (r) => [r.created_at, r.order_id],
    handle: async (row) => {
      if (now - row.created_at > EXPIRE_AFTER_MS) {
        await env.DB.prepare("UPDATE credit_orders SET state = 'expired' WHERE order_id = ? AND state = 'pending'").bind(row.order_id).run();
        return;
      }
      const q = await provider.inquire(row.order_id);
      if (q === 'unsupported' || q === 'unavailable' || q.status === 'PENDING') return;
      if (q.status === 'SUCCESS' && !q.transactionId) return;
      // The webhook's own apply path (claim on the transaction id, amount check), so there is no second way to credit.
      const ev: ParsedWebhook = { event: 'pay', status: q.status, orderId: row.order_id, transactionId: q.transactionId ?? `none:${row.order_id}`, amountMinor: q.amountMinor ?? -1, currency: q.currency ?? '', eventKey: `kashier:${q.transactionId ?? row.order_id}:${q.status}` };
      try {
        if ((await applyCreditWebhook(env, row, ev, now)) === 'credited') credited++;
      } catch (err) {
        alert('credit_pack_repair_failed', { error: err instanceof Error ? err.name : 'error' });
      }
    },
  });
  return { checked: handled, credited };
}
