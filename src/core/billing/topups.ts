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
import { applyProviderRefund } from './card-refunds';
import { roundHalfEvenDiv } from './money';
import { RefundContention, applyPackageWebhook, auditOnce, findPackageOrder } from './package-orders';
import { packagesEnabled, paymentProvider, topupsEnabled, type ParsedWebhook, type PaymentProvider } from './payments';
import { alert } from '../observability';
import { funnel } from '../funnel';
import { frozenForOffboarding, refuseIfOffboarded } from '../ops/offboarded';
import { drainKeyset, type PassOpts } from './drain';
import { applyCreditWebhook, findCreditOrder } from './credit-packs';

export const MIN_TOPUP_MINOR = 1000;
export const MAX_TOPUP_MINOR = 5_000_000;
/** A pending top-up is checked with the provider after this long (the webhook normally arrives within seconds). */
export const REPAIR_AFTER_MS = 15 * 60_000;
export const EXPIRE_AFTER_MS = 7 * 86_400_000;

export type TopupRow = { order_id: string; workspace_id: string; amount_minor: number; fee_minor: number; total_minor: number; currency: string; state: 'pending' | 'paid' | 'failed' | 'expired'; created_at: number; transaction_id: string | null };
export const TOPUP_COLS = 'order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_at, transaction_id';
const stubOf = (env: Env, workspaceId: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));

/** The card fee on top of `amountMinor`: bps of the amount (half-even) plus a fixed part, both from the environment. */
export function feeFor(env: Env, amountMinor: number): number {
  const bps = Number(env.KASHIER_FEE_BPS ?? 0);
  const fixed = Number(env.KASHIER_FEE_FIXED_MINOR ?? 0);
  if (!Number.isSafeInteger(bps) || !Number.isSafeInteger(fixed) || bps < 0 || fixed < 0) return 0;
  return Number(roundHalfEvenDiv(BigInt(amountMinor) * BigInt(bps), 10000n)) + fixed;
}

export type StartResult =
  | { ok: true; orderId: string; amountMinor: number; feeMinor: number; totalMinor: number; checkoutUrl: string }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'session_revoked' | 'invalid_amount' | 'offboarding' };

export async function startTopup(env: Env, a: { workspaceId: string; userId: string; sessionId: string; amountMinor: number; returnUrl?: string }, now = Date.now()): Promise<StartResult> {
  if (await frozenForOffboarding(env, a.workspaceId)) return { ok: false, reason: 'offboarding' }; // OFFBOARD-FREEZE-1
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
  return env.DB.prepare(`SELECT ${TOPUP_COLS} FROM topups WHERE order_id = ? AND workspace_id = ?`).bind(orderId, workspaceId).first<TopupRow>();
}

/**
 * Credits the exact top-up amount once for this order. The order is first bound to ONE provider transaction (`transaction_id`, set only
 * while empty): a second SUCCESS carrying another transaction id is `conflict` and credits nothing, so two different payments (or a refund
 * relabelled as a payment) can never both credit one order. Throws if the workspace could not be reached (the caller answers 5xx).
 */
export async function credit(env: Env, row: TopupRow, transactionId: string, now: number, walletRef = `kashier:${transactionId}`): Promise<'credited' | 'duplicate' | 'conflict' | 'offboarded'> {
  // A late confirmation for a deleted workspace credits nothing and never addresses its (pseudonymous) Durable Object: a person refunds it (credit_after_offboard, P1).
  if (await refuseIfOffboarded(env, row.workspace_id, 'topup', row.order_id, now)) return 'offboarded';
  const claim = await env.DB.prepare('UPDATE topups SET transaction_id = ? WHERE order_id = ? AND transaction_id IS NULL').bind(transactionId, row.order_id).run();
  if (claim.meta.changes !== 1) {
    const cur = await env.DB.prepare('SELECT transaction_id FROM topups WHERE order_id = ?').bind(row.order_id).first<{ transaction_id: string | null }>();
    if (cur?.transaction_id !== transactionId) return 'conflict';
  }
  const r = await stubOf(env, row.workspace_id).postWallet({ kind: 'topup', netMinor: row.amount_minor, ref: walletRef, note: `top-up ${row.order_id}` }, now);
  if (!r.ok && r.reason !== 'duplicate') throw new Error(`top-up credit refused: ${r.reason}`);
  await env.DB.prepare("UPDATE topups SET state = 'paid', paid_at = coalesce(paid_at, ?) WHERE order_id = ? AND state IN ('pending', 'expired', 'failed')").bind(now, row.order_id).run();
  if (r.ok) funnel(env, 'topup_credited', row.workspace_id);
  return r.ok ? 'credited' : 'duplicate';
}

