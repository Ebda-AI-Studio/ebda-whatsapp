/**
 * Packages and entitlements (Phase 7.1). The control plane (D1 `workspace_subscriptions`) is the source; the workspace keeps a COPY in
 * `entitlements` that only moves forward: an event carries a `version` and an older or equal one is ignored, so redelivery, a late
 * reconcile and a retried push can never roll a plan back. Staleness class: NEVER-stale for status (a past_due plan must stop
 * marketing at once), kept fresh by event push on every change plus a daily reconcile that only RE-SENDS events (never a TTL).
 *
 * `past_due`, `cancelled` and `expired` block marketing only; service, utility and authentication messages, the inbox and the wallet
 * keep working. A cancelled workspace keeps its wallet and ledger (money rows are never deleted).
 */
import { z } from 'zod';
import { expireGrant, grantCredits, lastGrantStart, upgradeGrant } from '../ai/credits';
import { addMonthsUtc, monthsStarted } from './yearly';
import { addTask } from '../scheduler';

type Sql = DurableObjectStorage['sql'];

export const ENTITLEMENT_STATUS = ['trialing', 'active', 'past_due', 'cancelled', 'expired'] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUS)[number];

export const entitlementEvent = z.object({
  version: z.number().int().positive(),
  packageId: z.string().min(1).max(64),
  status: z.enum(ENTITLEMENT_STATUS),
  periodStart: z.number().int().nonnegative(),
  periodEnd: z.number().int().positive(),
  /** AI credits the package grants per period. */
  aiCredits: z.number().int().nonnegative().default(0),
  cancelledAt: z.number().int().positive().nullable().default(null),
  /** When the subscription first became past_due (epoch ms), set by the control plane; null otherwise. Bounds the WA-GRACE-1 grace. */
  pastDueSince: z.number().int().positive().nullable().default(null),
  /** Billing period length of the package: 1 (monthly) or 12 (yearly). AI credits are `aiCredits` PER MONTH either way. */
  periodMonths: z.number().int().min(1).max(12).default(1),
  /** What the package allows. The default is the DENY shape: an event from before limits existed grants no feature and one seat. */
  limits: z.object({
    maxMembers: z.number().int().min(1),
    campaigns: z.boolean(),
    orderInChat: z.boolean(),
    api: z.boolean(),
    prioritySupport: z.boolean(),
  }).default({ maxMembers: 1, campaigns: false, orderInChat: false, api: false, prioritySupport: false }),
});
export type EntitlementEvent = z.input<typeof entitlementEvent>;

export type Entitlement = {
  version: number; packageId: string; status: EntitlementStatus; periodStart: number; periodEnd: number; aiCredits: number; cancelledAt: number | null; updatedAt: number; periodMonths: number;
};

export type PlanFeature = 'campaigns' | 'order_in_chat' | 'api';

type Row = { version: number; package_id: string; status: EntitlementStatus; period_start: number; period_end: number; ai_credits: number; cancelled_at: number | null; updated_at: number; period_months: number };

export function readEntitlement(sql: Sql): Entitlement | null {
  const r = sql.exec<Row>('SELECT version, package_id, status, period_start, period_end, ai_credits, cancelled_at, updated_at, period_months FROM entitlements WHERE id = 1').toArray()[0];
  return r ? { version: r.version, packageId: r.package_id, status: r.status, periodStart: r.period_start, periodEnd: r.period_end, aiCredits: r.ai_credits, cancelledAt: r.cancelled_at, updatedAt: r.updated_at, periodMonths: r.period_months } : null;
}

/**
 * Ruling WA-CANCEL-1: the ONE definition of "the paid plan is in effect". trialing, active AND cancelled (the Store sends `cancelled` while the
 * paid period is still running) are in effect only while period_end is in the future, compared with `now` on EVERY check: the workspace expires
 * itself from its own copy, never waiting for the reconcile, an `expired` event or the expiry alarm. expired, past_due and a cancelled or active
 * plan whose period has ended are NOT in effect. (past_due has its own bounded grace, see `serviceAllowed`.)
 */
