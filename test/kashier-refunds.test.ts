import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { linkDashboardRefund, reconcileCardRefunds } from '../src/core/billing/card-refunds';
import { createRefundRequest, decideRefund } from '../src/core/billing/refunds';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, OP2, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { fund, ledger } from './helpers/billing';
import { decideAdjustment } from '../src/core/billing/operator';
import { detailsFetch, kashierLedger, kashierRefunds, testKashier } from './helpers/kashier';
import { signedWebhook } from './helpers/kashier-webhook';
import { seedNumber, workspace } from './helpers/workspace';

useApiKey();
const DAY = 86_400_000;
const W = (n: number) => W0(9400 + n);
type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
/** What Kashier's refund route answers (set per test); the details GET is the shared stub. */
let refundAnswer: () => Promise<Response> = async () => refundOk('TX-RF-DEFAULT', 15000);
const refundOk = (id: string, minor: number, status = 'SUCCESS') =>
  Response.json({ status: 'SUCCESS', transactionId: id, response: { status, operation: 'refund', transactionId: id, amount: minor / 100, currency: 'EGP' }, messages: { en: 'ok' } });
const fetchK = async (url: string, init?: RequestInit): Promise<Response> => {
  if (init?.method === 'PUT') {
    calls.push({ url, method: 'PUT', body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return refundAnswer();
  }
  return detailsFetch(url);
};
const kashier = testKashier(fetchK);
const puts = () => calls.filter((c) => c.method === 'PUT');
beforeEach(() => { configureSessionCheck(async () => false); calls = []; refundAnswer = async () => refundOk('TX-RF-DEFAULT', 15000); configurePayments(() => kashier); });
afterEach(() => { configureSessionCheck(null); configurePayments((e) => (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY ? new KashierProvider(e.KASHIER_MERCHANT_ID, e.KASHIER_API_KEY) : null)); vi.restoreAllMocks(); });
const OFF = { ...env, KASHIER_REFUNDS_ENABLED: undefined } as typeof env;

/** A cancelled workspace with one paid card top-up (20000 credited, 300 card fee on top) and a refund request for `ask`. */
async function setup(n: number, ask = 15000, o: { amount?: number; fee?: number } = {}) {
  const ws = W(n);
  const amount = o.amount ?? 20000;
  const fee = o.fee ?? 300;
  await seedNumber(`pn-kr${n}`, ws);
  const end = Date.now() - 2 * DAY;
  await workspace(ws).applyEntitlement({ version: 1, packageId: 'p', status: 'cancelled', periodStart: end - 30 * DAY, periodEnd: end, cancelledAt: end - DAY });
  await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at, transaction_id, paid_at) VALUES (?, ?, ?, ?, ?, 'EGP', 'paid', 'u', 1, ?, 5)")
    .bind(`o-kr${n}`, ws, amount, fee, amount + fee, `TX-KR${n}`).run();
  kashierLedger.set(`TX-KR${n}`, { operation: 'pay', status: 'SUCCESS', orderId: `o-kr${n}` });
  await fund(ws, amount, `kashier:TX-KR${n}`);
  const r = await createRefundRequest(env, { workspaceId: ws, userId: 'u1', amountMinor: ask });
  if (!r.ok) throw new Error(r.reason);
  return { ws, order: `o-kr${n}`, tx: `TX-KR${n}`, id: r.request.id };
}
const hookRefund = async (order: string, refundTx: string, amountEgp: string, status = 'SUCCESS', genuine?: string) => {
  const { body, sig } = await signedWebhook({ merchantOrderId: order, transactionId: refundTx, amount: amountEgp, status }, 'refund', genuine);
  return handleProviderWebhook(env, body, sig, kashier);
};
const kinds = async (ws: string) => (await ledger(ws)).map((r) => [r.kind, r.amount_minor]);
const req = (id: string) => env.DB.prepare('SELECT state, card_refunded_minor, manual_minor FROM refund_requests WHERE id = ?').bind(id).first<{ state: string; card_refunded_minor: number; manual_minor: number }>();
const rowsOf = (id: string) => env.DB.prepare('SELECT state, source, amount_minor, kashier_refund_id FROM card_refunds WHERE request_id = ? ORDER BY id').bind(id).all().then((x) => x.results);
const refunded = (order: string) => env.DB.prepare('SELECT refunded_minor FROM topups WHERE order_id = ?').bind(order).first<{ refunded_minor: number }>().then((x) => x!.refunded_minor);

describe('KashierProvider.refund: the documented refund operation', () => {
  it('reads Kashier\'s order id from the paid transaction, PUTs the documented body, and maps a clean SUCCESS', async () => {
    kashierLedger.set('TX-U1', { operation: 'pay', status: 'SUCCESS', orderId: 'o-u1' });
    refundAnswer = async () => refundOk('TX-RF-U1', 15000);
    expect(await kashier.refund({ transactionId: 'TX-U1', amountMinor: 15000, reason: 'refund-request:r1:1' })).toEqual({ ok: true, refundId: 'TX-RF-U1', status: 'SUCCESS' });
    expect(puts()).toEqual([{ url: 'https://api.kashier.io/v3/payment/refund/KO-TX-U1', method: 'PUT', body: { apiOperation: 'REFUND', reason: 'refund-request:r1:1', transaction: { amount: 150 } } }]);
  });
  it('PENDING is ok+PENDING; an explicit FAILURE, a 4xx are rejected', async () => {
    kashierLedger.set('TX-U2', { operation: 'pay', status: 'SUCCESS', orderId: 'o-u2' });
    refundAnswer = async () => refundOk('TX-RF-U2', 1000, 'PENDING');
    expect(await kashier.refund({ transactionId: 'TX-U2', amountMinor: 1000 })).toEqual({ ok: true, refundId: 'TX-RF-U2', status: 'PENDING' });
    refundAnswer = async () => Response.json({ status: 'SUCCESS', response: { status: 'FAILURE', operation: 'refund' } });
    expect(await kashier.refund({ transactionId: 'TX-U2', amountMinor: 1000 })).toEqual({ ok: false, reason: 'rejected' });
    refundAnswer = async () => new Response('no permission', { status: 401 });
    expect(await kashier.refund({ transactionId: 'TX-U2', amountMinor: 1000 })).toEqual({ ok: false, reason: 'rejected' });
  });
  it('anything that might mean "processed" is uncertain, never a retry: 5xx, a thrown request, unreadable JSON, a 200 for another amount or without a refund id', async () => {
    kashierLedger.set('TX-U3', { operation: 'pay', status: 'SUCCESS', orderId: 'o-u3' });
    for (const answer of [
      async () => new Response('boom', { status: 502 }),
      async () => { throw new Error('timeout'); },
      async () => new Response('<html>', { status: 200 }),
      async () => refundOk('TX-RF-U3', 999),
      async () => Response.json({ status: 'SUCCESS', response: { status: 'SUCCESS', operation: 'refund', amount: 10 } }),
    ]) {
      refundAnswer = answer;
      expect(await kashier.refund({ transactionId: 'TX-U3', amountMinor: 1000 })).toEqual({ ok: false, reason: 'uncertain' });
    }
  });
  it('without Kashier\'s order id (or a paid transaction) nothing is sent at all', async () => {
    kashierLedger.set('TX-U4', { operation: 'pay', status: 'SUCCESS', orderId: 'o-u4' });
    const noOrder = testKashier(async (url, init) => (init?.method === 'PUT' ? refundAnswer() : Response.json({ body: { transactionId: 'TX-U4', trxType: 'payment', status: 'SUCCESS', merchantOrderId: 'o-u4' } })));
    expect(await noOrder.refund({ transactionId: 'TX-U4', amountMinor: 1000 })).toEqual({ ok: false, reason: 'unsupported' });
    kashierLedger.set('TX-U5', { operation: 'pay', status: 'FAILURE', orderId: 'o-u5' });
    expect(await kashier.refund({ transactionId: 'TX-U5', amountMinor: 1000 })).toEqual({ ok: false, reason: 'unsupported' });
    expect(await kashier.refund({ transactionId: 'bad/../id', amountMinor: 1000 })).toEqual({ ok: false, reason: 'unsupported' });
    expect(puts()).toEqual([]);
  });
});

describe('approval with KASHIER_REFUNDS_ENABLED', () => {
  it('success: one wallet debit, a recorded card refund, refunded_minor in wallet units; the refund\'s own webhook (and its replay) debits nothing more', async () => {
    const { ws, id, order } = await setup(1);
    refundAnswer = async () => refundOk('TX-RF1', 15000);
    const r = await decideRefund(env, { id, decision: 'approve', actor: OP1 });
    expect(r).toMatchObject({ ok: true, request: { state: 'paid', cardRefundedMinor: 15000, manualMinor: 0 } });
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect(await rowsOf(id)).toEqual([{ state: 'succeeded', source: 'api', amount_minor: 15000, kashier_refund_id: 'TX-RF1' }]);
    expect(await refunded(order)).toBe(15000);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]!.body).toMatchObject({ reason: `refund-request:${id}:1`, transaction: { amount: 150 } });
    expect((await hookRefund(order, 'TX-RF1', '150.00')).status).toBe(200);
    expect((await hookRefund(order, 'TX-RF1', '150.00')).status).toBe(200);
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect(await refunded(order)).toBe(15000);
    expect(await req(id)).toEqual({ state: 'paid', card_refunded_minor: 15000, manual_minor: 0 });
  });
  it('rejected: falls back to a manual payout, debited once, no card refund recorded as done', async () => {
    const { ws, id, order } = await setup(2);
    refundAnswer = async () => new Response('nope', { status: 403 });
    expect(await decideRefund(env, { id, decision: 'approve', actor: OP1 })).toMatchObject({ ok: true, request: { state: 'manual_payout', cardRefundedMinor: 0, manualMinor: 15000 } });
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect((await rowsOf(id))[0]).toMatchObject({ state: 'failed' });
    expect(await refunded(order)).toBe(0);
  });
  it('timeout: the request stays processing, the provider is asked once, the wallet is debited once; the refund webhook settles it with no second debit', async () => {
    const { ws, id, order } = await setup(3);
    refundAnswer = async () => { throw new Error('timeout'); };
    expect(await decideRefund(env, { id, decision: 'approve', actor: OP1 })).toMatchObject({ ok: true, request: { state: 'processing', cardRefundedMinor: 0, manualMinor: 0 } });
    expect((await rowsOf(id))[0]).toMatchObject({ state: 'uncertain', kashier_refund_id: null });
    expect((await decideRefund(env, { id, decision: 'approve', actor: OP1 })).ok).toBe(false); // never twice
    expect(puts()).toHaveLength(1);
    expect(await hookRefund(order, 'TX-RF3', '150.00')).toMatchObject({ status: 200 }); // Kashier did process it after all
    expect(await rowsOf(id)).toEqual([{ state: 'succeeded', source: 'api', amount_minor: 15000, kashier_refund_id: 'TX-RF3' }]);
    expect(await req(id)).toEqual({ state: 'paid', card_refunded_minor: 15000, manual_minor: 0 });
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect(await hookRefund(order, 'TX-RF3', '150.00')).toMatchObject({ status: 200 });
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect(await refunded(order)).toBe(15000);
    expect(puts()).toHaveLength(1);
  });
  it('PENDING: stays processing; the webhook by refund id settles it; a FAILURE webhook turns it into a manual payout', async () => {
    const a = await setup(4);
    refundAnswer = async () => refundOk('TX-RF4', 15000, 'PENDING');
    expect(await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 })).toMatchObject({ request: { state: 'processing' } });
    await hookRefund(a.order, 'TX-RF4', '150.00');
    expect(await req(a.id)).toEqual({ state: 'paid', card_refunded_minor: 15000, manual_minor: 0 });
    const b = await setup(5);
    refundAnswer = async () => refundOk('TX-RF5', 15000, 'PENDING');
    await decideRefund(env, { id: b.id, decision: 'approve', actor: OP1 });
    await hookRefund(b.order, 'TX-RF5', '150.00', 'FAILURE');
    expect(await req(b.id)).toEqual({ state: 'manual_payout', card_refunded_minor: 0, manual_minor: 15000 });
    expect(await kinds(b.ws)).toEqual([['topup', 20000], ['refund', -15000]]);
  });
  it('a webhook that lands while the call is still in flight is matched to the row written before it, not booked again', async () => {
    const { ws, id, order } = await setup(6);
    refundAnswer = async () => { await hookRefund(order, 'TX-RF6', '150.00'); return refundOk('TX-RF6', 15000); };
    expect(await decideRefund(env, { id, decision: 'approve', actor: OP1 })).toMatchObject({ ok: true, request: { state: 'paid', cardRefundedMinor: 15000 } });
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect(await refunded(order)).toBe(15000);
  });
  it('switch off (the default): the provider is never called and the result is the manual payout it always was', async () => {
    const { ws, id, order } = await setup(7);
    expect(await decideRefund(OFF, { id, decision: 'approve', actor: OP1 })).toMatchObject({ ok: true, request: { state: 'manual_payout', cardRefundedMinor: 0, manualMinor: 15000 } });
    expect(puts()).toEqual([]);
    expect(await rowsOf(id)).toEqual([]);
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect(await refunded(order)).toBe(0);
  });
  it('the details lack Kashier\'s order id: nothing is sent and the refund is a manual payout', async () => {
    const { id } = await setup(8);
    configurePayments(() => testKashier(async (url, init) => (init?.method === 'PUT' ? refundAnswer() : Response.json({ body: { transactionId: url.split('/').pop(), trxType: 'payment', status: 'SUCCESS' } }))));
    expect(await decideRefund(env, { id, decision: 'approve', actor: OP1 })).toMatchObject({ request: { state: 'manual_payout', manualMinor: 15000 } });
    expect(puts()).toEqual([]);
  });
  it('an open card refund reserves its part of the top-up: a second request cannot be sent for the same money', async () => {
    const a = await setup(9, 15000);
    refundAnswer = async () => { throw new Error('timeout'); };
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    const second = await createRefundRequest(env, { workspaceId: a.ws, userId: 'u1', amountMinor: 5000 });
    expect(second.ok).toBe(false); // 20000 - 15000 leaves 5000 but the open request already counts against the balance
  });
});

