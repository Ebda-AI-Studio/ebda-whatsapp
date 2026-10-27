/**
 * Card refunds and every refund the provider tells us about (`card_refunds`, migration 0010).
 *
 * One rule: the wallet is debited ONCE per refund. A refund request debits the wallet when an operator approves it (`refund:<id>:<n>`); a
 * refund the provider later reports (our own API call, or an operator refunding the card in the provider's dashboard) must be recognised as
 * that same money, not booked again. So every refund transaction we know of has a row here BEFORE the provider is asked, the provider's
 * refund id is stored when it is known, and the refund webhook is matched against the rows:
 *   1. by the provider's refund id (only for a real refund operation, never a chargeback / reversal)     -> ours: reconcile, no wallet movement
 *   2. else, for a real refund (`refund` / `partial_refund`, not a chargeback, reversal or void), an API row of the same top-up with the same
 *      amount that has NO provider id yet                                                                -> ours: bind the id, no wallet movement
 *   3. else it is a refund or chargeback we did not start -> the wallet is debited, once (ref `chargeback:<id>`), its FULL amount in wallet
 *      units up to what the top-up credited (the card fee was never in the wallet); the wallet may go into debt. Nothing already used by
 *      other refunds or open card refunds shrinks it. An amount beyond the credited amount (and beyond the card fee) is never dropped
 *      silently: it is recorded and raised as a P1 alert for an operator.
 * Kashier documents no idempotency key, so the provider's refund API is called at most once per recorded row; a timeout or an unreadable
 * answer leaves the row `uncertain` and is reconciled (webhook, refund status, refund list), never repeated.
 */
import type { Env } from '../../env';
import { TRANSACTION_ID } from './kashier-confirm';
import { ensureAdjustmentApplied, requestAdjustment } from './operator';
import { auditOnce } from './package-orders';
import { APPROVAL_LEASE_MS } from './refunds';
import { isCardRefundOperation, paymentProvider, type ParsedWebhook, type PaymentProvider } from './payments';
import { alert } from '../observability';
import { refuseIfOffboarded } from '../ops/offboarded';
import { DRAIN_PAGE, drainKeyset, type PassOpts } from './drain';
import { noteRefundExcess } from './refund-excess';

/** Rows that count against a top-up's room: the open ones, the planned ones (reserved, not debited yet) and held refunds (real refunds awaiting a match). */
export const RESERVING = "('planned', 'sending', 'calling', 'pending', 'uncertain', 'held')";
export const OPEN = "('sending', 'calling', 'pending', 'uncertain')";
const STUCK_AFTER_MS = 3 * 86_400_000;
const RECONCILE_AFTER_MS = 15 * 60_000;
const stubOf = (env: Env, workspaceId: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));

