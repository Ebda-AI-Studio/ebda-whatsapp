/**
 * Control-plane side of packages: D1 `workspace_subscriptions` is the source, the workspace holds a versioned copy.
 *
 * Every write goes through `setSubscription` / `cancelSubscription` / `rollRenewals` here: one D1 batch bumps `version` in the same
 * statement that writes the row and appends the `billing_audit` row; only AFTER it commits does `announceSubscription` push the
 * workspace and queue `whatsapp.entitlement_changed` for the Store (event id = f(workspace, version), so announcing again is harmless).
 */
import type { Env } from '../../env';
import { outboundStoreEventSchema } from '../api/store-events';
import { storeLink } from '../store-link';
import { uuidFromKey } from '../store-link/orders';
import type { EntitlementEvent } from './entitlements';
import { alert } from '../observability';
import { isStandaloneId } from '../workspace-kind';

export const STORE_INCLUDED = 'store-included';
/** `col` (ms) plus N whole calendar months, N being a SQL expression. */
export const MONTHS_SQL = (col: string, months: string) => `CAST(strftime('%s', ${col} / 1000, 'unixepoch', '+' || (${months}) || ' months') AS INTEGER) * 1000`;
export const MONTH_SQL = (col: string) => MONTHS_SQL(col, '1');
/** The billing period (1 or 12 months) of the package a `workspace_subscriptions` row is on. */
export const PERIOD_MONTHS_SQL = 'coalesce((SELECT period_months FROM packages WHERE id = workspace_subscriptions.package_id), 1)';
/**
 * Used while a queued period is rolled in: the order that now OWNS the running period decides the package and how many months that period is, because a queued
 * order keeps what it was bought as (a 12-month period rolls as 12 months, and a queued downgrade rolls as the package it was bought for), whatever the
 * package row says later. Evaluated after the owner flag moved, so exactly one order matches; with no order (a legacy row) the subscription keeps its own.
 */
export const OWNER_MONTHS_SQL = 'coalesce((SELECT period_months FROM package_orders WHERE workspace_id = workspace_subscriptions.workspace_id AND owns_running = 1), 1)';
export const OWNER_PACKAGE_SQL = 'coalesce((SELECT package_id FROM package_orders WHERE workspace_id = workspace_subscriptions.workspace_id AND owns_running = 1), package_id)';

type SubRow = { workspace_id: string; package_id: string; status: EntitlementEvent['status']; period_start: number; period_end: number; cancelled_at: number | null; version: number; ai_credits: number | null; max_members: number | null; feat_campaigns: number | null; feat_order_in_chat: number | null; feat_api: number | null; priority_support: number | null; past_due_since: number | null; period_months: number | null };

/** A package row that is missing (LEFT JOIN null) yields the DENY limits, never a feature. */
export const toEvent = (r: SubRow): EntitlementEvent => ({
  version: r.version, packageId: r.package_id, status: r.status, periodStart: r.period_start, periodEnd: r.period_end, aiCredits: r.ai_credits ?? 0, cancelledAt: r.cancelled_at, pastDueSince: r.status === 'past_due' ? r.past_due_since : null, periodMonths: r.period_months ?? 1,
  limits: { maxMembers: Math.max(1, r.max_members ?? 1), campaigns: r.feat_campaigns === 1, orderInChat: r.feat_order_in_chat === 1, api: r.feat_api === 1, prioritySupport: r.priority_support === 1 },
});

const SELECT = `SELECT s.workspace_id, s.package_id, s.status, s.period_start, s.period_end, s.cancelled_at, s.version, p.ai_credits, p.max_members, p.feat_campaigns, p.feat_order_in_chat, p.feat_api, p.priority_support, s.past_due_since, p.period_months
  FROM workspace_subscriptions s LEFT JOIN packages p ON p.id = s.package_id`;

const errName = (err: unknown) => (err instanceof Error ? err.name : 'error');

