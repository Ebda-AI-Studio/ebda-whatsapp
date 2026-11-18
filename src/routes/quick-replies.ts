import { Hono } from 'hono';
import { createQuickReplyRequest, updateQuickReplyRequest } from '../core/api/contract';
import { apiError, intParam, workspaceStub, type ApiEnv } from './shared';

/**
 * The merchant's own quick replies for the inbox composer (A25). Owner and staff may read and write (staff answer customers, so they keep the
 * team's canned texts); the store id comes from the path-checked middleware, never the body; every change lands in the audit log through
 * `auditWrites`. A super admin passes the same middleware (support override), nothing here narrows that.
 */
export const quickRepliesRoutes = new Hono<ApiEnv>();

quickRepliesRoutes.get('/stores/:storeId/quick-replies', async (c) => {
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  return c.json({ items: await ws.listQuickReplies() });
});

quickRepliesRoutes.post('/stores/:storeId/quick-replies', async (c) => {
  const body = createQuickReplyRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request', body.error.issues[0]?.message);
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const r = await ws.createQuickReply({ text: body.data.text, actor: c.get('principal').userId });
  return r.ok ? c.json(r.reply, 201) : apiError(c, 409, 'invalid_request', r.reason);
});

quickRepliesRoutes.put('/stores/:storeId/quick-replies/:quickReplyId', async (c) => {
  const id = intParam(c, 'quickReplyId');
  const body = updateQuickReplyRequest.safeParse(await c.req.json().catch(() => null));
  if (!id || !body.success) return apiError(c, 400, 'invalid_request', body.success ? undefined : body.error.issues[0]?.message);
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const r = await ws.updateQuickReply(id, body.data.text);
  if (r.ok) return c.json(r.reply);
  return r.reason === 'not_found' ? apiError(c, 404, 'not_found') : apiError(c, 409, 'invalid_request', r.reason);
});

quickRepliesRoutes.delete('/stores/:storeId/quick-replies/:quickReplyId', async (c) => {
  const id = intParam(c, 'quickReplyId');
  if (!id) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  return (await ws.deleteQuickReply(id)) ? c.body(null, 204) : apiError(c, 404, 'not_found');
});
