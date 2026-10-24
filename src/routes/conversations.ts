import { Hono } from 'hono';
import { addNoteRequest, assignRequest, getMessagesQuery, listConversationsQuery, searchQuery, setTagsRequest } from '../core/api/contract';
import { apiError, intParam, workspaceStub, type ApiEnv } from './shared';

export const conversationsRoutes = new Hono<ApiEnv>();

conversationsRoutes.get('/stores/:storeId/conversations', async (c) => {
  const q = listConversationsQuery.safeParse(c.req.query());
  if (!q.success || (q.data.cursor !== undefined && !/^\d+\.\d+$/.test(q.data.cursor))) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  return c.json(await ws.listConversations({ filter: q.data.filter, userId: c.get('principal').userId, ...(q.data.cursor ? { cursor: q.data.cursor } : {}), limit: q.data.limit }));
});

conversationsRoutes.get('/stores/:storeId/conversations/:conversationId/messages', async (c) => {
  const id = intParam(c, 'conversationId');
  const q = getMessagesQuery.safeParse(c.req.query());
  if (!id || !q.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  const page = ws && (await ws.getMessages(id, q.data.before, q.data.limit));
  return page ? c.json(page) : apiError(c, 404, 'not_found');
});

conversationsRoutes.get('/stores/:storeId/messages/:messageId/body', async (c) => {
  const id = intParam(c, 'messageId');
  if (!id) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  const body = ws && (await ws.getBody(id));
  return body ? c.json(body) : apiError(c, 404, 'not_found');
});

conversationsRoutes.post('/stores/:storeId/conversations/:conversationId/read', async (c) => {
  const id = intParam(c, 'conversationId');
  if (!id) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  const conv = ws && (await ws.markRead(id));
  return conv ? c.json(conv) : apiError(c, 404, 'not_found');
});

conversationsRoutes.post('/stores/:storeId/conversations/:conversationId/assign', async (c) => {
  const id = intParam(c, 'conversationId');
  const body = assignRequest.safeParse(await c.req.json().catch(() => null));
  if (!id || !body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  const conv = ws && (await ws.assign(id, body.data.userId));
  return conv ? c.json(conv) : apiError(c, 404, 'not_found');
});

conversationsRoutes.put('/stores/:storeId/conversations/:conversationId/tags', async (c) => {
  const id = intParam(c, 'conversationId');
  const body = setTagsRequest.safeParse(await c.req.json().catch(() => null));
  if (!id || !body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  const conv = ws && (await ws.setTags(id, body.data.tags));
  return conv ? c.json(conv) : apiError(c, 404, 'not_found');
});

conversationsRoutes.get('/stores/:storeId/conversations/:conversationId/notes', async (c) => {
  const id = intParam(c, 'conversationId');
  if (!id) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  const items = ws && (await ws.listNotes(id));
  return items ? c.json({ items }) : apiError(c, 404, 'not_found');
});

conversationsRoutes.post('/stores/:storeId/conversations/:conversationId/notes', async (c) => {
  const id = intParam(c, 'conversationId');
  const body = addNoteRequest.safeParse(await c.req.json().catch(() => null));
  if (!id || !body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  const note = ws && (await ws.addNote(id, c.get('principal').userId, body.data.text));
  return note ? c.json(note, 201) : apiError(c, 404, 'not_found');
});

conversationsRoutes.get('/stores/:storeId/search', async (c) => {
  const q = searchQuery.safeParse(c.req.query());
  if (!q.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  return c.json({ items: await ws.search(q.data.q, q.data.limit) });
});
