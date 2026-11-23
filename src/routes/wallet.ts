import { Hono } from 'hono';
import { confirmToken, costEstimateQuery, creditOrderDto, creditPackBuy, creditPackPick, digestSettings, numberFundingChoice, numberFundingConfirm, refundRequestCreate, statementQuery, topupRequest, yearlyRefundPreviewDto, yearlyRefundViewDto, type WalletDto } from '../core/api/contract';
import { statementCsv } from '../core/billing/statement';
import { namePlan } from '../core/billing/store-plan';
import { cardCheckoutReady, topupsEnabled } from '../core/billing/payments';
import { instapayEnabled, rejectionNotice } from '../core/billing/instapay';
import { payeeFor } from './instapay';
import { getTopup, startTopup } from '../core/billing/topups';
import { createRefundRequest, listRefundRequests } from '../core/billing/refunds';
import { issueConfirmation, consumeConfirmation, type Consumed } from '../core/billing/confirmation';
import { creditCheckoutOn, creditPacks, getCreditOrder, packPayload, startCreditPack } from '../core/billing/credit-packs';
import { ownNumberFunding, setOwnNumberCard } from '../core/billing/funding';
import { createYearlyRefundRequest, latestRequest, merchantQuote, quotePayload, requestDto } from '../core/billing/yearly-refund-request';
import { apiError, senderNumber, workspaceStub, type ApiContext, type ApiEnv } from './shared';

export const walletRoutes = new Hono<ApiEnv>();
const owner = (c: ApiContext) => c.get('storeRole') === 'owner';
/** A refused confirmation, in words the screen can act on: `confirmation_mismatch` means the figures moved since the preview (preview again). */
const confirmRefusal = (c: ApiContext, why: Exclude<Consumed, 'ok'>) => apiError(c, 409, 'invalid_request', `confirmation_${why}`);

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
  const namedPlan = await namePlan(c.env, c.req.param('storeId')!, v.plan as WalletDto['plan']);
  const dto: WalletDto = {
    balanceMinor: v.balanceMinor, heldMinor: v.heldMinor, availableMinor: v.availableMinor, debtMinor: v.debtMinor, creditLimitMinor: v.creditLimitMinor, currency: 'EGP',
    funding: results.map((r) => ({ phoneNumberId: r.phone_number_id, displayPhone: r.display_phone, funding: r.funding ?? 'unknown' })),
    topupsEnabled: topupsEnabled(c.env), cardCheckout: cardCheckoutReady(c.env), instapayAvailable: instapayEnabled(c.env) && payeeFor(c.env) !== null, lowBalance: v.lowBalance, lowBalanceThresholdMinor: v.lowBalanceThresholdMinor, aiCredits: v.aiCredits, plan: namedPlan,
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

// ---- Who pays Meta for an OWN number (A21). Owner only; the store id comes from the session, the number must be one of this store's own. ----
// Super-admin override (reason: platform-config): PUT /operator/numbers/:phoneNumberId/funding stays; it is the only way to set `platform_line` and to move a number off it.
walletRoutes.post('/stores/:storeId/numbers/:phoneNumberId/funding/preview', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const body = numberFundingChoice.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  if (body.data.funding === 'platform_line') return apiError(c, 403, 'forbidden', 'platform_line_is_operator_only');
  const own = await ownNumberFunding(c.env, c.req.param('storeId')!, c.req.param('phoneNumberId')!);
  if (!own) return apiError(c, 404, 'not_found');
  if (own.current === 'platform_line') return apiError(c, 409, 'invalid_request', 'operator_funded');
  const confirm = await issueConfirmation(c.env, { workspaceId: c.req.param('storeId')!, userId: c.get('principal').userId, action: 'number_funding', payload: { phoneNumberId: own.phoneNumberId, funding: 'merchant_card' } });
  return c.json({ phoneNumberId: own.phoneNumberId, current: own.current, funding: 'merchant_card', confirm });
});

walletRoutes.put('/stores/:storeId/numbers/:phoneNumberId/funding', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const body = numberFundingConfirm.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  if (body.data.funding === 'platform_line') return apiError(c, 403, 'forbidden', 'platform_line_is_operator_only');
  const storeId = c.req.param('storeId')!;
  const own = await ownNumberFunding(c.env, storeId, c.req.param('phoneNumberId')!);
  if (!own) return apiError(c, 404, 'not_found');
  if (own.current === 'platform_line') return apiError(c, 409, 'invalid_request', 'operator_funded');
  const p = c.get('principal');
  const used = await consumeConfirmation(c.env, { workspaceId: storeId, userId: p.userId, action: 'number_funding', confirmId: body.data.confirmId, token: body.data.token, payload: { phoneNumberId: own.phoneNumberId, funding: 'merchant_card' } });
  if (used !== 'ok') return confirmRefusal(c, used);
  const r = await setOwnNumberCard(c.env, { workspaceId: storeId, phoneNumberId: own.phoneNumberId, actor: p.userId });
  if (r === 'not_found') return apiError(c, 404, 'not_found');
  if (r === 'operator_funded') return apiError(c, 409, 'invalid_request', 'operator_funded'); // an operator wrote it between the check and the write
  return c.json({ phoneNumberId: own.phoneNumberId, funding: 'merchant_card' });
});

