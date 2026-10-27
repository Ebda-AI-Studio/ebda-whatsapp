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
import { addMonthsUtc, monthsStarted, partialRefundCut, periodLengthMonths, upgradePriceMinor, yearlyRefundQuote, type YearlyRefundQuote } from './yearly';
import { sessionState } from '../identity/session';
import { packagesEnabled, paymentProvider, type ParsedWebhook, type PaymentProvider } from './payments';
import { MONTHS_SQL, announceSubscription, auditStmt, fallbackToStorePlan, runWrite, setSubscription } from './subscriptions';
import { alert } from '../observability';

const SWITCH_KINDS: readonly PurchaseKind[] = ['upgrade', 'queued_switch'];

const errName = (err: unknown) => (err instanceof Error ? err.name : 'error');
export const PENDING_EXPIRES_AFTER_MS = 24 * 3_600_000;

export type PackageDto = { id: string; name: string; priceMinor: number; aiCredits: number; maxMembers: number; features: (typeof PACKAGE_FEATURE_KEYS)[number][]; periodMonths: number };
export type OrderStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded' | 'charged_back';
export type PackageOrderRow = {
  order_id: string; workspace_id: string; package_id: string; amount_minor: number; currency: string; status: OrderStatus; created_at: number;
  provider_ref: string | null; granted_at: number | null; queued: number; refunded_minor: number;
  /** WA-YEARLY-SWITCH-2: what this order is (decided server-side at creation) and the period length it bought. */
  kind: PurchaseKind; from_package: string | null; period_months: number; quoted_period_start: number | null; quoted_period_end: number | null;
};
export type PurchaseKind = 'purchase' | 'upgrade' | 'queued_switch';
export const ORDER_COLS = 'order_id, workspace_id, package_id, amount_minor, currency, status, created_at, provider_ref, granted_at, queued, refunded_minor, kind, from_package, period_months, quoted_period_start, quoted_period_end';

/** Active packages a merchant can buy (a free package, like the one a Store plan includes, is not for sale). */
export async function listPackages(env: Env): Promise<PackageDto[]> {
  const { results } = await env.DB.prepare('SELECT id, name, price_minor, ai_credits, max_members, feat_campaigns, feat_order_in_chat, feat_api, priority_support, period_months FROM packages WHERE active = 1 AND price_minor > 0 ORDER BY price_minor, id')
    .all<{ id: string; name: string; price_minor: number; ai_credits: number; max_members: number; feat_campaigns: number; feat_order_in_chat: number; feat_api: number; priority_support: number; period_months: number }>();
  return results.map((r) => {
    const on: Record<(typeof PACKAGE_FEATURE_KEYS)[number], boolean> = {
      members: true, shared_inbox: true, order_confirmations: true, templates: true, campaigns: r.feat_campaigns === 1, order_in_chat: r.feat_order_in_chat === 1,
      api: r.feat_api === 1, priority_support: r.priority_support === 1, ai_credits: r.ai_credits > 0,
    };
    return { id: r.id, name: r.name, priceMinor: r.price_minor, aiCredits: r.ai_credits, maxMembers: r.max_members, features: PACKAGE_FEATURE_KEYS.filter((k) => on[k]), periodMonths: r.period_months };
  });
}

export type PurchasePlan =
  | { ok: true; kind: PurchaseKind; amountMinor: number; periodMonths: number; fromPackage: string | null; quotedStart: number | null; quotedEnd: number | null }
  | { ok: false; reason: 'unknown_package' | 'yearly_queued' };

/**
 * WA-YEARLY-SWITCH-2: what buying `packageId` means for this workspace right now, decided on the server (the client never names an amount or a kind).
 * - No yearly period running: a plain purchase at the package's price (a different package replaces a monthly one at once, as always).
 * - A yearly period running, the SAME package: a renewal queued behind it, as always.
 * - A higher YEARLY package (price/12 above the running one's): an UPGRADE: the prorated difference for the remaining months (the current month and every month
 *   after it), floored to a whole EGP; it starts at once with the same period end.
 * - Anything else (a lower or equal yearly, any monthly package): a DOWNGRADE, paid in full, queued to start at the next renewal; no refund of the running one.
 * - A queued period cannot be switched: while one is queued, only a renewal of the running package is accepted (and not at all if the queue holds a switch).
 */