export type CardRefundRow = {
  id: string; request_id: string | null; order_id: string; workspace_id: string; amount_minor: number; source: 'api' | 'dashboard' | 'webhook' | 'held';
  state: 'planned' | 'sending' | 'calling' | 'pending' | 'uncertain' | 'succeeded' | 'failed' | 'linked' | 'held' | 'matched'; kashier_refund_id: string | null; created_at: number; updated_at: number; confirmed_at: number | null; candidate_id: string | null; note: string | null;
};
const COLS = 'id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at, confirmed_at, candidate_id, note';
export const getCardRefund = (env: Env, id: string) => env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE id = ?`).bind(id).first<CardRefundRow>();

/**
 * Recomputes a request's split from its rows (derived, never incremented, so a replay cannot drift it): card = succeeded + linked rows,
 * open = rows still waiting for the provider, manual = the rest. `processing` while anything is open, else `manual_payout` while a manual
 * part remains, else `paid`. A request an operator already closed (`paid`, `rejected`, ...) is left alone.
 */
export async function refreshRequest(env: Env, requestId: string): Promise<void> {
  const card = "(SELECT coalesce(sum(amount_minor), 0) FROM card_refunds WHERE request_id = refund_requests.id AND state IN ('succeeded', 'linked'))";
  const open = `(SELECT coalesce(sum(amount_minor), 0) FROM card_refunds WHERE request_id = refund_requests.id AND state IN ${OPEN})`;
  // Until every wallet debit of the approval is posted (`debit_complete`), the request is only `processing` and no manual amount is shown: the
  // manual part would include chunks that were never debited.
  await env.DB.prepare(
    `UPDATE refund_requests SET
       card_refunded_minor = ${card},
       manual_minor = CASE WHEN debit_complete = 1 THEN amount_minor - ${card} - ${open} ELSE 0 END,
       state = CASE
         WHEN debit_complete = 0 OR EXISTS (SELECT 1 FROM card_refunds WHERE request_id = refund_requests.id AND state IN ${OPEN}) THEN 'processing'
         WHEN amount_minor - ${card} > 0 THEN 'manual_payout'
         ELSE 'paid' END
     WHERE id = ? AND state IN ('processing', 'manual_payout')`,
  ).bind(requestId).run();
}

/** What the top-up still has room for beyond the OTHER rows that count ahead of this one (already calling / pending / uncertain / held, and sending or planned rows ordered before it). */
const ROOM = `coalesce((SELECT t.amount_minor - t.refunded_minor FROM topups t WHERE t.order_id = card_refunds.order_id), 0)
  - coalesce((SELECT sum(c.amount_minor) FROM card_refunds c WHERE c.order_id = card_refunds.order_id AND c.id != card_refunds.id
      AND (c.state IN ('calling', 'pending', 'uncertain', 'held') OR (c.state IN ('sending', 'planned') AND (c.created_at < card_refunds.created_at OR (c.created_at = card_refunds.created_at AND c.id < card_refunds.id))))), 0)`;

/**
 * The guarded flip that lets exactly one run send a row to the provider, and only while the top-up still has room for it. `claimed` = this run
 * sends it; `over` = no room: the row was failed by ONE atomic statement that re-checks it is still `sending` and still has no room (so a row a
 * concurrent run just moved to `calling` is never failed); `busy` = another run owns it (or the room changed under us: nothing is sent, nothing
 * is failed, and the row stays open for a person).
 */
export async function claimForCall(env: Env, id: string, now: number, token?: string): Promise<'claimed' | 'busy' | 'over'> {
  // A run may send a row only while its request is still `processing` under THIS run's lease: an abandon (or a resume that took the lease over) stops a stale run here.
  const mine = token === undefined ? '' : " AND EXISTS (SELECT 1 FROM refund_requests q WHERE q.id = card_refunds.request_id AND q.state = 'processing' AND q.claimed_by = ?3)";
  const claimed = await env.DB.prepare(`UPDATE card_refunds SET state = 'calling', updated_at = ?1 WHERE id = ?2 AND state = 'sending'${mine} AND ${ROOM} >= card_refunds.amount_minor`).bind(...(token === undefined ? [now, id] : [now, id, token])).run();
  if (claimed.meta.changes === 1) return 'claimed';
  const over = await env.DB.prepare(`UPDATE card_refunds SET state = 'failed', updated_at = ?1 WHERE id = ?2 AND state = 'sending'${mine} AND ${ROOM} < card_refunds.amount_minor`).bind(...(token === undefined ? [now, id] : [now, id, token])).run();
  if (over.meta.changes !== 1) return 'busy';
  const row = await getCardRefund(env, id);
  if (row?.request_id) await refreshRequest(env, row.request_id);
  return 'over';
}

/** Marks the approval's debit phase finished (every wallet chunk posted and every card refund row written). */
export async function completeDebitPhase(env: Env, requestId: string, token: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE refund_requests SET debit_complete = 1 WHERE id = ? AND state = 'processing' AND claimed_by = ?").bind(requestId, token).run();
  return r.meta.changes === 1;
}

/** True while this run still holds the request: `processing` under its own lease token (an abandon or a takeover makes it false). */
export async function holdsRequest(env: Env, requestId: string, token: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM refund_requests WHERE id = ? AND state = 'processing' AND claimed_by = ?").bind(requestId, token).first());
}

const markConfirmed = (env: Env, id: string, now: number) => env.DB.prepare('UPDATE card_refunds SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL').bind(now, id).run();

/**
 * The row of one card chunk, made visible to the matchers only AFTER its wallet chunk was posted: a plan writes it as `planned` (a reservation),
 * and this flips it to `sending` with a guarded UPDATE. A re-run finds it already `sending` or later and changes nothing.
 */
export async function openCardRefund(env: Env, r: { id: string; requestId: string; orderId: string; workspaceId: string; amountMinor: number }, now: number): Promise<CardRefundRow> {
  await env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'api', 'planned', ?, ?) ON CONFLICT DO NOTHING")
    .bind(r.id, r.requestId, r.orderId, r.workspaceId, r.amountMinor, now, now).run();
  await env.DB.prepare("UPDATE card_refunds SET state = 'sending', updated_at = ? WHERE id = ? AND state = 'planned'").bind(now, r.id).run();
  return (await getCardRefund(env, r.id))!;
}

export type Outcome = { to: 'succeeded' | 'failed'; refundId?: string } | { to: 'pending'; refundId: string } | { to: 'uncertain' };

/**
 * Moves an OPEN row to its outcome. The guard (`state IN OPEN`) makes a late or repeated outcome a no-op, and a success books the top-up's
 * `refunded_minor` in the same batch as the state change, so it counts once however many paths report it. A webhook's id overrides a stored
 * one (it is signed and confirmed; a replay then matches by id). Returns true when this call moved the row.
 */
export async function settleCardRefund(env: Env, id: string, o: Outcome, now: number, opts: { overrideId?: boolean } = {}): Promise<boolean> {
  const idSql = opts.overrideId ? '?' : 'coalesce(kashier_refund_id, ?)';
  const refundId = 'refundId' in o && o.refundId ? o.refundId : null;
  const state = o.to;
  const upd = env.DB.prepare(`UPDATE card_refunds SET state = ?, kashier_refund_id = ${refundId === null ? 'kashier_refund_id' : idSql}, updated_at = ? WHERE id = ? AND state IN ${OPEN}`);
  const first = refundId === null ? upd.bind(state, now, id) : upd.bind(state, refundId, now, id);
  const stmts = [first];
  if (o.to === 'succeeded') {
    stmts.push(env.DB.prepare('UPDATE topups SET refunded_minor = MIN(amount_minor, refunded_minor + (SELECT amount_minor FROM card_refunds WHERE id = ?)) WHERE order_id = (SELECT order_id FROM card_refunds WHERE id = ?) AND changes() > 0').bind(id, id));
  }
  const res = await env.DB.batch(stmts);
  const moved = (res[0]?.meta.changes ?? 0) > 0;
  const row = await getCardRefund(env, id);
  if (row?.request_id) await refreshRequest(env, row.request_id);
  return moved;
}

type TopupLite = { order_id: string; workspace_id: string };

/**
 * The ONE decision for an event whose refund id is already owned by a row of another path (an API refund, a link, a recorded webhook).
 * Only a real card refund (`refund` / `partial_refund`, not a chargeback or reversal) may settle the row and be `refund_reconciled`; anything
 * else carrying that id is a conflict: it settles nothing, raises a P1 alert, leaves a review item (`billing_audit` `refund_id_conflict`, once
 * per refund id) and is `refund_unmatched`. Never silent, and never a debit.
 */
async function reconcileOwned(env: Env, t: TopupLite, ev: ParsedWebhook, owner: CardRefundRow, isCardRefund: boolean, now: number): Promise<string> {
  if (!isCardRefund) {
    if (await auditOnce(env, 'refund_id_conflict', t.workspace_id, ev.transactionId, now)) alert('refund_id_conflict', { severity: 'P1', workspace: t.workspace_id, orderId: t.order_id, refundId: ev.transactionId, operation: ev.operation ?? null, chargeback: !!ev.chargeback });
    return 'refund_unmatched';
  }
  if (owner.state === 'sending' || owner.state === 'calling' || owner.state === 'pending' || owner.state === 'uncertain') {
    await settleCardRefund(env, owner.id, { to: ev.status === 'SUCCESS' ? 'succeeded' : 'failed' }, now); // false = another path settled it first
  }
  if (ev.status === 'SUCCESS') await markConfirmed(env, owner.id, now); // a signed, confirmed webhook named this refund by its id
  return 'refund_reconciled';
}

/**
 * A confirmed refund webhook for one of our top-ups (SUCCESS or FAILURE). Returns the resolution word. Throws only when something could
 * not be written (the caller answers 5xx and the delivery is retried; every step is idempotent).
 */
export async function applyProviderRefund(env: Env, t: TopupLite, ev: ParsedWebhook, now: number): Promise<string> {
  const isCardRefund = !ev.chargeback && isCardRefundOperation(ev.operation);
  const byId = await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE kashier_refund_id = ?`).bind(ev.transactionId).first<CardRefundRow>();
  if (byId?.source === 'held') return byId.state === 'matched' ? 'refund_reconciled' : 'refund_held'; // a held refund moves no money until an operator matches it
  if (byId && byId.source !== 'webhook') return reconcileOwned(env, t, ev, byId, isCardRefund, now);
  if (ev.status !== 'SUCCESS') return 'ignored';
  if (!byId && isCardRefund) {
    // Kashier's own details (confirm) say this is a refund of this order; the signed amount must equal ours, and our row must not have an id yet.
    const open = await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE order_id = ? AND source = 'api' AND state IN ${OPEN} AND kashier_refund_id IS NULL AND amount_minor = ? ORDER BY created_at LIMIT 1`).bind(t.order_id, ev.amountMinor).first<CardRefundRow>();
    if (open) {
      await settleCardRefund(env, open.id, { to: 'succeeded', refundId: ev.transactionId }, now); // false = another path settled it first
      await markConfirmed(env, open.id, now);
      return 'refund_reconciled';
    }
  }
  // A refund or chargeback we did not start. The wallet only ever held `amount_minor` of this top-up (the card fee never was in it): debit the
  // event's full amount up to that, once, whatever else happened to the top-up (a chargeback is never shrunk by refunds already made or open).
  let row = byId;
  let excess = 0;
  if (!row) {
    // The id mismatch trap: our own API refund answered with id R, Kashier's webhook names it W. A real card refund of the same top-up and amount
    // while one of ours is still unconfirmed is far more likely that refund than a second one: hold it (no debit) for an operator to match.
    if (isCardRefund) {
      const cand = await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE order_id = ? AND source IN ('api', 'dashboard') AND amount_minor = ? AND created_at > ? AND kashier_refund_id IS NOT NULL AND kashier_refund_id != ? AND confirmed_at IS NULL AND state IN ('succeeded', 'pending', 'linked') ORDER BY created_at LIMIT 1`)
        .bind(t.order_id, ev.amountMinor, now - 7 * 86_400_000, ev.transactionId).first<CardRefundRow>();
      if (cand) {
        await env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at, candidate_id) VALUES (?, NULL, ?, ?, ?, 'held', 'held', ?, ?, ?, ?) ON CONFLICT DO NOTHING")
          .bind(`held:${ev.transactionId}`, t.order_id, t.workspace_id, ev.amountMinor, ev.transactionId, now, now, cand.id).run();
        if (await auditOnce(env, 'refund_held', t.workspace_id, ev.transactionId, now)) alert('refund_held', { severity: 'P1', workspace: t.workspace_id, orderId: t.order_id, refundId: ev.transactionId, candidate: cand.id, candidateRefundId: cand.kashier_refund_id });
        return 'refund_held';
      }
    }
    const top = await env.DB.prepare('SELECT amount_minor, fee_minor, refunded_minor FROM topups WHERE order_id = ?').bind(t.order_id).first<{ amount_minor: number; fee_minor: number; refunded_minor: number }>();
    const credited = top?.amount_minor ?? 0;
    const debit = Math.min(ev.amountMinor, credited);
    if (debit <= 0) {
      // Nothing was credited by this top-up, so there is nothing to take back: a review item and a P1, and the delivery is ANSWERED (a 5xx would only repeat it forever).
      if (await auditOnce(env, 'refund_unmatched_review', t.workspace_id, ev.transactionId, now)) alert('refund_unmatched_no_credit', { severity: 'P1', workspace: t.workspace_id, orderId: t.order_id, refundId: ev.transactionId, amountMinor: ev.amountMinor });
      return 'refund_unmatched';
    }
    excess = ev.amountMinor - debit;
    // MONEY-FACT-1: the refund is recorded and debited in full; only the bookkeeping column is clamped, and what lies beyond the charge is reported.
    const over = Math.max(0, (top?.refunded_minor ?? 0) + debit - credited);
    const res = await env.DB.batch([
      env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at, note, over_charge_minor) VALUES (?, NULL, ?, ?, ?, 'webhook', 'succeeded', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(`wh:${ev.transactionId}`, t.order_id, t.workspace_id, debit, ev.transactionId, now, now, excess > 0 ? `excess_minor=${excess};fee_minor=${top?.fee_minor ?? 0}` : null, over),
      env.DB.prepare('UPDATE topups SET refunded_minor = MIN(amount_minor, refunded_minor + ?) WHERE order_id = ? AND changes() > 0').bind(debit, t.order_id),
    ]);
    if ((res[0]?.meta.changes ?? 0) > 0) await noteRefundExcess(env, { kind: 'topup', workspaceId: t.workspace_id, orderId: t.order_id, eventRef: ev.transactionId, eventMinor: ev.amountMinor, overMinor: over }, now);
    row = (await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE kashier_refund_id = ?`).bind(ev.transactionId).first<CardRefundRow>())!;
    // Another path took this refund id between our read and our write: it owns the money (the wallet was debited at approval), nothing is posted here.
    if (!(res[0]?.meta.changes ?? 0) && row.source !== 'webhook') return reconcileOwned(env, t, ev, row, isCardRefund, now);
    // Beyond the credited amount the card fee explains up to `fee_minor`; anything past that is money we cannot place: a person decides.
    const unexplained = excess - Math.min(excess, top?.fee_minor ?? 0);
    if (unexplained > 0 && (await auditOnce(env, 'refund_excess_review', t.workspace_id, ev.transactionId, now))) {
      alert('refund_excess_for_review', { severity: 'P1', workspace: t.workspace_id, orderId: t.order_id, refundId: ev.transactionId, excessMinor: unexplained, chargeback: !!ev.chargeback });
    }
  }
  // A deleted workspace has no wallet to debit (and addressing its pseudonym would create a ghost): the refund fact is recorded above; a person reconciles it.
  if (await refuseIfOffboarded(env, t.workspace_id, 'provider_refund', ev.transactionId, now)) return 'refunded';
  // Same ref on every path and replay: a second delivery posts nothing.
  const r = await stubOf(env, t.workspace_id).postWallet({ kind: 'chargeback', netMinor: -row.amount_minor, ref: `chargeback:${ev.transactionId}`, note: `provider refund of ${t.order_id}: operator review` }, now);
  if (r.ok) alert('topup_refunded_by_provider', { workspace: t.workspace_id, orderId: t.order_id });
  else if (r.reason !== 'duplicate') throw new Error(`refund debit refused: ${r.reason}`);
  return 'refunded';
}

/** The credit that returns a duplicate debit, as ONE adjustment per Kashier refund id. */
async function relinkCredit(env: Env, a: { requestId: string; kashierRefundId: string; actor: string }, workspaceId: string, row: CardRefundRow & { note?: string | null }, now: number): Promise<{ id: string; state: 'pending' | 'approved' | 'rejected' }> {
  const id = `relink:${a.kashierRefundId}`;
  const already = await ensureAdjustmentApplied(env, id, now); // exists: finish its wallet post if that was interrupted, never create another
  if (already) return already;
  const adj = await requestAdjustment(env, { id, actor: a.actor, workspaceId, amountMinor: row.amount_minor, reason: `refund ${a.kashierRefundId} linked to request ${a.requestId}: duplicate debit returned`, secondApproverAlways: true }, now);
  if (!adj.ok) throw new Error(adj.reason);
  return { id: adj.adjustment.id, state: adj.adjustment.state };
}

export type LinkResult =
  | { ok: true; adjustment?: { id: string; state: 'pending' | 'approved' | 'rejected' } }
  | { ok: false; reason: 'not_found' | 'not_manual_payout' | 'invalid_refund_id' | 'invalid_order' | 'exceeds_manual' | 'exceeds_order' | 'amount_mismatch' | 'already_linked' | 'refund_not_verified' | 'provider_unavailable' };

/**
 * "Refunded in the provider's dashboard": an operator paid a manual payout by refunding the card in Kashier's dashboard and links that
 * refund to the request. The wallet was already debited at approval, so the provider's webhook for it must not debit again.
 *  - The link first asks Kashier: the id must be listed for this top-up's order as a card refund (`refund` / `partial_refund`, never a
 *    reversal or void), SUCCESS, for exactly this amount. Anything else is refused and records nothing.
 *  - The link itself moves no money. If the refund's webhook already arrived first (booked as an unknown refund and debited a second time),
 *    giving that debit back is a wallet CREDIT, and it goes through the normal adjustment flow (`requestAdjustment`: above
 *    ADJUSTMENT_APPROVAL_MINOR a DIFFERENT super admin must approve; the requester cannot approve their own).
 */
export async function linkDashboardRefund(env: Env, a: { requestId: string; kashierRefundId: string; amountMinor: number; orderId?: string; actor: string }, now = Date.now(), provider: PaymentProvider | null = paymentProvider(env)): Promise<LinkResult> {
  if (!TRANSACTION_ID.test(a.kashierRefundId)) return { ok: false, reason: 'invalid_refund_id' };
  const req = await env.DB.prepare('SELECT id, workspace_id, state, manual_minor FROM refund_requests WHERE id = ?').bind(a.requestId).first<{ id: string; workspace_id: string; state: string; manual_minor: number }>();
  if (!req) return { ok: false, reason: 'not_found' };
  const existing = await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE kashier_refund_id = ?`).bind(a.kashierRefundId).first<CardRefundRow>();
  if (existing && existing.source === 'dashboard' && existing.note === 'relink' && existing.request_id === a.requestId && existing.workspace_id === req.workspace_id) {
    // A retry of a relink that was claimed but did not finish: make sure the credit exists (once), then finish.
    const adjustment = await relinkCredit(env, a, req.workspace_id, existing, now);
    await refreshRequest(env, a.requestId);
    return { ok: true, adjustment };
  }
  if (req.state !== 'manual_payout') return { ok: false, reason: 'not_manual_payout' };
  if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor <= 0 || a.amountMinor > req.manual_minor) return { ok: false, reason: 'exceeds_manual' };
  if (existing && (existing.source !== 'webhook' || existing.workspace_id !== req.workspace_id)) return { ok: false, reason: 'already_linked' };
  if (existing && existing.amount_minor !== a.amountMinor) return { ok: false, reason: 'amount_mismatch' };
  // Which top-up the refund belongs to.
  let topup: { order_id: string; amount_minor: number; refunded_minor: number } | null;
  if (existing) {
    topup = await env.DB.prepare('SELECT order_id, amount_minor, refunded_minor FROM topups WHERE order_id = ?').bind(existing.order_id).first();
  } else if (a.orderId) {
    topup = await env.DB.prepare("SELECT order_id, amount_minor, refunded_minor FROM topups WHERE workspace_id = ? AND state = 'paid' AND order_id = ?").bind(req.workspace_id, a.orderId).first();
  } else {
    topup = await env.DB.prepare("SELECT order_id, amount_minor, refunded_minor FROM topups WHERE workspace_id = ? AND state = 'paid' AND provider = 'kashier' AND transaction_id IS NOT NULL AND amount_minor - refunded_minor >= ? ORDER BY paid_at, order_id LIMIT 1").bind(req.workspace_id, a.amountMinor).first();
  }
  if (!topup) return { ok: false, reason: a.orderId ? 'invalid_order' : 'exceeds_order' };
  if (!existing) {
    const reserved = await env.DB.prepare(`SELECT coalesce(sum(amount_minor), 0) AS n FROM card_refunds WHERE order_id = ? AND state IN ${RESERVING}`).bind(topup.order_id).first<{ n: number }>();
    if (a.amountMinor > topup.amount_minor - topup.refunded_minor - (reserved?.n ?? 0)) return { ok: false, reason: 'exceeds_order' };
  }
  // Ask Kashier before anything is written.
  if (!provider?.listRefunds) return { ok: false, reason: 'provider_unavailable' };
  const listed = await provider.listRefunds(topup.order_id);
  if (listed === 'unavailable') return { ok: false, reason: 'provider_unavailable' };
  const real = listed.find((r) => r.refundId === a.kashierRefundId);
  if (!real || real.status !== 'SUCCESS' || !isCardRefundOperation(real.operation) || real.amountMinor !== a.amountMinor) return { ok: false, reason: 'refund_not_verified' };

  let adjustment: { id: string; state: 'pending' | 'approved' | 'rejected' } | undefined;
  if (existing) {
    // The refund webhook came first and debited the wallet a second time. Claim the row for this request, then ask for the credit through the
    // adjustment flow under a deterministic id (`relink:<refund id>`): asking twice finds the first adjustment, so a retry never credits twice,
    // and once the adjustment exists the claim is never undone.
    const claim = await env.DB.prepare("UPDATE card_refunds SET source = 'dashboard', state = 'linked', request_id = ?, updated_at = ?, note = 'relink' WHERE id = ? AND source = 'webhook'").bind(a.requestId, now, existing.id).run();
    if (!claim.meta.changes) return { ok: false, reason: 'already_linked' };
    adjustment = await relinkCredit(env, a, req.workspace_id, existing, now);
  } else {
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'dashboard', 'linked', ?, ?, ?)")
          .bind(`dash:${a.kashierRefundId}`, a.requestId, topup.order_id, req.workspace_id, a.amountMinor, a.kashierRefundId, now, now),
        env.DB.prepare('UPDATE topups SET refunded_minor = MIN(amount_minor, refunded_minor + ?) WHERE order_id = ? AND changes() > 0').bind(a.amountMinor, topup.order_id),
      ]);
    } catch {
      return { ok: false, reason: 'already_linked' }; // the provider's refund id is unique
    }
  }
  await refreshRequest(env, a.requestId);
  await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, ref) VALUES (?, ?, 'refund_dashboard_linked', ?, NULL, ?, ?)")
    .bind(now, a.actor, req.workspace_id, JSON.stringify({ amountMinor: a.amountMinor, ...(adjustment ? { adjustmentId: adjustment.id } : {}) }), `${a.requestId}:${a.kashierRefundId}`).run();
  return { ok: true, ...(adjustment ? { adjustment } : {}) };
}