// ---- Yearly package: cancel and refund the unused months (A22). The quote is the operator's own function; confirming files a REQUEST and moves no money. ----
// Super-admin override (reason: money-dispute): /operator/package-orders/:orderId/{refund-quote,yearly-refund} stay; a person executes the request and sends any card refund.
walletRoutes.get('/stores/:storeId/wallet/yearly-refund', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const storeId = c.req.param('storeId')!;
  const [m, req] = await Promise.all([merchantQuote(c.env, storeId), latestRequest(c.env, storeId)]);
  return c.json(yearlyRefundViewDto.parse({ quote: 'quote' in m ? m.quote : null, reason: 'quote' in m ? null : m.reason, request: req ? requestDto(req) : null }));
});

walletRoutes.post('/stores/:storeId/wallet/yearly-refund/preview', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const storeId = c.req.param('storeId')!;
  const m = await merchantQuote(c.env, storeId);
  if (!('quote' in m)) return apiError(c, 409, 'invalid_request', m.reason);
  if (m.quote.unusedMonths <= 0 || m.quote.grossMinor <= 0) return apiError(c, 409, 'invalid_request', 'nothing_to_refund');
  const confirm = await issueConfirmation(c.env, { workspaceId: storeId, userId: c.get('principal').userId, action: 'yearly_refund_request', payload: quotePayload(m.quote) });
  return c.json(yearlyRefundPreviewDto.parse({ quote: m.quote, confirm }));
});

walletRoutes.post('/stores/:storeId/wallet/yearly-refund/requests', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const body = confirmToken.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  const r = await createYearlyRefundRequest(c.env, { workspaceId: c.req.param('storeId')!, userId: c.get('principal').userId, ...body.data });
  if (r.ok) return c.json(requestDto(r.request), 201);
  if (r.reason === 'request_pending' || r.reason === 'nothing_to_refund' || r.reason === 'quote_unavailable') return apiError(c, 409, 'invalid_request', r.reason);
  return confirmRefusal(c, r.reason);
});

// ---- Buy AI credits by card (A9, Chat half). Credits are added ONLY by the verified provider webhook (once per payment), never by these routes. ----
// Super-admin override: an operator wallet adjustment / the package grant stay (goodwill credits); nothing here limits them.
walletRoutes.get('/stores/:storeId/wallet/credit-packs', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  return c.json({ items: await creditPacks(c.env), enabled: creditCheckoutOn(c.env) });
});

walletRoutes.post('/stores/:storeId/wallet/credit-packs/preview', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const body = creditPackPick.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  if (!creditCheckoutOn(c.env)) return apiError(c, 503, 'unavailable', 'disabled');
  const pack = (await creditPacks(c.env)).find((p) => p.id === body.data.packId);
  if (!pack) return apiError(c, 404, 'not_found');
  const confirm = await issueConfirmation(c.env, { workspaceId: c.req.param('storeId')!, userId: c.get('principal').userId, action: 'credit_pack', payload: packPayload(pack) });
  return c.json({ pack, confirm });
});

walletRoutes.post('/stores/:storeId/wallet/credit-packs/orders', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const body = creditPackBuy.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  const p = c.get('principal');
  const r = await startCreditPack(c.env, { workspaceId: c.req.param('storeId')!, userId: p.userId, sessionId: p.sessionId, ...body.data });
  if (r.ok) return c.json(creditOrderDto.parse({ orderId: r.orderId, state: 'pending', credits: r.credits, amountMinor: r.amountMinor, checkoutUrl: r.checkoutUrl }), 201);
  if (r.reason === 'unknown_pack') return apiError(c, 404, 'not_found');
  if (r.reason === 'session_revoked') return apiError(c, 401, 'unauthorized');
  if (r.reason === 'offboarding') return apiError(c, 409, 'invalid_request', 'offboarding_pending'); // OFFBOARD-FREEZE-1
  if (r.reason === 'disabled' || r.reason === 'unavailable') return apiError(c, 503, 'unavailable', r.reason); // nothing was written
  return confirmRefusal(c, r.reason);
});

/** Read only: where the browser lands after paying. It adds no credit; the webhook does. */
walletRoutes.get('/stores/:storeId/wallet/credit-packs/orders/:orderId', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const o = await getCreditOrder(c.env, c.req.param('storeId')!, c.req.param('orderId')!);
  return o ? c.json(creditOrderDto.parse({ orderId: o.order_id, state: o.state, credits: o.credits, amountMinor: o.amount_minor })) : apiError(c, 404, 'not_found');
});
