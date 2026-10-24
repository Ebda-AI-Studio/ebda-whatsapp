import { Hono } from 'hono';
import { agentSettingsUpdate } from '../core/api/contract';
import { apiError, workspaceStub, type ApiEnv } from './shared';

export const agentRoutes = new Hono<ApiEnv>();

// The agent's settings (persona, FAQ, endpoint) are the merchant's to read and change: owner only.
agentRoutes.get('/stores/:storeId/agent', async (c) => {
  if (c.get('storeRole') === 'staff') return apiError(c, 403, 'forbidden');
  const ws = await workspaceStub(c);
  return ws ? c.json(await ws.getAgentSettings()) : apiError(c, 404, 'not_found');
});

agentRoutes.put('/stores/:storeId/agent', async (c) => {
  if (c.get('storeRole') === 'staff') return apiError(c, 403, 'forbidden');
  const body = agentSettingsUpdate.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const res = await ws.setAgentSettings(body.data);
  if (res.ok) return c.json(res.settings);
  // Never echo a submitted value back: the reason is a fixed code.
  return res.reason === 'secrets_unavailable' ? apiError(c, 503, 'rate_limited', res.reason) : apiError(c, 400, 'invalid_request', res.reason);
});