/**
 * Daily: asks the provider about refunds still waiting (`sending` / `pending` / `uncertain`, older than 15 min). A pending one with an id is
 * read by id; one without an id is looked for in the provider's refund list for its top-up (same order, same amount, not already ours).
 * Nothing is ever re-sent. One that stays unresolved for 3 days alerts once (`card_refund_stuck`): a person checks the provider's dashboard.
 */
export async function reconcileCardRefunds(env: Env, provider: PaymentProvider | null, now = Date.now(), opts: PassOpts = {}): Promise<{ settled: number; open: number }> {
  const out = { settled: 0, open: 0 };
  if (!provider) return out;
  const size = opts.page ?? DRAIN_PAGE;
  await drainKeyset<CardRefundRow, [number, string]>({
    name: 'reconcile_card_refunds', pageSize: size, ...(opts.maxBatches ? { maxBatches: opts.maxBatches } : {}),
    page: async (after) => (await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE state IN ${OPEN} AND source = 'api' AND updated_at < ?1 ${after ? 'AND (created_at > ?2 OR (created_at = ?2 AND id > ?3))' : ''} ORDER BY created_at, id LIMIT ${size}`)
      .bind(now - RECONCILE_AFTER_MS, ...(after ?? [])).all<CardRefundRow>()).results,
    cursorOf: (r) => [r.created_at, r.id],
    handle: async (row) => {
    try {
      let outcome: Outcome | null = null;
      if (row.kashier_refund_id && provider.refundStatus) {
        const st = await provider.refundStatus(row.kashier_refund_id);
        if (st === 'SUCCESS') outcome = { to: 'succeeded' };
        else if (st === 'FAILURE') outcome = { to: 'failed' };
      } else if (!row.kashier_refund_id && provider.listRefunds) {
        const listed = await provider.listRefunds(row.order_id);
        if (listed !== 'unavailable') {
          for (const cand of listed) {
            if (cand.status !== 'SUCCESS' || cand.amountMinor !== row.amount_minor || !isCardRefundOperation(cand.operation)) continue;
            const taken = await env.DB.prepare('SELECT 1 AS x FROM card_refunds WHERE kashier_refund_id = ?').bind(cand.refundId).first();
            if (taken) continue;
            outcome = { to: 'succeeded', refundId: cand.refundId };
            break;
          }
        }
      }
      if (outcome && (await settleCardRefund(env, row.id, outcome, now))) { out.settled++; return; }
    } catch (err) {
      alert('card_refund_reconcile_failed', { id: row.id, error: err instanceof Error ? err.name : 'error' });
    }
    out.open++;
    if (now - row.created_at > STUCK_AFTER_MS && (await auditOnce(env, 'card_refund_stuck', row.workspace_id, row.id, now))) alert('card_refund_stuck', { id: row.id, workspace: row.workspace_id, state: row.state });
    },
  });
  return out;
}

export type HeldResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_held' | 'not_verified' | 'refund_not_verified' | 'separate_refund_debited' | 'provider_unavailable' };

/**
 * A held refund (its id differs from the id Kashier gave our own refund for the same top-up and amount) matched to that refund by an operator.
 *  - The candidate (`candidate_id`, its own column) must exist, be unconfirmed, in succeeded / pending / linked, on the same order and amount. The
 *    match is ONE guarded batch: the candidate is confirmed only if that statement changed exactly one row, and the held row is marked `matched`
 *    only if it did. Otherwise nothing changes (`not_verified`).
 *  - Kashier must list the held id as a successful card refund of the order for exactly that amount.
 *  - If Kashier lists BOTH the held id and the candidate's id as separate successful refunds, money left Kashier twice: the match is refused and
 *    the held refund is debited as the unknown refund it is (capped at what the top-up credited, P1 alert).
 * No wallet movement on a match: the wallet was debited at approval and the held refund was never debited. Idempotent.
 */
export async function matchHeldRefund(env: Env, a: { refundId: string; actor: string }, now = Date.now(), provider: PaymentProvider | null = paymentProvider(env)): Promise<HeldResult> {
  const held = await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE kashier_refund_id = ? AND source = 'held'`).bind(a.refundId).first<CardRefundRow>();
  if (!held) return { ok: false, reason: 'not_found' };
  if (held.state === 'matched') return { ok: true };
  if (held.state !== 'held') return { ok: false, reason: 'not_held' };
  const cand = held.candidate_id ? await getCardRefund(env, held.candidate_id) : null;
  if (!cand || (cand.source !== 'api' && cand.source !== 'dashboard') || cand.confirmed_at !== null || !['succeeded', 'pending', 'linked'].includes(cand.state) || cand.order_id !== held.order_id || cand.amount_minor !== held.amount_minor) {
    return { ok: false, reason: 'not_verified' };
  }
  if (!provider?.listRefunds) return { ok: false, reason: 'provider_unavailable' };
  const listed = await provider.listRefunds(held.order_id);
  if (listed === 'unavailable') return { ok: false, reason: 'provider_unavailable' };
  const real = listed.find((r) => r.refundId === a.refundId);
  if (!real || real.status !== 'SUCCESS' || !isCardRefundOperation(real.operation) || real.amountMinor !== held.amount_minor) return { ok: false, reason: 'refund_not_verified' };
  const both = cand.kashier_refund_id !== null && listed.some((r) => r.refundId === cand.kashier_refund_id && r.status === 'SUCCESS' && isCardRefundOperation(r.operation));
  if (both) {
    // A real second refund. Debit it as the unknown refund it is: held row -> webhook row (in one guarded batch), then the wallet (idempotent ref).
    const top = await env.DB.prepare('SELECT amount_minor, refunded_minor FROM topups WHERE order_id = ?').bind(held.order_id).first<{ amount_minor: number; refunded_minor: number }>();
    const debit = Math.min(held.amount_minor, top?.amount_minor ?? 0);
    if (debit > 0) {
      // Money first (the ref is idempotent per Kashier transaction, so a retry cannot debit twice), THEN the state flip: if the wallet post
      // throws, the row is still `held` and the retry finds it.
      if (await refuseIfOffboarded(env, held.workspace_id, 'provider_refund', a.refundId, now)) return { ok: false, reason: 'separate_refund_debited' };
      const r = await stubOf(env, held.workspace_id).postWallet({ kind: 'chargeback', netMinor: -debit, ref: `chargeback:${a.refundId}`, note: `provider refund of ${held.order_id}: operator review` }, now);
      if (!r.ok && r.reason !== 'duplicate') throw new Error(`refund debit refused: ${r.reason}`);
      await env.DB.batch([
        env.DB.prepare("UPDATE card_refunds SET source = 'webhook', state = 'succeeded', amount_minor = ?, updated_at = ?, over_charge_minor = ? WHERE id = ? AND source = 'held' AND state = 'held'").bind(debit, now, Math.max(0, (top?.refunded_minor ?? 0) + debit - (top?.amount_minor ?? 0)), held.id),
        env.DB.prepare('UPDATE topups SET refunded_minor = MIN(amount_minor, refunded_minor + ?) WHERE order_id = ? AND changes() > 0').bind(debit, held.order_id),
      ]);
    }
    await noteRefundExcess(env, { kind: 'topup', workspaceId: held.workspace_id, orderId: held.order_id, eventRef: a.refundId, eventMinor: held.amount_minor, overMinor: Math.max(0, (top?.refunded_minor ?? 0) + debit - (top?.amount_minor ?? 0)) }, now);
    alert('refund_held_debited', { severity: 'P1', workspace: held.workspace_id, orderId: held.order_id, refundId: a.refundId, candidate: cand.id, debitedMinor: debit });
    return { ok: false, reason: 'separate_refund_debited' };
  }
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE card_refunds SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL AND state IN ('succeeded', 'pending', 'linked') AND order_id = ? AND amount_minor = ?").bind(now, cand.id, held.order_id, held.amount_minor),
    env.DB.prepare("UPDATE card_refunds SET state = 'matched', updated_at = ? WHERE id = ? AND state = 'held' AND changes() > 0").bind(now, held.id),
  ]);
  if ((res[0]?.meta.changes ?? 0) !== 1 || (res[1]?.meta.changes ?? 0) !== 1) return { ok: false, reason: 'not_verified' };
  await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, ref) VALUES (?, ?, 'refund_held_matched', ?, NULL, ?, ?)")
    .bind(now, a.actor, held.workspace_id, JSON.stringify({ candidate: cand.id, amountMinor: held.amount_minor }), a.refundId).run();
  return { ok: true };
}

