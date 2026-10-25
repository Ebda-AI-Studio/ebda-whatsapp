/**
 * Card refunds and every refund the provider tells us about (`card_refunds`, migration 0010).
 *
 * One rule: the wallet is debited ONCE per refund. A refund request debits the wallet when an operator approves it (`refund:<id>:<n>`); a
 * refund the provider later reports (our own API call, or an operator refunding the card in the provider's dashboard) must be recognised as
 * that same money, not booked again. So every refund transaction we know of has a row here BEFORE the provider is asked, the provider's
 * refund id is stored when it is known, and the refund webhook is matched against the rows:
 *   1. by the provider's refund id                                            -> ours: reconcile the row, no wallet movement
 *   2. else an open API row for the same top-up with the same amount          -> ours: bind the id, reconcile, no wallet movement
 *   3. else it is a refund or chargeback we did not start                     -> the wallet is debited, once, capped at what the top-up
 *      credited the wallet (`amount_minor - refunded_minor`, one unit: the card fee was never in the wallet), and recorded here.
 * Kashier documents no idempotency key, so the provider's refund API is called at most once per recorded row; a timeout or an unreadable
 * answer leaves the row `uncertain` and is reconciled (webhook, refund status, refund list), never repeated.
 */
import type { Env } from '../../env';
import { TRANSACTION_ID } from './kashier-confirm';
import { auditOnce } from './package-orders';
import type { ParsedWebhook, PaymentProvider } from './payments';

export const OPEN = "('sending', 'pending', 'uncertain')";
const STUCK_AFTER_MS = 3 * 86_400_000;
const RECONCILE_AFTER_MS = 15 * 60_000;
const alert = (what: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ alert: what, ...extra }));
const stubOf = (env: Env, workspaceId: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));

