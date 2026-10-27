import { Hono } from 'hono';
import { retentionRequest } from '../core/api/contract';
import { apiError, workspaceStub, type ApiEnv } from './shared';

/** /api/v1/stores/:storeId/retention: how long messages are kept (B4). Owner only; the purge is the workspace's daily task. */
export const retentionRoutes = new Hono<ApiEnv>();
const ownerOnly = (role: string) => role === 'owner' || role === 'super_admin';

retentionRoutes.get('/stores/:storeId/retention', async (c) => {
  if (!ownerOnly(c.get('storeRole'))) return apiError(c, 403, 'forbidden');
  const ws = await workspaceStub(c);
  return ws ? c.json(await ws.getRetention()) : apiError(c, 404, 'not_found');
});

retentionRoutes.put('/stores/:storeId/retention', async (c) => {
  if (!ownerOnly(c.get('storeRole'))) return apiError(c, 403, 'forbidden');
  const body = retentionRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  return ws ? c.json(await ws.setRetention(body.data.days)) : apiError(c, 404, 'not_found');
});