export type MarkFailedResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_open' | 'refund_exists_at_provider' | 'provider_unavailable' };

/**
 * A card refund left `sending` or `uncertain` (a crash, a lost answer) turned into a manual payout by an operator, only after Kashier's refund
 * list shows no successful refund of that amount for the top-up that is not already claimed by another row.
 */
export async function markCardRefundFailed(env: Env, a: { requestId: string; cardRefundId: string; actor: string }, now = Date.now(), provider: PaymentProvider | null = paymentProvider(env)): Promise<MarkFailedResult> {
  const row = await getCardRefund(env, a.cardRefundId);
  if (!row || row.request_id !== a.requestId || row.source !== 'api') return { ok: false, reason: 'not_found' };
  if (row.state !== 'sending' && row.state !== 'calling' && row.state !== 'uncertain') return { ok: false, reason: 'not_open' };
  if (!provider?.listRefunds) return { ok: false, reason: 'provider_unavailable' };
  const listed = await provider.listRefunds(row.order_id);
  if (listed === 'unavailable') return { ok: false, reason: 'provider_unavailable' };
  for (const cand of listed) {
    if (cand.status === 'FAILURE' || !isCardRefundOperation(cand.operation) || cand.amountMinor !== row.amount_minor) continue;
    const taken = await env.DB.prepare('SELECT 1 AS x FROM card_refunds WHERE kashier_refund_id = ?').bind(cand.refundId).first();
    if (!taken) return { ok: false, reason: 'refund_exists_at_provider' };
  }
  await settleCardRefund(env, row.id, { to: 'failed' }, now);
  await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, ref) VALUES (?, ?, 'card_refund_marked_failed', ?, NULL, ?, ?)")
    .bind(now, a.actor, row.workspace_id, JSON.stringify({ amountMinor: row.amount_minor }), row.id).run();
  return { ok: true };
}

