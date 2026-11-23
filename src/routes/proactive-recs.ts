import { Hono } from 'hono';
import { proactiveRecsRequest } from '../core/api/contract';
import { apiError, workspaceStub, type ApiEnv } from './shared';

/**
 * /api/v1/stores/:storeId/proactive-recs (CHAT-RECS-SWITCH-1): the switch for post-order product suggestions sent as an approved template.
 * Owner only, both ways: it makes the store start messages to customers and spend wallet credit. OFF until the owner turns it on.
 */
export const proactiveRecsRoutes = new Hono<ApiEnv>();
const ownerOnly = (role: string) => role === 'owner' || role === 'super_admin';

proactiveRecsRoutes.get('/stores/:storeId/proactive-recs', async (c) => {
  if (!ownerOnly(c.get('storeRole'))) return apiError(c, 403, 'forbidden');
  const ws = await workspaceStub(c);
  return ws ? c.json(await ws.getProactiveRecs()) : apiError(c, 404, 'not_found');
});

proactiveRecsRoutes.put('/stores/:storeId/proactive-recs', async (c) => {
  if (!ownerOnly(c.get('storeRole'))) return apiError(c, 403, 'forbidden');
  const body = proactiveRecsRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const r = await ws.setProactiveRecs(body.data);
  return r.ok ? c.json(r.view) : apiError(c, 400, 'invalid_request', r.reason);
});
