/**
 * Self-serve package checkout (behind PACKAGE_CHECKOUT_ENABLED, default off). Same Kashier machinery and the same signed webhook as
 * top-ups; a second order kind.
 *
 * Money rules: the amount is read from `packages.price_minor` on the server, never from the client. A pending `package_orders` row is
 * written when the OWNER starts a checkout (and the session is not revoked: fail closed). A package is granted only from a webhook whose
 * HMAC verified (the shared path in `handleProviderWebhook`), with status SUCCESS and the order id, amount and currency matching OUR row;
 * the workspace and package come from the row, never from the payload.
 *
 * Exactly-once grant: ONE D1 batch claims the order (pending|failed|expired -> paid, `provider_ref` unique), writes the subscription only if
 * that claim holds and the order is not yet granted, and stamps `granted_at`. Either all of it commits or none does, so there is no state
 * in which money is taken, the order says paid and nothing was granted; a retried webhook finds `granted_at` and only re-announces.
 * The daily `repairPackageOrders` grants any `paid` + `granted_at IS NULL` row anyway and alerts. No card fee is added to a package price.
 */
import type { Env } from '../../env';
import { PACKAGE_FEATURE_KEYS } from '../api/contract';
import { sessionState } from '../identity/session';
import { packagesEnabled, paymentProvider, type ParsedWebhook, type PaymentProvider } from './payments';
import { MONTH_SQL, announceSubscription, fallbackToStorePlan, setSubscription } from './subscriptions';

const alert = (what: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ alert: what, ...extra }));
const errName = (err: unknown) => (err instanceof Error ? err.name : 'error');
export const PENDING_EXPIRES_AFTER_MS = 24 * 3_600_000;

export type PackageDto = { id: string; name: string; priceMinor: number; aiCredits: number; maxMembers: number; features: (typeof PACKAGE_FEATURE_KEYS)[number][]; periodMonths: number };
export type OrderStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded' | 'charged_back';
export type PackageOrderRow = {
  order_id: string; workspace_id: string; package_id: string; amount_minor: number; currency: string; status: OrderStatus; created_at: number;
  provider_ref: string | null; granted_at: number | null; queued: number; refunded_minor: number;
};
export const ORDER_COLS = 'order_id, workspace_id, package_id, amount_minor, currency, status, created_at, provider_ref, granted_at, queued, refunded_minor';

/** Active packages a merchant can buy (a free package, like the one a Store plan includes, is not for sale). */
export async function listPackages(env: Env): Promise<PackageDto[]> {
  const { results } = await env.DB.prepare('SELECT id, name, price_minor, ai_credits, max_members, feat_campaigns, feat_order_in_chat, feat_api, priority_support FROM packages WHERE active = 1 AND price_minor > 0 ORDER BY price_minor, id')
    .all<{ id: string; name: string; price_minor: number; ai_credits: number; max_members: number; feat_campaigns: number; feat_order_in_chat: number; feat_api: number; priority_support: number }>();
  return results.map((r) => {
    const on: Record<(typeof PACKAGE_FEATURE_KEYS)[number], boolean> = {
      members: true, shared_inbox: true, order_confirmations: true, templates: true, campaigns: r.feat_campaigns === 1, order_in_chat: r.feat_order_in_chat === 1,
      api: r.feat_api === 1, priority_support: r.priority_support === 1, ai_credits: r.ai_credits > 0,
    };
    return { id: r.id, name: r.name, priceMinor: r.price_minor, aiCredits: r.ai_credits, maxMembers: r.max_members, features: PACKAGE_FEATURE_KEYS.filter((k) => on[k]), periodMonths: 1 };
  });
}

export type StartPackageResult =
  | { ok: true; orderId: string; amountMinor: number; checkoutUrl: string }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'session_revoked' | 'unknown_package' };

