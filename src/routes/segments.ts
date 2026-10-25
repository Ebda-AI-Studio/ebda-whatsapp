import { Hono } from 'hono';
import { createSegmentRequest, segmentPreviewRequest, updateSegmentRequest } from '../core/api/contract';
import { apiError, intParam, workspaceStub, type ApiContext, type ApiEnv, managesStore } from './shared';

export const segmentsRoutes = new Hono<ApiEnv>();
const ownerOnly = managesStore;

segmentsRoutes.get('/stores/:storeId/segments', async (c) => {
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  return c.json({ items: await ws.listSegments() });
});

segmentsRoutes.post('/stores/:storeId/segments', async (c) => {
  if (!ownerOnly(c)) return apiError(c, 403, 'forbidden');
  const body = createSegmentRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request', body.error.issues[0]?.message);
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const r = await ws.createSegment({ ...body.data, actor: c.get('principal').userId });
  return r.ok ? c.json(r.segment, 201) : apiError(c, 409, 'invalid_request', r.reason);
});

// Declared before ":segmentId" so "preview" is never read as an id.
segmentsRoutes.post('/stores/:storeId/segments/preview', async (c) => {
  const body = segmentPreviewRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request', body.error.issues[0]?.message);
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  return c.json(await ws.previewAudience(body.data.criteria));
});

segmentsRoutes.get('/stores/:storeId/segments/:segmentId', async (c) => {
  const id = intParam(c, 'segmentId');
  const ws = await workspaceStub(c);
  const seg = id && ws && (await ws.getSegment(id));
  return seg ? c.json(seg) : apiError(c, 404, 'not_found');
});

segmentsRoutes.get('/stores/:storeId/segments/:segmentId/preview', async (c) => {
  const id = intParam(c, 'segmentId');
  const ws = await workspaceStub(c);
  const seg = id && ws && (await ws.getSegment(id));
  return seg ? c.json(await ws!.previewAudience(seg.criteria)) : apiError(c, 404, 'not_found');
});

segmentsRoutes.put('/stores/:storeId/segments/:segmentId', async (c) => {
  if (!ownerOnly(c)) return apiError(c, 403, 'forbidden');
  const id = intParam(c, 'segmentId');
  const body = updateSegmentRequest.safeParse(await c.req.json().catch(() => null));
  if (!id || !body.success) return apiError(c, 400, 'invalid_request', body.success ? undefined : body.error.issues[0]?.message);
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const r = await ws.updateSegment(id, body.data);
  if (r.ok) return c.json(r.segment);
  return r.reason === 'not_found' ? apiError(c, 404, 'not_found') : apiError(c, 409, 'invalid_request', r.reason);
});

segmentsRoutes.delete('/stores/:storeId/segments/:segmentId', async (c) => {
  if (!ownerOnly(c)) return apiError(c, 403, 'forbidden');
  const id = intParam(c, 'segmentId');
  const ws = await workspaceStub(c);
  if (!id || !ws) return apiError(c, 404, 'not_found');
  return (await ws.deleteSegment(id)) ? c.body(null, 204) : apiError(c, 404, 'not_found');
});