const AGED_AFTER_MS = 24 * 3_600_000;
const RETRY_EVERY_MS = 24 * 3_600_000;
const MAX_ATTEMPTS = 14;
const KEEP_CLOSED_MS = 30 * 86_400_000;
const PASS_LIMIT = 300;

/** Only what re-verification needs: the signed fields (named by `signatureKeys`) and `signatureKeys` itself. */
function reducedBody(raw: string): string {
  const d = ((JSON.parse(raw) as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(d.signatureKeys) ? d.signatureKeys.filter((k): k is string => typeof k === 'string') : [];
  const data: Record<string, unknown> = {};
  for (const k of keys) data[k] = d[k];
  data.signatureKeys = d.signatureKeys;
  return JSON.stringify({ data });
}

/** Keeps a delivery that must be run again (not confirmable yet, or held until its payment is credited). */
async function recordUnconfirmed(env: Env, signed: ParsedWebhook, raw: string, signature: string | null, reason: string, now: number): Promise<void> {
  if (!signed.eventKey) return;
  await env.DB.prepare(
    `INSERT INTO unconfirmed_webhooks (event_key, order_id, raw_body, signature, first_seen, last_seen, attempts, next_attempt_at, last_reason) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(event_key) DO UPDATE SET last_seen = excluded.last_seen, last_reason = excluded.last_reason WHERE status = 'open'`,
  ).bind(signed.eventKey, signed.orderId, reducedBody(raw), signature ?? '', now, now, now, reason).run();
}
const closeUnconfirmed = (env: Env, eventKey: string | undefined, status: 'resolved' | 'abandoned', resolution: string, now: number) =>
  eventKey ? env.DB.prepare("UPDATE unconfirmed_webhooks SET status = ?, resolution = ?, resolved_at = ? WHERE event_key = ? AND status = 'open'").bind(status, resolution, now, eventKey).run() : Promise.resolve();

export type WebhookOutcome = { status: 200 | 401 | 404 | 500 | 503; body: string };

/** What a confirmed webhook did to a top-up, as a resolution word. Throws only if something could not be written. */
async function applyTopupWebhook(env: Env, t: TopupRow, ev: ParsedWebhook, now: number): Promise<string> {
  if (ev.event === 'pay') {
    if (ev.status === 'FAILURE') {
      await env.DB.prepare("UPDATE topups SET state = 'failed' WHERE order_id = ? AND state = 'pending'").bind(t.order_id).run();
      return 'failed';
    }
    if (ev.status !== 'SUCCESS') return 'ignored';
    if (ev.currency !== t.currency || ev.amountMinor !== t.total_minor) {
      if (await auditOnce(env, 'topup_amount_mismatch', t.workspace_id, t.order_id, now)) alert('topup_amount_mismatch', { workspace: t.workspace_id });
      return 'amount_mismatch';
    }
    const c = await credit(env, t, ev.transactionId, now);
    if (c === 'conflict') {
      alert('duplicate_success', { kind: 'topup', workspace: t.workspace_id, eventKey: ev.eventKey });
      return 'duplicate_success';
    }
    if (c === 'offboarded') return 'offboarded_manual_refund'; // credit_after_offboard (P1) was raised: the money is refunded by hand
    // Another path (the webhook or a repair) already credited this transaction: nothing was credited now, so nothing follows from it.
    return c === 'duplicate' ? 'duplicate' : 'credited';
  }
  if (ev.event === 'refund') {
    if (ev.status === 'PENDING') return 'ignored';
    // A refund is a DIFFERENT transaction from the payment it returns.
    if (ev.status === 'SUCCESS' && t.transaction_id === ev.transactionId) {
      alert('refund_refused', { kind: 'topup', workspace: t.workspace_id, eventKey: ev.eventKey });
      return 'refund_refused';
    }
    // The payment is not credited (yet): the refund is held and applied once it is, whichever path credits it.
    if (ev.status === 'SUCCESS' && (t.state !== 'paid' || !t.transaction_id)) return 'payment_pending';
    // Ours (an API refund or one linked from the provider's dashboard) is reconciled without touching the wallet again; only a refund or
    // chargeback we did not start debits it, once and capped (card-refunds.ts).
    return applyProviderRefund(env, t, ev, now);
  }
  return 'ignored';
}

/** Runs the refunds that were held for this order's payment (their payment is credited now). */
async function rerunHeldRefunds(env: Env, orderId: string, provider: PaymentProvider, now: number): Promise<void> {
  const { results } = await env.DB.prepare("SELECT raw_body, signature FROM unconfirmed_webhooks WHERE status = 'open' AND order_id = ? AND last_reason = 'payment_pending'").bind(orderId).all<{ raw_body: string; signature: string }>();
  for (const r of results) await handleProviderWebhook(env, r.raw_body, r.signature, provider, now).catch(() => undefined);
}

/**
 * The provider webhook. 401 = signature/structure invalid (nothing read from the payload). 200 = acknowledged (including ignored events).
 * 5xx = retry me. Money facts come from the SIGNED fields; the unsigned `event` label is never applied: for an order of ours the signed
 * transaction is confirmed with the provider first (`provider.confirm`), and the kind and status the provider reports are what is acted on.
 * If the provider cannot be asked, or its answer does not match, the answer is 503 and nothing happens, and the delivery is kept for the
 * daily pass. Every terminal outcome closes the kept row with its reason; a refund whose payment is not credited yet stays open until it is.
 */
export async function handleProviderWebhook(env: Env, raw: string, signature: string | null, provider: PaymentProvider | null = paymentProvider(env), now = Date.now()): Promise<WebhookOutcome> {
  if (!topupsEnabled(env) && !packagesEnabled(env)) return { status: 404, body: 'not found' };
  if (!provider) return { status: 503, body: 'unavailable' };
  const signed = await provider.verifyWebhook(raw, signature);
  if (!signed) return { status: 401, body: 'unauthorized' };
  const row = await env.DB.prepare(`SELECT ${TOPUP_COLS} FROM topups WHERE order_id = ?`).bind(signed.orderId).first<TopupRow>();
  const pkg = row ? null : await findPackageOrder(env, signed.orderId);
  const credit = row || pkg ? null : await findCreditOrder(env, signed.orderId);
  if (!row && !pkg && !credit) {
    alert('topup_unknown_order');
    return { status: 200, body: 'ok' };
  }
  if ((row || credit) && !topupsEnabled(env)) return { status: 404, body: 'not found' };
  if (signed.status === 'PENDING') return { status: 200, body: 'ok' }; // nothing to apply yet; the final status arrives as its own delivery
  let ev: ParsedWebhook;
  try {
    ev = await provider.confirm(signed);
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 80) : 'error';
    alert('webhook_unconfirmed', { eventKey: signed.eventKey, reason });
    await recordUnconfirmed(env, signed, raw, signature, reason, now).catch(() => undefined);
    return { status: 503, body: 'unconfirmed' };
  }
  let resolution: string;
  try {
    resolution = pkg ? await applyPackageWebhook(env, pkg, ev, now) : credit ? await applyCreditWebhook(env, credit, ev, now) : await applyTopupWebhook(env, row!, ev, now);
  } catch (err) {
    if (err instanceof RefundContention) {
      alert('package_refund_contention', { eventKey: signed.eventKey });
      await recordUnconfirmed(env, signed, raw, signature, 'refund_contention', now).catch(() => undefined);
    } else {
      alert(pkg ? 'package_webhook_failed' : credit ? 'credit_pack_webhook_failed' : 'topup_webhook_failed', { error: err instanceof Error ? err.name : 'error' });
    }
    return { status: 500, body: 'retry' };
  }
  if (resolution === 'payment_pending') {
    await recordUnconfirmed(env, signed, raw, signature, 'payment_pending', now);
    return { status: 200, body: 'ok' };
  }
  await closeUnconfirmed(env, signed.eventKey, 'resolved', resolution, now);
  if (resolution === 'credited' || resolution === 'granted' || resolution === 'replay') await rerunHeldRefunds(env, signed.orderId, provider, now);
  return { status: 200, body: 'ok' };
}

/**
 * Daily: kept deliveries that are due are run through the SAME path as a live webhook (so whichever confirms first, the claim on the
 * transaction id makes it one effect). One attempt a day; one still open 24 h after it first arrived alerts `webhook_unconfirmed_aged` once;
 * after 14 attempts it is `abandoned` and alerts `webhook_unconfirmed_abandoned` once (the structured alert line the alert bridge turns into
 * a notice, like every other money alert here). Only open, due rows are read, so finished or abandoned rows never take a slot.
 */
export async function reconfirmUnconfirmed(env: Env, provider: PaymentProvider | null = paymentProvider(env), now = Date.now(), opts: PassOpts = {}): Promise<{ resolved: number; pending: number; aged: number; abandoned: number }> {
  const out = { resolved: 0, pending: 0, aged: 0, abandoned: 0 };
  if (!provider) return out;
  type U = { event_key: string; raw_body: string; signature: string; first_seen: number; attempts: number; aged_alerted: number; next_attempt_at: number };
  const size = opts.page ?? PASS_LIMIT;
  await drainKeyset<U, [number, string]>({
    name: 'reconfirm_unconfirmed', pageSize: size, ...(opts.maxBatches ? { maxBatches: opts.maxBatches } : {}),
    page: async (after) => (await env.DB.prepare(`SELECT event_key, raw_body, signature, first_seen, attempts, aged_alerted, next_attempt_at FROM unconfirmed_webhooks WHERE status = 'open' AND next_attempt_at <= ?1 ${after ? 'AND (next_attempt_at > ?2 OR (next_attempt_at = ?2 AND event_key > ?3))' : ''} ORDER BY next_attempt_at, event_key LIMIT ${size}`)
      .bind(now, ...(after ?? [])).all<U>()).results,
    cursorOf: (r) => [r.next_attempt_at, r.event_key],
    handle: async (r) => {
    const res = await handleProviderWebhook(env, r.raw_body, r.signature, provider, now).catch(() => ({ status: 500 as const, body: 'error' }));
    const cur = await env.DB.prepare('SELECT status FROM unconfirmed_webhooks WHERE event_key = ?').bind(r.event_key).first<{ status: string }>();
    if (cur?.status !== 'open') { out.resolved++; return; }
    const attempts = r.attempts + 1;
    if (attempts >= MAX_ATTEMPTS || res.status === 401) {
      await closeUnconfirmed(env, r.event_key, 'abandoned', 'abandoned', now);
      await env.DB.prepare('UPDATE unconfirmed_webhooks SET attempts = ? WHERE event_key = ?').bind(attempts, r.event_key).run();
      alert('webhook_unconfirmed_abandoned', { eventKey: r.event_key, firstSeen: r.first_seen, attempts });
      out.abandoned++;
      return;
    }
    const aged = r.aged_alerted === 0 && now - r.first_seen > AGED_AFTER_MS;
    if (aged) { alert('webhook_unconfirmed_aged', { eventKey: r.event_key, firstSeen: r.first_seen, lastStatus: res.status }); out.aged++; }
    await env.DB.prepare('UPDATE unconfirmed_webhooks SET attempts = ?, next_attempt_at = ?, aged_alerted = ? WHERE event_key = ?').bind(attempts, now + RETRY_EVERY_MS, aged ? 1 : r.aged_alerted, r.event_key).run();
    out.pending++;
    },
  });
  await env.DB.prepare("DELETE FROM unconfirmed_webhooks WHERE status != 'open' AND resolved_at < ?").bind(now - KEEP_CLOSED_MS).run();
  return out;
}

/** Daily: ask the provider about top-ups still pending after REPAIR_AFTER_MS; credit what was paid, close what failed or is a week old. */
export async function repairTopups(env: Env, provider: PaymentProvider | null = paymentProvider(env), now = Date.now(), opts: PassOpts = {}): Promise<{ checked: number; credited: number; unsupported: boolean }> {
  if (!topupsEnabled(env) || !provider) return { checked: 0, credited: 0, unsupported: false };
  const size = opts.page ?? 200;
  let credited = 0;
  let unsupported = false;
  const { handled } = await drainKeyset<TopupRow, [number, string]>({
    name: 'repair_topups', pageSize: size, ...(opts.maxBatches ? { maxBatches: opts.maxBatches } : {}),
    page: async (after) => (await env.DB.prepare(`SELECT ${TOPUP_COLS} FROM topups WHERE provider = 'kashier' AND state = 'pending' AND created_at < ?1 ${after ? 'AND (created_at > ?2 OR (created_at = ?2 AND order_id > ?3))' : ''} ORDER BY created_at, order_id LIMIT ${size}`)
      .bind(now - REPAIR_AFTER_MS, ...(after ?? [])).all<TopupRow>()).results,
    cursorOf: (r) => [r.created_at, r.order_id],
    handle: async (row) => {
    if (now - row.created_at > EXPIRE_AFTER_MS) {
      await env.DB.prepare("UPDATE topups SET state = 'expired' WHERE order_id = ? AND state = 'pending'").bind(row.order_id).run();
      return;
    }
    const q = await provider.inquire(row.order_id);
    if (q === 'unsupported') { unsupported = true; return; }
    if (q === 'unavailable' || q.status === 'PENDING') return;
    if (q.status === 'SUCCESS' && !q.transactionId) return;
    // The webhook's own apply path (claim on the transaction id, amount/currency check with its alert), so there is no second way to credit.
    const ev: ParsedWebhook = { event: 'pay', status: q.status, orderId: row.order_id, transactionId: q.transactionId ?? `none:${row.order_id}`, amountMinor: q.amountMinor ?? -1, currency: q.currency ?? '', eventKey: `kashier:${q.transactionId ?? row.order_id}:${q.status}` };
    try {
      if ((await applyTopupWebhook(env, row, ev, now)) === 'credited') { credited++; await rerunHeldRefunds(env, row.order_id, provider, now); }
    } catch (err) {
      alert('topup_repair_failed', { error: err instanceof Error ? err.name : 'error' });
    }
      },
  });
  if (unsupported) alert('topup_inquiry_unsupported');
  return { checked: handled, credited, unsupported };
}