export async function startPackageCheckout(env: Env, a: { workspaceId: string; userId: string; sessionId: string; packageId: string }, now = Date.now()): Promise<StartPackageResult> {
  if (!packagesEnabled(env)) return { ok: false, reason: 'disabled' };
  const provider = paymentProvider(env);
  // Without the Kashier secret key every webhook would be refused: do not let customers pay for something that can never be granted.
  if (!provider || !provider.confirmationReady()) return { ok: false, reason: 'unavailable' };
  const pkg = await env.DB.prepare('SELECT price_minor FROM packages WHERE id = ? AND active = 1 AND price_minor > 0').bind(a.packageId).first<{ price_minor: number }>();
  if (!pkg) return { ok: false, reason: 'unknown_package' };
  const session = await sessionState(env, a.sessionId);
  if (session === 'revoked') return { ok: false, reason: 'session_revoked' };
  if (session === 'unavailable') return { ok: false, reason: 'unavailable' };
  const orderId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO package_orders (order_id, workspace_id, package_id, amount_minor, currency, status, created_by, created_at) VALUES (?, ?, ?, ?, 'EGP', 'pending', ?, ?)")
    .bind(orderId, a.workspaceId, a.packageId, pkg.price_minor, a.userId, now).run();
  try {
    const { checkoutUrl } = await provider.createSession({ orderId, totalMinor: pkg.price_minor, currency: 'EGP' });
    // Only the provider's own checkout origin is ever handed to a merchant's browser.
    if (new URL(checkoutUrl).origin !== new URL(env.KASHIER_CHECKOUT_URL ?? 'https://checkout.kashier.io').origin) throw new Error('unexpected checkout origin');
    return { ok: true, orderId, amountMinor: pkg.price_minor, checkoutUrl };
  } catch {
    await env.DB.prepare("UPDATE package_orders SET status = 'failed' WHERE order_id = ? AND status = 'pending'").bind(orderId).run();
    return { ok: false, reason: 'unavailable' };
  }
}

export async function getPackageOrder(env: Env, workspaceId: string, orderId: string): Promise<PackageOrderRow | null> {
  return env.DB.prepare(`SELECT ${ORDER_COLS} FROM package_orders WHERE order_id = ? AND workspace_id = ?`).bind(orderId, workspaceId).first<PackageOrderRow>();
}

/** What the merchant's page may be told: `paid` only once the package was really granted. */
export function publicState(o: Pick<PackageOrderRow, 'status' | 'granted_at'>): 'pending' | 'paid' | 'failed' | 'expired' | 'refunded' {
  if (o.status === 'paid') return o.granted_at === null ? 'pending' : 'paid';
  return o.status === 'charged_back' ? 'refunded' : o.status;
}

export const findPackageOrder = (env: Env, orderId: string): Promise<PackageOrderRow | null> => env.DB.prepare(`SELECT ${ORDER_COLS} FROM package_orders WHERE order_id = ?`).bind(orderId).first<PackageOrderRow>();

