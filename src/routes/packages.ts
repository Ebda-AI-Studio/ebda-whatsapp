import { Hono } from 'hono';
import { packageDto, packageOrderDto } from '../core/api/contract';
import { getPackageOrder, listPackages, publicState, startPackageCheckout } from '../core/billing/package-orders';
import { packagesEnabled } from '../core/billing/payments';
import { apiError, type ApiContext, type ApiEnv } from './shared';

/** Self-serve packages. Every route answers 404 while PACKAGE_CHECKOUT_ENABLED is off. Buying is the owner's; the client never sends an amount. */
export const packageRoutes = new Hono<ApiEnv>();
const owner = (c: ApiContext) => c.get('storeRole') === 'owner';

packageRoutes.use('/stores/:storeId/packages/*', async (c, next) => (packagesEnabled(c.env) ? next() : apiError(c, 404, 'not_found')));
packageRoutes.use('/stores/:storeId/packages', async (c, next) => (packagesEnabled(c.env) ? next() : apiError(c, 404, 'not_found')));

packageRoutes.get('/stores/:storeId/packages', async (c) => c.json({ items: (await listPackages(c.env)).map((p) => packageDto.parse(p)) }));

packageRoutes.post('/stores/:storeId/packages/:packageId/checkout', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const p = c.get('principal');
  const r = await startPackageCheckout(c.env, { workspaceId: c.req.param('storeId')!, userId: p.userId, sessionId: p.sessionId, packageId: c.req.param('packageId')! });
  if (r.ok) return c.json(packageOrderDto.parse({ orderId: r.orderId, state: 'pending', packageId: c.req.param('packageId'), amountMinor: r.amountMinor, checkoutUrl: r.checkoutUrl }), 201);
  if (r.reason === 'unknown_package') return apiError(c, 404, 'not_found');
  if (r.reason === 'session_revoked') return apiError(c, 401, 'unauthorized');
  if (r.reason === 'yearly_queued') return c.json({ error: 'yearly_queued' }, 409); // a queued period cannot be switched: support / the operator cancels and refunds it
  if (r.reason === 'disabled') return apiError(c, 404, 'not_found');
  return apiError(c, 503, 'unavailable');
});

/** Read only: where the browser lands after paying. It grants nothing; the webhook does. */
packageRoutes.get('/stores/:storeId/packages/orders/:orderId', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const o = await getPackageOrder(c.env, c.req.param('storeId')!, c.req.param('orderId')!);
  return o ? c.json(packageOrderDto.parse({ orderId: o.order_id, state: publicState(o), packageId: o.package_id, amountMinor: o.amount_minor })) : apiError(c, 404, 'not_found');
});