/**
 * THE eligibility rule for giving a request's wallet chunks back, shared by the abandon, a run noticing the abandon and every sweep. A chunk is
 * reversible only if it has NO card refund row, or its row is `failed` and was closed by the abandon (`note = abandoned:<id>`). If ANY row of
 * the request is in a state where money may have left (calling, succeeded, uncertain, pending, linked), NOTHING is reversible (`blocked`).
 */
export async function reversibleChunks(env: Env, requestId: string): Promise<{ blocked: boolean; chunks: { n: number; amount_minor: number }[] }> {
  const { results: rows } = await env.DB.prepare('SELECT id, state, note FROM card_refunds WHERE request_id = ?').bind(requestId).all<{ id: string; state: string; note: string | null }>();
  if (rows.some((r) => !['planned', 'sending', 'failed'].includes(r.state))) return { blocked: true, chunks: [] };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const { results: chunks } = await env.DB.prepare('SELECT n, amount_minor FROM refund_chunks WHERE request_id = ? ORDER BY n').bind(requestId).all<{ n: number; amount_minor: number }>();
  return { blocked: false, chunks: chunks.filter((c) => { const r = byId.get(`cr:${requestId}:${c.n}`); return !r || (r.state === 'failed' && r.note === `abandoned:${requestId}`); }) };
}