export async function planPurchase(env: Env, workspaceId: string, packageId: string, now: number): Promise<PurchasePlan> {
  const pkg = await env.DB.prepare('SELECT price_minor, period_months FROM packages WHERE id = ? AND active = 1 AND price_minor > 0').bind(packageId).first<{ price_minor: number; period_months: number }>();
  if (!pkg) return { ok: false, reason: 'unknown_package' };
  const plain: PurchasePlan = { ok: true, kind: 'purchase', amountMinor: pkg.price_minor, periodMonths: pkg.period_months, fromPackage: null, quotedStart: null, quotedEnd: null };
  const cur = await env.DB.prepare(
    `SELECT s.package_id, s.period_start, s.period_end, s.status, s.queued_periods, p.price_minor, p.period_months FROM workspace_subscriptions s JOIN packages p ON p.id = s.package_id WHERE s.workspace_id = ?`,
  ).bind(workspaceId).first<{ package_id: string; period_start: number; period_end: number; status: string; queued_periods: number; price_minor: number; period_months: number }>();
  if (!cur || cur.period_months <= 1 || cur.period_end <= now || (cur.status !== 'active' && cur.status !== 'trialing')) return plain;
  if (cur.queued_periods > 0) {
    const hasSwitch = await env.DB.prepare('SELECT 1 FROM package_orders WHERE workspace_id = ? AND queued_seq IS NOT NULL AND package_id != ? LIMIT 1').bind(workspaceId, cur.package_id).first();
    if (hasSwitch || packageId !== cur.package_id) return { ok: false, reason: 'yearly_queued' };
  }
  if (packageId === cur.package_id) return plain;
  if (pkg.period_months > 1 && Math.floor(pkg.price_minor / pkg.period_months) > Math.floor(cur.price_minor / cur.period_months)) {
    const amountMinor = upgradePriceMinor({ oldPriceMinor: cur.price_minor, newPriceMinor: pkg.price_minor, periodMonths: cur.period_months, periodStart: cur.period_start, periodEnd: cur.period_end, now });
    if (amountMinor > 0) return { ok: true, kind: 'upgrade', amountMinor, periodMonths: pkg.period_months, fromPackage: cur.package_id, quotedStart: cur.period_start, quotedEnd: cur.period_end };
  }
  return { ok: true, kind: 'queued_switch', amountMinor: pkg.price_minor, periodMonths: pkg.period_months, fromPackage: cur.package_id, quotedStart: cur.period_start, quotedEnd: cur.period_end };
}

export type StartPackageResult =
  | { ok: true; orderId: string; amountMinor: number; checkoutUrl: string }
  | { ok: false; reason: 'disabled' | 'unavailable' | 'session_revoked' | 'unknown_package' | 'yearly_queued' };

