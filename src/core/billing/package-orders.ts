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
import { sessionState } from '../identity/session';
import { packagesEnabled, paymentProvider, type ParsedWebhook } from './payments';
import { announceSubscription, cancelSubscription, fallbackToStorePlan, setSubscription } from './subscriptions';

const alert = (what: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ alert: what, ...extra }));
const errName = (err: unknown) => (err instanceof Error ? err.name : 'error');
export const PENDING_EXPIRES_AFTER_MS = 24 * 3_600_000;

export type PackageDto = { id: string; name: string; priceMinor: number; aiCredits: number };
export type OrderStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded' | 'charged_back';
export type PackageOrderRow = {
  order_id: string; workspace_id: string; package_id: string; amount_minor: number; currency: string; status: OrderStatus; created_at: number;
  provider_ref: string | null; granted_at: number | null; queued: number;
};
const COLS = 'order_id, workspace_id, package_id, amount_minor, currency, status, created_at, provider_ref, granted_at, queued';

/** Active packages a merchant can buy (a free package, like the one a Store plan includes, is not for sale). */
export async function listPackages(env: Env): Promise<PackageDto[]> {
  const { results } = await env.DB.prepare('SELECT id, name, price_minor, ai_credits FROM packages WHERE active = 1 AND price_minor > 0 ORDER BY price_minor, id').all<{ id: string; name: string; price_minor: number; ai_credits: number }>();
  return results.map((r) => ({ id: r.id, name: r.name, priceMinor: r.price_minor, aiCredits: r.ai_credits }));
}

export type StartPackageResult =
  | { ok: true; orderId: string; amountMinor: number; checkoutUrl: string }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'session_revoked' | 'unknown_package' };

export async function startPackageCheckout(env: Env, a: { workspaceId: string; userId: string; sessionId: string; packageId: string }, now = Date.now()): Promise<StartPackageResult> {
  if (!packagesEnabled(env)) return { ok: false, reason: 'disabled' };
  const provider = paymentProvider(env);
  if (!provider) return { ok: false, reason: 'unavailable' };
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
  return env.DB.prepare(`SELECT ${COLS} FROM package_orders WHERE order_id = ? AND workspace_id = ?`).bind(orderId, workspaceId).first<PackageOrderRow>();
}

/** What the merchant's page may be told: `paid` only once the package was really granted. */
export function publicState(o: Pick<PackageOrderRow, 'status' | 'granted_at'>): 'pending' | 'paid' | 'failed' | 'expired' | 'refunded' {
  if (o.status === 'paid') return o.granted_at === null ? 'pending' : 'paid';
  return o.status === 'charged_back' ? 'refunded' : o.status;
}

export const findPackageOrder = (env: Env, orderId: string): Promise<PackageOrderRow | null> => env.DB.prepare(`SELECT ${COLS} FROM package_orders WHERE order_id = ?`).bind(orderId).first<PackageOrderRow>();

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
 */
async function grantOrder(env: Env, row: PackageOrderRow, ref: string, now: number, opts: { claim: boolean }): Promise<'granted' | 'replay'> {
  const claim = env.DB.prepare("UPDATE package_orders SET status = 'paid', provider_ref = ?, paid_at = ? WHERE order_id = ? AND status IN ('pending', 'failed', 'expired')").bind(ref, now, row.order_id);
  // Was the package already running when this was paid? Then this order bought a queued period, not a new one.
  const flagQueued = env.DB.prepare(
    `UPDATE package_orders SET queued = EXISTS (SELECT 1 FROM workspace_subscriptions s WHERE s.workspace_id = package_orders.workspace_id AND s.package_id = package_orders.package_id AND s.period_end > ? AND s.status IN ('active', 'trialing'))
     WHERE order_id = ? AND status = 'paid' AND provider_ref = ? AND granted_at IS NULL`,
  ).bind(now, row.order_id, ref);
  const stamp = env.DB.prepare('UPDATE package_orders SET granted_at = ? WHERE order_id = ? AND provider_ref = ? AND granted_at IS NULL AND changes() > 0').bind(now, row.order_id, ref);
  const r = await setSubscription(env, { workspaceId: row.workspace_id, packageId: row.package_id, status: 'active', periodStart: now, periodEnd: addMonth(now), source: 'purchase', ref: row.order_id }, now, {
    before: opts.claim ? [claim, flagQueued] : [flagQueued], only: orderPaidUngranted(row.order_id, ref), after: [stamp], renewal: true,
  });
  if (r.written) return 'granted';
  const now2 = await findPackageOrder(env, row.order_id);
  if (now2 && now2.status === 'paid' && now2.granted_at !== null && now2.provider_ref === ref) await announceSubscription(env, row.workspace_id, now);
  return 'replay';
}

async function recordOnce(env: Env, action: string, row: PackageOrderRow, reason: string, now: number): Promise<void> {
  await env.DB.prepare('INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) SELECT ?, ?, ?, ?, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM billing_audit WHERE action = ? AND reason = ?)')
    .bind(now, 'provider', action, row.workspace_id, JSON.stringify({ orderId: row.order_id }), reason, action, reason).run();
}