/** Kashier lists this refund for the order and its details say what it really is (the proof the relink asks for). */
const kashierHasRefund = (order: string, refundId: string, amount: string, operation = 'refund') => {
  kashierRefunds.set(order, [...(kashierRefunds.get(order) ?? []), { transactionId: refundId, amount }]);
  kashierLedger.set(refundId, { operation, status: 'SUCCESS', orderId: order });
};
const link = (id: string, refundId: string, amountMinor: number, extra: Record<string, unknown> = {}, e: typeof env = env) => linkDashboardRefund(e, { requestId: id, kashierRefundId: refundId, amountMinor, actor: OP1, ...extra }, Date.now(), kashier);
const alertsOf = (spy: { mock: { calls: unknown[][] } }, what: string) => spy.mock.calls.filter((c) => String(c[0]).includes(what));

describe('the refund webhook never debits money already debited at approval', () => {
  it('a manual payout the operator refunded in Kashier\'s dashboard and linked (Kashier confirms it): its webhook (and replay) debits nothing more', async () => {
    const { ws, id, order } = await setup(10);
    await decideRefund(OFF, { id, decision: 'approve', actor: OP1 });
    kashierHasRefund(order, 'DASH-10', '150.00');
    expect(await link(id, 'DASH-10', 15000)).toMatchObject({ ok: true });
    expect(await req(id)).toEqual({ state: 'paid', card_refunded_minor: 15000, manual_minor: 0 });
    await hookRefund(order, 'DASH-10', '150.00');
    await hookRefund(order, 'DASH-10', '150.00');
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect(await refunded(order)).toBe(15000);
    expect(await link(id, 'DASH-10', 15000)).toMatchObject({ ok: false });
  });
  it('the relink first asks Kashier: an id Kashier does not list, a reversal, or another amount is refused and records nothing', async () => {
    const { id, order } = await setup(16);
    await decideRefund(OFF, { id, decision: 'approve', actor: OP1 });
    expect(await link(id, 'GHOST-16', 15000)).toMatchObject({ ok: false, reason: 'refund_not_verified' });
    kashierHasRefund(order, 'REV-16', '150.00', 'reversal');
    expect(await link(id, 'REV-16', 15000)).toMatchObject({ ok: false, reason: 'refund_not_verified' });
    kashierHasRefund(order, 'AMT-16', '99.00');
    expect(await link(id, 'AMT-16', 15000)).toMatchObject({ ok: false, reason: 'refund_not_verified' });
    expect(await rowsOf(id)).toEqual([]);
    const noList = Object.assign(Object.create(kashier) as PaymentProvider, { listRefunds: async () => 'unavailable' as const });
    kashierHasRefund(order, 'OK-16', '150.00');
    expect(await linkDashboardRefund(env, { requestId: id, kashierRefundId: 'OK-16', amountMinor: 15000, actor: OP1 }, Date.now(), noList)).toMatchObject({ ok: false, reason: 'provider_unavailable' });
    expect(await req(id)).toMatchObject({ state: 'manual_payout' });
  });
  it('the webhook arrived BEFORE the link: the duplicate debit comes back only through the adjustment flow (self-approved below the threshold)', async () => {
    const { ws, id, order } = await setup(11);
    await decideRefund(OFF, { id, decision: 'approve', actor: OP1 });
    await hookRefund(order, 'DASH-11', '150.00'); // unknown at this point: debits
    expect((await kinds(ws)).map((k) => k[0])).toEqual(['topup', 'refund', 'chargeback']);
    kashierHasRefund(order, 'DASH-11', '150.00');
    expect(await link(id, 'DASH-11', 15000)).toMatchObject({ ok: true });
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000], ['chargeback', -15000], ['adjustment', 15000]]);
    expect((await workspace(ws).walletView()).balanceMinor).toBe(5000);
    await hookRefund(order, 'DASH-11', '150.00');
    expect((await kinds(ws)).length).toBe(4);
    expect(await refunded(order)).toBe(15000);
    expect(await req(id)).toEqual({ state: 'paid', card_refunded_minor: 15000, manual_minor: 0 });
  });
  it('above ADJUSTMENT_APPROVAL_MINOR the credit waits for a SECOND operator: the requester cannot approve their own link', async () => {
    const { ws, id, order } = await setup(17);
    await decideRefund(OFF, { id, decision: 'approve', actor: OP1 });
    await hookRefund(order, 'DASH-17', '150.00');
    kashierHasRefund(order, 'DASH-17', '150.00');
    const low = { ...env, ADJUSTMENT_APPROVAL_MINOR: '10000' } as typeof env;
    const r = await link(id, 'DASH-17', 15000, {}, low);
    expect(r).toMatchObject({ ok: true, adjustment: { state: 'pending' } });
    expect((await kinds(ws)).map((k) => k[0])).toEqual(['topup', 'refund', 'chargeback']); // nothing credited yet
    const adjId = (r as { adjustment: { id: string } }).adjustment.id;
    expect(await decideAdjustment(env, { actor: OP1, id: adjId, decision: 'approve' })).toMatchObject({ ok: false, reason: 'second_approver_required' });
    expect(await decideAdjustment(env, { actor: OP2, id: adjId, decision: 'approve' })).toMatchObject({ ok: true });
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000], ['chargeback', -15000], ['adjustment', 15000]]);
  });
  it('link validation: only a manual payout, not more than is owed manually, a plain provider id; and it is reachable by the operator API', async () => {
    const { id, order } = await setup(12);
    expect(await link(id, 'X-1', 100)).toMatchObject({ reason: 'not_manual_payout' });
    await decideRefund(OFF, { id, decision: 'approve', actor: OP1 });
    expect(await link(id, 'x/../y', 100)).toMatchObject({ reason: 'invalid_refund_id' });
    expect(await link(id, 'X-2', 15001)).toMatchObject({ reason: 'exceeds_manual' });
    expect(await link('nope', 'X-3', 100)).toMatchObject({ reason: 'not_found' });
    kashierHasRefund(order, 'X-4', '50.00');
    configurePayments(() => kashier);
    const res = await operatorCall(OP1, 'POST', `/refund-requests/${id}/link-dashboard-refund`, { kashierRefundId: 'X-4', amountMinor: 5000 });
    expect(res.status).toBe(200);
    expect(await req(id)).toEqual({ state: 'manual_payout', card_refunded_minor: 5000, manual_minor: 10000 });
  });
  it('an unknown chargeback debits its FULL amount up to what the top-up credited (even past the cap that used to drop it), the excess goes to a person with a P1 alert, and a replay changes nothing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ws, order } = await setup(13, 5000);
    await hookRefund(order, 'CB-13', '999.00', 'SUCCESS', 'reversal');
    await hookRefund(order, 'CB-13', '999.00', 'SUCCESS', 'reversal');
    expect(await kinds(ws)).toEqual([['topup', 20000], ['chargeback', -20000]]);
    expect(alertsOf(spy, 'refund_excess_for_review')).toHaveLength(1);
    expect(String(alertsOf(spy, 'refund_excess_for_review')[0]![0])).toContain('"severity":"P1"');
    expect(await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE action = 'refund_excess_review' AND reason = 'CB-13'").first()).toEqual({ n: 1 });
    await hookRefund(order, 'CB-13b', '10.00', 'SUCCESS', 'reversal'); // a second one is not silently dropped because the first used the cap
    expect(await kinds(ws)).toEqual([['topup', 20000], ['chargeback', -20000], ['chargeback', -1000]]);
  });
  it('a full refund of a payment that carried a card fee never debits the fee, and the fee is not an "excess" for review', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ws, order } = await setup(14, 5000, { amount: 20000, fee: 300 });
    await hookRefund(order, 'FULL-14', '203.00');
    expect(await kinds(ws)).toEqual([['topup', 20000], ['chargeback', -20000]]);
    expect(alertsOf(spy, 'refund_excess_for_review')).toHaveLength(0);
  });
  it('unknown partial refunds each debit their own amount (never shrunk by what earlier ones or our own refunds used)', async () => {
    const { ws, order } = await setup(15, 5000);
    await hookRefund(order, 'P-15a', '120.00');
    await hookRefund(order, 'P-15b', '60.00');
    expect(await kinds(ws)).toEqual([['topup', 20000], ['chargeback', -12000], ['chargeback', -6000]]);
  });
  it('a chargeback is never reduced by an open card refund\'s reservation, and never settles that open refund', async () => {
    const { ws, id, order } = await setup(30);
    refundAnswer = async () => { throw new Error('timeout'); };
    await decideRefund(env, { id, decision: 'approve', actor: OP1 });
    await hookRefund(order, 'CB-30', '150.00', 'SUCCESS', 'reversal'); // same amount as our open refund
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000], ['chargeback', -15000]]);
    expect((await rowsOf(id))[0]).toMatchObject({ state: 'uncertain', kashier_refund_id: null });
    expect(await req(id)).toMatchObject({ state: 'processing' });
  });
  it('only a real refund operation may settle an open card refund: a void with the same amount, or a refund while our row already has another id, books as unknown instead', async () => {
    const a = await setup(31);
    refundAnswer = async () => { throw new Error('timeout'); };
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    await hookRefund(a.order, 'VOID-31', '150.00', 'SUCCESS', 'void');
    expect((await rowsOf(a.id))[0]).toMatchObject({ state: 'uncertain', kashier_refund_id: null });
    expect((await kinds(a.ws)).map((k) => k[0])).toEqual(['topup', 'refund', 'chargeback']);
    const b = await setup(32);
    refundAnswer = async () => refundOk('TX-RF32', 15000, 'PENDING');
    await decideRefund(env, { id: b.id, decision: 'approve', actor: OP1 });
    await hookRefund(b.order, 'OTHER-32', '150.00'); // a refund with another id: ours has its own id and is not guessed
    expect((await rowsOf(b.id))[0]).toMatchObject({ state: 'pending', kashier_refund_id: 'TX-RF32' });
    expect((await kinds(b.ws)).map((k) => k[0])).toEqual(['topup', 'refund', 'chargeback']);
  });
});