function inEffect(r: { status: EntitlementStatus; period_end: number }, now: number): boolean {
  return (r.status === 'trialing' || r.status === 'active' || r.status === 'cancelled') && r.period_end > now;
}

/**
 * A plan feature (campaigns, ordering in chat, the server API) is allowed only when the plan is in effect (WA-CANCEL-1) AND the package's limit
 * is on. No row, a lapsed plan or an old event without limits = DENY. Read per request from the workspace's own copy: a permission is
 * NEVER-stale, so there is no cache here.
 */
export function featureAllowed(sql: Sql, feature: PlanFeature, now: number = Date.now()): boolean {
  const col = feature === 'campaigns' ? 'lim_campaigns' : feature === 'order_in_chat' ? 'lim_order_in_chat' : 'lim_api';
  const r = sql.exec<{ status: EntitlementStatus; period_end: number; flag: number }>(`SELECT status, period_end, ${col} AS flag FROM entitlements WHERE id = 1`).toArray()[0];
  return r !== undefined && inEffect(r, now) && r.flag === 1;
}

/** Seats the package allows, the owner included. No row or a plan not in effect = 1 (the owner alone). */
export function memberLimit(sql: Sql, now: number = Date.now()): number {
  const r = sql.exec<{ status: EntitlementStatus; period_end: number; n: number }>('SELECT status, period_end, max_members AS n FROM entitlements WHERE id = 1').toArray()[0];
  return r && inEffect(r, now) ? Math.max(1, r.n) : 1;
}

/**
 * Marketing needs a plan IN EFFECT (WA-CANCEL-1: `cancelled` itself does not block it while the paid period runs). No entitlement row = BLOCKED
 * (fail closed: a plan gate is money state, and a workspace the control plane has not pushed yet must not send paid marketing for free).
 * past_due blocks it at once, whatever the grace for service. Utility, authentication and service sends and the inbox consult `serviceAllowed`.
 */
export function marketingBlocked(sql: Sql, now: number = Date.now()): boolean {
  const r = sql.exec<{ status: EntitlementStatus; period_end: number }>('SELECT status, period_end FROM entitlements WHERE id = 1').toArray()[0];
  return r === undefined || !inEffect(r, now);
}

/** WA-GRACE-1: how long after the first failed renewal a past_due workspace may still send service messages. */
export const PAST_DUE_GRACE_MS = 7 * 86_400_000;

/**
 * WA-NOFREE-1 + WA-CANCEL-1 + WA-GRACE-1, THE gate for service: every send path (API, template, bot, agent replies, store-link outbound incl. OTP and
 * order / COD confirmations, campaigns), the AI agent turn, background AI spend and number setup ask this and nothing else. True only when the plan
 * is in effect (trialing / active / cancelled, with period_end in the future) or past_due INSIDE its bounded grace (now < min(period_end,
 * past_due_since + 7 days)). No row, expired, or any plan whose period has ended = false: there is no free plan. A past_due copy that never learned
 * its start (past_due_since null) is bounded from the moment the copy was written. Read per call from the workspace copy; never cached.
 */
export function serviceAllowed(sql: Sql, now: number): boolean {
  const r = sql.exec<{ status: EntitlementStatus; period_end: number; past_due_since: number | null; updated_at: number }>('SELECT status, period_end, past_due_since, updated_at FROM entitlements WHERE id = 1').toArray()[0];
  if (!r) return false;
  if (inEffect(r, now)) return true;
  return r.status === 'past_due' && now < Math.min(r.period_end, (r.past_due_since ?? r.updated_at) + PAST_DUE_GRACE_MS);
}

const GRANTING: ReadonlySet<EntitlementStatus> = new Set(['trialing', 'active']); // grants AI credits (a cancelled plan's period already got its grant)

/** Replaces the pending expiry task with one at `periodEnd`. */
function scheduleExpiry(sql: Sql, periodEnd: number): void {
  sql.exec("DELETE FROM scheduled_tasks WHERE kind = 'subscription_expire' AND lease_until IS NULL");
  addTask(sql, 'subscription_expire', periodEnd);
}

