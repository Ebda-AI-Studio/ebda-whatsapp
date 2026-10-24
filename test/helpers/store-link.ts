import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { afterEach, beforeEach, vi } from 'vitest';
import { EBDA_DEFAULT_TEMPLATES } from '../../src/addons/ebda/templates';
import { EBDA_ORDERING_COPY } from '../../src/addons/ebda/store-copy';
import type { OutboundStoreEvent } from '../../src/core/api/store-events';
import { configureStoreLink, type StoreEventSink, type StoreLinkConfig } from '../../src/core/store-link';
import type { SendJob } from '../../src/core/send-queue';
import worker from '../../src/index';
import { FakeStore } from './fake-store';
import { exec, seedNumber, workspace } from './workspace';

export const BUYER_SECRET = 'ebda-suite-buyer-key-test-v1';
/** HMAC of +201001234567 under BUYER_SECRET (the pinned vector of the integration contract). */
export const BUYER_KEY_1 = 'e8771d4105457e95d06a8589827d6c09043f73bb1750f2ef525bccbc22d67edd';
export const PHONE_1 = '+201001234567';
export const WA_1 = '201001234567';

/** A sink that records what would go to the Store queue. */
export class RecordingSink implements StoreEventSink {
  readonly sent: OutboundStoreEvent[] = [];
  failNext = 0;
  async send(event: OutboundStoreEvent): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('queue down');
    }
    this.sent.push(event);
  }
}

/** Registers the fake Store (and a recording sink) for each test in the file; restores the previous wiring afterwards. */
export function useStoreLink(make: () => FakeStore = () => new FakeStore('*')) {
  const ctx = { fake: undefined as unknown as FakeStore, sink: new RecordingSink() };
  let previous: StoreLinkConfig | undefined;
  beforeEach(() => {
    ctx.fake = make();
    ctx.sink = new RecordingSink();
    previous = configureStoreLink({ bridge: () => ctx.fake, events: () => ctx.sink, buyerSecret: () => BUYER_SECRET, proof: () => ({ secret: 'proof-test-secret', baseUrl: 'https://wa.test' }) });
  });
  afterEach(() => {
    if (previous) configureStoreLink(previous);
  });
  return ctx;
}

/** A workspace with an active number and the Ebda default templates approved (OTP included). */
export async function storeWorkspace(ws: string, opts: { templates?: boolean } = {}): Promise<string> {
  const pn = `pn-${ws}`;
  await seedNumber(pn, ws).catch(() => {});
  if (opts.templates !== false) {
    for (const t of EBDA_DEFAULT_TEMPLATES) {
      await exec(ws, "INSERT OR REPLACE INTO templates (name, language, category, status, components, updated_at) VALUES (?, ?, ?, 'APPROVED', ?, 1)", t.name, t.language, t.category, JSON.stringify(t.components));
    }
  }
  return pn;
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();
export { iso };

export function storeEvent(storeId: string, type: string, data: Record<string, unknown>, extra: { id?: string; occurredAt?: string } = {}) {
  return { id: extra.id ?? crypto.randomUUID(), type, v: 1, storeId, occurredAt: extra.occurredAt ?? iso(), data };
}

/** Delivers events through the real queue consumer (`ebda-wa-events`). */
export async function deliver(events: unknown[], attempts = 1) {
  const batch = createMessageBatch('ebda-wa-events', events.map((body, i) => ({ id: `e${i}`, timestamp: new Date(), attempts, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

export const sentJobs = (): SendJob[] => vi.mocked(env.SEND_QUEUE.sendBatch).mock.calls.flatMap((c) => (c[0] as { body: SendJob }[]).map((m) => m.body));

/** Runs the workspace's due tasks (the hand-over of stored messages to the send queue) and returns what was queued. */
export async function flush(ws: string): Promise<SendJob[]> {
  await workspace(ws).runDueTasks();
  return sentJobs();
}

export const COPY = EBDA_ORDERING_COPY;