describe('reconciling refunds nobody answered for', () => {
  it('an uncertain refund that Kashier lists as done is settled by the daily pass; nothing is re-sent; a pending one is read by its id', async () => {
    const a = await setup(20);
    refundAnswer = async () => { throw new Error('timeout'); };
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    const listing: PaymentProvider = Object.assign(Object.create(kashier) as PaymentProvider, { listRefunds: async (o: string) => (o === a.order ? [{ refundId: 'TX-RL20', status: 'SUCCESS' as const, amountMinor: 15000, operation: 'refund' }] : []) });
    const later = Date.now() + 20 * 60_000;
    // the file shares one D1: other tests' open rows are in the pass too, so this one is checked by its own request
    expect((await reconcileCardRefunds(env, listing, later)).settled).toBeGreaterThanOrEqual(1);
    expect(await req(a.id)).toEqual({ state: 'paid', card_refunded_minor: 15000, manual_minor: 0 });
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect(puts()).toHaveLength(1);
    const b = await setup(21);
    refundAnswer = async () => refundOk('TX-RL21', 15000, 'PENDING');
    await decideRefund(env, { id: b.id, decision: 'approve', actor: OP1 });
    kashierLedger.set('TX-RL21', { operation: 'refund', status: 'SUCCESS', orderId: b.order });
    expect((await reconcileCardRefunds(env, kashier, later)).settled).toBeGreaterThanOrEqual(1);
    expect(await req(b.id)).toEqual({ state: 'paid', card_refunded_minor: 15000, manual_minor: 0 });
  });
  it('unresolved for 3 days: one alert for a person, still nothing re-sent and still processing', async () => {
    const a = await setup(22);
    refundAnswer = async () => { throw new Error('timeout'); };
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const empty: PaymentProvider = Object.assign(Object.create(kashier) as PaymentProvider, { listRefunds: async () => [] });
    const late = Date.now() + 4 * DAY;
    await reconcileCardRefunds(env, empty, late);
    await reconcileCardRefunds(env, empty, late + 1000);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('card_refund_stuck') && String(c[0]).includes(`cr:${a.id}:1`))).toHaveLength(1);
    expect(await req(a.id)).toMatchObject({ state: 'processing' });
    expect(puts()).toHaveLength(1);
  });
});

