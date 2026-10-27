import { Hono } from 'hono';
import { sendMessageRequest } from '../core/api/contract';
import { sharedTemplateSendable } from '../core/shared/shared-templates';
import { senderNumber, apiError, intParam, workspaceStub, type ApiEnv } from './shared';
import { alert } from '../core/observability';

export const messagesRoutes = new Hono<ApiEnv>();

messagesRoutes.post('/stores/:storeId/conversations/:conversationId/messages', async (c) => {
  const conversationId = intParam(c, 'conversationId');
  const parsed = sendMessageRequest.safeParse(await c.req.json().catch(() => null));
  if (!conversationId || !parsed.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const number = await senderNumber(c);
  if (!number) return apiError(c, 409, 'invalid_request', 'no_active_number');
  // WA-SHARED-NOCAMP-1: refuse up front what the send chokepoint would refuse anyway (the platform catalog decides, not the store's copy).
  if (number.shared && parsed.data.type === 'template' && !(await sharedTemplateSendable(c.env, number.phoneNumberId, parsed.data.name, parsed.data.language))) {
    return apiError(c, 409, 'template_not_approved');
  }
  const r = await ws.queueOutbound(conversationId, number.phoneNumberId, parsed.data);
  if (!r.ok) {
    switch (r.reason) {
      case 'not_found': return apiError(c, 404, 'not_found');
      case 'invalid_request': return apiError(c, 400, 'invalid_request', r.message);
      case 'unsupported_media': return apiError(c, 415, 'unsupported_media', r.message);
      case 'plan_required': return apiError(c, 403, 'plan_required');
      default: return apiError(c, 409, r.reason, r.message);
    }
  }
  if (r.job) {
    try {
      await c.env.SEND_QUEUE.sendBatch([{ body: r.job }]);
    } catch (err) {
      // Queue-then-send fails fast: never leave an orphan 'queued' row that nothing will send.
      await ws.markEnqueueFailed(r.job.idempotencyKey);
      alert('send_enqueue_failed', { workspace: c.req.param('storeId'), error: (err as Error).message });
      return apiError(c, 503, 'rate_limited', 'enqueue_failed');
    }
  }
  return c.json(r.message, 202);
});

/** How much of the number's Meta tier is used and how many sends are waiting for a slot. */
messagesRoutes.get('/stores/:storeId/throttle', async (c) => {
  const ws = await workspaceStub(c);
  const number = await senderNumber(c);
  if (!ws || !number) return apiError(c, 404, 'not_found');
  return c.json(await ws.throttleReport(number.phoneNumberId));
});
