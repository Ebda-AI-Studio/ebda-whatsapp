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
import type { WalletDto } from '../api/contract';
import type { StoreEvent } from '../api/store-events';
import { alert } from '../observability';
import { isStandaloneId } from '../workspace-kind';
import { chatPackageName } from './package-names';
import { storePlanNames } from './store-plan-names';
import { STORE_INCLUDED, cancelSubscription, setSubscription, type WriteOpts } from './subscriptions';

export { STORE_INCLUDED };
type PlanEvent = Extract<StoreEvent, { type: 'store.plan_changed' }>;

export async function applyStorePlan(env: Env, event: PlanEvent, now = Date.now()): Promise<'applied' | 'ignored' | 'kept'> {
  const ws = event.storeId;
  if (isStandaloneId(ws)) { alert('standalone_store_plan_event', { workspace: ws }); return 'ignored'; } // CHAT-SA-6: a Store plan can never write to a standalone workspace
  const eff = Date.parse(event.data.effectiveAt);
  const includes = event.data.includesWhatsApp;
  // D3: access is never GRANTED on a guess. The contract keeps `status` and `periodEnd` optional so an old Store event still parses, but an event
  // that says "includes WhatsApp" without saying for how long and in what state grants nothing (no default to active, no invented period) and pages
  // a human: the Store must send both. A cancellation needs neither (removing access is always safe).
  if (includes && (event.data.status === undefined || event.data.periodEnd === undefined)) {
    alert('store_plan_incomplete', { workspace: ws, missing: [event.data.status === undefined ? 'status' : null, event.data.periodEnd === undefined ? 'periodEnd' : null].filter(Boolean) });
    return 'ignored';
  }
  const status = event.data.status ?? 'cancelled';
  const periodEnd = event.data.periodEnd ? Date.parse(event.data.periodEnd) : eff;
  // Contract v1.4: `pastDueSince` (ISO, only while past_due). Without it the first past_due we see is "now" (setSubscription).
  const rawSince = event.data.pastDueSince;
  const since = status === 'past_due' && rawSince ? Date.parse(rawSince) : NaN;
  const pastDueSince = Number.isFinite(since) && since > 0 && since <= now ? since : undefined;
  // C12 / wa#117: the grant is keyed on the STORE billing period, not on the event. A store-included row that already covers the same Store period
  // (same `periodEnd`) keeps its period start, so a past_due -> active flip, a failed charge then a paid retry, or a repeat of the same state inside one
  // Store period never starts a new period (which would expire the old grant and grant 100 fresh credits). A renewal moves `periodEnd`: a new period.
  const samePeriod = includes
    ? await env.DB.prepare("SELECT period_start FROM workspace_subscriptions WHERE workspace_id = ? AND package_id = ? AND source = 'store_plan' AND period_end = ?").bind(ws, STORE_INCLUDED, periodEnd).first<{ period_start: number }>()
    : null;
  const periodStart = samePeriod ? Math.min(samePeriod.period_start, eff) : eff;
  const claim = env.DB.prepare(
    `INSERT INTO store_plan_applied (workspace_id, effective_at, event_id, includes_whatsapp, status, period_end, claimed, plan_code) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET effective_at = excluded.effective_at, event_id = excluded.event_id, includes_whatsapp = excluded.includes_whatsapp,
       status = excluded.status, period_end = excluded.period_end, claimed = 1, plan_code = excluded.plan_code
     WHERE excluded.effective_at >= store_plan_applied.effective_at AND store_plan_applied.event_id != excluded.event_id`,
  ).bind(ws, eff, event.id, includes ? 1 : 0, status, periodEnd, event.data.planCode);
  const release = env.DB.prepare('UPDATE store_plan_applied SET claimed = 0 WHERE workspace_id = ? AND event_id = ?').bind(ws, event.id);
  const claimed: WriteOpts['only'] = { sql: 'EXISTS (SELECT 1 FROM store_plan_applied WHERE workspace_id = ? AND event_id = ? AND claimed = 1)', binds: [ws, event.id] };
  // Not a package someone paid for or an operator set, unless that one has ended or is not running.
  const notProtected = { sql: "((workspace_subscriptions.source IS NOT NULL AND workspace_subscriptions.source NOT IN ('purchase', 'operator')) OR workspace_subscriptions.period_end <= ? OR workspace_subscriptions.status NOT IN ('active', 'trialing'))", binds: [now] };

  const r = includes
    ? await setSubscription(env, { workspaceId: ws, packageId: STORE_INCLUDED, status, periodStart, periodEnd, source: 'store_plan', ref: event.id, ...(pastDueSince !== undefined ? { pastDueSince } : {}) }, now, { before: [claim], after: [release], only: claimed, guard: notProtected })
    : await cancelSubscription(env, { workspaceId: ws, actor: 'store_plan', ref: event.id, takeSource: true }, now, {
      before: [claim], after: [release], only: claimed, guard: { sql: `workspace_subscriptions.status != 'cancelled' AND ${notProtected.sql}`, binds: notProtected.binds },
    });
  if (r.pre[0] === 0) return 'ignored';
  return r.written ? 'applied' : 'kept';
}

/**
 * CHAT-QA-13: name the running plan the way the merchant knows it. The package the Store plan includes is the Store plan (its own name, from the code kept with the applied event);
 * any other package was bought in Chat and carries its Chat package name. Tenant-scoped: both reads are keyed by this workspace / this package.
 */
export async function namePlan(env: Env, workspaceId: string, plan: WalletDto['plan']): Promise<WalletDto['plan']> {
  if (!plan) return plan;
  if (plan.packageId === STORE_INCLUDED) {
    const row = await env.DB.prepare('SELECT plan_code FROM store_plan_applied WHERE workspace_id = ?').bind(workspaceId).first<{ plan_code: string | null }>();
    return row?.plan_code ? { ...plan, storePlan: storePlanNames(row.plan_code) } : plan;
  }
  const row = await env.DB.prepare('SELECT ai_credits, period_months FROM packages WHERE id = ?').bind(plan.packageId).first<{ ai_credits: number; period_months: number }>();
  if (!row) return plan;
  const n = chatPackageName(row.ai_credits, row.period_months);
  return { ...plan, packageName: n.nameEn, packageNameAr: n.nameAr };
}
