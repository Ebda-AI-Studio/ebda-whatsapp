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
import { isCardRefundOperation, paymentProvider, type ParsedWebhook, type PaymentProvider } from './payments';

export const OPEN = "('sending', 'pending', 'uncertain')";
const STUCK_AFTER_MS = 3 * 86_400_000;
const RECONCILE_AFTER_MS = 15 * 60_000;
const alert = (what: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ alert: what, ...extra }));
const stubOf = (env: Env, workspaceId: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));

export type CardRefundRow = {
  id: string; request_id: string | null; order_id: string; workspace_id: string; amount_minor: number; source: 'api' | 'dashboard' | 'webhook';
  state: 'sending' | 'pending' | 'uncertain' | 'succeeded' | 'failed' | 'linked'; kashier_refund_id: string | null; created_at: number; updated_at: number; note: string | null;
};
const COLS = 'id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at, note';
export const getCardRefund = (env: Env, id: string) => env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE id = ?`).bind(id).first<CardRefundRow>();

/**
 * Recomputes a request's split from its rows (derived, never incremented, so a replay cannot drift it): card = succeeded + linked rows,
 * open = rows still waiting for the provider, manual = the rest. `processing` while anything is open, else `manual_payout` while a manual
 * part remains, else `paid`. A request an operator already closed (`paid`, `rejected`, ...) is left alone.
 */
export async function refreshRequest(env: Env, requestId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE refund_requests SET
       card_refunded_minor = (SELECT coalesce(sum(amount_minor), 0) FROM card_refunds WHERE request_id = refund_requests.id AND state IN ('succeeded', 'linked')),
       manual_minor = amount_minor - (SELECT coalesce(sum(amount_minor), 0) FROM card_refunds WHERE request_id = refund_requests.id AND state IN ('succeeded', 'linked'))
                      - (SELECT coalesce(sum(amount_minor), 0) FROM card_refunds WHERE request_id = refund_requests.id AND state IN ${OPEN}),
       state = CASE
         WHEN EXISTS (SELECT 1 FROM card_refunds WHERE request_id = refund_requests.id AND state IN ${OPEN}) THEN 'processing'
         WHEN amount_minor - (SELECT coalesce(sum(amount_minor), 0) FROM card_refunds WHERE request_id = refund_requests.id AND state IN ('succeeded', 'linked')) > 0 THEN 'manual_payout'
         ELSE 'paid' END
     WHERE id = ? AND state IN ('processing', 'manual_payout')`,
  ).bind(requestId).run();
}

/** Records the row BEFORE the provider is asked. A re-run of the same approval finds the same id and never inserts a second row. */
export async function openCardRefund(env: Env, r: { id: string; requestId: string; orderId: string; workspaceId: string; amountMinor: number }, now: number): Promise<CardRefundRow> {
  await env.DB.prepare("INSERT OR IGNORE INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'api', 'sending', ?, ?)")
    .bind(r.id, r.requestId, r.orderId, r.workspaceId, r.amountMinor, now, now).run();
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
    stmts.push(env.DB.prepare('UPDATE topups SET refunded_minor = refunded_minor + (SELECT amount_minor FROM card_refunds WHERE id = ?) WHERE order_id = (SELECT order_id FROM card_refunds WHERE id = ?) AND changes() > 0').bind(id, id));
  }
  const res = await env.DB.batch(stmts);
  const moved = (res[0]?.meta.changes ?? 0) > 0;
  const row = await getCardRefund(env, id);
  if (row?.request_id) await refreshRequest(env, row.request_id);
  return moved;
}

type TopupLite = { order_id: string; workspace_id: string };

/**
 * A confirmed refund webhook for one of our top-ups (SUCCESS or FAILURE). Returns the resolution word. Throws only when something could
 * not be written (the caller answers 5xx and the delivery is retried; every step is idempotent).
 */
