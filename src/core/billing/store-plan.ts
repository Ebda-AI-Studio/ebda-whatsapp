/**
 * Store plan -> the `store-included` package (the Store is one of three writers of a workspace's package, see docs/billing.md).
 * Runs in the Worker (the queue consumer) before the workspace records the event, because the package lives in D1.
 *
 * Guards: a replay of the last applied event id and an event whose `effectiveAt` is older than the last applied one do nothing;
 * a package that was bought or assigned by an operator is never overwritten or cancelled by the Store plan while it is running.
 */
import type { Env } from '../../env';
import type { StoreEvent } from '../api/store-events';
import { setSubscription } from './subscriptions';

export const STORE_INCLUDED = 'store-included';
const DEFAULT_PERIOD_MS = 31 * 86_400_000;
type PlanEvent = Extract<StoreEvent, { type: 'store.plan_changed' }>;
type Cur = { package_id: string; status: string; period_start: number; period_end: number; source: string | null };

export async function applyStorePlan(env: Env, event: PlanEvent, now = Date.now()): Promise<'applied' | 'ignored' | 'kept'> {
  const ws = event.storeId;
  const eff = Date.parse(event.data.effectiveAt);
  const last = await env.DB.prepare('SELECT effective_at, event_id FROM store_plan_applied WHERE workspace_id = ?').bind(ws).first<{ effective_at: number; event_id: string }>();
  if (last && (last.event_id === event.id || eff < last.effective_at)) return 'ignored';
  const cur = await env.DB.prepare('SELECT package_id, status, period_start, period_end, source FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<Cur>();
  const protectedPackage = cur && (cur.source === 'purchase' || cur.source === 'operator');
  let result: 'applied' | 'kept' = 'kept';
  if (event.data.includesWhatsApp) {
    const running = cur && (cur.status === 'active' || cur.status === 'trialing') && cur.period_end > now;
    if (!(protectedPackage && running)) {
      await setSubscription(env, {
        workspaceId: ws, packageId: STORE_INCLUDED, status: event.data.status ?? 'active', periodStart: eff,
        periodEnd: event.data.periodEnd ? Date.parse(event.data.periodEnd) : eff + DEFAULT_PERIOD_MS, source: 'store_plan', ref: event.id,
      }, now);
      result = 'applied';
    }
  } else if (cur && !protectedPackage && cur.status !== 'cancelled') {
    await setSubscription(env, { workspaceId: ws, packageId: cur.package_id, status: 'cancelled', periodStart: cur.period_start, periodEnd: cur.period_end, source: 'store_plan', ref: event.id }, now);
    result = 'applied';
  }
  await env.DB.prepare('INSERT INTO store_plan_applied (workspace_id, effective_at, event_id) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET effective_at = excluded.effective_at, event_id = excluded.event_id')
    .bind(ws, eff, event.id).run();
  return result;
}