/** Statuses whose yearly period still earns its monthly AI credits: a plan cancelled while in effect keeps them until period_end (WA-CANCEL-1). */
function earnsMonthlyCredits(e: { status: EntitlementStatus; period_end?: number; periodEnd?: number; aiCredits?: number; ai_credits?: number }, now: number): boolean {
  const end = e.periodEnd ?? e.period_end ?? 0;
  const credits = e.aiCredits ?? e.ai_credits ?? 0;
  return credits > 0 && (e.status === 'active' || e.status === 'trialing' || (e.status === 'cancelled' && end > now));
}

/**
 * The next month of a period longer than a month (yearly) that has not been granted yet, derived from the LAST month actually granted (never from the clock, so a
 * missed run or a replayed event cannot skip a month), and when it is due. Null = nothing more to grant in this period.
 */
function nextCreditMonth(sql: Sql, e: { periodStart: number; periodEnd: number; periodMonths: number }): { k: number; due: number } | null {
  if (e.periodMonths <= 1) return null;
  const k = monthsStarted(e.periodStart, e.periodMonths, lastGrantStart(sql, e.periodStart));
  const due = addMonthsUtc(e.periodStart, k);
  return k >= 1 && k < e.periodMonths && due < e.periodEnd ? { k, due } : null;
}

/**
 * A period longer than a month (yearly) gets its AI credits ONE MONTH AT A TIME: the first month's allowance lands with the event, and ONE `credit_month` task
 * (a singleton row) sits at the next monthly anniversary. An event re-points that row; a RUNNING (leased) row is left alone, because it recomputes its own next
 * month when it finishes. A plan that no longer earns them, or a one-month period, has none.
 */
function scheduleCreditMonth(sql: Sql, ev: { periodStart: number; periodEnd: number; periodMonths: number; status: EntitlementStatus; aiCredits: number }, now: number): void {
  sql.exec("DELETE FROM scheduled_tasks WHERE kind = 'credit_month' AND lease_until IS NULL");
  if (!earnsMonthlyCredits(ev, now)) return;
  const next = nextCreditMonth(sql, ev);
  if (next) addTask(sql, 'credit_month', next.due, { periodStart: ev.periodStart });
}

/**
 * The `credit_month` task. Everything is derived from the ledger and the entitlement, never from the payload: it grants the next UNGRANTED month if its
 * anniversary has come (the previous month's unused grant expires first; purchased credits roll over), under refs keyed by the month so a replay is a no-op, and
 * returns the due time of the month after (or the not-yet-due month), or undefined when the period has nothing more to grant. A duplicate row, a stale payload, a
 * replacement period or a refund-shortened period therefore cannot grant or expire anything twice.
 */
export function runCreditMonth(sql: Sql, now: number): number | undefined {
  const e = readEntitlement(sql);
  if (!e || !earnsMonthlyCredits(e, now)) return undefined;
  const next = nextCreditMonth(sql, e);
  if (!next) return undefined;
  if (next.due > now) return next.due; // not yet: keep the row at its true time
  expireGrant(sql, { periodStart: lastGrantStart(sql, e.periodStart), now });
  grantCredits(sql, { periodStart: next.due, packageId: e.packageId, credits: e.aiCredits, now });
  return nextCreditMonth(sql, e)?.due;
}

