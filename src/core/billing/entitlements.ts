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
import { expireGrant, grantCredits, upgradeGrant } from '../ai/credits';
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
});
export type EntitlementEvent = z.input<typeof entitlementEvent>;

export type Entitlement = {
  version: number; packageId: string; status: EntitlementStatus; periodStart: number; periodEnd: number; aiCredits: number; cancelledAt: number | null; updatedAt: number;
};

type Row = { version: number; package_id: string; status: EntitlementStatus; period_start: number; period_end: number; ai_credits: number; cancelled_at: number | null; updated_at: number };

export function readEntitlement(sql: Sql): Entitlement | null {
  const r = sql.exec<Row>('SELECT version, package_id, status, period_start, period_end, ai_credits, cancelled_at, updated_at FROM entitlements WHERE id = 1').toArray()[0];
  return r ? { version: r.version, packageId: r.package_id, status: r.status, periodStart: r.period_start, periodEnd: r.period_end, aiCredits: r.ai_credits, cancelledAt: r.cancelled_at, updatedAt: r.updated_at } : null;
}

/**
 * Marketing needs a plan on record that is not lapsed. No entitlement row = BLOCKED (fail closed: a plan gate is money state, and a
 * workspace the control plane has not pushed yet must not send paid marketing for free). Utility, authentication and service sends and
 * the inbox never consult this.
 */
export function marketingBlocked(sql: Sql): boolean {
  const e = readEntitlement(sql);
  return e === null || e.status === 'past_due' || e.status === 'cancelled' || e.status === 'expired';
}

const GRANTING: ReadonlySet<EntitlementStatus> = new Set(['trialing', 'active']);

/** Replaces the pending expiry task with one at `periodEnd`. */
function scheduleExpiry(sql: Sql, periodEnd: number): void {
  sql.exec("DELETE FROM scheduled_tasks WHERE kind = 'subscription_expire' AND lease_until IS NULL");
  addTask(sql, 'subscription_expire', periodEnd);
}

/** Applies one event inside the caller's transaction. */
export function applyEntitlement(sql: Sql, raw: EntitlementEvent, now: number): 'applied' | 'stale' | 'invalid' {
  const parsed = entitlementEvent.safeParse(raw);
  if (!parsed.success) return 'invalid';
  const ev = parsed.data;
  const cur = readEntitlement(sql);
  if (cur && ev.version <= cur.version) return 'stale';
  sql.exec(
    `INSERT INTO entitlements (id, version, package_id, status, period_start, period_end, ai_credits, cancelled_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version, package_id = excluded.package_id, status = excluded.status, period_start = excluded.period_start,
       period_end = excluded.period_end, ai_credits = excluded.ai_credits, cancelled_at = excluded.cancelled_at, updated_at = excluded.updated_at`,
    ev.version, ev.packageId, ev.status, ev.periodStart, ev.periodEnd, ev.aiCredits, ev.cancelledAt, now,
  );
  if (!cur || ev.periodStart > cur.periodStart) {
    // A new period: what the last one granted and nobody used expires (purchased credits roll over), then the new grant lands.
    if (cur) expireGrant(sql, { periodStart: cur.periodStart, now });
    if (GRANTING.has(ev.status) && ev.aiCredits > 0) grantCredits(sql, { periodStart: ev.periodStart, packageId: ev.packageId, credits: ev.aiCredits, now });
  } else if (ev.periodStart === cur.periodStart && GRANTING.has(ev.status) && ev.aiCredits > 0) {
    upgradeGrant(sql, { periodStart: ev.periodStart, toPackage: ev.packageId, toCredits: ev.aiCredits, now }); // only the difference; a downgrade or repeat grants nothing
  }
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
    expireGrant(sql, { periodStart: e.periodStart, now });
  }
  return null;
}
