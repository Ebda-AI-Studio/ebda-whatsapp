import { z } from 'zod';

const link = z.object({ link: z.string() });
const templateComponentSchema = z.object({
  type: z.enum(['header', 'body', 'button']),
  sub_type: z.string().optional(),
  index: z.string().optional(),
  parameters: z.array(z.object({ type: z.string(), text: z.string().optional(), image: link.optional(), video: link.optional(), document: link.optional(), payload: z.string().max(256).optional() })),
});
const mediaKind = z.enum(['image', 'audio', 'video', 'document']);
export const sendJobSchema = z.object({
  workspaceId: z.string().min(1),
  phoneNumberId: z.string().min(1),
  to: z.string().min(1),
  /** Absent = text (the Phase 1 reply jobs). */
  kind: z.enum(['text', 'template', 'interactive', 'media', 'list', 'image_link']).optional(),
  text: z.string().min(1).max(4096).optional(),
  template: z.object({ name: z.string().min(1), language: z.string().min(2), components: z.array(templateComponentSchema) }).optional(),
  interactive: z.object({ body: z.string().min(1).max(1024), buttons: z.array(z.object({ id: z.string().min(1), title: z.string().min(1) })).min(1).max(3) }).optional(),
  list: z.object({
    body: z.string().min(1).max(1024),
    button: z.string().min(1).max(20),
    rows: z.array(z.object({ id: z.string().min(1).max(200), title: z.string().min(1).max(24), description: z.string().max(72).optional() })).min(1).max(10),
    footer: z.string().max(60).optional(),
  }).optional(),
  imageLink: z.object({ link: z.string().regex(/^https:\/\/[^\s]+$/).max(2000), caption: z.string().max(1024).optional() }).optional(),
  media: z.object({ kind: mediaKind, mediaId: z.string().min(1), caption: z.string().max(1024).optional(), filename: z.string().max(255).optional() }).optional(),
  idempotencyKey: z.string().min(1),
  inboundAt: z.number().optional(),
  receivedAt: z.number().optional(),
  /** How many times Meta's marketing frequency cap (131049) already pushed this job back 24 h. */
  deferrals: z.number().int().nonnegative().optional(),
}).superRefine((j, ctx) => {
  const kind = j.kind ?? 'text';
  const have = { text: j.text, template: j.template, interactive: j.interactive, media: j.media, list: j.list, image_link: j.imageLink }[kind];
  if (have === undefined) ctx.addIssue({ code: 'custom', message: `${kind} job is missing its ${kind} payload` });
});
export type SendJob = z.input<typeof sendJobSchema>;
export const jobKind = (j: Pick<SendJob, 'kind'>) => j.kind ?? 'text';

import { sendImageLink, sendInteractive, sendList, sendMedia, sendTemplate, sendText, type SendResult } from './meta/client';
import type { Env } from '../env';
import { mark } from './timing';
import { workspaceForPhoneNumber } from './routing';
import { STALE_CLAIM_MS } from './workspace-do';

const MAX_RETRY_DELAY_S = 300;

/** Sends one job to Meta in the shape its kind calls for. */
export function sendToMeta(env: Env, job: z.output<typeof sendJobSchema>): Promise<SendResult> {
  const base = { token: env.META_SYSTEM_TOKEN, graphVersion: env.META_GRAPH_VERSION, phoneNumberId: job.phoneNumberId, to: job.to };
  switch (jobKind(job)) {
    case 'template': return sendTemplate({ ...base, ...job.template! });
    case 'interactive': return sendInteractive({ ...base, ...job.interactive! });
    case 'media': return sendMedia({ ...base, ...job.media! });
    case 'list': return sendList({ ...base, ...job.list! });
    case 'image_link': return sendImageLink({ ...base, ...job.imageLink! });
    default: return sendText({ ...base, text: job.text! });
  }
}
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
    if (claim === 'already_sent' || claim === 'dropped' || claim === 'deferred') {
      if (claim === 'dropped') console.warn(JSON.stringify({ warn: 'send_job_dropped', workspace: job.workspaceId }));
      msg.ack();
      continue;
    }
    if (claim === 'in_flight') {
      // Another attempt holds the claim (or died holding it): come back after it goes stale, never ack it away.
      msg.retry({ delaySeconds: STALE_CLAIM_MS / 1000 + 10 });
      continue;
    }
    const sent = await sendToMeta(env, job);
    if (!sent.ok && sent.code === 131049) {
      // Meta's marketing frequency cap: retry that recipient in 24 h, never treat it as a failure of the contact.
      await ws.rescheduleFrequencyCap(job);
      msg.ack();
      continue;
    }
    const lastAttempt = msg.attempts >= MAX_SEND_ATTEMPTS;
    const result = !sent.ok && sent.retryable && lastAttempt ? { ...sent, retryable: false } : sent;
    await ws.recordOutbound(job.idempotencyKey, result);
    if (result.ok) mark(env, 'meta_accepted', job.inboundAt ? Date.now() - job.inboundAt : 0, job.receivedAt ? Date.now() - job.receivedAt : 0, job.workspaceId);
    if (!result.ok && result.retryable) msg.retry({ delaySeconds: Math.min(MAX_RETRY_DELAY_S, 5 * 2 ** (msg.attempts - 1)) });
    else msg.ack();
  }
}
