import type { Env } from '../env';
import { parseStoreEvent } from './api/store-events';
import { recordWorkspaceOwner } from './campaigns/new-cap';
import { applyStorePlan } from './billing/store-plan';
import { errClass, alert } from './observability';
import { ensureCodV2 } from './cod-v2';
import { syncSuspendedMirror } from './ops/suspension-mirror';
import { senderNumberFor } from './shared/shared-number';
import { bridgeFor } from './store-link';
import { ensureWorkspace } from './workspace-registry';

const MAX_RETRY_DELAY_S = 300;
/** STORE-STANDING-1: the Store's standing events (suspend / reactivate / delete). */
const STANDING: ReadonlySet<string> = new Set(['store.suspended', 'store.reactivated', 'store.deleted']);

/**
 * The Worker's copy of the hold (D1 `workspaces.suspended_*`), DERIVED from the workspace's flags by the one shared helper (`syncSuspendedMirror`): a Store release clears
 * only the Store tag, and the operator's suspension or a wallet debt hold that is still on keeps D1 suspended with its own reason. `reason` is the hold the caller read;
 * the helper reads the full state itself.
 */
export async function mirrorStoreHold(env: Env, workspaceId: string, _reason: 'store_suspended' | 'store_deleted' | null, now: number): Promise<void> {
  await syncSuspendedMirror(env.DB, workspaceId, await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId)).suspensionState(), now);
}
/** A store whose events race ahead of its registration is retried this many deliveries; then the event is acknowledged (the store never enabled Chat). */
const UNKNOWN_WORKSPACE_ATTEMPTS = 4;

/**
 * CHAT-ENABLE-1: registers the store named by a `store.linked` event, but only if the Store confirms (live, through the bridge) that `ownerUserId` is the OWNER of exactly that
 * store. `retry` = the Store could not answer (fail closed, never register on a guess); `refused` = the Store says that user is not the owner (or there is no Store link to ask),
 * acknowledged and logged. Another store's id or an operator's account cannot register a store they do not own.
 */
async function registerLinkedStore(env: Env, storeId: string, ownerUserId: string): Promise<'registered' | 'retry' | 'refused'> {
  const bridge = bridgeFor(env);
  if (!bridge) {
    console.warn(JSON.stringify({ warn: 'store_linked_no_store_link', storeId }));
    return 'refused';
  }
  const role = await bridge.memberRole(storeId, ownerUserId);
  if (!role.ok) return 'retry';
  if (role.value.role !== 'owner') {
    console.warn(JSON.stringify({ warn: 'store_linked_owner_not_confirmed', storeId }));
    return 'refused';
  }
  const profile = await bridge.getStoreProfile(storeId); // the display name only: a failure never blocks the registration
  await ensureWorkspace(env, { storeId, ownerUserId, name: profile.ok ? profile.value.name : null });
  return 'registered';
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
      // The workspace id is the store id. Ruling CHAT-ENABLE-1: a workspace is registered ONLY by the owner's own "connect Ebda Chat" action in Store admin, which is what emits
      // `store.linked` (its owner/admin check and plan entitlement happen there). That event registers the store here, after the Store confirms the owner; no other event does.
      let known = await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(event.storeId).first();
      if (!known && event.type === 'store.linked') {
        const reg = await registerLinkedStore(env, event.storeId, event.data.ownerUserId);
        if (reg === 'retry') { msg.retry({ delaySeconds: retryDelay(msg.attempts) }); continue; }
        if (reg === 'refused') { msg.ack(); continue; }
        known = { registered: 1 };
      }
      if (!known && STANDING.has(event.type)) {
        msg.ack(); // nothing here can spend for a store it never registered (and a deleted store never registers): no retry, no DLQ
        continue;
      }
      if (!known) {
        // A store that never enabled Chat: its events are NOT dead-lettered. A few short retries cover `store.plan_changed` racing just behind the `store.linked` that registers the
        // store; after that the event is acknowledged and logged (no queue churn for stores that never opted in).
        if (msg.attempts < UNKNOWN_WORKSPACE_ATTEMPTS) {
          console.warn(JSON.stringify({ warn: 'store_event_unknown_workspace', type: event.type, storeId: event.storeId, attempts: msg.attempts }));
          msg.retry({ delaySeconds: retryDelay(msg.attempts) });
        } else {
          console.warn(JSON.stringify({ warn: 'store_event_dropped_not_enabled', type: event.type, storeId: event.storeId }));
          msg.ack();
        }
        continue;
      }
      // The package lives in D1: a plan change is applied here, before the workspace records the event, so a failure is retried with it.
      if (event.type === 'store.plan_changed' || event.type === 'store.linked') await recordWorkspaceOwner(env, event.storeId, event.data.ownerUserId, Date.now()); // who owns the store: the new-workspace campaign cap is per owner
      if (event.type === 'store.plan_changed') await applyStorePlan(env, event);
      // Own number, else the shared platform number for a member (transactional events carry their order ref there).
      const number = await senderNumberFor(env, event.storeId);
      const result = await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(event.storeId)).applyStoreEvent(event, { phoneNumberId: number?.phoneNumberId ?? null, shared: number?.shared ?? false });
      // The Worker's copy of the hold (D1 `workspaces.suspended_*`, what the API middleware reads) is written from the workspace's CURRENT hold, not
      // from the event, on EVERY delivery (applied, duplicate or stale): a retry after a failed D1 save finds the event already recorded in the
      // workspace (`duplicate`) and still re-attempts the save, and a stale event re-asserts the newer state. Awaited: a failure retries the event.
      if (STANDING.has(event.type)) {
        const held = await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(event.storeId)).storeHold();
        await mirrorStoreHold(env, event.storeId, held === null ? null : held === 'store_deleted' ? 'store_deleted' : 'store_suspended', Date.now());
      }
      console.log(JSON.stringify({ audit: 'store_event', type: event.type, storeId: event.storeId, status: result.status, ...(result.detail ? { detail: result.detail } : {}) }));
      // A store that told us where it shops gets its COD v2 template submitted (idempotent; never blocks or fails the event).
      if (event.type === 'store.linked' && event.data.storefrontOrigin && result.status === 'applied') await ensureCodV2(env, event.storeId);
      if (result.status === 'retry') msg.retry({ delaySeconds: retryDelay(msg.attempts) });
      else msg.ack();
    } catch (err) {
      alert('store_event_failed', { type: event.type, storeId: event.storeId, attempts: msg.attempts, error: errClass(err) });
      msg.retry({ delaySeconds: retryDelay(msg.attempts) });
    }
  }
}