/** Pushes one workspace's current subscription. Called after every change to its row; a failed push is repaired by the daily reconcile. */
export async function pushEntitlement(env: Env, workspaceId: string): Promise<'applied' | 'stale' | 'invalid' | 'none'> {
  const r = await env.DB.prepare(`${SELECT} WHERE s.workspace_id = ?`).bind(workspaceId).first<SubRow>();
  if (!r) return 'none';
  return env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId)).applyEntitlement(toEvent(r));
}

/** Queues `whatsapp.entitlement_changed` for a row. Throws if the Store queue is down. */
async function emitStoreEvent(env: Env, r: SubRow, now: number): Promise<boolean> {
  const sink = storeLink().events(env);
  if (!sink) return false;
  await sink.send(outboundStoreEventSchema.parse({
    id: await uuidFromKey(`entitlement:${r.workspace_id}:${r.version}`), type: 'whatsapp.entitlement_changed', v: 1, storeId: r.workspace_id, occurredAt: new Date(now).toISOString(),
    data: { packageId: r.package_id, automation: r.status === 'trialing' || r.status === 'active', status: r.status, validUntil: new Date(r.period_end).toISOString(), version: r.version },
  }));
  return true;
}

/** After a committed write: push the workspace and tell the Store, each independently reported, neither undoing the write. */
export async function announceSubscription(env: Env, workspaceId: string, now = Date.now()): Promise<{ applied: boolean; eventQueued: boolean }> {
  let applied = false;
  try {
    applied = (await pushEntitlement(env, workspaceId)) === 'applied';
  } catch (err) {
    alert('entitlement_push_failed', { workspace: workspaceId, error: errName(err) });
  }
  let eventQueued = false;
  try {
    const r = await env.DB.prepare(`${SELECT} WHERE s.workspace_id = ?`).bind(workspaceId).first<SubRow>();
    if (r) eventQueued = await emitStoreEvent(env, r, now);
  } catch (err) {
    alert('entitlement_event_not_queued', { workspace: workspaceId, error: errName(err) });
  }
  return { applied, eventQueued };
}

export type SubscriptionSource = 'store_plan' | 'operator' | 'purchase';
type Frag = { sql: string; binds: unknown[] };
export type WriteOpts = {
  /** The write happens only if this holds (evaluated when the statement runs, inside the batch). */
  only?: Frag;
  /** On an EXISTING row: the update happens only if this holds. Columns are the existing row's (`workspace_subscriptions.<col>`). */
  guard?: Frag;
  /** Statements run in the same batch before / after the write (a claim marker, an order flag). */
  before?: D1PreparedStatement[];
  after?: D1PreparedStatement[];
  /** A purchase: renewing the same running package queues a period instead of moving the running one. */
  renewal?: boolean;
};
export type SetSubscription = {
  workspaceId: string; packageId: string; status: EntitlementEvent['status']; periodStart: number; periodEnd: number; source: SubscriptionSource;
  /** What caused the write: the Store event id, the operator's user id or the order id. Goes to the audit row. */
  ref: string;
  reason?: string;
  /** Epoch ms the renewal first failed, when the caller knows it (the Store plan event). Otherwise "now" the first time the status turns past_due. */
  pastDueSince?: number;
};
export type WriteResult = { version: number; written: boolean; applied: boolean; eventQueued: boolean; pre: number[] };

export const auditStmt = (env: Env, a: { actor: string; workspaceId: string; after: unknown; ref: string }, now: number) =>
  env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, ref) SELECT ?, ?, 'subscription_set', ?, NULL, ?, ? WHERE changes() > 0")
    .bind(now, a.actor, a.workspaceId, JSON.stringify(a.after), a.ref);

export async function runWrite(env: Env, write: D1PreparedStatement, audit: D1PreparedStatement, o: WriteOpts, workspaceId: string, now: number): Promise<WriteResult> {
  const before = o.before ?? [];
  const res = await env.DB.batch([...before, write, audit, ...(o.after ?? [])]);
  const version = (res[before.length]!.results[0] as { version: number } | undefined)?.version;
  const pre = before.map((_s, i) => res[i]!.meta.changes);
  if (version === undefined) return { version: 0, written: false, applied: false, eventQueued: false, pre };
  return { version, written: true, ...(await announceSubscription(env, workspaceId, now)), pre };
}

