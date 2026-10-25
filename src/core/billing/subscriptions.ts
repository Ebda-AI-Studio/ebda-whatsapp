/** Control-plane side of packages: reads D1 `workspace_subscriptions` and sends the matching events to workspaces. */
import type { Env } from '../../env';
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
