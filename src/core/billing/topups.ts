/**
 * Wallet top-ups (Phase 7.4), behind TOPUPS_ENABLED (default off).
 *
 * Rules: a pending `topups` row is written in D1 when the OWNER starts a session (and the session is not revoked: fail closed when the
 * accounts binding is missing). The wallet is credited only from a webhook whose HMAC verified, with status SUCCESS and the order id,
 * amount and currency matching our pending row; the workspace comes from OUR row, never from the payload. The browser's return to our site
 * credits nothing (it only reads the row). A scheduled inquiry repairs a lost webhook. The credit ref is `kashier:<transactionId>`, so a
 * redelivered webhook or a repair racing the webhook credits once. WA-TOPUP-FEE-1: the merchant pays the card fee on top; the wallet is
 * credited the exact amount. A provider refund or chargeback becomes a negative `chargeback` row (debt) and an alert for the operator.
 */
import type { Env } from '../../env';
import { sessionState } from '../identity/session';
import { roundHalfEvenDiv } from './money';
import { paymentProvider, topupsEnabled, type PaymentProvider } from './payments';

export const MIN_TOPUP_MINOR = 1000;
export const MAX_TOPUP_MINOR = 5_000_000;
/** A pending top-up is checked with the provider after this long (the webhook normally arrives within seconds). */
export const REPAIR_AFTER_MS = 15 * 60_000;
export const EXPIRE_AFTER_MS = 7 * 86_400_000;

export type TopupRow = { order_id: string; workspace_id: string; amount_minor: number; fee_minor: number; total_minor: number; currency: string; state: 'pending' | 'paid' | 'failed' | 'expired'; created_at: number; transaction_id: string | null };
const COLS = 'order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_at, transaction_id';
const stubOf = (env: Env, workspaceId: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));
const alert = (what: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ alert: what, ...extra }));

/** The card fee on top of `amountMinor`: bps of the amount (half-even) plus a fixed part, both from the environment. */
export function feeFor(env: Env, amountMinor: number): number {
  const bps = Number(env.KASHIER_FEE_BPS ?? 0);
  const fixed = Number(env.KASHIER_FEE_FIXED_MINOR ?? 0);
  if (!Number.isSafeInteger(bps) || !Number.isSafeInteger(fixed) || bps < 0 || fixed < 0) return 0;
  return Number(roundHalfEvenDiv(BigInt(amountMinor) * BigInt(bps), 10000n)) + fixed;
}

export type StartResult =
  | { ok: true; orderId: string; amountMinor: number; feeMinor: number; totalMinor: number; checkoutUrl: string }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'session_revoked' | 'invalid_amount' };

export async function startTopup(env: Env, a: { workspaceId: string; userId: string; sessionId: string; amountMinor: number; returnUrl?: string }, now = Date.now()): Promise<StartResult> {
  if (!topupsEnabled(env)) return { ok: false, reason: 'disabled' };
  const provider = paymentProvider(env);
  if (!provider) return { ok: false, reason: 'unavailable' };
  if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor < MIN_TOPUP_MINOR || a.amountMinor > MAX_TOPUP_MINOR) return { ok: false, reason: 'invalid_amount' };
  // Spending the merchant's money: a revoked session must not be able to start it. No accounts binding = cannot check = refuse.
  const session = await sessionState(env, a.sessionId);
  if (session === 'revoked') return { ok: false, reason: 'session_revoked' };
  if (session === 'unavailable') return { ok: false, reason: 'unavailable' };
  const orderId = crypto.randomUUID();
  const fee = feeFor(env, a.amountMinor);
  const total = a.amountMinor + fee;
  await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'EGP', 'pending', ?, ?)")
    .bind(orderId, a.workspaceId, a.amountMinor, fee, total, a.userId, now).run();
  try {
    const { checkoutUrl } = await provider.createSession({ orderId, totalMinor: total, currency: 'EGP', ...(a.returnUrl ? { returnUrl: a.returnUrl } : {}) });
    return { ok: true, orderId, amountMinor: a.amountMinor, feeMinor: fee, totalMinor: total, checkoutUrl };
  } catch {
    await env.DB.prepare("UPDATE topups SET state = 'failed' WHERE order_id = ? AND state = 'pending'").bind(orderId).run();
    return { ok: false, reason: 'unavailable' };
  }
}

export async function getTopup(env: Env, workspaceId: string, orderId: string): Promise<TopupRow | null> {
  return env.DB.prepare(`SELECT ${COLS} FROM topups WHERE order_id = ? AND workspace_id = ?`).bind(orderId, workspaceId).first<TopupRow>();
}

