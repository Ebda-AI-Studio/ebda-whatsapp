/**
 * How this service reaches the commerce side. The core never imports a product addon, so the entry point registers
 * the concrete pieces once at start-up (`configureStoreLink`), and tests register fakes the same way.
 */
import type { Env } from '../env';
import { isStandaloneId } from './workspace-kind';
import type { OutboundStoreEvent } from './api/store-events';
import type { OrderingCopy } from './ordering/copy';
import { DEFAULT_OTP_POLICY, type OtpPolicy } from './otp-policy';
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
  /** Where payment screenshots are served from, and the key that signs those links; null = not configured. */
  proof: (env: Env) => { secret: string; baseUrl: string } | null;
  /** Limits for one-time codes over WhatsApp. */
  otp: OtpPolicy;
  /** Customer-facing copy and template names; supplied by the product addon. */
  copy: OrderingCopy | null;
};

let current: StoreLinkConfig = { bridge: () => null, events: () => null, buyerSecret: (env) => env.SUITE_BUYER_KEY_SECRET, proof: (env) => (env.PROOF_URL_SECRET && env.PUBLIC_BASE_URL ? { secret: env.PROOF_URL_SECRET, baseUrl: env.PUBLIC_BASE_URL.replace(/\/$/, '') } : null), otp: DEFAULT_OTP_POLICY, copy: null };

export function configureStoreLink(next: Partial<StoreLinkConfig>): StoreLinkConfig {
  const previous = current;
  current = { ...current, ...next };
  return previous;
}
export const storeLink = (): StoreLinkConfig => current;
export const bridgeFor = (env: Env): StoreBridge | null => current.bridge(env);
/**
 * CHAT-SA-2: the Store bridge is per DEPLOY, not per workspace, so every call that acts for a workspace goes through here. A standalone (`sw_`) workspace has no Store: always null,
 * which switches every store-coupled feature off by construction. `bridgeFor` stays only for code with no workspace in scope (the Store-event consumer, UUID-only).
 */
export const bridgeForWorkspace = (env: Env, workspaceId: string): StoreBridge | null => (isStandaloneId(workspaceId) ? null : bridgeFor(env));
