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
import { claimForCall, completeDebitPhase, holdsRequest, openCardRefund, refreshRequest, reverseUnreversedChunks, settleCardRefund } from './card-refunds';
import { paymentProvider, refundsEnabled } from './payments';

export type RefundRequestDto = z.infer<typeof refundRequestDto>;
export const MIN_REFUND_MINOR = 5000;
export const REFUND_WINDOW_MS = 365 * 86_400_000;

type Row = {
  debit_complete?: number;
  id: string; workspace_id: string; amount_minor: number; note: string | null; state: RefundRequestDto['state']; requested_by: string; created_at: number;
  decided_by: string | null; decided_at: number | null; decision_note: string | null; card_refunded_minor: number; manual_minor: number;
};
const COLS = 'debit_complete, id, workspace_id, amount_minor, note, state, requested_by, created_at, decided_by, decided_at, decision_note, card_refunded_minor, manual_minor';
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

/** One run of an approval holds this lease; a stuck run's lease runs out and a resume may take over (a compare-and-swap, never two at once). */
export const APPROVAL_LEASE_MS = 5 * 60_000;
type Chunk = { n: number; kind: 'card' | 'manual'; order_id: string | null; transaction_id: string | null; amount_minor: number };

export async function decideRefund(env: Env, a: { id: string; decision: 'approve' | 'reject'; actor: string; note?: string }, now = Date.now()): Promise<Decide> {
  const req = await env.DB.prepare(`SELECT ${COLS} FROM refund_requests WHERE id = ?`).bind(a.id).first<Row>();
  if (!req) return { ok: false, reason: 'not_found' };
  if (a.decision === 'reject') {
    // Only a request nobody has started: once an approval has debited the wallet (even partly) it can no longer be closed by a reject.
    if (req.state !== 'pending') return { ok: false, reason: 'not_pending' };
    const closed = await env.DB.prepare("UPDATE refund_requests SET state = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?, card_refunded_minor = 0, manual_minor = 0 WHERE id = ? AND state = 'pending'").bind(a.actor, now, a.note ?? null, a.id).run();
    if (!closed.meta.changes) return { ok: false, reason: 'not_pending' };
    await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) VALUES (?, ?, 'refund_rejected', ?, ?, ?, ?)").bind(now, a.actor, req.workspace_id, JSON.stringify({ state: 'pending', amountMinor: req.amount_minor }), JSON.stringify({ state: 'rejected' }), a.note ?? null).run();
    return { ok: true, request: dto((await env.DB.prepare(`SELECT ${COLS} FROM refund_requests WHERE id = ?`).bind(a.id).first<Row>())!) };
  }
  // A run whose debit phase was cut short (`processing`, debits not complete) may be run again: every effect below is idempotent.
  const resume = req.state === 'processing' && req.debit_complete === 0;
  if (req.state !== 'pending' && !resume) return { ok: false, reason: 'not_pending' };
  const stub = stubOf(env, req.workspace_id);
  if (!resume && (await stub.walletView(now)).availableMinor < req.amount_minor) return { ok: false, reason: 'insufficient_balance' };
  // Claim the request with a lease (a compare-and-swap), so two approvers, or two resumes, cannot both run it.
  const token = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE refund_requests SET state = 'processing', debit_complete = CASE WHEN state = 'pending' THEN 0 ELSE debit_complete END,
            decided_by = CASE WHEN state = 'pending' THEN ? ELSE decided_by END, decided_at = CASE WHEN state = 'pending' THEN ? ELSE decided_at END,
            decision_note = CASE WHEN state = 'pending' THEN ? ELSE decision_note END, claimed_by = ?, lease_until = ?
      WHERE id = ? AND (state = 'pending' OR (state = 'processing' AND debit_complete = 0 AND (lease_until IS NULL OR lease_until < ?)))`,
  ).bind(a.actor, now, a.note ?? null, token, now + APPROVAL_LEASE_MS, a.id, now).run();
  if (!claimed.meta.changes) return { ok: false, reason: 'not_pending' };
  const release = () => env.DB.prepare('UPDATE refund_requests SET lease_until = NULL, claimed_by = NULL WHERE id = ? AND claimed_by = ?').bind(a.id, token).run();

  // Off (default): no provider call at all, every card chunk is a manual payout, exactly as before the card API existed.
  const provider = refundsEnabled(env) ? paymentProvider(env) : null;
  // THE PLAN, recorded once before any money moves. A resume replays it as it was: amounts, refs and transactions never change.
  let chunks = (await env.DB.prepare('SELECT n, kind, order_id, transaction_id, amount_minor FROM refund_chunks WHERE request_id = ? ORDER BY n').bind(a.id).all<Chunk>()).results;
  if (chunks.length === 0) {
    // The card top-ups, oldest first, minus what was already returned and what another request's open card refund has reserved.
    const { results: topups } = await env.DB.prepare(
      `SELECT t.order_id, t.transaction_id, t.amount_minor, t.refunded_minor,
              coalesce((SELECT sum(c.amount_minor) FROM card_refunds c WHERE c.order_id = t.order_id AND c.state IN ('planned', 'sending', 'calling', 'pending', 'uncertain', 'held') AND coalesce(c.request_id, '') != ?), 0) AS reserved
         FROM topups t WHERE t.workspace_id = ? AND t.state = 'paid' AND t.transaction_id IS NOT NULL ORDER BY t.paid_at, t.order_id`,
    ).bind(a.id, req.workspace_id).all<{ order_id: string; transaction_id: string; amount_minor: number; refunded_minor: number; reserved: number }>();
    const plan: Chunk[] = [];
    let left = req.amount_minor;
    let n = 0;
    for (const t of topups) {
      if (left <= 0) break;
      const chunk = Math.min(left, t.amount_minor - t.refunded_minor - t.reserved);
      if (chunk <= 0) continue;
      n++;
      left -= chunk;
      plan.push({ n, kind: provider && !t.transaction_id.startsWith('instapay:') ? 'card' : 'manual', order_id: t.order_id, transaction_id: t.transaction_id, amount_minor: chunk }); // an InstaPay top-up has no card to refund
    }
    if (left > 0) plan.push({ n: n + 1, kind: 'manual', order_id: null, transaction_id: null, amount_minor: left }); // beyond the card top-ups (bank/InstaPay)
    // The card refund rows of the whole plan are written in the SAME batch as the plan (as `planned`: reservations only, invisible to matchers until their wallet chunk is posted).
    await env.DB.batch(plan.flatMap((c) => [
      env.DB.prepare('INSERT INTO refund_chunks (request_id, n, kind, order_id, transaction_id, amount_minor) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(a.id, c.n, c.kind, c.order_id, c.transaction_id, c.amount_minor),
      ...(c.kind === 'card' ? [env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'api', 'planned', ?, ?) ON CONFLICT DO NOTHING").bind(`cr:${a.id}:${c.n}`, a.id, c.order_id, req.workspace_id, c.amount_minor, now, now)] : []),
    ]));
    chunks = (await env.DB.prepare('SELECT n, kind, order_id, transaction_id, amount_minor FROM refund_chunks WHERE request_id = ? ORDER BY n').bind(a.id).all<Chunk>()).results;
  }

  // PHASE 1, the debits: every wallet chunk of the approval is posted (and its card refund row written) BEFORE any provider call. If this phase
  // aborts (the balance shrank), nothing was sent to the provider, the request stays `processing` with no manual amount (money that was never
  // debited is never offered for payout), a P1 alert asks a person to look, and the run can be repeated (the plan and the refs are fixed).
  for (const c of chunks) {
    // A run whose lease was taken over (or whose request was abandoned) must not post anything.
    if (!(await holdsRequest(env, a.id, token))) return { ok: false, reason: 'not_pending' };
    const posted = await stub.postWallet({ kind: 'refund', netMinor: -c.amount_minor, ref: `refund:${a.id}:${c.n}`, actor: a.actor, note: c.order_id ? `refund of top-up ${c.order_id}` : 'refund beyond card top-ups (bank/InstaPay)' }, now);
    // The post and the lease check are in different stores, so check again AFTER posting: if an abandon took over in between, this debit landed on an
    // abandoned request. Give it back (idempotent ref) and stop. The abandon's own sweep and the daily pass are the other two sides of the same net.
    if (posted.ok && !(await holdsRequest(env, a.id, token))) {
      const cur = await env.DB.prepare('SELECT state FROM refund_requests WHERE id = ?').bind(a.id).first<{ state: string }>();
      if (cur?.state === 'abandoning' || cur?.state === 'abandoned') await reverseUnreversedChunks(env, a.id, req.workspace_id, 'system', now);
      return { ok: false, reason: 'not_pending' };
    }
    if (!posted.ok && posted.reason !== 'duplicate') {
      await release();
      console.error(JSON.stringify({ alert: 'refund_debit_incomplete', severity: 'P1', requestId: a.id, workspace: req.workspace_id }));
      return { ok: false, reason: 'insufficient_balance' };
    }
    // The row is written BEFORE the provider is asked: a refund webhook that arrives mid-call (or an answer we never see) is then matched to this
    // refund instead of being booked as a second debit. Kashier documents no idempotency key, so the call is made once per row.
    if (c.kind === 'card') await openCardRefund(env, { id: `cr:${a.id}:${c.n}`, requestId: a.id, orderId: c.order_id!, workspaceId: req.workspace_id, amountMinor: c.amount_minor }, now);
  }
  if (!(await completeDebitPhase(env, a.id, token))) return { ok: false, reason: 'not_pending' };

  // PHASE 2, the provider: each row is sent by the one run that wins the guarded sending -> calling flip, with the amount and transaction RECORDED for it.
  const { results: rows } = await env.DB.prepare("SELECT id, amount_minor FROM card_refunds WHERE request_id = ? AND source = 'api' AND state = 'sending' ORDER BY id").bind(a.id).all<{ id: string; amount_minor: number }>();
  for (const row of rows) {
    const n = Number(row.id.split(':').pop());
    const c = chunks.find((x) => x.n === n);
    if (!c || !c.transaction_id) continue;
    if (!provider) { await settleCardRefund(env, row.id, { to: 'failed' }, now); continue; } // the switch went off since the plan: nothing was sent, a manual payout
    const claim = await claimForCall(env, row.id, now, token);
    if (claim === 'busy') continue; // another run owns this row, or this run lost its lease
    if (claim === 'over') {
      // The top-up no longer has room for this refund (another approval's refunds came first): nothing is sent, it becomes a manual payout.
      console.error(JSON.stringify({ alert: 'card_refund_over_refundable', severity: 'P1', requestId: a.id, workspace: req.workspace_id, cardRefundId: row.id, amountMinor: row.amount_minor }));
      continue; // claimForCall already failed the row in one atomic statement and refreshed the request
    }
    const r = await provider.refund({ transactionId: c.transaction_id, amountMinor: row.amount_minor, reason: `refund-request:${a.id}:${n}` }).catch(() => ({ ok: false as const, reason: 'uncertain' as const }));
    if (r.ok) {
      // Kashier took it. If the id cannot be stored it belongs to another row (a recorded webhook debit, a held refund): the refund still happened,
      // so the row is settled without the id, and a person is told (P1) because that other row may already have debited this money.
      await settleCardRefund(env, row.id, r.status === 'PENDING' ? { to: 'pending', refundId: r.refundId } : { to: 'succeeded', refundId: r.refundId }, now).catch(async () => {
        const owner = await env.DB.prepare('SELECT source FROM card_refunds WHERE kashier_refund_id = ?').bind(r.refundId).first<{ source: string }>();
        console.error(JSON.stringify({ alert: 'refund_id_conflict', severity: 'P1', requestId: a.id, workspace: req.workspace_id, refundId: r.refundId, ownedBy: owner?.source ?? null }));
        return settleCardRefund(env, row.id, r.status === 'PENDING' ? { to: 'uncertain' } : { to: 'succeeded' }, now);
      });
    } else {
      await settleCardRefund(env, row.id, r.reason === 'uncertain' ? { to: 'uncertain' } : { to: 'failed' }, now);
    }
  }
  await release();
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
