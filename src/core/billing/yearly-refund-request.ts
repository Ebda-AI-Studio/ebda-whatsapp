/**
 * A merchant's REQUEST to cancel a yearly package and have its unused whole months refunded (self-service A22).
 *
 * The quote is `packageRefundQuote`, the very function the operator's refund-quote route and `executeYearlyRefund` call, so what the merchant sees is what the operator would
 * execute at that moment. Confirming writes ONE row in `yearly_refund_requests` and nothing else: no subscription change, no wallet row, no card refund. A person still runs
 * the operator's yearly refund (which recomputes the figures and sends any card refund by hand); doing so marks the request executed.
 */
import type { Env } from '../../env';
import { consumeConfirmation, type Consumed } from './confirmation';
import { packageRefundQuote, type PackageRefundQuote } from './package-orders';

export type MerchantQuote = { orderId: string; packageId: string; periodMonths: number; monthlyMinor: number; unusedMonths: number; grossMinor: number; debtMinor: number; debtSettledMinor: number; refundMinor: number };
export type RefundRequestRow = { id: string; order_id: string; unused_months: number; gross_minor: number; debt_settled_minor: number; refund_minor: number; state: 'pending' | 'executed'; created_at: number };
export type YearlyRefundRequestDto = { id: string; orderId: string; state: 'pending' | 'executed'; unusedMonths: number; debtSettledMinor: number; refundMinor: number; createdAt: number };
const COLS = 'id, order_id, unused_months, gross_minor, debt_settled_minor, refund_minor, state, created_at';
export const requestDto = (r: RefundRequestRow): YearlyRefundRequestDto => ({ id: r.id, orderId: r.order_id, state: r.state, unusedMonths: r.unused_months, debtSettledMinor: r.debt_settled_minor, refundMinor: r.refund_minor, createdAt: r.created_at });

/** The paid order that owns the workspace's running period (the one a yearly refund applies to), or null. */
export async function runningOrderId(env: Env, workspaceId: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT order_id FROM package_orders WHERE workspace_id = ? AND status = 'paid' AND owns_running = 1 ORDER BY created_at DESC LIMIT 1").bind(workspaceId).first<{ order_id: string }>())?.order_id ?? null;
}

const toMerchant = (q: PackageRefundQuote): MerchantQuote => ({ orderId: q.orderId, packageId: q.packageId, periodMonths: q.periodMonths, monthlyMinor: q.monthlyMinor, unusedMonths: q.unusedMonths, grossMinor: q.grossMinor, debtMinor: q.debtMinor, debtSettledMinor: q.debtSettledMinor, refundMinor: q.refundMinor });

/** The merchant's quote for their running yearly period; a word when there is none (no yearly package running, a renewal is queued behind it...). */
export async function merchantQuote(env: Env, workspaceId: string, now = Date.now()): Promise<{ quote: MerchantQuote } | { reason: 'no_running_package' | 'not_yearly' | 'not_paid' | 'queued_periods' | 'order_queued' }> {
  const orderId = await runningOrderId(env, workspaceId);
  if (!orderId) return { reason: 'no_running_package' };
  const q = await packageRefundQuote(env, orderId, now);
  if (typeof q === 'string') return q === 'not_found' ? { reason: 'no_running_package' } : { reason: q };
  if (q.periodMonths <= 1) return { reason: 'not_yearly' };
  return { quote: toMerchant(q) };
}

/** What the confirmation binds to: every figure the merchant was shown. A month beginning, a debt change or a refund landing in between changes it. */
export const quotePayload = (q: MerchantQuote) => ({ orderId: q.orderId, unusedMonths: q.unusedMonths, grossMinor: q.grossMinor, debtSettledMinor: q.debtSettledMinor, refundMinor: q.refundMinor });

export const pendingRequest = (env: Env, workspaceId: string): Promise<RefundRequestRow | null> =>
  env.DB.prepare(`SELECT ${COLS} FROM yearly_refund_requests WHERE workspace_id = ? AND state = 'pending'`).bind(workspaceId).first<RefundRequestRow>();

export async function latestRequest(env: Env, workspaceId: string): Promise<RefundRequestRow | null> {
  return env.DB.prepare(`SELECT ${COLS} FROM yearly_refund_requests WHERE workspace_id = ? ORDER BY (state = 'pending') DESC, created_at DESC LIMIT 1`).bind(workspaceId).first<RefundRequestRow>();
}

export type CreateRequest = { ok: true; request: RefundRequestRow } | { ok: false; reason: 'request_pending' | 'nothing_to_refund' | 'quote_unavailable' | Exclude<Consumed, 'ok'> };

export async function createYearlyRefundRequest(env: Env, a: { workspaceId: string; userId: string; confirmId: string; token: string }, now = Date.now()): Promise<CreateRequest> {
  if (await pendingRequest(env, a.workspaceId)) return { ok: false, reason: 'request_pending' }; // checked before the token is spent
  const m = await merchantQuote(env, a.workspaceId, now);
  if (!('quote' in m)) return { ok: false, reason: 'quote_unavailable' };
  const q = m.quote;
  if (q.unusedMonths <= 0 || q.grossMinor <= 0) return { ok: false, reason: 'nothing_to_refund' };
  const c = await consumeConfirmation(env, { workspaceId: a.workspaceId, userId: a.userId, action: 'yearly_refund_request', confirmId: a.confirmId, token: a.token, payload: quotePayload(q) }, now);
  if (c !== 'ok') return { ok: false, reason: c };
  // The confirmation id is the primary key: a replay cannot insert a second row; the unique pending index stops two different ids racing.
  const r = await env.DB.prepare("INSERT INTO yearly_refund_requests (id, workspace_id, order_id, unused_months, gross_minor, debt_settled_minor, refund_minor, state, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT DO NOTHING")
    .bind(a.confirmId, a.workspaceId, q.orderId, q.unusedMonths, q.grossMinor, q.debtSettledMinor, q.refundMinor, a.userId, now).run();
  if (r.meta.changes !== 1) return { ok: false, reason: 'request_pending' };
  return { ok: true, request: (await env.DB.prepare(`SELECT ${COLS} FROM yearly_refund_requests WHERE id = ?`).bind(a.confirmId).first<RefundRequestRow>())! };
}

/** The operator ran the yearly refund for this order's workspace: the open request is closed (idempotent). */
export async function markRequestExecuted(env: Env, orderId: string, actor: string, now = Date.now()): Promise<void> {
  await env.DB.prepare("UPDATE yearly_refund_requests SET state = 'executed', executed_by = ?, executed_at = ? WHERE state = 'pending' AND workspace_id = (SELECT workspace_id FROM package_orders WHERE order_id = ?)").bind(actor, now, orderId).run();
}

/** The operator's queue: requests still waiting for a person, oldest first. */
export async function listPendingRequests(env: Env, limit = 100): Promise<(YearlyRefundRequestDto & { workspaceId: string })[]> {
  const { results } = await env.DB.prepare(`SELECT ${COLS}, workspace_id FROM yearly_refund_requests WHERE state = 'pending' ORDER BY created_at LIMIT ?`).bind(limit).all<RefundRequestRow & { workspace_id: string }>();
  return results.map((r) => ({ ...requestDto(r), workspaceId: r.workspace_id }));
}