export async function startPackageCheckout(env: Env, a: { workspaceId: string; userId: string; sessionId: string; packageId: string }, now = Date.now()): Promise<StartPackageResult> {
  if (!packagesEnabled(env)) return { ok: false, reason: 'disabled' };
  const provider = paymentProvider(env);
  // Without the Kashier secret key every webhook would be refused: do not let customers pay for something that can never be granted.
  if (!provider || !provider.confirmationReady()) return { ok: false, reason: 'unavailable' };
  const plan = await planPurchase(env, a.workspaceId, a.packageId, now);
  if (!plan.ok) return plan;
  const session = await sessionState(env, a.sessionId);
  if (session === 'revoked') return { ok: false, reason: 'session_revoked' };
  if (session === 'unavailable') return { ok: false, reason: 'unavailable' };
  const orderId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO package_orders (order_id, workspace_id, package_id, amount_minor, currency, status, created_by, created_at, kind, from_package, period_months, quoted_period_start, quoted_period_end) VALUES (?, ?, ?, ?, 'EGP', 'pending', ?, ?, ?, ?, ?, ?, ?)")
    .bind(orderId, a.workspaceId, a.packageId, plan.amountMinor, a.userId, now, plan.kind, plan.fromPackage, plan.periodMonths, plan.quotedStart, plan.quotedEnd).run();
  try {
    const { checkoutUrl } = await provider.createSession({ orderId, totalMinor: plan.amountMinor, currency: 'EGP' });
    // Only the provider's own checkout origin is ever handed to a merchant's browser.
    if (new URL(checkoutUrl).origin !== new URL(env.KASHIER_CHECKOUT_URL ?? 'https://checkout.kashier.io').origin) throw new Error('unexpected checkout origin');
    return { ok: true, orderId, amountMinor: plan.amountMinor, checkoutUrl };
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

/** The billing period of a package in months: 1 (monthly) or 12 (yearly). An unknown package is 1. */
async function periodMonthsOf(env: Env, packageId: string): Promise<number> {
  return (await env.DB.prepare('SELECT period_months FROM packages WHERE id = ?').bind(packageId).first<{ period_months: number }>())?.period_months ?? 1;
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
  if (row.kind === 'upgrade') return grantUpgrade(env, row, ref, now, opts);
  if (row.kind === 'queued_switch' && (await yearlyRunning(env, row.workspace_id, now))) return grantQueuedSwitch(env, row, ref, now, opts);
  // (A queued switch whose yearly period ended before it was paid is just a purchase at its own full price: it falls through.)
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
  const months = row.period_months > 1 ? row.period_months : await periodMonthsOf(env, row.package_id); // what the ORDER was bought as
  const r = await setSubscription(env, { workspaceId: row.workspace_id, packageId: row.package_id, status: 'active', periodStart: now, periodEnd: addMonthsUtc(now, months), source: 'purchase', ref: row.order_id }, now, {
    before: opts.claim ? [claim, flag, handOver] : [flag, handOver], only: orderPaidUngranted(row.order_id, ref), after: [stamp], renewal: true,
  });
  if (r.written) return 'granted';
  const now2 = await findPackageOrder(env, row.order_id);
  if (now2 && now2.status === 'paid' && now2.granted_at !== null && now2.provider_ref === ref) await announceSubscription(env, row.workspace_id, now);
  return 'replay';
}

/** The claim a switch order's grant batch makes: an EXPIRED quote is not claimed here (it is recorded by `staleOrReplay`, and never granted). */
const claimStmt = (env: Env, row: PackageOrderRow, ref: string, now: number) =>
  env.DB.prepare("UPDATE package_orders SET status = 'paid', provider_ref = ?, paid_at = ? WHERE order_id = ? AND status IN ('pending', 'failed')").bind(ref, now, row.order_id);

/** Is a yearly period running for this workspace (so a switch order is an upgrade or a queued downgrade rather than a fresh purchase)? */
async function yearlyRunning(env: Env, workspaceId: string, now: number): Promise<boolean> {
  return !!(await env.DB.prepare(
    `SELECT 1 FROM workspace_subscriptions s JOIN packages p ON p.id = s.package_id WHERE s.workspace_id = ? AND p.period_months > 1 AND s.period_end > ? AND s.status IN ('active', 'trialing')`,
  ).bind(workspaceId, now).first());
}

/** The replay answer shared by the switch paths: already granted under this reference = re-announce (a push or Store event lost after the commit still happens). */
async function replayOrNot(env: Env, row: PackageOrderRow, ref: string, now: number): Promise<'replay'> {
  const again = await findPackageOrder(env, row.order_id);
  if (again && again.status === 'paid' && again.granted_at !== null && again.provider_ref === ref) await announceSubscription(env, row.workspace_id, now);
  return 'replay';
}

/**
 * Not written: either this payment was already granted (a replay: re-announce) or the order was priced against a period the subscription is no longer in
 * (rolled, switched, ended). The second is NEVER granted at the stale price: the order stays paid-but-ungranted and a person is told (the daily repair repeats it).
 */
async function staleOrReplay(env: Env, row: PackageOrderRow, ref: string, now: number, claim: boolean): Promise<'replay'> {
  // The money was taken, so it is always RECORDED (paid, with the transaction), even for an expired quote: a refund of it can then match the order. It is just never granted.
  if (claim) await env.DB.prepare("UPDATE package_orders SET status = 'paid', provider_ref = ?, paid_at = ? WHERE order_id = ? AND status IN ('pending', 'failed', 'expired')").bind(ref, now, row.order_id).run();
  const again = await findPackageOrder(env, row.order_id);
  // Once per order (the daily repair finds it again every day).
  if (again && again.status === 'paid' && again.granted_at === null && again.provider_ref === ref && (await auditOnce(env, 'switch_order_stale', row.workspace_id, row.order_id, now))) {
    alert('switch_order_stale', { severity: 'P1', workspace: row.workspace_id, orderId: row.order_id, kind: row.kind });
  }
  return replayOrNot(env, row, ref, now);
}

/** An upgrade is priced for the months still to come when it is QUOTED; it is only granted in that same month (paid later, it would overpay months already gone). */
function quotedThisMonth(row: PackageOrderRow, now: number): boolean {
  if (row.quoted_period_start === null || row.quoted_period_end === null) return false;
  const n = periodLengthMonths(row.quoted_period_start, row.quoted_period_end, 12);
  return monthsStarted(row.quoted_period_start, n, now) === monthsStarted(row.quoted_period_start, n, row.created_at);
}

/**
 * WA-YEARLY-SWITCH-2 upgrade: the package of the RUNNING period changes at once, with the same start and end. One batch: claim, the guarded change (only if the
 * subscription is still on the package the upgrade was priced from and still running), an audit row and the grant stamp. A replayed payment finds the order
 * granted and changes nothing; if the subscription moved on meanwhile the order stays paid-but-ungranted and the daily repair alerts it for a person.
 * The workspace then tops up the CURRENT month to the new allowance (used credits kept) when the entitlement event arrives.
 */
async function grantUpgrade(env: Env, row: PackageOrderRow, ref: string, now: number, opts: { claim: boolean }): Promise<'granted' | 'replay'> {
  if (row.status === 'expired' || !quotedThisMonth(row, now)) return staleOrReplay(env, row, ref, now, opts.claim);
  const gate = orderPaidUngranted(row.order_id, ref);
  const write = env.DB.prepare(
    `UPDATE workspace_subscriptions SET package_id = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND package_id = ? AND period_end > ? AND period_start = ? AND period_end = ? AND status IN ('active', 'trialing') AND ${gate.sql} RETURNING version`,
  ).bind(row.package_id, now, row.workspace_id, row.from_package, now, row.quoted_period_start, row.quoted_period_end, ...gate.binds);
  const stamp = env.DB.prepare(
    `UPDATE package_orders SET granted_at = ?, owns_running = 0, period_owner = (SELECT o.order_id FROM package_orders o WHERE o.workspace_id = ? AND o.owns_running = 1 LIMIT 1) WHERE order_id = ? AND provider_ref = ? AND granted_at IS NULL AND changes() > 0`,
  ).bind(now, row.workspace_id, row.order_id, ref);
  const audit = auditStmt(env, { actor: 'purchase', workspaceId: row.workspace_id, ref: row.order_id, after: { upgradeFrom: row.from_package, to: row.package_id } }, now);
  const r = await runWrite(env, write, audit, { ...(opts.claim ? { before: [claimStmt(env, row, ref, now)] } : {}), after: [stamp] }, row.workspace_id, now);
  return r.written ? 'granted' : staleOrReplay(env, row, ref, now, opts.claim);
}

/** A downgrade (WA-YEARLY-SWITCH-2): paid in full and queued behind the running yearly period; it starts, as its own package, when that period ends. */
async function grantQueuedSwitch(env: Env, row: PackageOrderRow, ref: string, now: number, opts: { claim: boolean }): Promise<'granted' | 'replay'> {
  if (row.status === 'expired') return staleOrReplay(env, row, ref, now, opts.claim);
  const gate = orderPaidUngranted(row.order_id, ref);
  const flag = env.DB.prepare(
    `UPDATE package_orders SET queued = 1, owns_running = 0,
       queued_seq = (SELECT coalesce(max(q.queued_seq), 0) + 1 FROM package_orders q WHERE q.workspace_id = package_orders.workspace_id)
     WHERE order_id = ? AND status = 'paid' AND provider_ref = ? AND granted_at IS NULL
       AND EXISTS (SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND period_start = ? AND period_end = ? AND period_end > ? AND status IN ('active', 'trialing'))`,
  ).bind(row.order_id, ref, row.workspace_id, row.quoted_period_start, row.quoted_period_end, now);
  const write = env.DB.prepare(
    `UPDATE workspace_subscriptions SET queued_periods = queued_periods + 1, version = version + 1, updated_at = ? WHERE workspace_id = ? AND period_end > ? AND period_start = ? AND period_end = ? AND status IN ('active', 'trialing') AND ${gate.sql} RETURNING version`,
  ).bind(now, row.workspace_id, now, row.quoted_period_start, row.quoted_period_end, ...gate.binds);
  const stamp = env.DB.prepare('UPDATE package_orders SET granted_at = ? WHERE order_id = ? AND provider_ref = ? AND granted_at IS NULL AND changes() > 0').bind(now, row.order_id, ref);
  const audit = auditStmt(env, { actor: 'purchase', workspaceId: row.workspace_id, ref: row.order_id, after: { queuedSwitchFrom: row.from_package, to: row.package_id } }, now);
  const r = await runWrite(env, write, audit, { before: [...(opts.claim ? [claimStmt(env, row, ref, now)] : []), flag], after: [stamp] }, row.workspace_id, now);
  return r.written ? 'granted' : staleOrReplay(env, row, ref, now, opts.claim);
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

/**
 * The period an order belongs to, measured over ALL of its orders (WA-YEARLY-SWITCH-2: after an upgrade the period was paid for by the original order plus the
 * upgrade). `ownerId` is the order that owns the running period (the order itself, or the owner an upgrade points at). Months are valued at the CURRENT
 * package's price / period months; `paidMinor` and `refundedMinor` are sums over the period's orders. Null when the order's period is not the running one.
 */
type PeriodBasis = { ownerId: string; running: boolean; periodStart: number; periodEnd: number; periodMonths: number; packageId: string; priceMinor: number; paidMinor: number; refundedMinor: number; queued: boolean; queuedPeriods: number; consumedMinor: number };
async function periodBasis(env: Env, o: PackageOrderRow, now: number): Promise<PeriodBasis | null> {
  const flags = await env.DB.prepare('SELECT owns_running, queued_seq, period_owner FROM package_orders WHERE order_id = ?').bind(o.order_id).first<{ owns_running: number; queued_seq: number | null; period_owner: string | null }>();
  const sub = await env.DB.prepare(
    'SELECT s.package_id, s.period_start, s.period_end, s.source, s.queued_periods, p.price_minor, p.period_months FROM workspace_subscriptions s JOIN packages p ON p.id = s.package_id WHERE s.workspace_id = ?',
  ).bind(o.workspace_id).first<{ package_id: string; period_start: number; period_end: number; source: string | null; queued_periods: number; price_minor: number; period_months: number }>();
  if (!flags || !sub) return null;
  // An order belongs to the RUNNING period only while it (or the owner an upgrade points at) currently owns it: the same predicate refundOrder uses.
  const ownerNow = flags.period_owner !== null
    ? (await env.DB.prepare('SELECT 1 AS x FROM package_orders WHERE order_id = ? AND owns_running = 1').bind(flags.period_owner).first()) !== null
    : false;
  const ownerId = flags.owns_running === 1 ? o.order_id : flags.period_owner ?? o.order_id;
  // ...and only while the period itself is a PURCHASE: an operator or Store-plan period is nobody's order (a stale owns_running flag must not make it refundable).
  const mine = (flags.owns_running === 1 || ownerNow) && sub.source === 'purchase';
  const sums = await env.DB.prepare(
    `SELECT coalesce(sum(amount_minor), 0) AS paid, coalesce(sum(refunded_minor), 0) AS refunded FROM package_orders
      WHERE workspace_id = ? AND status IN ('paid', 'refunded', 'charged_back') AND (order_id = ? OR period_owner = ?)`,
  ).bind(o.workspace_id, ownerId, ownerId).first<{ paid: number; refunded: number }>();
  const own = mine ? sums : { paid: o.amount_minor, refunded: o.refunded_minor };
  // What the months already cut by partial refunds of this period consumed, each at the rate in effect when it was cut.
  const consumed = mine
    ? (await env.DB.prepare(
        `SELECT coalesce(sum(r.cut_value_minor), 0) AS c FROM package_refunds r JOIN package_orders po ON po.order_id = r.order_id
          WHERE po.workspace_id = ? AND (po.order_id = ? OR po.period_owner = ?) AND r.applied = 1 AND r.period_start = ?`,
      ).bind(o.workspace_id, ownerId, ownerId, sub.period_start).first<{ c: number }>())?.c ?? 0
    : 0;
  return {
    ownerId, running: mine && sub.period_end > now, queued: flags.queued_seq !== null, periodStart: sub.period_start, periodEnd: sub.period_end,
    periodMonths: mine ? sub.period_months : o.period_months, packageId: mine ? sub.package_id : o.package_id, priceMinor: mine ? sub.price_minor : o.amount_minor,
    paidMinor: own?.paid ?? 0, refundedMinor: own?.refunded ?? 0, queuedPeriods: sub.queued_periods, consumedMinor: consumed,
  };
}

/** Whole months a partial refund of a yearly order takes off the running period (cumulative over the period's orders, current month kept, never lengthening). */
async function yearlyShortening(env: Env, o: PackageOrderRow, refundMinor: number, now: number): Promise<{ months: number; newEnd: number; periodStart: number; periodEnd: number; cutValueMinor: number } | null> {
  const b = await periodBasis(env, o, now);
  if (!b || !b.running || b.periodMonths <= 1) return null;
  const cut = partialRefundCut({ monthlyMinor: Math.floor(b.priceMinor / b.periodMonths), periodMonths: b.periodMonths, periodStart: b.periodStart, periodEnd: b.periodEnd, now, refundedMinor: b.refundedMinor, refundMinor, consumedMinor: b.consumedMinor });
  return { months: cut.months, newEnd: cut.newEnd, periodStart: b.periodStart, periodEnd: b.periodEnd, cutValueMinor: cut.months * Math.floor(b.priceMinor / b.periodMonths) };
}

export type PackageRefundQuote = YearlyRefundQuote & { orderId: string; packageId: string; priceMinor: number; paidMinor: number; refundedMinor: number };

/**
 * What a human can refund of a package order right now (operator quote). Months are valued at the CURRENT package's price/12 for the months still to come (after an
 * upgrade that is the higher plan's rate, because the difference for those months was paid), counted up to the current end, minus money already refunded beyond the
 * months already cut, never above all that was paid for the period minus what was refunded. The wallet's debt is settled first.
 */
export async function packageRefundQuote(env: Env, orderId: string, now = Date.now()): Promise<PackageRefundQuote | 'not_found' | 'not_paid' | 'queued_periods' | 'order_queued'> {
  const o = await findPackageOrder(env, orderId);
  if (!o) return 'not_found';
  if (o.status !== 'paid') return 'not_paid';
  const b = await periodBasis(env, o, now);
  // The same two refusals the execute path makes, so the quote never offers what the operator action will refuse: a renewal queued behind the period would be
  // stranded by a cancellation, and a queued order is refunded by returning its whole payment (that removes just that period).
  if (b?.running && b.queuedPeriods > 0) return 'queued_periods';
  if (b && !b.running && b.queued) return 'order_queued';
  const debtMinor = (await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(o.workspace_id)).walletView(now)).debtMinor;
  // An order queued behind the running period has not begun (all its months are unused); one that is neither running nor queued has ended (nothing to refund).
  const periodStart = b && b.running ? b.periodStart : b?.queued ? now + 1 : 0;
  const q = yearlyRefundQuote({
    priceMinor: b?.priceMinor ?? o.amount_minor, periodMonths: b?.periodMonths ?? o.period_months, periodStart, ...(b && b.running ? { periodEnd: b.periodEnd } : {}),
    now, debtMinor, refundedMinor: b?.refundedMinor ?? o.refunded_minor, paidMinor: b?.paidMinor ?? o.amount_minor, ...(b ? { consumedMinor: b.consumedMinor } : {}),
  });
  return { orderId, packageId: b?.packageId ?? o.package_id, priceMinor: b?.priceMinor ?? o.amount_minor, paidMinor: b?.paidMinor ?? o.amount_minor, refundedMinor: b?.refundedMinor ?? o.refunded_minor, ...q };
}

export type YearlyRefundResult =
  | { ok: true; orderId: string; shortenedMonths: number; debtSettledMinor: number; cashRefundMinor: number; noMoneyOut: boolean; periodEnd: number }
  | { ok: false; reason: 'not_found' | 'not_paid' | 'not_yearly' | 'not_running' | 'nothing_to_refund' | 'queued_periods' | 'order_queued' | 'quote_changed' };

type PlanRow = { order_id: string; workspace_id: string; shortened_months: number; debt_settled_minor: number; cash_minor: number; new_period_end: number; applied: number; actor: string };

const PLAN_COLS_SQL = 'SELECT order_id, workspace_id, shortened_months, debt_settled_minor, cash_minor, new_period_end, applied, actor FROM package_refund_plans WHERE order_id = ?';

/** Credits the wallet with the plan's debt part under the fixed ref (idempotent: a replay finds the ref) and records that it landed so the daily pass leaves it alone. */
async function postPlanDebt(env: Env, p: Pick<PlanRow, 'order_id' | 'workspace_id' | 'debt_settled_minor' | 'actor'>, now: number): Promise<void> {
  if (p.debt_settled_minor <= 0) return;
  const posted = await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(p.workspace_id)).postWallet(
    { kind: 'adjustment', netMinor: p.debt_settled_minor, ref: `yearly-refund-debt:${p.order_id}`, actor: p.actor, note: 'yearly package refund: wallet debt settled first' }, now,
  );
  if (!posted.ok && posted.reason !== 'duplicate') throw new Error('debt credit refused'); // 'duplicate' = this ref already posted (a replay): done
  await env.DB.prepare('UPDATE package_refund_plans SET debt_posted = 1 WHERE order_id = ?').bind(p.order_id).run();
}

/** Daily: an applied plan whose debt credit never reached the wallet (the call failed after the D1 batch) is posted now. Same fixed ref, so it can only ever land once. */
async function repairRefundPlans(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare('SELECT order_id, workspace_id, debt_settled_minor, actor FROM package_refund_plans WHERE applied = 1 AND debt_settled_minor > 0 AND debt_posted = 0 LIMIT 100')
    .all<Pick<PlanRow, 'order_id' | 'workspace_id' | 'debt_settled_minor' | 'actor'>>();
  for (const p of results) {
    try {
      await postPlanDebt(env, p, now);
    } catch (err) {
      alert('yearly_refund_debt_not_posted', { severity: 'P1', workspace: p.workspace_id, orderId: p.order_id, error: errName(err) });
    }
  }
}

/**
 * The operator's cancel + refund of a YEARLY period, debt first (Important 7, WA-REFUND-1). One decision, stored in `package_refund_plans` (one per period owner),
 * so a replay returns the same answer and only redoes the idempotent steps:
 *  1. the quote at this moment fixes the figures: the unused whole months, the wallet debt settled FIRST out of their value, and the cash left to send back;
 *  2. ONE D1 batch records the plan, adds the debt part to the order's refunded total, and CANCELS the subscription at the end of the CURRENT month (the paid
 *     month stays in effect, WA-CANCEL-1): the period is shortened by the quote's unused months, never by the net cash;
 *  3. the debt is credited to the wallet as a ledger row under a fixed ref (`yearly-refund-debt:<order>`), so it posts exactly once however often this runs.
 * The cash part is sent by a person through the provider's dashboard; its webhook adds to the refunded total and shortens nothing more (the months are already cut).
 * When the debt is at least the value of the unused months, nothing is paid out and the result says so (`noMoneyOut`).
 */
export async function executeYearlyRefund(env: Env, orderId: string, a: { actor: string; reason: string }, now = Date.now()): Promise<YearlyRefundResult> {
  const o = await findPackageOrder(env, orderId);
  if (!o) return { ok: false, reason: 'not_found' };
  if (o.status !== 'paid') return { ok: false, reason: 'not_paid' };
  const b = await periodBasis(env, o, now);
  if (!b || b.periodMonths <= 1) return { ok: false, reason: 'not_yearly' };
  const finish = async (p: PlanRow): Promise<YearlyRefundResult> => {
    // Steps outside D1, all idempotent: the debt credit (fixed ref) and the push of the changed subscription.
    await postPlanDebt(env, p, now);
    await announceSubscription(env, p.workspace_id, now);
    return { ok: true, orderId: p.order_id, shortenedMonths: p.shortened_months, debtSettledMinor: p.debt_settled_minor, cashRefundMinor: p.cash_minor, noMoneyOut: p.cash_minor === 0, periodEnd: p.new_period_end };
  };
  const existing = await env.DB.prepare(PLAN_COLS_SQL).bind(b.ownerId).first<PlanRow>();
  if (existing?.applied === 1) return finish(existing);
  if (existing) await env.DB.prepare('DELETE FROM package_refund_plans WHERE order_id = ? AND applied = 0').bind(b.ownerId).run();
  if (b.queued && !b.running) return { ok: false, reason: 'order_queued' };
  if (!b.running) return { ok: false, reason: 'not_running' };
  const q = await packageRefundQuote(env, orderId, now);
  if (typeof q === 'string') return { ok: false, reason: q };
  if (q.unusedMonths <= 0 || q.grossMinor <= 0) return { ok: false, reason: 'nothing_to_refund' };
  const newEnd = addMonthsUtc(b.periodEnd, -q.unusedMonths);
  const plan: PlanRow = { order_id: b.ownerId, workspace_id: o.workspace_id, shortened_months: q.unusedMonths, debt_settled_minor: q.debtSettledMinor, cash_minor: q.refundMinor, new_period_end: newEnd, applied: 0, actor: a.actor };
  const open = 'EXISTS (SELECT 1 FROM package_refund_plans WHERE order_id = ? AND applied = 0)';
  await env.DB.batch([
    // The plan is only recorded if the figures it rests on still hold: the money already refunded across the period (a webhook partial refund landing since the
    // quote would otherwise overstate the cash) and the very period the quote was taken on.
    env.DB.prepare(`INSERT INTO package_refund_plans (order_id, workspace_id, shortened_months, debt_settled_minor, cash_minor, period_start, new_period_end, actor, reason, at, applied)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
         WHERE (SELECT coalesce(sum(refunded_minor), 0) FROM package_orders WHERE workspace_id = ? AND status IN ('paid', 'refunded', 'charged_back') AND (order_id = ? OR period_owner = ?)) = ?
           AND EXISTS (SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND period_start = ? AND period_end = ?)
        ON CONFLICT DO NOTHING`)
      .bind(plan.order_id, plan.workspace_id, plan.shortened_months, plan.debt_settled_minor, plan.cash_minor, b.periodStart, newEnd, a.actor, a.reason, now, plan.workspace_id, plan.order_id, plan.order_id, q.refundedMinor, plan.workspace_id, b.periodStart, b.periodEnd),
    env.DB.prepare(`UPDATE workspace_subscriptions SET period_end = min(period_end, ?), status = 'cancelled', cancelled_at = ?, version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND period_start = ? AND status IN ('active', 'trialing') AND ${open}`).bind(newEnd, now, now, plan.workspace_id, b.periodStart, plan.order_id),
    env.DB.prepare(`UPDATE package_orders SET refunded_minor = refunded_minor + ? WHERE order_id = ? AND ${open}
        AND EXISTS (SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND status = 'cancelled' AND period_end = ?)`).bind(plan.debt_settled_minor, plan.order_id, plan.order_id, plan.workspace_id, newEnd),
    env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) SELECT ?, ?, 'yearly_refund', ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND status = 'cancelled' AND period_end = ?) AND "+open)
      .bind(now, a.actor, plan.workspace_id, JSON.stringify({ orderId: plan.order_id, shortenedMonths: plan.shortened_months, debtSettledMinor: plan.debt_settled_minor, cashMinor: plan.cash_minor }), a.reason, plan.workspace_id, newEnd, plan.order_id),
    env.DB.prepare(`UPDATE package_refund_plans SET applied = 1 WHERE order_id = ? AND EXISTS (SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND status = 'cancelled' AND period_end = ?)`).bind(plan.order_id, plan.workspace_id, newEnd),
  ]);
  const stored = await env.DB.prepare(PLAN_COLS_SQL).bind(plan.order_id).first<PlanRow>();
  if (!stored || stored.applied !== 1) {
    await env.DB.prepare('DELETE FROM package_refund_plans WHERE order_id = ? AND applied = 0').bind(plan.order_id).run();
    return { ok: false, reason: 'quote_changed' }; // the refunds or the subscription changed under the quote: nothing was applied, ask again for a fresh one
  }
  return finish(stored);
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
    const subBefore = await env.DB.prepare('SELECT version, period_start FROM workspace_subscriptions WHERE workspace_id = ?').bind(row.workspace_id).first<{ version: number; period_start: number }>();
    const amount = row.amount_minor;
    const before = row.refunded_minor;
    const remainingBefore = amount - before;
    const full = before + r >= amount;
    const months = await periodMonthsOf(env, row.package_id);
    // The queued order that takes over if this one owns the running period and is refunded in full: its OWN package and length.
    const nextQueued = await env.DB.prepare('SELECT package_id, period_months FROM package_orders WHERE workspace_id = ? AND queued_seq IS NOT NULL ORDER BY queued_seq LIMIT 1').bind(row.workspace_id).first<{ package_id: string; period_months: number }>();
    // A YEARLY order is refunded in WHOLE months (Review Focus 5): the period is shortened by floor(refund / monthly value), never into the current month.
    const yearly = months > 1 && !full ? await yearlyShortening(env, row, r, now) : null;
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
      ).bind(refundRef, oid, r, now, ws, months > 1 ? 0 : r, remainingBefore, oid, before), // frac_num 0: a yearly refund never expires part of the current month's credits
    ];
    const audit = (note: string) => env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) SELECT ?, 'provider', 'subscription_set', ?, NULL, ?, ? WHERE changes() > 0").bind(now, ws, JSON.stringify({ note }), oid);
    const owner = months > 1
      // yearly: the order owns the running period, or is an upgrade of the order that does (WA-YEARLY-SWITCH-2)
      ? "(SELECT (owns_running = 1 OR (period_owner IS NOT NULL AND period_owner = (SELECT o2.order_id FROM package_orders o2 WHERE o2.workspace_id = package_orders.workspace_id AND o2.owns_running = 1))) FROM package_orders WHERE order_id = ?) = 1"
      : '(SELECT owns_running FROM package_orders WHERE order_id = ?) = 1';
    if (full && row.kind === 'upgrade') {
      // A full refund of an UPGRADE order undoes the upgrade only: the subscription goes back to the package it was bought from, for the rest of the same
      // period. It never cancels or rolls the period (that belongs to the order that owns it), and "full" is measured over this order alone.
      stmts.push(
        env.DB.prepare(`UPDATE package_orders SET status = ?, refunded_minor = refunded_minor + ? WHERE order_id = ? AND status = 'paid' AND ${g.sql}`).bind(ev.chargeback ? 'charged_back' : 'refunded', r, oid, ...g.binds),
        // ...but only the period the upgrade was GRANTED in: an upgrade of an earlier period (or one that was paid and never granted) must not downgrade today's period.
        env.DB.prepare(`UPDATE workspace_subscriptions SET package_id = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND package_id = ? AND period_end > ? AND period_start = ? AND status IN ('active', 'trialing')
            AND EXISTS (SELECT 1 FROM package_orders WHERE order_id = ? AND granted_at IS NOT NULL) AND ${g.sql} RETURNING version`)
          .bind(row.from_package, now, ws, row.package_id, now, row.quoted_period_start, oid, ...g.binds),
        audit('upgrade_reverted_by_refund'),
      );
    } else if (full) {
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
        env.DB.prepare(`UPDATE workspace_subscriptions SET period_start = ?, package_id = coalesce(?, package_id), period_end = ${MONTHS_SQL('?', '?')}, queued_periods = queued_periods - 1, version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND queued_periods > 0 AND source = 'purchase' AND status IN ('active', 'trialing') AND ${owner} AND ${g.sql} RETURNING version`).bind(now, nextQueued?.package_id ?? null, now, nextQueued?.period_months ?? 1, now, ws, oid, ...g.binds),
        audit('next_period_started_by_refund'),
        env.DB.prepare(`UPDATE package_orders SET owns_running = 0 WHERE order_id = ? AND ${g.sql}`).bind(oid, ...g.binds),
      );
    } else {
      const remainingAfter = remainingBefore - r;
      stmts.push(
        env.DB.prepare(`UPDATE package_orders SET refunded_minor = refunded_minor + ? WHERE order_id = ? AND ${g.sql}`).bind(r, oid, ...g.binds),
        months > 1
          // yearly: the new end was computed from the subscription row read above; the statement only applies if that row is still the one it was computed from
          ? env.DB.prepare(`UPDATE workspace_subscriptions SET period_end = min(period_end, ?), version = version + 1, updated_at = ?
              WHERE workspace_id = ? AND ? > 0 AND period_start = ? AND period_end = ? AND ? < period_end AND source = 'purchase' AND status IN ('active', 'trialing') AND ${owner} AND ${g.sql} RETURNING version`)
            .bind(yearly?.newEnd ?? 0, now, ws, yearly?.months ?? 0, yearly?.periodStart ?? 0, yearly?.periodEnd ?? 0, yearly?.newEnd ?? 0, oid, ...g.binds)
          : env.DB.prepare(`UPDATE workspace_subscriptions SET period_end = max(?, period_start + (period_end - period_start) * ? / ?), version = version + 1, updated_at = ?
              WHERE workspace_id = ? AND source = 'purchase' AND status IN ('active', 'trialing') AND period_end > ? AND ${owner} AND ${g.sql} RETURNING version`).bind(now, remainingAfter, remainingBefore, now, ws, now, oid, ...g.binds),
        audit('shortened_by_partial_refund'),
        env.DB.prepare('UPDATE package_refunds SET shortened = 1, cut_value_minor = ? WHERE refund_ref = ? AND changes() > 0').bind(yearly?.cutValueMinor ?? 0, refundRef),
      );
    }
    stmts.push(env.DB.prepare('UPDATE package_refunds SET applied = 1 WHERE refund_ref = ?').bind(refundRef));
    const res = await env.DB.batch(stmts);
    if (res[0]!.meta.changes === 0) continue; // another refund of this order committed first: decide again on the new total
    alert(full ? (ev.chargeback ? 'package_chargeback' : 'package_refunded') : 'package_partial_refund', { workspace: ws, orderId: oid, amountMinor: r, eventKey: ev.eventKey });
    const subAfter = await env.DB.prepare('SELECT version FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ version: number }>();
    if (subAfter && subAfter.version !== subBefore?.version) await announceSubscription(env, ws, now);
    // (An upgrade of an earlier period, or one never granted, has nothing to revert: that is expected, not an alert.)
    if (full && row.kind === 'upgrade' && row.granted_at !== null && subBefore?.period_start === row.quoted_period_start && subAfter?.version === subBefore?.version) alert('upgrade_refund_not_reverted', { severity: 'P1', workspace: ws, orderId: oid }); // the subscription had moved on: a person reverts it
    outcome = full ? 'refunded' : 'partial_refund';
    settled = true;
    break;
  }
  // Losing every race must not look like success: the provider is answered 5xx and the delivery is kept for the daily pass.
  if (!settled) throw new RefundContention();
  await finishRefund(env, row0.order_id, refundRef, now);
  return outcome;
}

