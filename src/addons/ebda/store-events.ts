import type { Env } from '../../env';
import type { OutboundStoreEvent } from '../../core/api/store-events';
import type { StoreEventSink } from '../../core/store-link';

/** The Store's event queue (`ebda-store-events`), or null when it is not bound. */
export function createStoreEventSink(env: Pick<Env, 'STORE_EVENTS'>): StoreEventSink | null {
  const queue = env.STORE_EVENTS;
  if (!queue) return null;
  return { send: async (event: OutboundStoreEvent) => { await queue.send(event, { contentType: 'json' }); } };
}
