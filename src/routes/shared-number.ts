import { Hono } from 'hono';
import { sharedNumberJoin, type SharedNumberDto } from '../core/api/contract';
import { joinShared, leaveShared, sharedEnabled, sharedStatus } from '../core/shared/shared-number';
import { apiError, workspaceStub, type ApiContext, type ApiEnv } from './shared';

const owner = (c: ApiContext) => c.get('storeRole') === 'owner';

/** Phase 8.2: a store joins the shared platform number. Every route answers 404 until SHARED_NUMBER_ENABLED is on. */
export const sharedNumberRoutes = new Hono<ApiEnv>();
sharedNumberRoutes.use('/stores/:storeId/shared-number', async (c, next) => (sharedEnabled(c.env) ? next() : apiError(c, 404, 'not_found')));
sharedNumberRoutes.use('/stores/:storeId/shared-number/*', async (c, next) => (sharedEnabled(c.env) ? next() : apiError(c, 404, 'not_found')));

sharedNumberRoutes.get('/stores/:storeId/shared-number', async (c) => {
  if (!(await workspaceStub(c))) return apiError(c, 404, 'not_found');
  const body: SharedNumberDto = await sharedStatus(c.env, c.req.param('storeId')!);
  return c.json(body);
});

sharedNumberRoutes.post('/stores/:storeId/shared-number/join', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const body = sharedNumberJoin.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  if (!(await workspaceStub(c))) return apiError(c, 404, 'not_found');
  const st = await joinShared(c.env, c.req.param('storeId')!, body.data.displayName);
  if (!st) return apiError(c, 404, 'not_found'); // no platform number registered yet
  if (st === 'number_unhealthy') return apiError(c, 409, 'invalid_request', 'number_unhealthy'); // Meta flagged the platform number: no new members for now
  if (st === 'evicted') return apiError(c, 403, 'forbidden', 'evicted');
  if (st === 'package_required') return apiError(c, 402, 'package_required', 'package_required'); // the plan does not include the shared number
  if (st === 'name_taken') return apiError(c, 409, 'invalid_request', 'display_name_taken'); // another store on the number already looks like this
  console.log(JSON.stringify({ audit: 'shared_number_joined', storeId: c.req.param('storeId'), by: c.get('principal').userId }));
  return c.json(st);
});

sharedNumberRoutes.post('/stores/:storeId/shared-number/leave', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  if (!(await workspaceStub(c))) return apiError(c, 404, 'not_found');
  const st = await leaveShared(c.env, c.req.param('storeId')!);
  console.log(JSON.stringify({ audit: 'shared_number_left', storeId: c.req.param('storeId'), by: c.get('principal').userId }));
  return c.json(st);
});