/**
 * Gives back the eligible wallet chunks of a request that are on the ledger without their reversal. The ref `refund-reversal:<id>:<n>` is
 * idempotent, so the abandon, a run and the daily sweep can all call it in any order: a chunk is credited back once. Returns how many reversals
 * were newly posted, and whether the request was blocked (a row may have sent money: nothing is reversed and a P1 is raised once).
 */
export async function reverseUnreversedChunks(env: Env, requestId: string, workspaceId: string, actor: string, now: number): Promise<number> {
  const { blocked, chunks } = await reversibleChunks(env, requestId);
  if (blocked) {
    if (await auditOnce(env, 'refund_reversal_blocked', workspaceId, requestId, now)) alert('refund_reversal_blocked', { severity: 'P1', requestId, workspace: workspaceId });
    return 0;
  }
  if (chunks.length === 0) return 0;
  const stub = stubOf(env, workspaceId);
  const present = new Set(await stub.walletRefsPresent(chunks.flatMap((c) => [`refund:${requestId}:${c.n}`, `refund-reversal:${requestId}:${c.n}`])));
  let posted = 0;
  for (const c of chunks) {
    if (!present.has(`refund:${requestId}:${c.n}`) || present.has(`refund-reversal:${requestId}:${c.n}`)) continue;
    const r = await stub.postWallet({ kind: 'adjustment', netMinor: c.amount_minor, ref: `refund-reversal:${requestId}:${c.n}`, actor, note: `refund request ${requestId} abandoned: chunk ${c.n} returned` }, now);
    if (r.ok) posted++;
    else if (r.reason !== 'duplicate') throw new Error(`refund reversal refused: ${r.reason}`);
  }
  return posted;
}