/**
 * The writer of a package. The version is bumped by the database in the statement that writes the row, so racing writers never share or
 * lower one. Rules decided in SQL (never read-then-write): renewing/extending the SAME package while it runs keeps `period_start` (so the
 * period's AI credits are neither refilled nor expired); a different package, or one that has ended, starts a new period now.
 * A `renewal` of the same running package leaves the running period alone and queues one more (`queued_periods`).
 */
export async function setSubscription(env: Env, a: SetSubscription, now = Date.now(), o: WriteOpts = {}): Promise<WriteResult> {
  // CHAT-SA-6: a standalone workspace (no Store) buys Chat packages and nothing else: never the Store's `store-included`, never a Store-plan write, never a trial (CHAT-ENABLE-1).
  // The one writer refuses it for EVERY caller (Store events, the operator route, a future path); nothing is written and a person is told.
  if (isStandaloneId(a.workspaceId) && (a.packageId === STORE_INCLUDED || a.source === 'store_plan' || a.status === 'trialing')) {
    alert('standalone_subscription_refused', { workspace: a.workspaceId, source: a.source, packageId: a.packageId, status: a.status });
    return { version: 0, written: false, applied: false, eventQueued: false, pre: [0] };
  }
  const RUNNING = "workspace_subscriptions.package_id = excluded.package_id AND workspace_subscriptions.period_end > ? AND workspace_subscriptions.status IN ('active', 'trialing')";
  const sql = `INSERT INTO workspace_subscriptions (workspace_id, package_id, status, period_start, period_end, cancelled_at, version, updated_at, source, queued_periods, past_due_since)
    SELECT ?, ?, ?, ?, ?, CASE WHEN ? = 'cancelled' THEN ? END, 1, ?, ?, 0, CASE WHEN ? = 'past_due' THEN coalesce(?, ?) END WHERE ${o.only?.sql ?? '1'}
    ON CONFLICT(workspace_id) DO UPDATE SET package_id = excluded.package_id, status = excluded.status,
      period_start = CASE WHEN ${RUNNING} THEN workspace_subscriptions.period_start ELSE excluded.period_start END,
      period_end = CASE WHEN ${o.renewal ? 'TRUE' : 'FALSE'} AND ${RUNNING} THEN workspace_subscriptions.period_end ELSE excluded.period_end END,
      queued_periods = CASE WHEN ${o.renewal ? 'TRUE' : 'FALSE'} AND ${RUNNING} THEN workspace_subscriptions.queued_periods + 1 ELSE workspace_subscriptions.queued_periods END,
      cancelled_at = excluded.cancelled_at, version = workspace_subscriptions.version + 1, updated_at = excluded.updated_at, source = excluded.source, payment_unconfirmed_until = NULL,
      past_due_since = CASE WHEN excluded.status = 'past_due' THEN coalesce(?, CASE WHEN workspace_subscriptions.status = 'past_due' THEN workspace_subscriptions.past_due_since END, ?) ELSE NULL END
    WHERE ${o.guard?.sql ?? '1'}
    RETURNING version`;
  const binds = [a.workspaceId, a.packageId, a.status, a.periodStart, a.periodEnd, a.status, now, now, a.source, a.status, a.pastDueSince ?? null, now, ...(o.only?.binds ?? []), now, now, now, a.pastDueSince ?? null, now, ...(o.guard?.binds ?? [])];
  // A period written by anyone but a purchase (an operator, the Store plan) is no order's: the order that owned the previous period stops owning anything, in the
  // same batch and only if the write happened (the audit row, which runs right after the write, is what `changes()` sees). Otherwise an old order could later be
  // refunded as if it had paid for this period.
  const releaseOwner = env.DB.prepare('UPDATE package_orders SET owns_running = 0 WHERE workspace_id = ? AND owns_running = 1 AND changes() > 0').bind(a.workspaceId);
  const opts: WriteOpts = a.source === 'purchase' ? o : { ...o, after: [releaseOwner, ...(o.after ?? [])] };
  return runWrite(env, env.DB.prepare(sql).bind(...binds),
    auditStmt(env, { actor: a.source, workspaceId: a.workspaceId, ref: a.ref, after: { packageId: a.packageId, status: a.status, periodStart: a.periodStart, periodEnd: a.periodEnd, ...(a.reason ? { reason: a.reason } : {}) } }, now),
    opts, a.workspaceId, now);
}