function addMonth(ms: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

const orderPaidUngranted = (orderId: string, ref: string) => ({
  sql: "EXISTS (SELECT 1 FROM package_orders WHERE order_id = ? AND status = 'paid' AND provider_ref = ? AND granted_at IS NULL)", binds: [orderId, ref],
});

/**
 * Claims (if still open) and grants one order in a single batch. `ref` is the provider transaction. Returns whether THIS call granted;
 * a replay (already granted) only re-announces so a push or Store event lost after the commit still happens.
 * The same batch records which period the order paid for: `owns_running` (a new period) or `queued_seq` (an early renewal of the same
 * running package, queued behind it), so a later refund knows what to take back.
 */
export async function grantOrder(env: Env, row: PackageOrderRow, ref: string, now: number, opts: { claim: boolean }): Promise<'granted' | 'replay'> {
  const claim = env.DB.prepare("UPDATE package_orders SET status = 'paid', provider_ref = ?, paid_at = ? WHERE order_id = ? AND status IN ('pending', 'failed', 'expired')").bind(ref, now, row.order_id);
  const RUNNING = "EXISTS (SELECT 1 FROM workspace_subscriptions s WHERE s.workspace_id = package_orders.workspace_id AND s.package_id = package_orders.package_id AND s.period_end > ? AND s.status IN ('active', 'trialing'))";
  const flag = env.DB.prepare(
    `UPDATE package_orders SET queued = ${RUNNING},
       queued_seq = CASE WHEN ${RUNNING} THEN (SELECT coalesce(max(q.queued_seq), 0) + 1 FROM package_orders q WHERE q.workspace_id = package_orders.workspace_id) END,
       owns_running = CASE WHEN ${RUNNING} THEN 0 ELSE 1 END
     WHERE order_id = ? AND status = 'paid' AND provider_ref = ? AND granted_at IS NULL`,
  ).bind(now, now, now, row.order_id, ref);
  // A new period replaces the previous owner of the running one.
  const handOver = env.DB.prepare(
    `UPDATE package_orders SET owns_running = 0 WHERE workspace_id = ? AND order_id != ? AND owns_running = 1
       AND EXISTS (SELECT 1 FROM package_orders n WHERE n.order_id = ? AND n.owns_running = 1 AND n.status = 'paid' AND n.provider_ref = ? AND n.granted_at IS NULL)`,
  ).bind(row.workspace_id, row.order_id, row.order_id, ref);
  const stamp = env.DB.prepare('UPDATE package_orders SET granted_at = ? WHERE order_id = ? AND provider_ref = ? AND granted_at IS NULL AND changes() > 0').bind(now, row.order_id, ref);
  const r = await setSubscription(env, { workspaceId: row.workspace_id, packageId: row.package_id, status: 'active', periodStart: now, periodEnd: addMonth(now), source: 'purchase', ref: row.order_id }, now, {
    before: opts.claim ? [claim, flag, handOver] : [flag, handOver], only: orderPaidUngranted(row.order_id, ref), after: [stamp], renewal: true,
  });
  if (r.written) return 'granted';
  const now2 = await findPackageOrder(env, row.order_id);
  if (now2 && now2.status === 'paid' && now2.granted_at !== null && now2.provider_ref === ref) await announceSubscription(env, row.workspace_id, now);
  return 'replay';
}

/** Appends the audit row only if no row with this action + reason exists. True when this call wrote it (the caller alerts only then). */
export async function auditOnce(env: Env, action: string, workspaceId: string, reason: string, now: number): Promise<boolean> {
  const r = await env.DB.prepare('INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) SELECT ?, ?, ?, ?, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM billing_audit WHERE action = ? AND reason = ?)')
    .bind(now, 'provider', action, workspaceId, JSON.stringify({ orderId: reason }), reason, action, reason).run();
  return r.meta.changes > 0;
}
async function recordOnce(env: Env, action: string, row: PackageOrderRow, reason: string, now: number): Promise<void> {
  await auditOnce(env, action, row.workspace_id, reason, now);
}

/**
 * A CONFIRMED webhook for one of our package orders (the caller has already asked the provider what the signed transaction really is, so
 * `ev.event` is the provider's own kind, never the unsigned label). Throws only when something could not be written (the caller answers 5xx).
 */
export class RefundContention extends Error {
  constructor() {
    super('refund_contention');
    this.name = 'RefundContention';
  }
}

/** Returns how the delivery ended (a resolution word), or `payment_pending` when a refund must wait for its payment to be granted. */
export async function applyPackageWebhook(env: Env, row: PackageOrderRow, ev: ParsedWebhook, now: number): Promise<string> {
  if (ev.event === 'refund') return ev.status === 'SUCCESS' ? refundOrder(env, row, ev, now) : 'ignored';
  if (ev.event !== 'pay') return 'ignored';
  if (ev.status === 'FAILURE') {
    await env.DB.prepare("UPDATE package_orders SET status = 'failed' WHERE order_id = ? AND status = 'pending'").bind(row.order_id).run();
    return 'failed';
  }
  if (ev.status !== 'SUCCESS') return 'ignored';
  if (ev.currency !== row.currency || ev.amountMinor !== row.amount_minor) {
    // Once per order: the daily repair would otherwise repeat it every pass.
    if (await auditOnce(env, 'package_amount_mismatch', row.workspace_id, row.order_id, now)) alert('package_amount_mismatch', { workspace: row.workspace_id });
    return 'amount_mismatch';
  }
  const granted = await grantOrder(env, row, ev.transactionId, now, { claim: true });
  const after = await findPackageOrder(env, row.order_id);
  if (after && after.status !== 'pending' && after.provider_ref !== null && after.provider_ref !== ev.transactionId) {
    // The order is already bound to another transaction: a second success. Nothing is granted; a person must look at it.
    alert('duplicate_success', { kind: 'package', workspace: row.workspace_id, orderId: row.order_id, eventKey: ev.eventKey });
    await recordOnce(env, 'package_duplicate_payment', row, ev.transactionId, now);
    return 'duplicate_success';
  }
  return granted;
}

const G = (refundRef: string) => ({ sql: 'EXISTS (SELECT 1 FROM package_refunds WHERE refund_ref = ? AND applied = 0)', binds: [refundRef] });

/**
 * A provider refund or chargeback of a package order, applied once per refund transaction. The refund must be a DIFFERENT transaction from
 * the payment it returns (a relabelled payment is refused).
 *  - Full (cumulative refunds reach the order amount): the order closes. If it owns the running period, that period ends now and the next
 *    queued one starts immediately, or, with none queued, the plan is cancelled and the period's unused credits are zeroed. If it paid for a
 *    queued period, only that period is removed (later ones move up). If its period already ended, the plan is untouched.
 *  - Partial: the running period it owns is shortened by the refunded fraction and the same fraction of its unused credits expires.
 */
async function refundOrder(env: Env, row0: PackageOrderRow, ev: ParsedWebhook, now: number): Promise<string> {
  const refundRef = ev.transactionId;
  const r = ev.amountMinor;
  let outcome = 'refunded';
  let settled = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = (await findPackageOrder(env, row0.order_id)) ?? row0;
    // The payment is not granted (yet): hold the refund until it is, whichever path grants it.
    if (row.status === 'pending' || row.status === 'failed' || row.status === 'expired') return 'payment_pending';
    if (!row.provider_ref || row.provider_ref === refundRef) {
      alert('refund_refused', { kind: 'package', workspace: row.workspace_id, eventKey: ev.eventKey });
      return 'refund_refused';
    }
    const known = await env.DB.prepare('SELECT applied FROM package_refunds WHERE refund_ref = ?').bind(refundRef).first<{ applied: number }>();
    if (known) {
      if (row.status === 'refunded' || row.status === 'charged_back') await announceSubscription(env, row.workspace_id, now); // a replay: make sure the push and the Store event happened
      outcome = 'replay';
      settled = true;
      break;
    }
    if (row.status !== 'paid' || r <= 0) {
      alert('package_refund_unmatched', { workspace: row.workspace_id, orderId: row.order_id });
      return 'unmatched';
    }
    const subBefore = await env.DB.prepare('SELECT version FROM workspace_subscriptions WHERE workspace_id = ?').bind(row.workspace_id).first<{ version: number }>();
    const amount = row.amount_minor;
    const before = row.refunded_minor;
    const remainingBefore = amount - before;
    const full = before + r >= amount;
    const g = G(refundRef);
    const ws = row.workspace_id;
    const oid = row.order_id;
    // The refund row is the gate of everything below, and it is only written if the order still has exactly the refunded amount this
    // decision was made on: a refund that committed in between makes the insert a no-op, and the loop decides again.
    const stmts: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO package_refunds (refund_ref, order_id, amount_minor, at, period_start, applied, frac_num, frac_den)
         SELECT ?, ?, ?, ?, (SELECT period_start FROM workspace_subscriptions WHERE workspace_id = ?), 0, ?, ?
         WHERE EXISTS (SELECT 1 FROM package_orders WHERE order_id = ? AND status = 'paid' AND refunded_minor = ?) ON CONFLICT DO NOTHING`,
      ).bind(refundRef, oid, r, now, ws, r, remainingBefore, oid, before),
    ];
    const audit = (note: string) => env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) SELECT ?, 'provider', 'subscription_set', ?, NULL, ?, ? WHERE changes() > 0").bind(now, ws, JSON.stringify({ note }), oid);
    const owner = '(SELECT owns_running FROM package_orders WHERE order_id = ?) = 1';
    if (full) {
      stmts.push(
        env.DB.prepare(`UPDATE package_orders SET status = ?, refunded_minor = refunded_minor + ? WHERE order_id = ? AND status = 'paid' AND ${g.sql}`).bind(ev.chargeback ? 'charged_back' : 'refunded', r, oid, ...g.binds),
        // (a) it paid for a queued period: remove just that one
        env.DB.prepare(`UPDATE package_orders SET queued_seq = queued_seq - 1 WHERE workspace_id = ? AND queued_seq > (SELECT queued_seq FROM package_orders WHERE order_id = ?) AND ${g.sql}`).bind(ws, oid, ...g.binds),
        env.DB.prepare(`UPDATE workspace_subscriptions SET queued_periods = queued_periods - 1, version = version + 1, updated_at = ? WHERE workspace_id = ? AND queued_periods > 0 AND (SELECT queued_seq FROM package_orders WHERE order_id = ?) IS NOT NULL AND ${g.sql} RETURNING version`).bind(now, ws, oid, ...g.binds),
        audit('queued_period_removed'),
        env.DB.prepare(`UPDATE package_orders SET queued_seq = NULL WHERE order_id = ? AND ${g.sql}`).bind(oid, ...g.binds),
        // (b) it owns the running period and nothing is queued: cancel now and remember which period's credits to zero
        env.DB.prepare(`UPDATE package_orders SET revoked_period_start = (SELECT period_start FROM workspace_subscriptions WHERE workspace_id = ?) WHERE order_id = ? AND ${owner} AND ${g.sql}
          AND EXISTS (SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND queued_periods = 0 AND source = 'purchase' AND status IN ('active', 'trialing', 'past_due'))`).bind(ws, oid, oid, ...g.binds, ws),
        env.DB.prepare(`UPDATE workspace_subscriptions SET status = 'cancelled', cancelled_at = ?, period_end = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND queued_periods = 0 AND source = 'purchase'
          AND status IN ('active', 'trialing', 'past_due') AND ${owner} AND ${g.sql} RETURNING version`).bind(now, now, now, ws, oid, ...g.binds),
        audit('cancelled_by_refund'),
        // (c) it owns the running period and one is queued: the next period starts now
        env.DB.prepare(`UPDATE package_orders SET owns_running = 1, queued_seq = NULL WHERE order_id = (SELECT order_id FROM package_orders WHERE workspace_id = ? AND queued_seq IS NOT NULL ORDER BY queued_seq LIMIT 1)
          AND ${owner} AND ${g.sql} AND EXISTS (SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND queued_periods > 0 AND source = 'purchase' AND status IN ('active', 'trialing'))`).bind(ws, oid, ...g.binds, ws),
        env.DB.prepare(`UPDATE package_orders SET queued_seq = queued_seq - 1 WHERE workspace_id = ? AND queued_seq IS NOT NULL AND ${owner} AND ${g.sql}
          AND EXISTS (SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND queued_periods > 0 AND source = 'purchase' AND status IN ('active', 'trialing'))`).bind(ws, oid, ...g.binds, ws),
        env.DB.prepare(`UPDATE workspace_subscriptions SET period_start = ?, period_end = ${MONTH_SQL('?')}, queued_periods = queued_periods - 1, version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND queued_periods > 0 AND source = 'purchase' AND status IN ('active', 'trialing') AND ${owner} AND ${g.sql} RETURNING version`).bind(now, now, now, ws, oid, ...g.binds),
        audit('next_period_started_by_refund'),
        env.DB.prepare(`UPDATE package_orders SET owns_running = 0 WHERE order_id = ? AND ${g.sql}`).bind(oid, ...g.binds),
      );
    } else {
      const remainingAfter = remainingBefore - r;
      stmts.push(
        env.DB.prepare(`UPDATE package_orders SET refunded_minor = refunded_minor + ? WHERE order_id = ? AND ${g.sql}`).bind(r, oid, ...g.binds),
        env.DB.prepare(`UPDATE workspace_subscriptions SET period_end = max(?, period_start + (period_end - period_start) * ? / ?), version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND source = 'purchase' AND status IN ('active', 'trialing') AND period_end > ? AND ${owner} AND ${g.sql} RETURNING version`).bind(now, remainingAfter, remainingBefore, now, ws, now, oid, ...g.binds),
        audit('shortened_by_partial_refund'),
        env.DB.prepare('UPDATE package_refunds SET shortened = 1 WHERE refund_ref = ? AND changes() > 0').bind(refundRef),
      );
    }
    stmts.push(env.DB.prepare('UPDATE package_refunds SET applied = 1 WHERE refund_ref = ?').bind(refundRef));
    const res = await env.DB.batch(stmts);
    if (res[0]!.meta.changes === 0) continue; // another refund of this order committed first: decide again on the new total
    alert(full ? (ev.chargeback ? 'package_chargeback' : 'package_refunded') : 'package_partial_refund', { workspace: ws, orderId: oid, amountMinor: r, eventKey: ev.eventKey });
    const subAfter = await env.DB.prepare('SELECT version FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ version: number }>();
    if (subAfter && subAfter.version !== subBefore?.version) await announceSubscription(env, ws, now);
    outcome = full ? 'refunded' : 'partial_refund';
    settled = true;
    break;
  }
  // Losing every race must not look like success: the provider is answered 5xx and the delivery is kept for the daily pass.
  if (!settled) throw new RefundContention();
  await finishRefund(env, row0.order_id, refundRef, now);
  return outcome;
}

/** The steps after a refund's batch, each idempotent and retried by the provider's redelivery: zero the unused credits, hand back to the Store plan. */
async function finishRefund(env: Env, orderId: string, refundRef: string, now: number): Promise<void> {
  const o = await findPackageOrder(env, orderId);
  if (!o) return;
  const stub = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(o.workspace_id));
  const cancelled = (await env.DB.prepare('SELECT revoked_period_start FROM package_orders WHERE order_id = ?').bind(orderId).first<{ revoked_period_start: number | null }>())?.revoked_period_start ?? null;
  if ((o.status === 'refunded' || o.status === 'charged_back') && cancelled !== null) {
    // Credits already spent stay spent; only the unused part of that period's grant is zeroed, once per order. A failure throws: the webhook is retried.
    await stub.expireAiCredits(cancelled, now, `expire:refund:${orderId}`);
    await fallbackToStorePlan(env, o.workspace_id, now).catch((err) => alert('store_plan_fallback_failed', { workspace: o.workspace_id, error: errName(err) }));
  }
  const ref = await env.DB.prepare('SELECT period_start, shortened, frac_num, frac_den FROM package_refunds WHERE refund_ref = ?').bind(refundRef).first<{ period_start: number | null; shortened: number; frac_num: number | null; frac_den: number | null }>();
  if (ref && ref.shortened === 1 && ref.period_start !== null && ref.frac_num && ref.frac_den) {
    // Partial refund: the fraction fixed when THIS refund was decided (refunded / still-unrefunded), never recomputed from today's totals.
    await stub.expireAiCreditsFraction({ periodStart: ref.period_start, num: ref.frac_num, den: ref.frac_den, ref: `expire:partial:${refundRef}` }, now);
  }
}

/** A pending order is asked about after this long (the webhook normally arrives within seconds); an unpaid one is asked about for a week. */
export const REPAIR_AFTER_MS = 15 * 60_000;
export const INQUIRE_UNTIL_MS = 7 * 86_400_000;

/**
 * Daily: (1) a pending or expired order whose webhook never came is looked up with Kashier by our order id; a confirmed payment goes through
 * `applyPackageWebhook`, the webhook's own claim/grant path (so a repair racing the webhook grants once); an unreachable Kashier changes
 * nothing and the order is asked again tomorrow. (2) A `paid` order that was never granted (no batch ran) is granted now and reported.
 * (3) Pending orders older than 24 h expire (a payment that still arrives is granted, see `grantOrder`).
 */
export async function repairPackageOrders(env: Env, now = Date.now(), provider: PaymentProvider | null = paymentProvider(env)): Promise<{ granted: number; expired: number; confirmed: number }> {
  let granted = 0;
  let confirmed = 0;
  if (packagesEnabled(env) && provider) {
    const { results: stuck } = await env.DB.prepare(`SELECT ${ORDER_COLS} FROM package_orders WHERE provider = 'kashier' AND status IN ('pending', 'expired') AND created_at < ? AND created_at > ? ORDER BY created_at LIMIT 200`)
      .bind(now - REPAIR_AFTER_MS, now - INQUIRE_UNTIL_MS).all<PackageOrderRow>();
    for (const row of stuck) {
      try {
        const q = await provider.inquire(row.order_id);
        if (q === 'unsupported' || q === 'unavailable' || q.status === 'PENDING') continue;
        if (q.status === 'SUCCESS' && !q.transactionId) continue;
        const ev: ParsedWebhook = { event: 'pay', status: q.status, orderId: row.order_id, transactionId: q.transactionId ?? `none:${row.order_id}`, amountMinor: q.amountMinor ?? -1, currency: q.currency ?? '', eventKey: `kashier:${q.transactionId ?? row.order_id}:${q.status}` };
        if ((await applyPackageWebhook(env, row, ev, now)) === 'granted') confirmed++;
      } catch (err) {
        alert('package_repair_failed', { orderId: row.order_id, error: errName(err) });
      }
    }
  }
  const { results } = await env.DB.prepare(`SELECT ${ORDER_COLS} FROM package_orders WHERE status = 'paid' AND granted_at IS NULL AND provider_ref IS NOT NULL ORDER BY created_at LIMIT 200`).all<PackageOrderRow>();
  for (const row of results) {
    alert('package_paid_not_granted', { workspace: row.workspace_id, orderId: row.order_id });
    try {
      if ((await grantOrder(env, row, row.provider_ref!, now, { claim: false })) === 'granted') granted++;
    } catch (err) {
      alert('package_repair_failed', { orderId: row.order_id, error: errName(err) });
    }
  }
  const exp = await env.DB.prepare("UPDATE package_orders SET status = 'expired' WHERE provider = 'kashier' AND status = 'pending' AND created_at < ?").bind(now - PENDING_EXPIRES_AFTER_MS).run();
  return { granted, expired: exp.meta.changes, confirmed };
}