/**
 * A fully refunded UPGRADE that was reverted (the subscription is back on `from_package` in the very period it was granted in) also gives back the credits it added:
 * the month's grant above the old package's allowance expires, unused credits only. Skipped when nothing was reverted (an earlier period, or never granted).
 */
async function revokeRefundedUpgradeCredits(env: Env, o: PackageOrderRow, stub: ReturnType<Env['WORKSPACE_DO']['get']>, now: number): Promise<void> {
  if (o.granted_at === null || !o.from_package || o.quoted_period_start === null) return;
  const cur = await env.DB.prepare('SELECT package_id, period_start FROM workspace_subscriptions WHERE workspace_id = ?').bind(o.workspace_id).first<{ package_id: string; period_start: number }>();
  if (!cur || cur.package_id !== o.from_package || cur.period_start !== o.quoted_period_start) return;
  const keep = (await env.DB.prepare('SELECT ai_credits FROM packages WHERE id = ?').bind(o.from_package).first<{ ai_credits: number }>())?.ai_credits ?? 0;
  await stub.revokeUpgradeCredits({ keepCredits: keep, ref: `expire:upgrade-refund:${o.order_id}` }, now);
}

/** Refunding the order that OWNS a period in full leaves any upgrade paid on top of it paid and unrefunded: a person must refund or keep it (once per upgrade). */
async function flagStrandedUpgrades(env: Env, o: PackageOrderRow, now: number): Promise<void> {
  const { results } = await env.DB.prepare("SELECT order_id FROM package_orders WHERE workspace_id = ? AND period_owner = ? AND status = 'paid' AND amount_minor > refunded_minor").bind(o.workspace_id, o.order_id).all<{ order_id: string }>();
  for (const u of results) {
    if (await auditOnce(env, 'upgrade_stranded_by_owner_refund', o.workspace_id, u.order_id, now)) alert('upgrade_stranded_by_owner_refund', { severity: 'P1', workspace: o.workspace_id, orderId: u.order_id, ownerOrderId: o.order_id });
  }
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
  if (o.status === 'refunded' || o.status === 'charged_back') {
    if (o.kind === 'upgrade') await revokeRefundedUpgradeCredits(env, o, stub, now);
    else await flagStrandedUpgrades(env, o, now);
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
    // (A stale or expired switch order is reported once by `staleOrReplay`, not again every day.)
    if (!SWITCH_KINDS.includes(row.kind)) alert('package_paid_not_granted', { workspace: row.workspace_id, orderId: row.order_id });
    try {
      if ((await grantOrder(env, row, row.provider_ref!, now, { claim: false })) === 'granted') granted++;
    } catch (err) {
      alert('package_repair_failed', { orderId: row.order_id, error: errName(err) });
    }
  }
  await repairRefundPlans(env, now);
  // A switch quote whose period has ended can never be granted at its price: expire it now rather than after a day.
  await env.DB.prepare("UPDATE package_orders SET status = 'expired' WHERE provider = 'kashier' AND status = 'pending' AND kind IN ('upgrade', 'queued_switch') AND quoted_period_end <= ?").bind(now).run();
  const exp = await env.DB.prepare("UPDATE package_orders SET status = 'expired' WHERE provider = 'kashier' AND status = 'pending' AND created_at < ?").bind(now - PENDING_EXPIRES_AFTER_MS).run();
  return { granted, expired: exp.meta.changes, confirmed };
}
