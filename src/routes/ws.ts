import { Hono } from 'hono';
import { eventsQuery } from '../core/api/contract';
import { WS_EXP_HEADER, WS_ROLE_HEADER } from '../core/workspace-do';
import { apiError, workspaceStub, type ApiEnv } from './shared';

export const realtimeRoutes = new Hono<ApiEnv>();

/** WebSocket for live inbox events. The DO accepts it with the hibernation API. */
realtimeRoutes.get('/stores/:storeId/ws', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.text('expected a websocket upgrade', 426);
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  // The DO remembers when this token dies (and the caller's role) so it can drop the socket after that moment.
  const req = new Request(c.req.raw);
  req.headers.set(WS_EXP_HEADER, String(c.get('principal').expiresAt));
  req.headers.set(WS_ROLE_HEADER, c.get('storeRole'));
  return ws.fetch(req);
});

/** Resync after a gap (reconnect, sleeping phone): everything after `after`, by seq. */
realtimeRoutes.get('/stores/:storeId/events', async (c) => {
  const q = eventsQuery.safeParse(c.req.query());
  if (!q.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  return c.json(await ws.eventsAfter(q.data.after));
});
