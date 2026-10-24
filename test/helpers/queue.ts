import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import worker from '../../src/index';
import type { SendJob } from '../../src/core/send-queue';

/** Drives the send-queue consumer directly with the given jobs. */
export async function consume(jobs: SendJob[], attempts = 1) {
  const batch = createMessageBatch<SendJob>('ebda-wa-send', jobs.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}
