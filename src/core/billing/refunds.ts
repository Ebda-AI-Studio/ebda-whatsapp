/**
 * WA-REFUND-1. A cancelled workspace's wallet balance is refundable for 12 months after the plan period ended, debt first (only a positive
 * balance can be refunded). Not refundable: card fees already paid (never in the wallet), AI credits granted by a package (a different
 * ledger), the current package period (the plan stays usable to its end), purchased AI credits unless unused and within 14 days. Minimum
 * 50 EGP. Money records are never deleted on cancellation or erasure.
 *
 * Flow: the owner files a request (D1 queue); a super admin approves or rejects. Approval debits the wallet FIRST (`refund` rows, reversible
 * by an adjustment), then, only with KASHIER_REFUNDS_ENABLED, asks the provider to refund the card top-ups oldest first; whatever the
 * provider cannot return (unsupported, rejected, or beyond the card top-ups) becomes a manual bank/InstaPay payout after an identity check.
 * The wallet is debited in every case, once: the provider's own refund webhook is matched to the `card_refunds` row recorded before the
 * call (card-refunds.ts) and never debits again. An answer we cannot read leaves the row `uncertain` and the request `processing` until a
 * webhook or the daily reconcile settles it; the provider is never asked twice for one row.
 */
import type { Env } from '../../env';
import type { z } from 'zod';
import type { refundRequestDto } from '../api/contract';
import { openCardRefund, refreshRequest, settleCardRefund } from './card-refunds';
import { paymentProvider, refundsEnabled } from './payments';

export type RefundRequestDto = z.infer<typeof refundRequestDto>;
export const MIN_REFUND_MINOR = 5000;
export const REFUND_WINDOW_MS = 365 * 86_400_000;

type Row = {
  id: string; workspace_id: string; amount_minor: number; note: string | null; state: RefundRequestDto['state']; requested_by: string; created_at: number;
  decided_by: string | null; decided_at: number | null; decision_note: string | null; card_refunded_minor: number; manual_minor: number;
};
const COLS = 'id, workspace_id, amount_minor, note, state, requested_by, created_at, decided_by, decided_at, decision_note, card_refunded_minor, manual_minor';
const dto = (r: Row): RefundRequestDto => ({
  id: r.id, workspaceId: r.workspace_id, amountMinor: r.amount_minor, note: r.note, state: r.state, requestedBy: r.requested_by, createdAt: r.created_at,
  decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, cardRefundedMinor: r.card_refunded_minor, manualMinor: r.manual_minor,
});
const stubOf = (env: Env, workspaceId: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));

export type CreateRefund = { ok: true; request: RefundRequestDto } | { ok: false; reason: 'plan_still_active' | 'period_not_ended' | 'window_passed' | 'below_minimum' | 'exceeds_refundable' };

export async function createRefundRequest(env: Env, a: { workspaceId: string; userId: string; amountMinor: number; note?: string }, now = Date.now()): Promise<CreateRefund> {
  if (a.amountMinor < MIN_REFUND_MINOR) return { ok: false, reason: 'below_minimum' };
  const stub = stubOf(env, a.workspaceId);
  const ent = await stub.getEntitlement();
  if (!ent || (ent.status !== 'cancelled' && ent.status !== 'expired')) return { ok: false, reason: 'plan_still_active' };
  if (ent.periodEnd > now) return { ok: false, reason: 'period_not_ended' };
  if (now - Math.max(ent.periodEnd, ent.cancelledAt ?? 0) > REFUND_WINDOW_MS) return { ok: false, reason: 'window_passed' };
  const view = await stub.walletView(now);
  const pending = await env.DB.prepare("SELECT coalesce(sum(amount_minor), 0) AS n FROM refund_requests WHERE workspace_id = ? AND state IN ('pending', 'processing')").bind(a.workspaceId).first<{ n: number }>();
  if (a.amountMinor > Math.max(0, view.availableMinor) - (pending?.n ?? 0)) return { ok: false, reason: 'exceeds_refundable' };
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO refund_requests (id, workspace_id, amount_minor, note, state, requested_by, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)").bind(id, a.workspaceId, a.amountMinor, a.note ?? null, a.userId, now).run();
  const row = await env.DB.prepare(`SELECT ${COLS} FROM refund_requests WHERE id = ?`).bind(id).first<Row>();
  return { ok: true, request: dto(row!) };
}