describe('review round 3: one operation predicate, an idempotent relink credit, no debit when another path owns the id', () => {
  it('the reconciler never settles our refund with a reversal (or void): the provider only lists real card refunds, and the pass applies the same predicate', async () => {
    const a = await setup(40);
    refundAnswer = async () => { throw new Error('timeout'); };
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    const later = Date.now() + 20 * 60_000;
    const lying: PaymentProvider = Object.assign(Object.create(kashier) as PaymentProvider, { listRefunds: async (o: string) => (o === a.order ? [{ refundId: 'REV-40', status: 'SUCCESS' as const, amountMinor: 15000, operation: 'reversal' }, { refundId: 'VOID-40', status: 'SUCCESS' as const, amountMinor: 15000, operation: 'void' }] : []) });
    await reconcileCardRefunds(env, lying, later);
    expect((await rowsOf(a.id))[0]).toMatchObject({ state: 'uncertain', kashier_refund_id: null });
    // through the real provider: a reversal in Kashier's list is not even returned
    kashierRefunds.set(a.order, []);
    kashierHasRefund(a.order, 'REV-40b', '150.00', 'reversal');
    kashierHasRefund(a.order, 'RF-40b', '150.00', 'partial_refund');
    expect(await kashier.listRefunds(a.order)).toEqual([{ refundId: 'RF-40b', status: 'SUCCESS', amountMinor: 15000, operation: 'partial_refund' }]);
  });

  it('a relink that fails AFTER the credit was requested keeps the claim; the retry creates no second adjustment (exactly one credit)', async () => {
    const { ws, id, order } = await setup(41);
    await decideRefund(OFF, { id, decision: 'approve', actor: OP1 });
    await hookRefund(order, 'DASH-41', '150.00'); // booked as unknown first: the wallet was debited twice
    kashierHasRefund(order, 'DASH-41', '150.00');
    let armed = true;
    const flaky = { ...env, DB: new Proxy(env.DB, { get(t, p) {
      if (p === 'prepare') return (sql: string) => { if (armed && sql.includes("'refund_dashboard_linked'")) { armed = false; throw new Error('db down after the credit was requested'); } return t.prepare(sql); };
      const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v;
    } }) } as typeof env;
    await expect(link(id, 'DASH-41', 15000, {}, flaky)).rejects.toThrow();
    expect((await rowsOf(id))[0]).toMatchObject({ source: 'dashboard', state: 'linked' }); // the claim is NOT undone once the adjustment exists
    expect((await env.DB.prepare("SELECT count(*) AS n FROM wallet_adjustments WHERE id = 'relink:DASH-41'").first<{ n: number }>())!.n).toBe(1);
    const again = await link(id, 'DASH-41', 15000);
    expect(again).toMatchObject({ ok: true, adjustment: { id: 'relink:DASH-41' } });
    await link(id, 'DASH-41', 15000);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM wallet_adjustments WHERE workspace_id = ?").bind(ws).first<{ n: number }>())!.n).toBe(1);
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000], ['chargeback', -15000], ['adjustment', 15000]]);
    expect(await req(id)).toEqual({ state: 'paid', card_refunded_minor: 15000, manual_minor: 0 });
  });

  it('another path (a link) took the refund id between the webhook\'s read and its write: the webhook reconciles and posts NO chargeback', async () => {
    const { ws, id, order } = await setup(42);
    await decideRefund(OFF, { id, decision: 'approve', actor: OP1 });
    let armed = true;
    const racing = { ...env, DB: new Proxy(env.DB, { get(t, p) {
      if (p === 'batch') return async (s: D1PreparedStatement[]) => {
        if (armed) { armed = false; await t.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at) VALUES ('dash:TX-RACE', ?, ?, ?, 15000, 'dashboard', 'linked', 'TX-RACE', 1, 1)").bind(id, order, ws).run(); }
        return t.batch(s);
      };
      const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v;
    } }) } as typeof env;
    const { body, sig } = await signedWebhook({ merchantOrderId: order, transactionId: 'TX-RACE', amount: '150.00' }, 'refund', 'reversal');
    expect((await handleProviderWebhook(racing, body, sig, kashier)).status).toBe(200);
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000]]);
  });

  it('a chargeback / reversal whose id equals a refund row another path owns is never reconciled: P1 alert + a review item, nothing settled, nothing debited (read first, and when the row appears between read and write)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = await setup(43);
    refundAnswer = async () => refundOk('TX-OWN43', 15000, 'PENDING');
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    await hookRefund(a.order, 'TX-OWN43', '150.00', 'SUCCESS', 'reversal');
    expect((await rowsOf(a.id))[0]).toMatchObject({ state: 'pending', kashier_refund_id: 'TX-OWN43' });
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect(alertsOf(spy, 'refund_id_conflict').length).toBeGreaterThanOrEqual(1);
    expect(String(alertsOf(spy, 'refund_id_conflict')[0]![0])).toContain('"severity":"P1"');
    expect(await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE action = 'refund_id_conflict' AND reason = 'TX-OWN43'").first()).toEqual({ n: 1 });
    // the same collision, but the owner appears after the webhook's read (the insert is ignored)
    const b = await setup(44);
    await decideRefund(OFF, { id: b.id, decision: 'approve', actor: OP1 });
    let armed = true;
    const racing = { ...env, DB: new Proxy(env.DB, { get(t, p) {
      if (p === 'batch') return async (st: D1PreparedStatement[]) => {
        if (armed) { armed = false; await t.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at) VALUES ('cr:race44', ?, ?, ?, 15000, 'api', 'pending', 'TX-OWN44', 1, 1)").bind(b.id, b.order, b.ws).run(); }
        return t.batch(st);
      };
      const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v;
    } }) } as typeof env;
    const { body, sig } = await signedWebhook({ merchantOrderId: b.order, transactionId: 'TX-OWN44', amount: '150.00' }, 'refund', 'reversal');
    expect((await handleProviderWebhook(racing, body, sig, kashier)).status).toBe(200);
    expect((await env.DB.prepare("SELECT state FROM card_refunds WHERE id = 'cr:race44'").first())).toEqual({ state: 'pending' });
    expect(await kinds(b.ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect(alertsOf(spy, 'refund_id_conflict').some((c) => String(c[0]).includes('"orderId":"' + b.order + '"'))).toBe(true);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE action = 'refund_id_conflict' AND reason = 'TX-OWN44'").first()).toEqual({ n: 1 });
  });
});