/** A verified webhook for one of our package orders. Throws only when something could not be written (the caller answers 5xx). */
export async function applyPackageWebhook(env: Env, row: PackageOrderRow, ev: ParsedWebhook, now: number): Promise<void> {
  if (ev.event === 'refund') {
    if (ev.status === 'SUCCESS') await revokeOrder(env, row, ev, now);
    return;
  }
  if (ev.event !== 'pay') return;
  if (ev.status === 'FAILURE') {
    await env.DB.prepare("UPDATE package_orders SET status = 'failed' WHERE order_id = ? AND status = 'pending'").bind(row.order_id).run();
    return;
  }
  if (ev.status !== 'SUCCESS') return;
  if (ev.currency !== row.currency || ev.amountMinor !== row.amount_minor) {
    alert('package_amount_mismatch', { workspace: row.workspace_id });
    return;
  }
  await grantOrder(env, row, ev.transactionId, now, { claim: true });
  const after = await findPackageOrder(env, row.order_id);
  if (after && after.status !== 'pending' && after.provider_ref !== null && after.provider_ref !== ev.transactionId) {
    // The order is already paid by another transaction: a second charge. Nothing is granted; a person must refund it.
    alert('package_duplicate_payment', { workspace: row.workspace_id, orderId: row.order_id });
    await recordOnce(env, 'package_duplicate_payment', row, ev.transactionId, now);
  }
}

/** A provider refund or chargeback: the order is closed and what it bought is taken away, once. */
async function revokeOrder(env: Env, row: PackageOrderRow, ev: ParsedWebhook, now: number): Promise<void> {
  const state = ev.chargeback ? 'charged_back' : 'refunded';
  const label = ev.chargeback ? 'package_chargeback' : 'package_refunded';
  if (row.status !== 'paid') {
    if (row.status !== 'refunded' && row.status !== 'charged_back') alert('package_refund_unmatched', { workspace: row.workspace_id, orderId: row.order_id });
    return;
  }
  const claim = env.DB.prepare("UPDATE package_orders SET status = ? WHERE order_id = ? AND status = 'paid'").bind(state, row.order_id);
  const sub = await env.DB.prepare('SELECT queued_periods, period_start FROM workspace_subscriptions WHERE workspace_id = ? AND package_id = ?').bind(row.workspace_id, row.package_id).first<{ queued_periods: number; period_start: number }>();
  let revoked = false;
  let periodStart: number | null = null;
  if (row.queued === 1 && sub && sub.queued_periods > 0) {
    // It paid for a period that has not started: remove that period only; the running one and its credits stay.
    const res = await env.DB.batch([
      claim,
      env.DB.prepare('UPDATE workspace_subscriptions SET queued_periods = queued_periods - 1, version = version + 1, updated_at = ? WHERE workspace_id = ? AND queued_periods > 0 AND changes() > 0 RETURNING version').bind(now, row.workspace_id),
      env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) SELECT ?, 'provider', 'subscription_set', ?, NULL, ?, ? WHERE changes() > 0").bind(now, row.workspace_id, JSON.stringify({ queuedPeriodRemoved: true }), row.order_id),
    ]);
    if (res[0]!.meta.changes === 1) {
      revoked = true;
      await announceSubscription(env, row.workspace_id, now);
    }
  } else {
    const r = await cancelSubscription(env, { workspaceId: row.workspace_id, actor: 'purchase', ref: row.order_id, periodEndNow: true }, now, {
      before: [claim], only: { sql: 'changes() > 0', binds: [] },
      // Only the package this order bought, still owned by a purchase (a later operator assignment is not undone by an old refund).
      guard: { sql: "workspace_subscriptions.package_id = ? AND workspace_subscriptions.source = 'purchase'", binds: [row.package_id] },
    });
    revoked = r.pre[0] === 1;
    if (r.written) periodStart = sub?.period_start ?? null;
  }
  if (!revoked) return; // a replay: the first delivery already acted
  alert(label, { workspace: row.workspace_id, orderId: row.order_id });
  if (periodStart !== null) {
    // Credits that were used stay used; only the part of this package's grant nobody spent is zeroed (a ledger 'expire' row, never a delete).
    await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(row.workspace_id)).expireAiCredits(periodStart, now).catch((err) => alert('package_credit_revoke_failed', { workspace: row.workspace_id, error: errName(err) }));
    await fallbackToStorePlan(env, row.workspace_id, now).catch((err) => alert('store_plan_fallback_failed', { workspace: row.workspace_id, error: errName(err) }));
  }
}

/**
 * Daily: a `paid` order that was never granted (no batch ran) is granted now and reported; pending orders older than 24 h expire
 * (a payment that still arrives is granted, see `grantOrder`).
 */
export async function repairPackageOrders(env: Env, now = Date.now()): Promise<{ granted: number; expired: number }> {
  let granted = 0;
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM package_orders WHERE status = 'paid' AND granted_at IS NULL AND provider_ref IS NOT NULL ORDER BY created_at LIMIT 200`).all<PackageOrderRow>();
  for (const row of results) {
    alert('package_paid_not_granted', { workspace: row.workspace_id, orderId: row.order_id });
    try {
      if ((await grantOrder(env, row, row.provider_ref!, now, { claim: false })) === 'granted') granted++;
    } catch (err) {
      alert('package_repair_failed', { orderId: row.order_id, error: errName(err) });
    }
  }
  const exp = await env.DB.prepare("UPDATE package_orders SET status = 'expired' WHERE status = 'pending' AND created_at < ?").bind(now - PENDING_EXPIRES_AFTER_MS).run();
  return { granted, expired: exp.meta.changes };
}
