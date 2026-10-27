import { Hono } from 'hono';
import { costEstimateQuery, digestSettings, refundRequestCreate, statementQuery, topupRequest, type WalletDto } from '../core/api/contract';
import { statementCsv } from '../core/billing/statement';
import { topupsEnabled } from '../core/billing/payments';
import { rejectionNotice } from '../core/billing/instapay';
import { getTopup, startTopup } from '../core/billing/topups';
import { createRefundRequest, listRefundRequests } from '../core/billing/refunds';
import { apiError, senderNumber, workspaceStub, type ApiContext, type ApiEnv } from './shared';

export const walletRoutes = new Hono<ApiEnv>();
const owner = (c: ApiContext) => c.get('storeRole') === 'owner';

walletRoutes.get('/stores/:storeId/wallet', async (c) => {
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const v = await ws.walletView();
  const { results } = await c.env.DB.prepare(`SELECT phone_number_id, display_phone, funding FROM (
      SELECT pn.phone_number_id, pn.display_phone, nf.funding, 0 AS grp, pn.rowid AS ord FROM phone_numbers pn LEFT JOIN number_funding nf ON nf.phone_number_id = pn.phone_number_id WHERE pn.workspace_id = ?1 AND pn.status = 'active'
      UNION ALL
      SELECT sn.phone_number_id, sn.display_phone, nf.funding, 1, sn.rowid FROM shared_number_members m JOIN shared_numbers sn ON sn.phone_number_id = m.phone_number_id LEFT JOIN number_funding nf ON nf.phone_number_id = sn.phone_number_id WHERE m.workspace_id = ?1 AND m.status = 'active'
    ) ORDER BY grp, ord`)
    .bind(c.req.param('storeId')!).all<{ phone_number_id: string; display_phone: string | null; funding: 'merchant_card' | 'platform_line' | null }>();
  const dto: WalletDto = {
    balanceMinor: v.balanceMinor, heldMinor: v.heldMinor, availableMinor: v.availableMinor, debtMinor: v.debtMinor, creditLimitMinor: v.creditLimitMinor, currency: 'EGP',
    funding: results.map((r) => ({ phoneNumberId: r.phone_number_id, displayPhone: r.display_phone, funding: r.funding ?? 'unknown' })),
    topupsEnabled: topupsEnabled(c.env), lowBalance: v.lowBalance, lowBalanceThresholdMinor: v.lowBalanceThresholdMinor, aiCredits: v.aiCredits, plan: v.plan as WalletDto['plan'],
    ...(owner(c) ? { instapayNotice: await rejectionNotice(c.env, c.req.param('storeId')!) } : {}),
  };
  return c.json(dto);
});

// Financial history: the owner's (and the operator's), not staff's.
walletRoutes.get('/stores/:storeId/wallet/statement', async (c) => {
  if (c.get('storeRole') === 'staff') return apiError(c, 403, 'forbidden');
  const q = statementQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!q.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const st = await ws.walletStatement(q.data.month);
  if (!st) return apiError(c, 400, 'invalid_request');
  if (q.data.format === 'csv') {
    return new Response(statementCsv(st), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="statement-${q.data.month}.csv"`, 'cache-control': 'no-store' } });
  }
  return c.json(st);
});

walletRoutes.get('/stores/:storeId/wallet/estimate', async (c) => {
  const q = costEstimateQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!q.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  const number = await senderNumber(c);
  if (!ws || !number) return apiError(c, 404, 'not_found');
  const e = await ws.estimateCost({ phoneNumberId: number.phoneNumberId, category: q.data.category, count: q.data.count, ...(q.data.country ? { country: q.data.country } : {}) });
  return c.json({ funding: e.funding, paidBy: e.paidBy, perMessageMinor: e.perMessageMinor, totalMinor: e.totalMinor, priced: e.priced, currency: 'EGP' });
});

walletRoutes.post('/stores/:storeId/wallet/topups', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const body = topupRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  const p = c.get('principal');
  const r = await startTopup(c.env, { workspaceId: c.req.param('storeId')!, userId: p.userId, sessionId: p.sessionId, amountMinor: body.data.amountMinor });
  if (r.ok) return c.json({ orderId: r.orderId, state: 'pending', amountMinor: r.amountMinor, feeMinor: r.feeMinor, totalMinor: r.totalMinor, checkoutUrl: r.checkoutUrl }, 201);
  if (r.reason === 'invalid_amount') return apiError(c, 400, 'invalid_request', r.reason);
  if (r.reason === 'offboarding') return apiError(c, 409, 'invalid_request', 'offboarding_pending'); // OFFBOARD-FREEZE-1: the owner cancels the deletion first
  if (r.reason === 'session_revoked') return apiError(c, 401, 'unauthorized');
  return apiError(c, 503, r.reason === 'unavailable' ? 'unavailable' : 'rate_limited', r.reason); // disabled / unavailable: nothing was written
});

/** Read only: where the browser lands after paying. It never credits anything; the webhook does. */
walletRoutes.get('/stores/:storeId/wallet/topups/:orderId', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const t = await getTopup(c.env, c.req.param('storeId')!, c.req.param('orderId')!);
  return t ? c.json({ orderId: t.order_id, state: t.state, amountMinor: t.amount_minor, feeMinor: t.fee_minor, totalMinor: t.total_minor }) : apiError(c, 404, 'not_found');
});

walletRoutes.post('/stores/:storeId/wallet/refund-requests', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const body = refundRequestCreate.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const r = await createRefundRequest(c.env, { workspaceId: c.req.param('storeId')!, userId: c.get('principal').userId, amountMinor: body.data.amountMinor, ...(body.data.note ? { note: body.data.note } : {}) });
  return r.ok ? c.json(r.request, 201) : apiError(c, 409, 'invalid_request', r.reason);
});

walletRoutes.get('/stores/:storeId/wallet/refund-requests', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  return c.json({ items: await listRefundRequests(c.env, { workspaceId: c.req.param('storeId')! }) });
});

// T13: the weekly digest. Everyone in the store may read it; only the owner (or the operator) switches it off. Counts only, never a person's data.
walletRoutes.get('/stores/:storeId/digest', async (c) => {
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  return c.json(await ws.weeklyDigest());
});
walletRoutes.put('/stores/:storeId/digest', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const body = digestSettings.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  await ws.setDigestEnabled(body.data.enabled);
  return c.json({ enabled: body.data.enabled });
});