/** Cancels the existing subscription (never creates one). `periodEndNow` ends the period at `now` (a refund); otherwise the period is kept. */
export async function cancelSubscription(env: Env, a: { workspaceId: string; actor: SubscriptionSource; ref: string; periodEndNow?: boolean; takeSource?: boolean }, now = Date.now(), o: WriteOpts = {}): Promise<WriteResult> {
  const sql = `UPDATE workspace_subscriptions SET status = 'cancelled', past_due_since = NULL, cancelled_at = ?, period_end = CASE WHEN ? THEN ? ELSE period_end END,
      version = version + 1, updated_at = ?, source = CASE WHEN ? THEN ? ELSE source END
    WHERE workspace_id = ? AND ${o.only?.sql ?? '1'} AND ${o.guard?.sql ?? '1'} RETURNING version`;
  const binds = [now, a.periodEndNow ? 1 : 0, now, now, a.takeSource ? 1 : 0, a.actor, a.workspaceId, ...(o.only?.binds ?? []), ...(o.guard?.binds ?? [])];
  return runWrite(env, env.DB.prepare(sql).bind(...binds), auditStmt(env, { actor: a.actor, workspaceId: a.workspaceId, ref: a.ref, after: { status: 'cancelled', ...(a.periodEndNow ? { periodEnd: now } : {}) } }, now), o, a.workspaceId, now);
}

/**
 * Starts the next queued period of every subscription whose running one has ended (an early renewal paid for it): the new period begins at
 * the old `period_end`, the queue shrinks by one per roll, and the version goes up. Returns the number of rolls. The workspace is NOT
 * pushed here (the Durable Object calling this applies the result itself); the Store is told.
 */
export async function rollRenewals(env: Env, workspaceId: string, now: number): Promise<number> {
  let rolled = 0;
  for (let i = 0; i < 12; i++) {
    // Which order owns the running period moves with the roll (decided by the same predicate the roll uses, evaluated before it).
    const due = { sql: "EXISTS (SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND queued_periods > 0 AND period_end <= ? AND status IN ('active', 'trialing'))", binds: [workspaceId, now] };
    const res = await env.DB.batch([
      env.DB.prepare(`UPDATE package_orders SET owns_running = 0 WHERE workspace_id = ? AND owns_running = 1 AND ${due.sql}`).bind(workspaceId, ...due.binds),
      env.DB.prepare(`UPDATE package_orders SET owns_running = 1, queued_seq = NULL WHERE order_id = (SELECT order_id FROM package_orders WHERE workspace_id = ? AND queued_seq IS NOT NULL ORDER BY queued_seq LIMIT 1) AND ${due.sql}`).bind(workspaceId, ...due.binds),
      env.DB.prepare(`UPDATE package_orders SET queued_seq = queued_seq - 1 WHERE workspace_id = ? AND queued_seq IS NOT NULL AND ${due.sql}`).bind(workspaceId, ...due.binds),
      env.DB.prepare(`UPDATE workspace_subscriptions SET period_start = period_end, package_id = ${OWNER_PACKAGE_SQL}, period_end = ${MONTHS_SQL('period_end', OWNER_MONTHS_SQL)}, queued_periods = queued_periods - 1,
          version = version + 1, updated_at = ? WHERE workspace_id = ? AND queued_periods > 0 AND period_end <= ? AND status IN ('active', 'trialing') RETURNING version`).bind(now, workspaceId, now),
      auditStmt(env, { actor: 'purchase', workspaceId, ref: 'queued_period_started', after: { rolledAt: now } }, now),
    ]);
    if ((res[3]!.results[0] as { version: number } | undefined) === undefined) break;
    rolled++;
  }
  if (rolled > 0) {
    try {
      const r = await env.DB.prepare(`${SELECT} WHERE s.workspace_id = ?`).bind(workspaceId).first<SubRow>();
      if (r) await emitStoreEvent(env, r, now);
    } catch (err) {
      alert('entitlement_event_not_queued', { workspace: workspaceId, error: errName(err) });
    }
  }
  return rolled;
}

