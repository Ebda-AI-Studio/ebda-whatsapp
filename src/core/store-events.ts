import type { Env } from '../env';
import { parseStoreEvent } from './api/store-events';
import { recordWorkspaceOwner } from './campaigns/new-cap';
import { applyStorePlan } from './billing/store-plan';
import { errClass, alert } from './observability';
import { senderNumberFor } from './shared/shared-number';

const MAX_RETRY_DELAY_S = 300;
/** STORE-STANDING-1: the Store's standing events (suspend / reactivate / delete). */
const STANDING: ReadonlySet<string> = new Set(['store.suspended', 'store.reactivated', 'store.deleted']);

/**
 * Writes the Store hold into D1 next to the operator's suspension, reusing `suspended_at` with a tagged `suspended_reason` (as offboarding does):
 * a hold never overwrites another reason, and a release clears only a `store_*` reason. When the operator suspension is still on in the
 * workspace (its own flag), the release leaves D1 suspended with reason `operator`.
 */
export async function mirrorStoreHold(env: Env, workspaceId: string, reason: 'store_suspended' | 'store_deleted' | null, now: number): Promise<void> {
  if (reason) {
    await env.DB.prepare("UPDATE workspaces SET suspended_at = coalesce(suspended_at, ?), suspended_reason = CASE WHEN suspended_reason IS NULL OR suspended_reason IN ('store_suspended', 'store_deleted') THEN ? ELSE suspended_reason END WHERE id = ?").bind(now, reason, workspaceId).run();
    return;
  }
  await env.DB.prepare("UPDATE workspaces SET suspended_at = NULL, suspended_reason = NULL WHERE id = ? AND suspended_reason IN ('store_suspended', 'store_deleted')").bind(workspaceId).run();
  if (await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId)).suspended()) {
    await env.DB.prepare("UPDATE workspaces SET suspended_at = coalesce(suspended_at, ?), suspended_reason = coalesce(suspended_reason, 'operator') WHERE id = ?").bind(now, workspaceId).run();
  }
}
const retryDelay = (attempts: number) => Math.min(MAX_RETRY_DELAY_S, 5 * 2 ** Math.max(0, attempts - 1));

/**
 * Queue consumer for the Store's events. The envelope id is the idempotency key (the workspace dedupes on it), so a
 * redelivered batch is harmless. Unknown types and versions are acknowledged and logged: a newer Store must not be able
 * to wedge this queue. Nothing here logs a phone number or a message body.
 */
export async function consumeStoreEvents(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = parseStoreEvent(msg.body);
    if (!parsed.ok) {
      console.warn(JSON.stringify({ warn: 'store_event_dropped', reason: parsed.reason }));
      msg.ack();
      continue;
    }
    const event = parsed.event;
    try {
      // The workspace id is the store id. A workspace that is not registered (yet) is retried: the
      // store may emit `store.linked` moments before onboarding registers it; the DLQ catches the ones that never appear.
      const known = await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(event.storeId).first();
      if (!known && STANDING.has(event.type)) {
        msg.ack(); // nothing here can spend for a store it never registered (and a deleted store never registers): no retry, no DLQ
        continue;
      }
      if (!known) {
        console.warn(JSON.stringify({ warn: 'store_event_unknown_workspace', type: event.type, storeId: event.storeId }));
        msg.retry({ delaySeconds: retryDelay(msg.attempts) });
        continue;
      }
      // The package lives in D1: a plan change is applied here, before the workspace records the event, so a failure is retried with it.
      if (event.type === 'store.plan_changed' || event.type === 'store.linked') await recordWorkspaceOwner(env, event.storeId, event.data.ownerUserId, Date.now()); // who owns the store: the new-workspace campaign cap is per owner
      if (event.type === 'store.plan_changed') await applyStorePlan(env, event);
      // Own number, else the shared platform number for a member (transactional events carry their order ref there).
      const number = await senderNumberFor(env, event.storeId);
      const result = await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(event.storeId)).applyStoreEvent(event, { phoneNumberId: number?.phoneNumberId ?? null, shared: number?.shared ?? false });
      // The Worker's copy of the hold (D1 `workspaces.suspended_*`, what the API middleware reads) follows the workspace's decision, so an
      // out-of-order event the workspace dropped as stale never moves it. Awaited: a failure retries the event (the workspace dedupes it).
      if (result.status === 'applied' && STANDING.has(event.type)) await mirrorStoreHold(env, event.storeId, event.type === 'store.reactivated' ? null : event.type === 'store.deleted' ? 'store_deleted' : 'store_suspended', Date.now());
      console.log(JSON.stringify({ audit: 'store_event', type: event.type, storeId: event.storeId, status: result.status, ...(result.detail ? { detail: result.detail } : {}) }));
      if (result.status === 'retry') msg.retry({ delaySeconds: retryDelay(msg.attempts) });
      else msg.ack();
    } catch (err) {
      alert('store_event_failed', { type: event.type, storeId: event.storeId, attempts: msg.attempts, error: errClass(err) });
      msg.retry({ delaySeconds: retryDelay(msg.attempts) });
    }
  }
}
