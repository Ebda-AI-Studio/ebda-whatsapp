import { Hono } from 'hono';
import { connectorId, connectorPut } from '../core/api/contract';
import { apiError, managesStore, workspaceStub, type ApiEnv } from './shared';

export const connectorRoutes = new Hono<ApiEnv>();

// A connector reaches the client's own systems with a secret: owner only (super admin included), staff never.

connectorRoutes.get('/stores/:storeId/connectors', async (c) => {
  if (!managesStore(c)) return apiError(c, 403, 'forbidden');
  const ws = await workspaceStub(c);
  return ws ? c.json(await ws.listConnectors()) : apiError(c, 404, 'not_found');
});

connectorRoutes.put('/stores/:storeId/connectors/:connectorId', async (c) => {
  if (!managesStore(c)) return apiError(c, 403, 'forbidden');
  const id = connectorId.safeParse(c.req.param('connectorId'));
  const body = connectorPut.safeParse(await c.req.json().catch(() => null));
  if (!id.success || !body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const res = await ws.putConnector(id.data, body.data, c.get('principal').userId);
  if (res.ok) return c.json(res.connector);
  // Never echo a submitted value back: the reason is a fixed code.
  return res.reason === 'secrets_unavailable' ? apiError(c, 503, 'rate_limited', res.reason) : apiError(c, 400, 'invalid_request', res.reason);
});

connectorRoutes.delete('/stores/:storeId/connectors/:connectorId', async (c) => {
  if (!managesStore(c)) return apiError(c, 403, 'forbidden');
  const id = connectorId.safeParse(c.req.param('connectorId'));
  if (!id.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  return (await ws.deleteConnector(id.data)) ? c.json({ ok: true }) : apiError(c, 404, 'not_found');
});

connectorRoutes.post('/stores/:storeId/connectors/:connectorId/test', async (c) => {
  if (!managesStore(c)) return apiError(c, 403, 'forbidden');
  const id = connectorId.safeParse(c.req.param('connectorId'));
  if (!id.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const res = await ws.testConnector(id.data);
  if (!res) return apiError(c, 404, 'not_found');
  return res.error === 'rate_limited' ? apiError(c, 429, 'rate_limited') : c.json(res);
});