export async function listRefundRequests(env: Env, f: { workspaceId?: string; state?: string }): Promise<RefundRequestDto[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.workspaceId) { where.push('workspace_id = ?'); params.push(f.workspaceId); }
  if (f.state) { where.push('state = ?'); params.push(f.state); }
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM refund_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 200`).bind(...params).all<Row>();
  return results.map(dto);
}

export type Decide = { ok: true; request: RefundRequestDto } | { ok: false; reason: 'not_found' | 'not_pending' | 'insufficient_balance' };

export async function decideRefund(env: Env, a: { id: string; decision: 'approve' | 'reject'; actor: string; note?: string }, now = Date.now()): Promise<Decide> {
  const req = await env.DB.prepare(`SELECT ${COLS} FROM refund_requests WHERE id = ?`).bind(a.id).first<Row>();
  if (!req) return { ok: false, reason: 'not_found' };
  if (req.state !== 'pending') return { ok: false, reason: 'not_pending' };
  const done = async (state: Row['state'], card = 0, manual = 0): Promise<Decide> => {
    await env.DB.prepare('UPDATE refund_requests SET state = ?, decided_by = ?, decided_at = ?, decision_note = ?, card_refunded_minor = ?, manual_minor = ? WHERE id = ?').bind(state, a.actor, now, a.note ?? null, card, manual, a.id).run();
    return { ok: true, request: dto((await env.DB.prepare(`SELECT ${COLS} FROM refund_requests WHERE id = ?`).bind(a.id).first<Row>())!) };
  };
  if (a.decision === 'reject') {
    await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) VALUES (?, ?, 'refund_rejected', ?, ?, ?, ?)").bind(now, a.actor, req.workspace_id, JSON.stringify({ state: 'pending', amountMinor: req.amount_minor }), JSON.stringify({ state: 'rejected' }), a.note ?? null).run();
    return done('rejected');
  }
  const stub = stubOf(env, req.workspace_id);
  if ((await stub.walletView(now)).availableMinor < req.amount_minor) return { ok: false, reason: 'insufficient_balance' };
  // Claim the request before any money moves, so two approvers cannot both run it.
  const claimed = await env.DB.prepare("UPDATE refund_requests SET state = 'processing', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND state = 'pending'").bind(a.actor, now, a.note ?? null, a.id).run();
  if (!claimed.meta.changes) return { ok: false, reason: 'not_pending' };
  // The card top-ups, oldest first, minus what was already returned and what an open card refund has reserved.
  const { results: topups } = await env.DB.prepare(
    `SELECT t.order_id, t.transaction_id, t.amount_minor, t.refunded_minor,
            coalesce((SELECT sum(c.amount_minor) FROM card_refunds c WHERE c.order_id = t.order_id AND c.state IN ('sending', 'pending', 'uncertain')), 0) AS reserved
       FROM topups t WHERE t.workspace_id = ? AND t.state = 'paid' AND t.transaction_id IS NOT NULL ORDER BY t.paid_at, t.order_id`,
  ).bind(req.workspace_id).all<{ order_id: string; transaction_id: string; amount_minor: number; refunded_minor: number; reserved: number }>();
  // Off (default): no provider call at all, every card chunk is a manual payout, exactly as before the card API existed.
  const provider = refundsEnabled(env) ? paymentProvider(env) : null;
  let left = req.amount_minor;
  let n = 0;
  for (const t of topups) {
    if (left <= 0) break;
    const chunk = Math.min(left, t.amount_minor - t.refunded_minor - t.reserved);
    if (chunk <= 0) continue;
    n++;
    const posted = await stub.postWallet({ kind: 'refund', netMinor: -chunk, ref: `refund:${a.id}:${n}`, actor: a.actor, note: `refund of top-up ${t.order_id}` }, now);
    if (!posted.ok && posted.reason !== 'duplicate') return { ok: false, reason: 'insufficient_balance' };
    left -= chunk;
    if (!provider) continue;
    // The row is written BEFORE the provider is asked: a refund webhook that arrives mid-call (or an answer we never see) is then matched to
    // this refund instead of being booked as a second debit. Kashier documents no idempotency key, so the call is made once per row.
    const row = await openCardRefund(env, { id: `cr:${a.id}:${n}`, requestId: a.id, orderId: t.order_id, workspaceId: req.workspace_id, amountMinor: chunk }, now);
    if (row.state !== 'sending') continue; // a re-run found the row already decided: never ask the provider twice
    const r = await provider.refund({ transactionId: t.transaction_id, amountMinor: chunk, reason: `refund-request:${a.id}:${n}` }).catch(() => ({ ok: false as const, reason: 'uncertain' as const }));
    // Kashier took it: if the id cannot be stored (already used by another row) the refund still happened, so settle it without the id.
    if (r.ok) await settleCardRefund(env, row.id, r.status === 'PENDING' ? { to: 'pending', refundId: r.refundId } : { to: 'succeeded', refundId: r.refundId }, now).catch(() => settleCardRefund(env, row.id, r.status === 'PENDING' ? { to: 'uncertain' } : { to: 'succeeded' }, now));
    else await settleCardRefund(env, row.id, r.reason === 'uncertain' ? { to: 'uncertain' } : { to: 'failed' }, now);
  }
  if (left > 0) {
    n++;
    const posted = await stub.postWallet({ kind: 'refund', netMinor: -left, ref: `refund:${a.id}:${n}`, actor: a.actor, note: 'refund beyond card top-ups (bank/InstaPay)' }, now);
    if (!posted.ok && posted.reason !== 'duplicate') return { ok: false, reason: 'insufficient_balance' };
  }
  // The split is derived from the card_refunds rows: card = confirmed, open = waiting for the provider (state stays `processing`), manual = the rest.
  await refreshRequest(env, a.id);
  const out = (await env.DB.prepare(`SELECT ${COLS} FROM refund_requests WHERE id = ?`).bind(a.id).first<Row>())!;
  await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) VALUES (?, ?, 'refund_approved', ?, ?, ?, ?)").bind(now, a.actor, req.workspace_id, JSON.stringify({ state: 'pending', amountMinor: req.amount_minor }), JSON.stringify({ cardMinor: out.card_refunded_minor, manualMinor: out.manual_minor, state: out.state }), a.note ?? null).run();
  return { ok: true, request: dto(out) };
}

/** The operator confirms a manual (bank/InstaPay) payout was made after the identity check. */
export async function markManualPaid(env: Env, id: string, actor: string, now = Date.now()): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE refund_requests SET state = 'paid' WHERE id = ? AND state = 'manual_payout'").bind(id).run();
  if (r.meta.changes) await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, reason) VALUES (?, ?, 'refund_manual_paid', ?)").bind(now, actor, id).run();
  return r.meta.changes > 0;
}
