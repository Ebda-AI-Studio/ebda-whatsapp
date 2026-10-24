import { z } from 'zod';

export const sendJobSchema = z.object({
  workspaceId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  to: z.string().min(1),
  text: z.string().min(1).max(4096),
  idempotencyKey: z.string().min(1),
  inboundAt: z.number().optional(),
  receivedAt: z.number().optional(),
});
export type SendJob = z.infer<typeof sendJobSchema>;

import { sendText } from './meta/client';
import type { Env } from '../env';
import { mark } from './timing';

const MAX_RETRY_DELAY_S = 300;

/** Queue consumer: claim → send → record. Only a 'claimed' job reaches Meta, so redelivery never double-sends. */
export async function consumeSendBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = sendJobSchema.safeParse(msg.body);
    if (!parsed.success) {
      console.warn('send queue: invalid job dropped');
      msg.ack();
      continue;
    }
    const job = parsed.data;
    const ws = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(job.workspaceId));
    if ((await ws.claimSend(job)) !== 'claimed') {
      msg.ack();
      continue;
    }
    const result = await sendText({ token: env.META_SYSTEM_TOKEN, graphVersion: env.META_GRAPH_VERSION, phoneNumberId: job.phoneNumberId, to: job.to, text: job.text });
    await ws.recordOutbound(job.idempotencyKey, result);
    if (result.ok) mark(env, 'meta_accepted', job.inboundAt ? Date.now() - job.inboundAt : 0, job.receivedAt ? Date.now() - job.receivedAt : 0, job.workspaceId);
    if (!result.ok && result.retryable) msg.retry({ delaySeconds: Math.min(MAX_RETRY_DELAY_S, 5 * 2 ** (msg.attempts - 1)) });
    else msg.ack();
  }
}
