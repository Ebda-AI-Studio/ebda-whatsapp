import { Hono } from 'hono';
import { codOutcomeRequest, storeLinkSettingsPatch, type OrderSummaryDto } from '../core/api/contract';
import { buyerKey } from '../core/buyer-key';
import { normaliseE164 } from '../core/phone';
import type { BridgeOrderSummary } from '../core/store-bridge';
import { bridgeFor, storeLink } from '../core/store-link';
import { catalogBelongsToWaba } from '../core/store-link/catalog';
import { provisionRequest } from '../core/store-link/catalog-provision';
import { activeNumber, apiError, workspaceStub, type ApiContext, type ApiEnv } from './shared';

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

ordersRoutes.get('/stores/:storeId/store-link/catalog', async (c) => {
  const ws = await workspaceStub(c);
  return ws ? c.json(await ws.getCatalogStatus()) : apiError(c, 404, 'not_found');
});

ordersRoutes.patch('/stores/:storeId/store-link/settings', async (c) => {
  if (c.get('storeRole') === 'staff') return apiError(c, 403, 'forbidden');
  const patch = storeLinkSettingsPatch.safeParse(await c.req.json().catch(() => null));
  if (!patch.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  let catalogWabaId: string | undefined;
  if (patch.data.catalogId) {
    // The platform token can write to any catalog it can see: only accept one that is connected to THIS workspace's WABA.
    const number = await activeNumber(c);
    if (!number) return apiError(c, 400, 'invalid_request', 'catalog_not_linked');
    const belongs = await catalogBelongsToWaba(c.env, number.wabaId, patch.data.catalogId);
    if (belongs === 'unavailable') return apiError(c, 503, 'rate_limited', 'meta_unavailable');
    if (belongs === 'no') return apiError(c, 400, 'invalid_request', 'catalog_not_linked');
    catalogWabaId = number.wabaId;
  }
  const res = await ws.setStoreLinkSettings(patch.data, catalogWabaId ? { catalogWabaId } : {});
  return res.ok ? c.json(res.settings) : apiError(c, 400, 'invalid_request', 'catalog_not_linked');
});

/** Creates a Meta catalog for a merchant who has none and connects it to their WhatsApp Business Account (owner only). */
ordersRoutes.post('/stores/:storeId/store-link/catalog/provision', async (c) => {
  if (c.get('storeRole') === 'staff') return apiError(c, 403, 'forbidden');
  const body = provisionRequest.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const number = await activeNumber(c);
  // The business id lives on the merchant's own Embedded Signup credential; a shared-number or older connection has none.
  const cred = number
    ? await c.env.DB.prepare('SELECT business_id FROM waba_credentials WHERE waba_id = ? AND workspace_id = ?').bind(number.wabaId, c.req.param('storeId')!).first<{ business_id: string | null }>()
    : null;
  if (!number || !cred?.business_id) return apiError(c, 409, 'invalid_request', 'no_business');
  const res = await ws.provisionCatalog({ ...(body.data.name ? { name: body.data.name } : {}), wabaId: number.wabaId, businessId: cred.business_id });
  if (res.ok) return c.json({ catalogId: res.catalogId });
  switch (res.code) {
    case 'missing_permission': return apiError(c, 403, 'forbidden', 'missing_permission');
    case 'already_set': return apiError(c, 409, 'invalid_request', 'catalog_already_set');
    case 'no_name': return apiError(c, 400, 'invalid_request', 'name_required');
    case 'no_business': return apiError(c, 409, 'invalid_request', 'no_business');
    case 'business_mismatch': return apiError(c, 409, 'invalid_request', 'business_mismatch');
    case 'meta_error': return c.json({ error: res.retryable ? 'rate_limited' : 'invalid_request', message: 'meta_error', retryable: res.retryable }, res.retryable ? 503 : 400);
  }
});