export type CardRefundRow = {
  id: string; request_id: string | null; order_id: string; workspace_id: string; amount_minor: number; source: 'api' | 'dashboard' | 'webhook';
  state: 'sending' | 'pending' | 'uncertain' | 'succeeded' | 'failed' | 'linked'; kashier_refund_id: string | null; created_at: number; updated_at: number;
};
const COLS = 'id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at';
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
  const byId = await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE kashier_refund_id = ?`).bind(ev.transactionId).first<CardRefundRow>();
  if (byId && byId.source !== 'webhook') {
    // Ours (an API refund, or one linked from the provider's dashboard).
    if (byId.state === 'sending' || byId.state === 'pending' || byId.state === 'uncertain') {
      await settleCardRefund(env, byId.id, { to: ev.status === 'SUCCESS' ? 'succeeded' : 'failed' }, now);
    }
    return 'refund_reconciled';
  }
  if (ev.status !== 'SUCCESS') return 'ignored';
  if (!byId) {
    const open = await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE order_id = ? AND source = 'api' AND state IN ${OPEN} AND amount_minor = ? ORDER BY (kashier_refund_id IS NULL) DESC, created_at LIMIT 1`).bind(t.order_id, ev.amountMinor).first<CardRefundRow>();
    if (open) {
      if (await settleCardRefund(env, open.id, { to: 'succeeded', refundId: ev.transactionId }, now, { overrideId: true })) return 'refund_reconciled';
      return 'refund_reconciled'; // another path settled it first
    }
  }
  // A refund or chargeback we did not start. The wallet only ever held `amount_minor` of this top-up (the card fee never was in it), and
  // `refunded_minor` counts the same unit, so the debit is capped by what is left, in that one unit.
  let row = byId;
  if (!row) {
    const reserved = await env.DB.prepare(`SELECT coalesce(sum(amount_minor), 0) AS n FROM card_refunds WHERE order_id = ? AND state IN ${OPEN}`).bind(t.order_id).first<{ n: number }>();
    const fresh = await env.DB.prepare('SELECT amount_minor, refunded_minor FROM topups WHERE order_id = ?').bind(t.order_id).first<{ amount_minor: number; refunded_minor: number }>();
    const debit = Math.min(ev.amountMinor, (fresh?.amount_minor ?? 0) - (fresh?.refunded_minor ?? 0) - (reserved?.n ?? 0));
    if (debit <= 0) {
      if (await auditOnce(env, 'refund_unmatched', t.workspace_id, ev.transactionId, now)) alert('refund_unmatched', { workspace: t.workspace_id, orderId: t.order_id });
      return 'refund_unmatched';
    }
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, 'webhook', 'succeeded', ?, ?, ?)")
        .bind(`wh:${ev.transactionId}`, t.order_id, t.workspace_id, debit, ev.transactionId, now, now),
      env.DB.prepare('UPDATE topups SET refunded_minor = refunded_minor + ? WHERE order_id = ? AND changes() > 0').bind(debit, t.order_id),
    ]);
    row = (await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE kashier_refund_id = ?`).bind(ev.transactionId).first<CardRefundRow>())!;
  }
  // Same ref on every path and replay: a second delivery posts nothing.
  const r = await stubOf(env, t.workspace_id).postWallet({ kind: 'chargeback', netMinor: -row.amount_minor, ref: `chargeback:${ev.transactionId}`, note: `provider refund of ${t.order_id}: operator review` }, now);
  if (r.ok) alert('topup_refunded_by_provider', { workspace: t.workspace_id, orderId: t.order_id });
  else if (r.reason !== 'duplicate') throw new Error(`refund debit refused: ${r.reason}`);
  return 'refunded';
}

export type LinkResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_manual_payout' | 'invalid_refund_id' | 'invalid_order' | 'exceeds_manual' | 'exceeds_order' | 'amount_mismatch' | 'already_linked' };

/**
 * "Refunded in the provider's dashboard": an operator paid a manual payout by refunding the card in Kashier's dashboard and links that
 * refund to the request. The wallet was already debited at approval, so the provider's webhook for it must not debit again. If that webhook
 * already arrived first (booked as an unknown refund and debited), the duplicate debit is returned by an offsetting adjustment.
 */
export async function linkDashboardRefund(env: Env, a: { requestId: string; kashierRefundId: string; amountMinor: number; orderId?: string; actor: string }, now = Date.now()): Promise<LinkResult> {
  if (!TRANSACTION_ID.test(a.kashierRefundId)) return { ok: false, reason: 'invalid_refund_id' };
  const req = await env.DB.prepare('SELECT id, workspace_id, state, manual_minor FROM refund_requests WHERE id = ?').bind(a.requestId).first<{ id: string; workspace_id: string; state: string; manual_minor: number }>();
  if (!req) return { ok: false, reason: 'not_found' };
  if (req.state !== 'manual_payout') return { ok: false, reason: 'not_manual_payout' };
  if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor <= 0 || a.amountMinor > req.manual_minor) return { ok: false, reason: 'exceeds_manual' };
  const existing = await env.DB.prepare(`SELECT ${COLS} FROM card_refunds WHERE kashier_refund_id = ?`).bind(a.kashierRefundId).first<CardRefundRow>();
  if (existing) {
    if (existing.source !== 'webhook' || existing.workspace_id !== req.workspace_id) return { ok: false, reason: 'already_linked' };
    if (existing.amount_minor !== a.amountMinor) return { ok: false, reason: 'amount_mismatch' };
    // The refund webhook came first and debited the wallet a second time: give that debit back, then link.
    const back = await stubOf(env, req.workspace_id).postWallet({ kind: 'adjustment', netMinor: existing.amount_minor, ref: `relink:${a.kashierRefundId}`, actor: a.actor, note: `refund ${a.kashierRefundId} linked to request ${a.requestId}: duplicate debit returned` }, now);
    if (!back.ok && back.reason !== 'duplicate') throw new Error(`relink refused: ${back.reason}`);
    await env.DB.prepare("UPDATE card_refunds SET source = 'dashboard', state = 'linked', request_id = ?, updated_at = ? WHERE id = ? AND source = 'webhook'").bind(a.requestId, now, existing.id).run();
  } else {
    const q = a.orderId
      ? env.DB.prepare("SELECT order_id, amount_minor, refunded_minor FROM topups WHERE workspace_id = ? AND state = 'paid' AND order_id = ?").bind(req.workspace_id, a.orderId)
      : env.DB.prepare("SELECT order_id, amount_minor, refunded_minor FROM topups WHERE workspace_id = ? AND state = 'paid' AND transaction_id IS NOT NULL AND amount_minor - refunded_minor >= ? ORDER BY paid_at, order_id LIMIT 1").bind(req.workspace_id, a.amountMinor);
    const t = await q.first<{ order_id: string; amount_minor: number; refunded_minor: number }>();
    if (!t) return { ok: false, reason: a.orderId ? 'invalid_order' : 'exceeds_order' };
    const reserved = await env.DB.prepare(`SELECT coalesce(sum(amount_minor), 0) AS n FROM card_refunds WHERE order_id = ? AND state IN ${OPEN}`).bind(t.order_id).first<{ n: number }>();
    if (a.amountMinor > t.amount_minor - t.refunded_minor - (reserved?.n ?? 0)) return { ok: false, reason: 'exceeds_order' };
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'dashboard', 'linked', ?, ?, ?)")
          .bind(`dash:${a.kashierRefundId}`, a.requestId, t.order_id, req.workspace_id, a.amountMinor, a.kashierRefundId, now, now),
        env.DB.prepare('UPDATE topups SET refunded_minor = refunded_minor + ? WHERE order_id = ? AND changes() > 0').bind(a.amountMinor, t.order_id),
      ]);
    } catch {
      return { ok: false, reason: 'already_linked' }; // the provider's refund id is unique
    }
  }
  await refreshRequest(env, a.requestId);
  await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) VALUES (?, ?, 'refund_dashboard_linked', ?, NULL, ?, ?)")
    .bind(now, a.actor, req.workspace_id, JSON.stringify({ amountMinor: a.amountMinor }), `${a.requestId}:${a.kashierRefundId}`).run();
  return { ok: true };
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
            if (cand.status !== 'SUCCESS' || cand.amountMinor !== row.amount_minor) continue;
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
