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
import { applyPackageWebhook, findPackageOrder } from './package-orders';
import { packagesEnabled, paymentProvider, topupsEnabled, type ParsedWebhook, type PaymentProvider } from './payments';

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
  // Without the Kashier secret key every webhook would be refused: do not let customers pay for a credit that could never arrive.
  if (!provider || !provider.confirmationReady()) return { ok: false, reason: 'unavailable' };
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

/**
 * Credits the exact top-up amount once for this order. The order is first bound to ONE provider transaction (`transaction_id`, set only
 * while empty): a second SUCCESS carrying another transaction id is `conflict` and credits nothing, so two different payments (or a refund
 * relabelled as a payment) can never both credit one order. Throws if the workspace could not be reached (the caller answers 5xx).
 */
async function credit(env: Env, row: TopupRow, transactionId: string, now: number): Promise<'credited' | 'duplicate' | 'conflict'> {
  const claim = await env.DB.prepare('UPDATE topups SET transaction_id = ? WHERE order_id = ? AND transaction_id IS NULL').bind(transactionId, row.order_id).run();
  if (claim.meta.changes !== 1) {
    const cur = await env.DB.prepare('SELECT transaction_id FROM topups WHERE order_id = ?').bind(row.order_id).first<{ transaction_id: string | null }>();
    if (cur?.transaction_id !== transactionId) return 'conflict';
  }
  const r = await stubOf(env, row.workspace_id).postWallet({ kind: 'topup', netMinor: row.amount_minor, ref: `kashier:${transactionId}`, note: `top-up ${row.order_id}` }, now);
  if (!r.ok && r.reason !== 'duplicate') throw new Error(`top-up credit refused: ${r.reason}`);
  await env.DB.prepare("UPDATE topups SET state = 'paid', paid_at = coalesce(paid_at, ?) WHERE order_id = ? AND state IN ('pending', 'expired', 'failed')").bind(now, row.order_id).run();
  return r.ok ? 'credited' : 'duplicate';
}

const AGED_AFTER_MS = 24 * 3_600_000;
const KEEP_RESOLVED_MS = 30 * 86_400_000;

