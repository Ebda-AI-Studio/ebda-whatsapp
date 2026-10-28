import type { Env } from '../env';
import { parseStoreEvent } from './api/store-events';
import { recordWorkspaceOwner } from './campaigns/new-cap';
import { applyStorePlan } from './billing/store-plan';
import { errClass, alert } from './observability';
import { senderNumberFor } from './shared/shared-number';

const MAX_RETRY_DELAY_S = 300;
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
      console.log(JSON.stringify({ audit: 'store_event', type: event.type, storeId: event.storeId, status: result.status, ...(result.detail ? { detail: result.detail } : {}) }));
      if (result.status === 'retry') msg.retry({ delaySeconds: retryDelay(msg.attempts) });
      else msg.ack();
    } catch (err) {
      alert('store_event_failed', { type: event.type, storeId: event.storeId, attempts: msg.attempts, error: errClass(err) });
      msg.retry({ delaySeconds: retryDelay(msg.attempts) });
    }
  }
}
