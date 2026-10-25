/**
 * Self-serve package checkout (behind PACKAGE_CHECKOUT_ENABLED, default off). Same Kashier machinery and the same signed webhook as
 * top-ups; a second order kind.
 *
 * Money rules: the amount is read from `packages.price_minor` on the server, never from the client. A pending `package_orders` row is
 * written when the OWNER starts a checkout (and the session is not revoked: fail closed). A package is granted only from a webhook whose
 * HMAC verified (the shared path in `handleProviderWebhook`), with status SUCCESS and the order id, amount and currency matching OUR row;
 * the workspace and package come from the row, never from the payload. The grant is claimed with a conditional UPDATE
 * (pending -> paid, `provider_ref` unique), so two concurrent webhooks for one order grant once. If the grant itself throws, the claim is
 * released and the webhook answers 5xx so the provider retries. No card fee is added to a package price (top-ups add one).
 */
import type { Env } from '../../env';
import { sessionState } from '../identity/session';
import { packagesEnabled, paymentProvider, type ParsedWebhook } from './payments';
import { setSubscription } from './subscriptions';

const alert = (what: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ alert: what, ...extra }));

export type PackageDto = { id: string; name: string; priceMinor: number; aiCredits: number };
export type PackageOrderRow = { order_id: string; workspace_id: string; package_id: string; amount_minor: number; currency: string; status: 'pending' | 'paid' | 'failed' | 'expired'; created_at: number };
const COLS = 'order_id, workspace_id, package_id, amount_minor, currency, status, created_at';

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
    return { ok: true, orderId, amountMinor: pkg.price_minor, checkoutUrl };
  } catch {
    await env.DB.prepare("UPDATE package_orders SET status = 'failed' WHERE order_id = ? AND status = 'pending'").bind(orderId).run();
    return { ok: false, reason: 'unavailable' };
  }
}

export async function getPackageOrder(env: Env, workspaceId: string, orderId: string): Promise<PackageOrderRow | null> {
  return env.DB.prepare(`SELECT ${COLS} FROM package_orders WHERE order_id = ? AND workspace_id = ?`).bind(orderId, workspaceId).first<PackageOrderRow>();
}

export const findPackageOrder = (env: Env, orderId: string): Promise<PackageOrderRow | null> => env.DB.prepare(`SELECT ${COLS} FROM package_orders WHERE order_id = ?`).bind(orderId).first<PackageOrderRow>();

function addMonth(ms: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

/** A verified webhook for one of our package orders. Throws only when the grant could not be made (the caller answers 5xx). */
export async function applyPackageWebhook(env: Env, row: PackageOrderRow, ev: ParsedWebhook, now: number): Promise<void> {
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
  const claim = await env.DB.prepare("UPDATE package_orders SET status = 'paid', provider_ref = ?, paid_at = ? WHERE order_id = ? AND status IN ('pending', 'expired', 'failed')")
    .bind(ev.transactionId, now, row.order_id).run();
  if (claim.meta.changes !== 1) return; // already paid (replay, or the concurrent webhook won the claim)
  try {
    // A renewal of the same running package keeps the days that are left.
    const cur = await env.DB.prepare('SELECT package_id, status, period_end FROM workspace_subscriptions WHERE workspace_id = ?').bind(row.workspace_id).first<{ package_id: string; status: string; period_end: number }>();
    const carry = cur && cur.package_id === row.package_id && (cur.status === 'active' || cur.status === 'trialing') && cur.period_end > now ? cur.period_end : now;
    await setSubscription(env, { workspaceId: row.workspace_id, packageId: row.package_id, status: 'active', periodStart: now, periodEnd: addMonth(carry), source: 'purchase', ref: row.order_id }, now);
  } catch (err) {
    await env.DB.prepare("UPDATE package_orders SET status = 'pending', provider_ref = NULL, paid_at = NULL WHERE order_id = ? AND provider_ref = ?").bind(row.order_id, ev.transactionId).run();
    throw err;
  }
}