/**
 * The daily backstop for the race between a run's wallet post and an abandon. Takes the oldest abandoned requests not yet marked clean
 * (`swept_at`), reverses what is eligible and marks each one it finished (clean or blocked-and-alerted) once it is past the grace window, so a backlog is worked off across
 * passes and older requests never starve behind newer ones.
 */
export async function sweepAbandonedRefunds(env: Env, now = Date.now(), batch = DRAIN_PAGE, opts: Pick<PassOpts, 'maxBatches'> = {}): Promise<{ checked: number; reversed: number }> {
  let reversed = 0;
  const { handled } = await drainKeyset<{ id: string; workspace_id: string; abandoned_at: number }, [number, string]>({
    name: 'sweep_abandoned_refunds', pageSize: batch, ...(opts.maxBatches ? { maxBatches: opts.maxBatches } : {}),
    page: async (after) => (await env.DB.prepare(`SELECT id, workspace_id, abandoned_at FROM refund_requests WHERE state = 'abandoned' AND swept_at IS NULL ${after ? 'AND (abandoned_at > ?1 OR (abandoned_at = ?1 AND id > ?2))' : ''} ORDER BY abandoned_at ASC, id ASC LIMIT ${batch}`)
      .bind(...(after ?? [])).all<{ id: string; workspace_id: string; abandoned_at: number }>()).results,
    cursorOf: (r) => [r.abandoned_at, r.id],
    handle: async (r) => {
      try {
        reversed += await reverseUnreversedChunks(env, r.id, r.workspace_id, 'system', now);
        // A run whose lease ran out may still post a chunk shortly after the abandon: mark clean only after twice its lease.
        await env.DB.prepare('UPDATE refund_requests SET swept_at = ? WHERE id = ? AND swept_at IS NULL AND abandoned_at < ?').bind(now, r.id, now - 2 * APPROVAL_LEASE_MS).run();
      } catch (err) {
        alert('refund_abandon_sweep_failed', { severity: 'P1', requestId: r.id, error: err instanceof Error ? err.name : 'error' });
      }
    },
  });
  return { checked: handled, reversed };
}

