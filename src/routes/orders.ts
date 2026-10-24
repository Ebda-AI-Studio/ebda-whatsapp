import { Hono } from 'hono';
import { codOutcomeRequest, storeLinkSettingsPatch, type OrderSummaryDto } from '../core/api/contract';
import { buyerKey } from '../core/buyer-key';
import { normaliseE164 } from '../core/phone';
import type { BridgeOrderSummary } from '../core/store-bridge';
import { bridgeFor, storeLink } from '../core/store-link';
import { apiError, workspaceStub, type ApiContext, type ApiEnv } from './shared';

export const ordersRoutes = new Hono<ApiEnv>();

/** Orders have no "pending payment" in the inbox panel's vocabulary yet: it shows as waiting. */
const toSummary = (o: BridgeOrderSummary): OrderSummaryDto => ({
  orderNumber: o.orderNumber, status: o.status === 'pending_payment' ? 'pending_confirmation' : o.status, totalMinor: o.totalMinor, currency: o.currency,
  paymentMethod: o.paymentMethod, itemsCount: o.itemsCount, at: o.at,
});

async function customer(c: ApiContext): Promise<{ waId: string; key: string } | Response> {
  const e164 = normaliseE164(`+${c.req.param('waId')}`);
  if (!e164) return apiError(c, 400, 'invalid_request', 'invalid phone number');
  const secret = storeLink().buyerSecret(c.env);
  if (!secret) return apiError(c, 503, 'rate_limited', 'store_link_not_configured');
  return { waId: e164.slice(1), key: await buyerKey(secret, e164) };
}

ordersRoutes.get('/stores/:storeId/contacts/:waId/orders', async (c) => {
  if (!(await workspaceStub(c))) return apiError(c, 404, 'not_found');
  const bridge = bridgeFor(c.env);
  // No Store bound: the UI keeps showing its labelled sample.
  if (!bridge) return c.json({ items: [], source: 'sample' as const });
  const who = await customer(c);
  if (who instanceof Response) return who;
  const res = await bridge.listCustomerOrders(c.req.param('storeId')!, who.key, 10);
  if (!res.ok) return res.reason === 'not_found' || res.reason === 'not_linked' ? c.json({ items: [], source: 'store' as const }) : apiError(c, 503, 'rate_limited', 'store_unavailable');
  return c.json({ items: res.value.items.map(toSummary), source: 'store' as const });
});

ordersRoutes.post('/stores/:storeId/contacts/:waId/orders/:orderNumber/cod-outcome', async (c) => {
  const body = codOutcomeRequest.safeParse(await c.req.json().catch(() => null));
  const orderNumber = c.req.param('orderNumber')!;
  if (!body.success || !/^[\w-]{1,40}$/.test(orderNumber)) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const bridge = bridgeFor(c.env);
  if (!bridge) return apiError(c, 503, 'rate_limited', 'store_link_off');
  const who = await customer(c);
  if (who instanceof Response) return who;
  const args = { orderNumber, waId: who.waId, outcome: body.data.outcome, idempotencyKey: body.data.idempotencyKey };
  let res = await ws.merchantCodOutcome(args);
  if (!res.ok && res.reason === 'unknown_order') {
    // An order the Store created that this workspace has not heard of: ask the Store which order that number is.
    const orders = await bridge.listCustomerOrders(c.req.param('storeId')!, who.key, 20);
    if (!orders.ok) return orders.reason === 'unavailable' ? apiError(c, 503, 'rate_limited', 'store_unavailable') : apiError(c, 404, 'not_found');
    const hit = orders.value.items.find((o) => o.orderNumber === orderNumber && o.paymentMethod === 'cod');
    if (!hit) return apiError(c, 404, 'not_found');
    res = await ws.merchantCodOutcome({ ...args, known: { orderId: hit.orderId, totalMinor: hit.totalMinor, currency: hit.currency, buyerKey: who.key } });
  }
  if (res.ok) return c.json({ orderNumber: res.orderNumber, outcome: res.outcome, pushed: res.pushed });
  if (res.reason === 'unknown_order') return apiError(c, 404, 'not_found');
  return apiError(c, 409, 'invalid_request', res.reason === 'closed' ? 'order_closed' : res.reason === 'not_cod' ? 'not_cod_order' : 'already_resolved');
});

ordersRoutes.get('/stores/:storeId/store-link/settings', async (c) => {
  const ws = await workspaceStub(c);
  return ws ? c.json(await ws.getStoreLinkSettings()) : apiError(c, 404, 'not_found');
});

ordersRoutes.patch('/stores/:storeId/store-link/settings', async (c) => {
  if (c.get('storeRole') === 'staff') return apiError(c, 403, 'forbidden');
  const patch = storeLinkSettingsPatch.safeParse(await c.req.json().catch(() => null));
  if (!patch.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  return ws ? c.json(await ws.setStoreLinkSettings(patch.data)) : apiError(c, 404, 'not_found');
});
