import { Hono } from 'hono';
import { storeCouponRequest, storeTopProductsQuery } from '../core/api/contract';
import { recordAudit } from '../core/audit';
import { bridgeForWorkspace } from '../core/store-link';
import type { BridgeResult } from '../core/store-bridge';
import { apiError, ownsStore, workspaceStub, type ApiContext, type ApiEnv } from './shared';

/**
 * Store-wide reads and writes for the owner assistant (Store ruling CHAT-ASSIST-1): best sellers, and creating a coupon. Both reach the Store over the bridge, authorised THERE by the
 * calling user's live role (never a claim in our token), and answer only what the Store answered: nothing here computes a number. The coupon route is the owner's alone and is
 * only ever called by the assistant after the merchant pressed confirm on a card (see `tools/store.tools.ts`).
 */
export const storeAssistRoutes = new Hono<ApiEnv>();

/** The Store's refusal as the HTTP answer: a typed code the assistant can name, never a raw message. Expected refusals are 4xx; an unreachable Store is 503. */
function refusal(c: ApiContext, r: Extract<BridgeResult<unknown>, { ok: false }>): Response {
  if (r.reason === 'unavailable') return apiError(c, 503, 'rate_limited', r.code === 'RATE_LIMITED' ? 'store_rate_limited' : 'store_unavailable');
  if (r.reason === 'not_found' || r.reason === 'not_linked') return apiError(c, 404, 'not_found', 'store_not_linked');
  if (r.code === 'FORBIDDEN') return apiError(c, 403, 'forbidden');
  return apiError(c, r.code === 'DUPLICATE_CODE' ? 409 : 400, 'invalid_request', (r.code ?? 'invalid').slice(0, 40));
}

/** Best sellers of a period (owner and staff read). */
storeAssistRoutes.get('/stores/:storeId/store/top-products', async (c) => {
  const q = storeTopProductsQuery.safeParse({ period: c.req.query('period'), limit: c.req.query('limit') });
  if (!q.success) return apiError(c, 400, 'invalid_request');
  if (!(await workspaceStub(c))) return apiError(c, 404, 'not_found');
  const bridge = bridgeForWorkspace(c.env, c.req.param('storeId')!);
  if (!bridge) return apiError(c, 503, 'rate_limited', 'store_link_off');
  const r = await bridge.getTopProducts(c.req.param('storeId')!, c.get('principal').userId, q.data);
  if (!r.ok) return refusal(c, r);
  return c.json({ currency: r.value.currency, period: r.value.period, from: r.value.fromMs, to: r.value.toMs, items: r.value.items });
});

/** Creates a coupon through the Store's own coupon service (owner only; a platform super admin's session never creates one). */
storeAssistRoutes.post('/stores/:storeId/store/coupons', async (c) => {
  if (c.get('storeRole') === 'super_admin') return apiError(c, 403, 'forbidden', 'operator_session');
  if (!ownsStore(c)) return apiError(c, 403, 'forbidden');
  const body = storeCouponRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  if (!(await workspaceStub(c))) return apiError(c, 404, 'not_found');
  const bridge = bridgeForWorkspace(c.env, c.req.param('storeId')!);
  if (!bridge) return apiError(c, 503, 'rate_limited', 'store_link_off');
  const actor = c.get('principal').userId;
  const r = await bridge.createCoupon(c.req.param('storeId')!, actor, body.data);
  if (!r.ok) return refusal(c, r);
  // Before/after for the owner's audit trail (ids, counts and the code only; the Store keeps its own row with the full terms).
  if (!r.value.replayed) {
    await recordAudit(c.env, { workspaceId: c.req.param('storeId')!, actor, role: 'owner', action: 'store.coupon_create', targetType: 'coupon', targetId: r.value.couponId,
      detail: { before: 'none', afterType: r.value.type, afterValue: r.value.value, afterCode: r.value.code, windowDays: body.data.durationDays ?? null, usageLimit: r.value.usageLimit } });
  }
  return c.json(r.value, r.value.replayed ? 200 : 201);
});
