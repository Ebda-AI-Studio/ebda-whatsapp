/** Control-plane side of packages: reads D1 `workspace_subscriptions` and sends the matching events to workspaces. */
import type { Env } from '../../env';
import { outboundStoreEventSchema } from '../api/store-events';
import { storeLink } from '../store-link';
import { uuidFromKey } from '../store-link/orders';
import type { EntitlementEvent } from './entitlements';

type SubRow = { workspace_id: string; package_id: string; status: EntitlementEvent['status']; period_start: number; period_end: number; cancelled_at: number | null; version: number; ai_credits: number | null };

const toEvent = (r: SubRow): EntitlementEvent => ({
  version: r.version, packageId: r.package_id, status: r.status, periodStart: r.period_start, periodEnd: r.period_end, aiCredits: r.ai_credits ?? 0, cancelledAt: r.cancelled_at,
});

const SELECT = `SELECT s.workspace_id, s.package_id, s.status, s.period_start, s.period_end, s.cancelled_at, s.version, p.ai_credits
  FROM workspace_subscriptions s LEFT JOIN packages p ON p.id = s.package_id`;

/** Pushes one workspace's current subscription. Called after every change to its row; a failed push is repaired by the daily reconcile. */
export async function pushEntitlement(env: Env, workspaceId: string): Promise<'applied' | 'stale' | 'invalid' | 'none'> {
  const r = await env.DB.prepare(`${SELECT} WHERE s.workspace_id = ?`).bind(workspaceId).first<SubRow>();
  if (!r) return 'none';
  return env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId)).applyEntitlement(toEvent(r));
}

/**
 * Daily: re-sends every subscription as an event. The workspace ignores what it already has (versions only move forward), so this
 * is safe to repeat and heals a push that was lost; it never decides anything itself (no TTL on an entitlement).
 */
export async function reconcileEntitlements(env: Env): Promise<{ sent: number; applied: number; failed: number }> {
  const { results } = await env.DB.prepare(`${SELECT} ORDER BY s.workspace_id`).all<SubRow>();
  let applied = 0;
  let failed = 0;
  for (const r of results) {
    try {
      if ((await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(r.workspace_id)).applyEntitlement(toEvent(r))) === 'applied') applied++;
    } catch (err) {
      failed++;
      console.error(JSON.stringify({ alert: 'entitlement_push_failed', workspace: r.workspace_id, error: err instanceof Error ? err.name : 'error' }));
    }
  }
  return { sent: results.length, applied, failed };
}

export type SubscriptionSource = 'store_plan' | 'operator' | 'purchase';
export type SetSubscription = {
  workspaceId: string; packageId: string; status: EntitlementEvent['status']; periodStart: number; periodEnd: number; source: SubscriptionSource;
  /** What caused the write: the Store event id, the operator's user id or the order id. Goes to the audit row. */
  ref: string;
  reason?: string;
};

/**
 * The ONE writer of `workspace_subscriptions`. The version is bumped by the database in the same statement that writes the row (so two
 * writers racing can never get the same or a lower one), the audit row lands in the same batch, and only AFTER that commits does the
 * workspace get the push and the Store get `whatsapp.entitlement_changed`. A failed push is repaired by the daily reconcile; a failed
 * Store queue is reported (`eventQueued: false`) and logged, never undoing the write.
 */
export async function setSubscription(env: Env, a: SetSubscription, now = Date.now()): Promise<{ version: number; applied: boolean; eventQueued: boolean }> {
  const [upsert] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspace_subscriptions (workspace_id, package_id, status, period_start, period_end, cancelled_at, version, updated_at, source)
       VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?3 = 'cancelled' THEN ?6 END, 1, ?6, ?7)
       ON CONFLICT(workspace_id) DO UPDATE SET package_id = excluded.package_id, status = excluded.status, period_start = excluded.period_start, period_end = excluded.period_end,
         cancelled_at = excluded.cancelled_at, version = workspace_subscriptions.version + 1, updated_at = excluded.updated_at, source = excluded.source
       RETURNING version`,
    ).bind(a.workspaceId, a.packageId, a.status, a.periodStart, a.periodEnd, now, a.source),
    env.DB.prepare('INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) VALUES (?, ?, ?, ?, NULL, ?, ?)')
      .bind(now, a.source, 'subscription_set', a.workspaceId, JSON.stringify({ packageId: a.packageId, status: a.status, periodStart: a.periodStart, periodEnd: a.periodEnd, ...(a.reason ? { reason: a.reason } : {}) }), a.ref),
  ]);
  const version = (upsert!.results[0] as { version: number }).version;
  let applied = false;
  try {
    applied = (await pushEntitlement(env, a.workspaceId)) === 'applied';
  } catch (err) {
    console.error(JSON.stringify({ alert: 'entitlement_push_failed', workspace: a.workspaceId, error: err instanceof Error ? err.name : 'error' }));
  }
  let eventQueued = false;
  try {
    const sink = storeLink().events(env);
    if (sink) {
      await sink.send(outboundStoreEventSchema.parse({
        id: await uuidFromKey(`entitlement:${a.workspaceId}:${version}`), type: 'whatsapp.entitlement_changed', v: 1, storeId: a.workspaceId, occurredAt: new Date(now).toISOString(),
        data: { packageId: a.packageId, automation: a.status === 'trialing' || a.status === 'active', status: a.status, validUntil: new Date(a.periodEnd).toISOString(), version },
      }));
      eventQueued = true;
    }
  } catch (err) {
    console.error(JSON.stringify({ alert: 'entitlement_event_not_queued', workspace: a.workspaceId, version, error: err instanceof Error ? err.name : 'error' }));
  }
  return { version, applied, eventQueued };
}
