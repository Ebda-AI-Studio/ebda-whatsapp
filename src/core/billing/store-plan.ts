/**
 * Store plan -> the `store-included` package (the Store is one of three writers of a workspace's package, see docs/billing.md).
 * Runs in the Worker (the queue consumer) before the workspace records the event, because the package lives in D1.
 *
 * Everything is decided in SQL inside ONE batch, so nothing can interleave between a decision and its write:
 *  - the event is CLAIMED first (`store_plan_applied`: only if its `effectiveAt` is not older than the last applied one and it is not the
 *    last applied event id). A replayed or older event claims nothing and writes nothing.
 *  - the package write happens only if the claim succeeded, and never replaces or cancels a purchased / operator package while it runs.
 * The marker also remembers what the Store plan says (`includes_whatsapp`, status, end), so a bought package that lapses falls back to it.
 */
import type { Env } from '../../env';
import type { StoreEvent } from '../api/store-events';
import { STORE_INCLUDED, cancelSubscription, setSubscription, type WriteOpts } from './subscriptions';

export { STORE_INCLUDED };
const DEFAULT_PERIOD_MS = 31 * 86_400_000;
type PlanEvent = Extract<StoreEvent, { type: 'store.plan_changed' }>;

export async function applyStorePlan(env: Env, event: PlanEvent, now = Date.now()): Promise<'applied' | 'ignored' | 'kept'> {
  const ws = event.storeId;
  const eff = Date.parse(event.data.effectiveAt);
  const status = event.data.status ?? 'active';
  const periodEnd = event.data.periodEnd ? Date.parse(event.data.periodEnd) : eff + DEFAULT_PERIOD_MS;
  const includes = event.data.includesWhatsApp;
  const claim = env.DB.prepare(
    `INSERT INTO store_plan_applied (workspace_id, effective_at, event_id, includes_whatsapp, status, period_end, claimed) VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(workspace_id) DO UPDATE SET effective_at = excluded.effective_at, event_id = excluded.event_id, includes_whatsapp = excluded.includes_whatsapp,
       status = excluded.status, period_end = excluded.period_end, claimed = 1
     WHERE excluded.effective_at >= store_plan_applied.effective_at AND store_plan_applied.event_id != excluded.event_id`,
  ).bind(ws, eff, event.id, includes ? 1 : 0, status, periodEnd);
  const release = env.DB.prepare('UPDATE store_plan_applied SET claimed = 0 WHERE workspace_id = ? AND event_id = ?').bind(ws, event.id);
  const claimed: WriteOpts['only'] = { sql: 'EXISTS (SELECT 1 FROM store_plan_applied WHERE workspace_id = ? AND event_id = ? AND claimed = 1)', binds: [ws, event.id] };
  // Not a package someone paid for or an operator set, unless that one has ended or is not running.
  const notProtected = { sql: "((workspace_subscriptions.source IS NOT NULL AND workspace_subscriptions.source NOT IN ('purchase', 'operator')) OR workspace_subscriptions.period_end <= ? OR workspace_subscriptions.status NOT IN ('active', 'trialing'))", binds: [now] };

  const r = includes
    ? await setSubscription(env, { workspaceId: ws, packageId: STORE_INCLUDED, status, periodStart: eff, periodEnd, source: 'store_plan', ref: event.id }, now, { before: [claim], after: [release], only: claimed, guard: notProtected })
    : await cancelSubscription(env, { workspaceId: ws, actor: 'store_plan', ref: event.id, takeSource: true }, now, {
      before: [claim], after: [release], only: claimed, guard: { sql: `workspace_subscriptions.status != 'cancelled' AND ${notProtected.sql}`, binds: notProtected.binds },
    });
  if (r.pre[0] === 0) return 'ignored';
  return r.written ? 'applied' : 'kept';
}
