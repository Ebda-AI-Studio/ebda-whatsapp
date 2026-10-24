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
import { workspaceForPhoneNumber } from './routing';
import { STALE_CLAIM_MS } from './workspace-do';

const MAX_RETRY_DELAY_S = 300;
/** Must match max_retries in wrangler.jsonc: the last attempt marks the message failed instead of leaving it in 'retry'. */
export const MAX_SEND_ATTEMPTS = 5;

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
    // Only send from a number this workspace still owns and that is active.
    if ((await workspaceForPhoneNumber(env.DB, job.phoneNumberId)) !== job.workspaceId) {
      console.warn('send queue: sender number not owned by workspace or inactive; dropped');
      msg.ack();
      continue;
    }
    const ws = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(job.workspaceId));
    const claim = await ws.claimSend(job);
    if (claim === 'already_sent') {
      msg.ack();
      continue;
    }
    if (claim === 'in_flight') {
      // Another attempt holds the claim (or died holding it): come back after it goes stale, never ack it away.
      msg.retry({ delaySeconds: STALE_CLAIM_MS / 1000 + 10 });
      continue;
    }
    const sent = await sendText({ token: env.META_SYSTEM_TOKEN, graphVersion: env.META_GRAPH_VERSION, phoneNumberId: job.phoneNumberId, to: job.to, text: job.text });
    const lastAttempt = msg.attempts >= MAX_SEND_ATTEMPTS;
    const result = !sent.ok && sent.retryable && lastAttempt ? { ...sent, retryable: false } : sent;
    await ws.recordOutbound(job.idempotencyKey, result);
    if (result.ok) mark(env, 'meta_accepted', job.inboundAt ? Date.now() - job.inboundAt : 0, job.receivedAt ? Date.now() - job.receivedAt : 0, job.workspaceId);
    if (!result.ok && result.retryable) msg.retry({ delaySeconds: Math.min(MAX_RETRY_DELAY_S, 5 * 2 ** (msg.attempts - 1)) });
    else msg.ack();
  }
}