/** Credits the exact top-up amount once for this provider transaction, then marks the row paid. Throws if the workspace could not be reached (the caller answers 5xx so the provider retries). */
async function credit(env: Env, row: TopupRow, transactionId: string, now: number): Promise<'credited' | 'duplicate'> {
  const r = await stubOf(env, row.workspace_id).postWallet({ kind: 'topup', netMinor: row.amount_minor, ref: `kashier:${transactionId}`, note: `top-up ${row.order_id}` }, now);
  if (!r.ok && r.reason !== 'duplicate') throw new Error(`top-up credit refused: ${r.reason}`);
  await env.DB.prepare("UPDATE topups SET state = 'paid', transaction_id = coalesce(transaction_id, ?), paid_at = coalesce(paid_at, ?) WHERE order_id = ? AND state IN ('pending', 'expired', 'failed')").bind(transactionId, now, row.order_id).run();
  return r.ok ? 'credited' : 'duplicate';
}

export type WebhookOutcome = { status: 200 | 401 | 404 | 500 | 503; body: string };

/** The provider webhook. 401 = signature/structure invalid (nothing read from the payload). 200 = acknowledged (including ignored events). 5xx = retry me. */
export async function handleProviderWebhook(env: Env, raw: string, signature: string | null, provider: PaymentProvider | null = paymentProvider(env), now = Date.now()): Promise<WebhookOutcome> {
  if (!topupsEnabled(env)) return { status: 404, body: 'not found' };
  if (!provider) return { status: 503, body: 'unavailable' };
  const ev = await provider.verifyWebhook(raw, signature);
  if (!ev) return { status: 401, body: 'unauthorized' };
  const row = await env.DB.prepare(`SELECT ${COLS} FROM topups WHERE order_id = ?`).bind(ev.orderId).first<TopupRow>();
  if (!row) {
    alert('topup_unknown_order');
    return { status: 200, body: 'ok' };
  }
  try {
    if (ev.event === 'pay') {
      if (ev.status === 'FAILURE') {
        await env.DB.prepare("UPDATE topups SET state = 'failed' WHERE order_id = ? AND state = 'pending'").bind(row.order_id).run();
        return { status: 200, body: 'ok' };
      }
      if (ev.status !== 'SUCCESS') return { status: 200, body: 'ok' };
      if (ev.currency !== row.currency || ev.amountMinor !== row.total_minor) {
        alert('topup_amount_mismatch', { workspace: row.workspace_id });
        return { status: 200, body: 'ok' };
      }
      await credit(env, row, ev.transactionId, now);
    } else if (ev.event === 'refund' && ev.status === 'SUCCESS') {
      const r = await stubOf(env, row.workspace_id).postWallet({ kind: 'chargeback', netMinor: -ev.amountMinor, ref: `chargeback:${ev.transactionId}`, note: `provider refund of ${row.order_id}: operator review` }, now);
      if (r.ok) {
        await env.DB.prepare('UPDATE topups SET refunded_minor = min(total_minor, refunded_minor + ?) WHERE order_id = ?').bind(ev.amountMinor, row.order_id).run();
        alert('topup_refunded_by_provider', { workspace: row.workspace_id, orderId: row.order_id });
      }
    }
  } catch (err) {
    alert('topup_webhook_failed', { error: err instanceof Error ? err.name : 'error' });
    return { status: 500, body: 'retry' };
  }
  return { status: 200, body: 'ok' };
}

/** Daily: ask the provider about top-ups still pending after REPAIR_AFTER_MS; credit what was paid, close what failed or is a week old. */
export async function repairTopups(env: Env, provider: PaymentProvider | null = paymentProvider(env), now = Date.now()): Promise<{ checked: number; credited: number; unsupported: boolean }> {
  if (!topupsEnabled(env) || !provider) return { checked: 0, credited: 0, unsupported: false };
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM topups WHERE state = 'pending' AND created_at < ? ORDER BY created_at LIMIT 200`).bind(now - REPAIR_AFTER_MS).all<TopupRow>();
  let credited = 0;
  let unsupported = false;
  for (const row of results) {
    if (now - row.created_at > EXPIRE_AFTER_MS) {
      await env.DB.prepare("UPDATE topups SET state = 'expired' WHERE order_id = ? AND state = 'pending'").bind(row.order_id).run();
      continue;
    }
    const q = await provider.inquire(row.order_id);
    if (q === 'unsupported') { unsupported = true; continue; }
    if (q === 'unavailable') continue;
    if (q.status === 'FAILURE') {
      await env.DB.prepare("UPDATE topups SET state = 'failed' WHERE order_id = ? AND state = 'pending'").bind(row.order_id).run();
    } else if (q.status === 'SUCCESS' && q.transactionId && q.amountMinor === row.total_minor && q.currency === row.currency) {
      try {
        if ((await credit(env, row, q.transactionId, now)) === 'credited') credited++;
      } catch (err) {
        alert('topup_repair_failed', { error: err instanceof Error ? err.name : 'error' });
      }
    }
  }
  if (unsupported) alert('topup_inquiry_unsupported');
  return { checked: results.length, credited, unsupported };
}
