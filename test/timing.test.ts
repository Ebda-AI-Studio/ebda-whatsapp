import { SELF, createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { SendJob } from '../src/core/send-queue';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { inboundPayload } from './helpers/payload';
import { seedNumber } from './helpers/workspace';

function stages(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => (c[0] as AnalyticsEngineDataPoint).blobs![0] as string).filter((b) => !b.startsWith('funnel.') && b !== 'ai_turn'); // pipeline stages only; funnel and AI-turn points are tested in funnel.test.ts
}

it('writes one data point per stage for one inbound text', async () => {
  await seedNumber('pn-t', 'ws-t');
  const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
  await postWebhook(SELF, inboundPayload('pn-t', [{ id: 'wamid.t1', text: 'hi', ts: Math.floor(Date.now() / 1000) }]));
  expect(stages(ae)).toEqual(['do_stored', 'enqueued', 'webhook_ack']);
  const point = ae.mock.calls.map((c) => c[0] as AnalyticsEngineDataPoint).find((x) => x.blobs![0] === 'do_stored')!;
  expect(point.blobs).toEqual(['do_stored', 'ws-t']);
  expect(point.indexes).toEqual(['do_stored']);
  expect(point.doubles).toHaveLength(2);

  const sent = [...vi.mocked(env.SEND_QUEUE.sendBatch).mock.calls[0]![0]];
  const job = sent[0]!.body as SendJob;
  expect(job.receivedAt).toBeTypeOf('number');
  const graph = stubGraph();
  ae.mockClear();
  const batch = createMessageBatch<SendJob>('ebda-wa-send', [{ id: 'm0', timestamp: new Date(), attempts: 1, body: job }]);
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  await getQueueResult(batch, ctx);
  expect(stages(ae)).toEqual(['meta_accepted']);
  expect((ae.mock.calls[0]![0] as AnalyticsEngineDataPoint).doubles![1]).toBeGreaterThanOrEqual(0);
  graph.restore();
});

it('counts an unrouted webhook', async () => {
  const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
  await postWebhook(SELF, inboundPayload('pn-unrouted', [{ id: 'wamid.u1' }]));
  expect(stages(ae)).toEqual(['unrouted', 'webhook_ack']);
});