/** Keeps a delivery that could not be confirmed, so the daily pass can re-confirm it even if the provider never retries. */
async function recordUnconfirmed(env: Env, eventKey: string, raw: string, signature: string | null, reason: string, now: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO unconfirmed_webhooks (event_key, raw_body, signature, first_seen, last_seen, attempts, last_reason) VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(event_key) DO UPDATE SET last_seen = excluded.last_seen, attempts = attempts + 1, last_reason = excluded.last_reason WHERE resolved_at IS NULL`,
  ).bind(eventKey, raw, signature ?? '', now, now, reason).run();
}
const resolveUnconfirmed = (env: Env, eventKey: string | undefined, now: number) =>
  eventKey ? env.DB.prepare('UPDATE unconfirmed_webhooks SET resolved_at = ? WHERE event_key = ? AND resolved_at IS NULL').bind(now, eventKey).run() : Promise.resolve();

export type WebhookOutcome = { status: 200 | 401 | 404 | 500 | 503; body: string };

/**
 * The provider webhook. 401 = signature/structure invalid (nothing read from the payload). 200 = acknowledged (including ignored events).
 * 5xx = retry me. Money facts come from the SIGNED fields; the unsigned `event` label is never applied: for an order of ours the signed
 * transaction is confirmed with the provider first (`provider.confirm`), and the kind and status the provider reports are what is acted on.
 * If the provider cannot be asked, or its answer does not match, the answer is 503 and nothing happens (the provider retries).
 */
export async function handleProviderWebhook(env: Env, raw: string, signature: string | null, provider: PaymentProvider | null = paymentProvider(env), now = Date.now()): Promise<WebhookOutcome> {
  if (!topupsEnabled(env) && !packagesEnabled(env)) return { status: 404, body: 'not found' };
  if (!provider) return { status: 503, body: 'unavailable' };
  const signed = await provider.verifyWebhook(raw, signature);
  if (!signed) return { status: 401, body: 'unauthorized' };
  const row = await env.DB.prepare(`SELECT ${COLS} FROM topups WHERE order_id = ?`).bind(signed.orderId).first<TopupRow>();
  const pkg = row ? null : await findPackageOrder(env, signed.orderId);
  if (!row && !pkg) {
    alert('topup_unknown_order');
    return { status: 200, body: 'ok' };
  }
  if (row && !topupsEnabled(env)) return { status: 404, body: 'not found' };
  if (signed.status === 'PENDING') return { status: 200, body: 'ok' }; // nothing to apply yet; the final status arrives as its own delivery
  let ev: ParsedWebhook;
  try {
    ev = await provider.confirm(signed);
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 80) : 'error';
    alert('webhook_unconfirmed', { eventKey: signed.eventKey, reason });
    if (signed.eventKey) await recordUnconfirmed(env, signed.eventKey, raw, signature, reason, now).catch(() => undefined);
    return { status: 503, body: 'unconfirmed' };
  }
  if (pkg) {
    try {
      await applyPackageWebhook(env, pkg, ev, now);
    } catch (err) {
      alert('package_webhook_failed', { error: err instanceof Error ? err.name : 'error' });
      return { status: 500, body: 'retry' };
    }
    await resolveUnconfirmed(env, signed.eventKey, now);
    return { status: 200, body: 'ok' };
  }
  const t = row!;
  try {
    if (ev.event === 'pay') {
      if (ev.status === 'FAILURE') {
        await env.DB.prepare("UPDATE topups SET state = 'failed' WHERE order_id = ? AND state = 'pending'").bind(t.order_id).run();
        return { status: 200, body: 'ok' };
      }
      if (ev.status !== 'SUCCESS') return { status: 200, body: 'ok' };
      if (ev.currency !== t.currency || ev.amountMinor !== t.total_minor) {
        alert('topup_amount_mismatch', { workspace: t.workspace_id });
        return { status: 200, body: 'ok' };
      }
      if ((await credit(env, t, ev.transactionId, now)) === 'conflict') alert('duplicate_success', { kind: 'topup', workspace: t.workspace_id, eventKey: ev.eventKey });
    } else if (ev.event === 'refund' && ev.status === 'SUCCESS') {
      // A refund is a DIFFERENT transaction from the payment it returns, and the order must have been paid.
      if (t.state !== 'paid' || !t.transaction_id || t.transaction_id === ev.transactionId) {
        alert('refund_refused', { kind: 'topup', workspace: t.workspace_id, eventKey: ev.eventKey });
        return { status: 200, body: 'ok' };
      }
      const r = await stubOf(env, t.workspace_id).postWallet({ kind: 'chargeback', netMinor: -ev.amountMinor, ref: `chargeback:${ev.transactionId}`, note: `provider refund of ${t.order_id}: operator review` }, now);
      if (r.ok) {
        await env.DB.prepare('UPDATE topups SET refunded_minor = min(total_minor, refunded_minor + ?) WHERE order_id = ?').bind(ev.amountMinor, t.order_id).run();
        alert('topup_refunded_by_provider', { workspace: t.workspace_id, orderId: t.order_id });
      }
    }
  } catch (err) {
    alert('topup_webhook_failed', { error: err instanceof Error ? err.name : 'error' });
    return { status: 500, body: 'retry' };
  }
  await resolveUnconfirmed(env, signed.eventKey, now);
  return { status: 200, body: 'ok' };
}

/**
 * Daily: deliveries that could not be confirmed are run through the SAME path as a live webhook (so whichever confirms first, the claim on the
 * transaction id makes it one effect). One that is still unconfirmed 24 h after it first arrived alerts `webhook_unconfirmed_aged` (the
 * structured alert line the alert bridge turns into a notice, like every other money alert here).
 */
export async function reconfirmUnconfirmed(env: Env, provider: PaymentProvider | null = paymentProvider(env), now = Date.now()): Promise<{ resolved: number; pending: number; aged: number }> {
  if (!provider) return { resolved: 0, pending: 0, aged: 0 };
  const { results } = await env.DB.prepare('SELECT event_key, raw_body, signature, first_seen FROM unconfirmed_webhooks WHERE resolved_at IS NULL ORDER BY first_seen LIMIT 100').all<{ event_key: string; raw_body: string; signature: string; first_seen: number }>();
  let resolved = 0;
  let pending = 0;
  let aged = 0;
  for (const r of results) {
    const out = await handleProviderWebhook(env, r.raw_body, r.signature, provider, now).catch(() => ({ status: 500 as const, body: 'error' }));
    if (out.status === 200) { resolved++; continue; }
    pending++;
    if (now - r.first_seen > AGED_AFTER_MS) {
      aged++;
      alert('webhook_unconfirmed_aged', { eventKey: r.event_key, firstSeen: r.first_seen, lastStatus: out.status });
    }
  }
  await env.DB.prepare('DELETE FROM unconfirmed_webhooks WHERE resolved_at IS NOT NULL AND resolved_at < ?').bind(now - KEEP_RESOLVED_MS).run();
  return { resolved, pending, aged };
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
        const c = await credit(env, row, q.transactionId, now);
        if (c === 'credited') credited++;
        else if (c === 'conflict') alert('duplicate_success', { kind: 'topup', workspace: row.workspace_id });
      } catch (err) {
        alert('topup_repair_failed', { error: err instanceof Error ? err.name : 'error' });
      }
    }
  }
  if (unsupported) alert('topup_inquiry_unsupported');
  return { checked: results.length, credited, unsupported };
}