export async function applyProviderRefund(env: Env, t: TopupLite, ev: ParsedWebhook, now: number): Promise<string> {
  const isCardRefund = !ev.chargeback && isCardRefundOperation(ev.operation);
  const byId = await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE kashier_refund_id = ?`).bind(ev.transactionId).first<CardRefundRow>();
  if (byId && byId.source !== 'webhook') {
    if (!isCardRefund) {
      // A chargeback / reversal / void carrying the id of a refund we recorded is not that refund: nothing is settled, a person looks.
      alert('refund_id_conflict', { severity: 'P1', workspace: t.workspace_id, orderId: t.order_id });
      return 'refund_unmatched';
    }
    if (byId.state === 'sending' || byId.state === 'pending' || byId.state === 'uncertain') {
      await settleCardRefund(env, byId.id, { to: ev.status === 'SUCCESS' ? 'succeeded' : 'failed' }, now);
    }
    return 'refund_reconciled';
  }
  if (ev.status !== 'SUCCESS') return 'ignored';
  if (!byId && isCardRefund) {
    // Kashier's own details (confirm) say this is a refund of this order; the signed amount must equal ours, and our row must not have an id yet.
    const open = await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE order_id = ? AND source = 'api' AND state IN ${OPEN} AND kashier_refund_id IS NULL AND amount_minor = ? ORDER BY created_at LIMIT 1`).bind(t.order_id, ev.amountMinor).first<CardRefundRow>();
    if (open) {
      await settleCardRefund(env, open.id, { to: 'succeeded', refundId: ev.transactionId }, now); // false = another path settled it first
      return 'refund_reconciled';
    }
  }
  // A refund or chargeback we did not start. The wallet only ever held `amount_minor` of this top-up (the card fee never was in it): debit the
  // event's full amount up to that, once, whatever else happened to the top-up (a chargeback is never shrunk by refunds already made or open).
  let row = byId;
  let excess = 0;
  if (!row) {
    const top = await env.DB.prepare('SELECT amount_minor, fee_minor FROM topups WHERE order_id = ?').bind(t.order_id).first<{ amount_minor: number; fee_minor: number }>();
    const credited = top?.amount_minor ?? 0;
    const debit = Math.min(ev.amountMinor, credited);
    if (debit <= 0) throw new Error('refund of a top-up that credited nothing');
    excess = ev.amountMinor - debit;
    const res = await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at, note) VALUES (?, NULL, ?, ?, ?, 'webhook', 'succeeded', ?, ?, ?, ?)")
        .bind(`wh:${ev.transactionId}`, t.order_id, t.workspace_id, debit, ev.transactionId, now, now, excess > 0 ? `excess_minor=${excess};fee_minor=${top?.fee_minor ?? 0}` : null),
      env.DB.prepare('UPDATE topups SET refunded_minor = refunded_minor + ? WHERE order_id = ? AND changes() > 0').bind(debit, t.order_id),
    ]);
    row = (await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE kashier_refund_id = ?`).bind(ev.transactionId).first<CardRefundRow>())!;
    if (!(res[0]?.meta.changes ?? 0) && row.source !== 'webhook') {
      // Another path (an API refund, or a link) took this refund id between our read and our write: it owns the money, the wallet was
      // debited at approval, and nothing is posted here.
      if (isCardRefund && (row.state === 'sending' || row.state === 'pending' || row.state === 'uncertain')) await settleCardRefund(env, row.id, { to: 'succeeded' }, now);
      return 'refund_reconciled';
    }
    // Beyond the credited amount the card fee explains up to `fee_minor`; anything past that is money we cannot place: a person decides.
    const unexplained = excess - Math.min(excess, top?.fee_minor ?? 0);
    if (unexplained > 0 && (await auditOnce(env, 'refund_excess_review', t.workspace_id, ev.transactionId, now))) {
      alert('refund_excess_for_review', { severity: 'P1', workspace: t.workspace_id, orderId: t.order_id, refundId: ev.transactionId, excessMinor: unexplained, chargeback: !!ev.chargeback });
    }
  }
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
  const adj = await requestAdjustment(env, { id, actor: a.actor, workspaceId, amountMinor: row.amount_minor, reason: `refund ${a.kashierRefundId} linked to request ${a.requestId}: duplicate debit returned` }, now);
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
    topup = await env.DB.prepare("SELECT order_id, amount_minor, refunded_minor FROM topups WHERE workspace_id = ? AND state = 'paid' AND transaction_id IS NOT NULL AND amount_minor - refunded_minor >= ? ORDER BY paid_at, order_id LIMIT 1").bind(req.workspace_id, a.amountMinor).first();
  }
  if (!topup) return { ok: false, reason: a.orderId ? 'invalid_order' : 'exceeds_order' };
  if (!existing) {
    const reserved = await env.DB.prepare(`SELECT coalesce(sum(amount_minor), 0) AS n FROM card_refunds WHERE order_id = ? AND state IN ${OPEN}`).bind(topup.order_id).first<{ n: number }>();
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
        env.DB.prepare('UPDATE topups SET refunded_minor = refunded_minor + ? WHERE order_id = ? AND changes() > 0').bind(a.amountMinor, topup.order_id),
      ]);
    } catch {
      return { ok: false, reason: 'already_linked' }; // the provider's refund id is unique
    }
  }
  await refreshRequest(env, a.requestId);
  await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) VALUES (?, ?, 'refund_dashboard_linked', ?, NULL, ?, ?)")
    .bind(now, a.actor, req.workspace_id, JSON.stringify({ amountMinor: a.amountMinor, ...(adjustment ? { adjustmentId: adjustment.id } : {}) }), `${a.requestId}:${a.kashierRefundId}`).run();
  return { ok: true, ...(adjustment ? { adjustment } : {}) };
}

/**
 * Daily: asks the provider about refunds still waiting (`sending` / `pending` / `uncertain`, older than 15 min). A pending one with an id is
 * read by id; one without an id is looked for in the provider's refund list for its top-up (same order, same amount, not already ours).
 * Nothing is ever re-sent. One that stays unresolved for 3 days alerts once (`card_refund_stuck`): a person checks the provider's dashboard.
 */
export async function reconcileCardRefunds(env: Env, provider: PaymentProvider | null, now = Date.now()): Promise<{ settled: number; open: number }> {
  const out = { settled: 0, open: 0 };
  if (!provider) return out;
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE state IN ${OPEN} AND source = 'api' AND updated_at < ? ORDER BY created_at LIMIT 100`).bind(now - RECONCILE_AFTER_MS).all<CardRefundRow>();
  for (const row of results) {
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
      if (outcome && (await settleCardRefund(env, row.id, outcome, now))) { out.settled++; continue; }
    } catch (err) {
      alert('card_refund_reconcile_failed', { id: row.id, error: err instanceof Error ? err.name : 'error' });
    }
    out.open++;
    if (now - row.created_at > STUCK_AFTER_MS && (await auditOnce(env, 'card_refund_stuck', row.workspace_id, row.id, now))) alert('card_refund_stuck', { id: row.id, workspace: row.workspace_id, state: row.state });
  }
  return out;
}