export type AbandonResult =
  | { ok: true; needsSecond?: true; already?: true }
  | { ok: false; reason: 'not_found' | 'not_abandonable' | 'second_approver_required' | 'money_may_have_left' | 'in_progress' };

/**
 * Abandons a refund request whose approval was cut short (`processing`, wallet debits not complete). Two operators: the first asks, a
 * DIFFERENT one confirms. Confirming:
 *  1. ONE compare-and-swap moves the request `processing` -> `abandoning` under a fresh lease token (a live run, or a concurrent abandon, makes it
 *     `in_progress`). From then on no resume can claim it, and a run holding an older lease can neither post a chunk nor send a row.
 *  2. The safety read comes AFTER that: any row calling / succeeded / uncertain / pending / linked means money may have left, and the request
 *     goes back to `processing` untouched.
 *  3. The planned and sending rows are failed by guarded UPDATEs (each marked `abandoned:<id>`); if one no longer moves (another run got it to
 *     calling first) the abandon stops the same way as in 2.
 *  4. Only the chunks that were really posted AND whose rows this abandon moved (or that never had a row) are credited back, once each
 *     (`refund-reversal:<id>:<n>`, an `adjustment`).
 *  5. `abandoning` -> `abandoned`, audited. A crash anywhere is finished by repeating the call (it takes the lease over once it expired).
 */
export async function abandonRefundRequest(env: Env, a: { id: string; actor: string }, now = Date.now()): Promise<AbandonResult> {
  const req = await env.DB.prepare('SELECT id, workspace_id, state, debit_complete, abandon_requested_by FROM refund_requests WHERE id = ?')
    .bind(a.id).first<{ id: string; workspace_id: string; state: string; debit_complete: number; abandon_requested_by: string | null }>();
  if (!req) return { ok: false, reason: 'not_found' };
  if (req.state === 'abandoned') return { ok: true, already: true };
  if (req.state !== 'abandoning' && (req.state !== 'processing' || req.debit_complete !== 0)) return { ok: false, reason: 'not_abandonable' };
  if (req.abandon_requested_by === null) {
    const first = await env.DB.prepare("UPDATE refund_requests SET abandon_requested_by = ?, abandon_requested_at = ? WHERE id = ? AND abandon_requested_by IS NULL AND state = 'processing' AND debit_complete = 0").bind(a.actor, now, a.id).run();
    if (first.meta.changes) return { ok: true, needsSecond: true };
    return abandonRefundRequest(env, a, now);
  }
  if (req.abandon_requested_by === a.actor && req.state === 'processing') return { ok: false, reason: 'second_approver_required' };
  // 1. the compare-and-swap
  const token = crypto.randomUUID();
  const cas = await env.DB.prepare(
    "UPDATE refund_requests SET state = 'abandoning', claimed_by = ?, lease_until = ? WHERE id = ? AND ((state = 'processing' AND debit_complete = 0) OR state = 'abandoning') AND (lease_until IS NULL OR lease_until < ?)",
  ).bind(token, now + 5 * 60_000, a.id, now).run();
  if (cas.meta.changes !== 1) {
    const cur = await env.DB.prepare('SELECT state FROM refund_requests WHERE id = ?').bind(a.id).first<{ state: string }>();
    return cur?.state === 'abandoned' ? { ok: true, already: true } : { ok: false, reason: 'in_progress' };
  }
  const back = async (reason: 'money_may_have_left'): Promise<AbandonResult> => {
    await env.DB.prepare("UPDATE refund_requests SET state = 'processing', claimed_by = NULL, lease_until = NULL WHERE id = ? AND state = 'abandoning' AND claimed_by = ?").bind(a.id, token).run();
    return { ok: false, reason };
  };
  // 2. the safety read, after the swap
  const { results: rows } = await env.DB.prepare('SELECT id, state, note FROM card_refunds WHERE request_id = ?').bind(a.id).all<{ id: string; state: string; note: string | null }>();
  const mine = `abandoned:${a.id}`;
  if (rows.some((r) => !['planned', 'sending', 'failed'].includes(r.state))) return back('money_may_have_left');
  // 3. fail the open rows, each by a guarded UPDATE
  for (const r of rows.filter((x) => x.state === 'planned' || x.state === 'sending')) {
    const moved = await env.DB.prepare("UPDATE card_refunds SET state = 'failed', note = ?, updated_at = ? WHERE id = ? AND state IN ('planned', 'sending')").bind(mine, now, r.id).run();
    if (moved.meta.changes !== 1) return back('money_may_have_left');
  }
  // 4. reverse what is eligible (the one shared rule): the chunks that were really posted and whose rows this abandon closed, or that never had a row
  const before = await reversibleChunks(env, a.id);
  if (before.blocked) return back('money_may_have_left');
  const reversed = await reverseUnreversedChunks(env, a.id, req.workspace_id, a.actor, now);
  // 5. finish
  const done = await env.DB.prepare("UPDATE refund_requests SET state = 'abandoned', abandoned_at = ?, card_refunded_minor = 0, manual_minor = 0, claimed_by = NULL, lease_until = NULL WHERE id = ? AND state = 'abandoning' AND claimed_by = ?").bind(now, a.id, token).run();
  if (done.meta.changes) {
    await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, ref) VALUES (?, ?, 'refund_abandoned', ?, ?, ?, ?)")
      .bind(now, a.actor, req.workspace_id, JSON.stringify({ requestedBy: req.abandon_requested_by }), JSON.stringify({ reversedChunks: reversed }), a.id).run();
    // A debit that was in flight in a run when the swap happened lands after the checks above: sweep once more now that the request is closed.
    await reverseUnreversedChunks(env, a.id, req.workspace_id, a.actor, now);
  }
  return { ok: true };
}