/** Applies one event inside the caller's transaction. */
export function applyEntitlement(sql: Sql, raw: EntitlementEvent, now: number): 'applied' | 'stale' | 'invalid' {
  const parsed = entitlementEvent.safeParse(raw);
  if (!parsed.success) return 'invalid';
  const ev = parsed.data;
  const cur = readEntitlement(sql);
  if (cur && ev.version < cur.version) return 'stale';
  if (cur && ev.version === cur.version) {
    // The daily reconcile re-sends the current version. It changes nothing about the period or the grants, but it is how a copy written before
    // limits existed (deny shape) picks them up, so the limits (and only the limits) are refreshed when the event really carries them.
    // Ruling P1a-3: no code path edits a package's limit columns after the seed (migration 0014 is the only writer; the operator route only writes
    // subscriptions). If one is ever added, it MUST bump the version of every affected workspace_subscriptions row in the same batch, otherwise a delayed
    // same-version push (carrying the old limits) could restore them through this refresh.
    const sent = (raw as { limits?: unknown }).limits !== undefined;
    if (sent && ev.packageId === cur.packageId) {
      const l = ev.limits;
      sql.exec('UPDATE entitlements SET max_members = ?, lim_campaigns = ?, lim_order_in_chat = ?, lim_api = ?, lim_priority_support = ? WHERE id = 1', l.maxMembers, l.campaigns ? 1 : 0, l.orderInChat ? 1 : 0, l.api ? 1 : 0, l.prioritySupport ? 1 : 0);
    }
    return 'stale';
  }
  const l = ev.limits;
  sql.exec(
    `INSERT INTO entitlements (id, version, package_id, status, period_start, period_end, ai_credits, cancelled_at, updated_at, max_members, lim_campaigns, lim_order_in_chat, lim_api, lim_priority_support, past_due_since, period_months)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version, package_id = excluded.package_id, status = excluded.status, period_start = excluded.period_start,
       period_end = excluded.period_end, ai_credits = excluded.ai_credits, cancelled_at = excluded.cancelled_at, updated_at = excluded.updated_at,
       max_members = excluded.max_members, lim_campaigns = excluded.lim_campaigns, lim_order_in_chat = excluded.lim_order_in_chat, lim_api = excluded.lim_api, lim_priority_support = excluded.lim_priority_support, past_due_since = excluded.past_due_since, period_months = excluded.period_months`,
    ev.version, ev.packageId, ev.status, ev.periodStart, ev.periodEnd, ev.aiCredits, ev.cancelledAt, now, l.maxMembers, l.campaigns ? 1 : 0, l.orderInChat ? 1 : 0, l.api ? 1 : 0, l.prioritySupport ? 1 : 0, ev.pastDueSince, ev.periodMonths,
  );
  if (!cur || ev.periodStart > cur.periodStart) {
    // A new period: what the last one granted and nobody used expires (purchased credits roll over), then the new grant lands.
    // (In a yearly period the grant still unused is the LATEST month's: expireGrant is pointed at it. For a monthly period that is the period start, as always.)
    if (cur) expireGrant(sql, { periodStart: lastGrantStart(sql, cur.periodStart), now });
    if (GRANTING.has(ev.status) && ev.aiCredits > 0) grantCredits(sql, { periodStart: ev.periodStart, packageId: ev.packageId, credits: ev.aiCredits, now }); // month 1 of the period
  } else if (ev.periodStart === cur.periodStart && GRANTING.has(ev.status) && ev.aiCredits > 0) {
    upgradeGrant(sql, { periodStart: lastGrantStart(sql, ev.periodStart), toPackage: ev.packageId, toCredits: ev.aiCredits, now }); // only the difference; a downgrade or repeat grants nothing
  }
  scheduleCreditMonth(sql, ev, now);
  scheduleExpiry(sql, ev.periodEnd);
  return 'applied';
}

/**
 * The `subscription_expire` task. Returns the time to try again when the period has not ended yet (a renewal moved it), else
 * null. A renewal that arrived before the task ran has a later `periodEnd`, so the task sees nothing to expire.
 */
export function expireSubscription(sql: Sql, now: number): number | null {
  const e = readEntitlement(sql);
  if (!e) return null;
  if (e.periodEnd > now) return e.periodEnd;
  if (e.status === 'active' || e.status === 'trialing' || e.status === 'past_due') {
    sql.exec("UPDATE entitlements SET status = 'expired', updated_at = ? WHERE id = 1", now);
    expireGrant(sql, { periodStart: lastGrantStart(sql, e.periodStart), now });
    sql.exec("DELETE FROM scheduled_tasks WHERE kind = 'credit_month' AND lease_until IS NULL");
  }
  return null;
}