/** The current subscription as a workspace event (what the Durable Object applies after `rollRenewals`). */
export async function currentEvent(env: Env, workspaceId: string): Promise<EntitlementEvent | null> {
  const r = await env.DB.prepare(`${SELECT} WHERE s.workspace_id = ?`).bind(workspaceId).first<SubRow>();
  return r ? toEvent(r) : null;
}

/**
 * A bought or operator package that has ended, in a store whose Store plan includes WhatsApp, gives way to `store-included` again
 * (the Store's last plan event is remembered in `store_plan_applied`). A running package, or one with a paid queued period, is never touched.
 */
export async function fallbackToStorePlan(env: Env, workspaceId: string, now: number): Promise<boolean> {
  if (isStandaloneId(workspaceId)) return false; // CHAT-SA-6: no Store plan to fall back to, ever (belt and braces: `store_plan_applied` has no row for it)
  const p = await env.DB.prepare('SELECT includes_whatsapp, status, period_end FROM store_plan_applied WHERE workspace_id = ?').bind(workspaceId).first<{ includes_whatsapp: number; status: EntitlementEvent['status']; period_end: number | null }>();
  if (!p || p.includes_whatsapp !== 1) return false;
  const r = await setSubscription(env, { workspaceId, packageId: STORE_INCLUDED, status: p.status, periodStart: now, periodEnd: p.period_end ?? now + 31 * 86_400_000, source: 'store_plan', ref: 'store_plan_fallback' }, now, {
    guard: { sql: "workspace_subscriptions.package_id != ? AND workspace_subscriptions.period_end <= ? AND workspace_subscriptions.queued_periods = 0 AND (workspace_subscriptions.source IS NULL OR workspace_subscriptions.source IN ('purchase', 'operator'))", binds: [STORE_INCLUDED, now] },
  });
  return r.written;
}

/**
 * Daily: starts queued periods that are due, hands lapsed packages back to the Store plan, then re-sends every subscription as an event.
 * The workspace ignores what it already has (versions only move forward), so re-sending is safe and heals a lost push; it never decides
 * anything itself (no TTL on an entitlement).
 */
export async function reconcileEntitlements(env: Env, now = Date.now()): Promise<{ sent: number; applied: number; failed: number }> {
  const due = await env.DB.prepare("SELECT workspace_id FROM workspace_subscriptions WHERE queued_periods > 0 AND period_end <= ? AND status IN ('active', 'trialing')").bind(now).all<{ workspace_id: string }>();
  for (const d of due.results) await rollRenewals(env, d.workspace_id, now).catch((err) => alert('queued_period_roll_failed', { workspace: d.workspace_id, error: errName(err) }));
  const lapsed = await env.DB.prepare(`SELECT s.workspace_id FROM workspace_subscriptions s JOIN store_plan_applied p ON p.workspace_id = s.workspace_id
    WHERE p.includes_whatsapp = 1 AND s.package_id != ? AND s.period_end <= ? AND s.queued_periods = 0 AND (s.source IS NULL OR s.source IN ('purchase', 'operator'))`).bind(STORE_INCLUDED, now).all<{ workspace_id: string }>();
  for (const l of lapsed.results) await fallbackToStorePlan(env, l.workspace_id, now).catch((err) => alert('store_plan_fallback_failed', { workspace: l.workspace_id, error: errName(err) }));
  const { results } = await env.DB.prepare(`${SELECT} ORDER BY s.workspace_id`).all<SubRow>();
  let applied = 0;
  let failed = 0;
  for (const r of results) {
    try {
      if ((await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(r.workspace_id)).applyEntitlement(toEvent(r))) === 'applied') applied++;
    } catch (err) {
      failed++;
      alert('entitlement_push_failed', { workspace: r.workspace_id, error: errName(err) });
    }
  }
  return { sent: results.length, applied, failed };
}
