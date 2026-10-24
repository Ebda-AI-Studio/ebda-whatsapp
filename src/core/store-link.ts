/**
 * How this service reaches the commerce side. The core never imports a product addon, so the entry point registers
 * the concrete pieces once at start-up (`configureStoreLink`), and tests register fakes the same way.
 */
import type { Env } from '../env';
import type { OutboundStoreEvent } from './api/store-events';
import type { OrderingCopy } from './ordering/copy';
import type { StoreBridge } from './store-bridge';

/** Where outcomes for the Store are queued (the messaging-to-store queue); `send` may reject and the caller retries. */
export interface StoreEventSink {
  send(event: OutboundStoreEvent): Promise<void>;
}

export type StoreLinkConfig = {
  /** The bridge to the Store, or null when none is bound (the link is then simply off). */
  bridge: (env: Env) => StoreBridge | null;
  events: (env: Env) => StoreEventSink | null;
  /** Secret for the suite-wide customer key (same value in every product). */
  buyerSecret: (env: Env) => string | undefined;
  /** Customer-facing copy and template names; supplied by the product addon. */
  copy: OrderingCopy | null;
};

let current: StoreLinkConfig = { bridge: () => null, events: () => null, buyerSecret: (env) => env.SUITE_BUYER_KEY_SECRET, copy: null };

export function configureStoreLink(next: Partial<StoreLinkConfig>): StoreLinkConfig {
  const previous = current;
  current = { ...current, ...next };
  return previous;
}
export const storeLink = (): StoreLinkConfig => current;
export const bridgeFor = (env: Env): StoreBridge | null => current.bridge(env);
