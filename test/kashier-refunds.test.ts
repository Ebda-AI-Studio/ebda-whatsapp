import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { abandonRefundRequest, linkDashboardRefund, reverseUnreversedChunks, sweepAbandonedRefunds, matchHeldRefund, reconcileCardRefunds } from '../src/core/billing/card-refunds';
import { createRefundRequest, decideRefund } from '../src/core/billing/refunds';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { dailyBilling } from '../src/index';
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
  it('the webhook arrived BEFORE the link: the duplicate debit comes back only through the adjustment flow, and a relink ALWAYS needs a second approver (even below the threshold)', async () => {
    const { ws, id, order } = await setup(11);
    await decideRefund(OFF, { id, decision: 'approve', actor: OP1 });
    await hookRefund(order, 'DASH-11', '150.00'); // unknown at this point: debits
    expect((await kinds(ws)).map((k) => k[0])).toEqual(['topup', 'refund', 'chargeback']);
    kashierHasRefund(order, 'DASH-11', '150.00');
    const r = await link(id, 'DASH-11', 15000);
    expect(r).toMatchObject({ ok: true, adjustment: { id: 'relink:DASH-11', state: 'pending' } });
    expect((await kinds(ws)).map((k) => k[0])).toEqual(['topup', 'refund', 'chargeback']); // nothing credited by one operator's click
    expect(await decideAdjustment(env, { actor: OP1, id: 'relink:DASH-11', decision: 'approve' })).toMatchObject({ ok: false, reason: 'second_approver_required' });
    expect(await decideAdjustment(env, { actor: OP2, id: 'relink:DASH-11', decision: 'approve' })).toMatchObject({ ok: true });
    expect(await kinds(ws)).toEqual([['topup', 20000], ['refund', -15000], ['chargeback', -15000], ['adjustment', 15000]]);
    expect((await workspace(ws).walletView()).balanceMinor).toBe(5000);
    await hookRefund(order, 'DASH-11', '150.00');
    expect((await kinds(ws)).length).toBe(4);
    expect(await refunded(order)).toBe(15000);
    expect(await req(id)).toEqual({ state: 'paid', card_refunded_minor: 15000, manual_minor: 0 });
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
  it('only a real refund operation may settle an open card refund: a void with the same amount, or a refund while our row already has another id is held (never settled, never debited)', async () => {
    const a = await setup(31);
    refundAnswer = async () => { throw new Error('timeout'); };
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    await hookRefund(a.order, 'VOID-31', '150.00', 'SUCCESS', 'void');
    expect((await rowsOf(a.id))[0]).toMatchObject({ state: 'uncertain', kashier_refund_id: null });
    expect((await kinds(a.ws)).map((k) => k[0])).toEqual(['topup', 'refund', 'chargeback']);
    const b = await setup(32);
    refundAnswer = async () => refundOk('TX-RF32', 15000, 'PENDING');
    await decideRefund(env, { id: b.id, decision: 'approve', actor: OP1 });
    await hookRefund(b.order, 'OTHER-32', '150.00'); // another id, same amount, ours still unconfirmed: never settles our row, and is HELD, not debited
    expect((await rowsOf(b.id))[0]).toMatchObject({ state: 'pending', kashier_refund_id: 'TX-RF32' });
    expect((await kinds(b.ws)).map((k) => k[0])).toEqual(['topup', 'refund']);
    expect(await env.DB.prepare("SELECT state FROM card_refunds WHERE kashier_refund_id = 'OTHER-32'").first()).toEqual({ state: 'held' });
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
    expect(await decideAdjustment(env, { actor: OP2, id: 'relink:DASH-41', decision: 'approve' })).toMatchObject({ ok: true });
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

describe('round 4 (Opus check)', () => {
  it('CRITICAL: Kashier\'s webhook id differs from the id in the refund answer: no second debit, a held record, a P1 alert; replays stay quiet; a chargeback of the same amount is NOT held', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = await setup(50);
    refundAnswer = async () => refundOk('TX-R50', 15000);
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    expect((await hookRefund(a.order, 'TX-W50', '150.00')).status).toBe(200);
    await hookRefund(a.order, 'TX-W50', '150.00');
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['refund', -15000]]); // no chargeback
    expect(alertsOf(spy, 'refund_held')).toHaveLength(1);
    expect(String(alertsOf(spy, 'refund_held')[0]![0])).toContain('"severity":"P1"');
    expect(await env.DB.prepare("SELECT source, state, amount_minor FROM card_refunds WHERE kashier_refund_id = 'TX-W50'").first()).toEqual({ source: 'held', state: 'held', amount_minor: 15000 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE action = 'refund_held' AND reason = 'TX-W50'").first()).toEqual({ n: 1 });
    expect(await refunded(a.order)).toBe(15000);
    // a chargeback of the same amount is a different thing: it still debits in full
    await hookRefund(a.order, 'CB-W50', '150.00', 'SUCCESS', 'reversal');
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['refund', -15000], ['chargeback', -15000]]);
  });
  it('CRITICAL: the operator matches the held refund to the request (Kashier must list it): reconciled, the wallet does not move, and the replayed webhook is quiet', async () => {
    const a = await setup(51);
    refundAnswer = async () => refundOk('TX-R51', 15000);
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    await hookRefund(a.order, 'TX-W51', '150.00');
    expect((await operatorCall(OP1, 'POST', '/card-refunds/held/TX-W51/match', {})).status).toBe(409); // Kashier does not list it yet
    kashierHasRefund(a.order, 'TX-W51', '150.00');
    configurePayments(() => kashier);
    expect((await operatorCall(OP1, 'POST', '/card-refunds/held/TX-W51/match', {})).status).toBe(200);
    expect(await env.DB.prepare("SELECT state FROM card_refunds WHERE kashier_refund_id = 'TX-W51'").first()).toEqual({ state: 'matched' });
    expect(await env.DB.prepare('SELECT confirmed_at IS NOT NULL AS c FROM card_refunds WHERE kashier_refund_id = ?').bind('TX-R51').first()).toEqual({ c: 1 });
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['refund', -15000]]);
    expect((await hookRefund(a.order, 'TX-W51', '150.00')).status).toBe(200);
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['refund', -15000]]);
  });
  it('CRITICAL: a refund the webhook already confirmed is not a candidate: a separate refund of the same amount debits as an unknown one', async () => {
    const a = await setup(54);
    refundAnswer = async () => refundOk('TX-R54', 15000);
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    await hookRefund(a.order, 'TX-R54', '150.00'); // the normal order: the same id, confirmed
    await hookRefund(a.order, 'TX-OTHER54', '150.00');
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['refund', -15000], ['chargeback', -15000]]);
  });

  it('IMPORTANT: all wallet debits are posted before any provider call; if the debit phase aborts nothing is promoted to a manual payout and no provider call was made', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = await setup(55, 15000);
    const ws = a.ws;
    await env.DB.prepare('UPDATE refund_requests SET amount_minor = 25000 WHERE id = ?').bind(a.id).run();
    await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at, transaction_id, paid_at) VALUES ('o-kr55b', ?, 10000, 0, 10000, 'EGP', 'paid', 'u', 1, 'TX-KR55b', 6)").bind(ws).run();
    kashierLedger.set('TX-KR55b', { operation: 'pay', status: 'SUCCESS', orderId: 'o-kr55b' });
    await fund(ws, 10000, 'kashier:TX-KR55b');
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));
    let posts = 0;
    const shrinking = { ...env, WORKSPACE_DO: { idFromName: (n: string) => env.WORKSPACE_DO.idFromName(n), get: () => ({
      walletView: (n?: number) => real.walletView(n),
      postWallet: async (x: Parameters<typeof real.postWallet>[0], n?: number) => (x.kind === 'refund' && ++posts === 2 ? { ok: false as const, reason: 'insufficient' as never } : real.postWallet(x, n)),
    }) } } as unknown as typeof env;
    expect(await decideRefund(shrinking, { id: a.id, decision: 'approve', actor: OP1 })).toEqual({ ok: false, reason: 'insufficient_balance' });
    expect(puts()).toEqual([]); // no provider call before every debit is posted
    expect(await req(a.id)).toEqual({ state: 'processing', card_refunded_minor: 0, manual_minor: 0 }); // nothing promoted, no manual amount for money never debited
    expect(await kinds(ws)).toEqual([['topup', 20000], ['topup', 10000], ['refund', -20000]]);
    expect(alertsOf(spy, 'refund_debit_incomplete')).toHaveLength(1);
  });

  it('IMPORTANT: switch off + a refund the provider reports for a top-up that credited nothing: 200, a review item and a P1, no endless retry; and the double-debit fix itself stays on when the switch is off', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = await setup(56);
    await decideRefund(OFF, { id: a.id, decision: 'approve', actor: OP1 });
    kashierHasRefund(a.order, 'DASH-56', '150.00');
    await link(a.id, 'DASH-56', 15000);
    const { body, sig } = await signedWebhook({ merchantOrderId: a.order, transactionId: 'DASH-56', amount: '150.00' }, 'refund');
    expect((await handleProviderWebhook(OFF, body, sig, kashier)).status).toBe(200);
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['refund', -15000]]); // the matched refund is not debited again, switch or no switch
    const { applyProviderRefund } = await import('../src/core/billing/card-refunds');
    const ev = { event: 'refund' as const, status: 'SUCCESS' as const, orderId: 'nowhere', transactionId: 'GHOST-56', amountMinor: 1000, currency: 'EGP', operation: 'refund' };
    expect(await applyProviderRefund(env, { order_id: 'o-gone-56', workspace_id: a.ws }, ev, Date.now())).toBe('refund_unmatched');
    expect(await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE action = 'refund_unmatched_review' AND reason = 'GHOST-56'").first()).toEqual({ n: 1 });
    expect(alertsOf(spy, 'refund_unmatched_no_credit').length).toBeGreaterThanOrEqual(1);
  });

  it('a refund id that a recorded webhook debit already owns, when our own answer reports it, raises a P1 (never silent)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = await setup(57, 5000, { amount: 40000 });
    await hookRefund(a.order, 'TX-W57', '150.00'); // an unknown refund: debited under wh:TX-W57
    await fund(a.ws, 20000, 'kashier:extra57');
    refundAnswer = async () => refundOk('TX-W57', 5000);
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    expect(alertsOf(spy, 'refund_id_conflict').length).toBeGreaterThanOrEqual(1);
    expect(String(alertsOf(spy, 'refund_id_conflict')[0]![0])).toContain('"severity":"P1"');
  });

  it('a crash-left `sending` row: the operator marks it failed (manual payout) only after Kashier\'s refund list shows nothing for it', async () => {
    const a = await setup(58);
    refundAnswer = async () => { throw new Error('timeout'); };
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    const crId = `cr:${a.id}:1`;
    const url = `/refund-requests/${a.id}/card-refunds/${encodeURIComponent(crId)}/mark-failed`;
    configurePayments(() => kashier);
    kashierHasRefund(a.order, 'TX-LIVE58', '150.00');
    expect((await operatorCall(OP1, 'POST', url, {})).status).toBe(409); // Kashier shows a refund for it
    expect((await rowsOf(a.id))[0]).toMatchObject({ state: 'uncertain' });
    kashierRefunds.set(a.order, []);
    expect((await operatorCall(OP1, 'POST', url, {})).status).toBe(200);
    expect(await req(a.id)).toEqual({ state: 'manual_payout', card_refunded_minor: 0, manual_minor: 15000 });
  });

  it('partial_refund is accepted as a refund answer', async () => {
    kashierLedger.set('TX-U60', { operation: 'pay', status: 'SUCCESS', orderId: 'o-u60' });
    refundAnswer = async () => Response.json({ status: 'SUCCESS', response: { status: 'SUCCESS', operation: 'partial_refund', transactionId: 'TX-RF60', amount: 10 } });
    expect(await kashier.refund({ transactionId: 'TX-U60', amountMinor: 1000 })).toEqual({ ok: true, refundId: 'TX-RF60', status: 'SUCCESS' });
  });

  it('KASHIER_API_URL is pinned to https *.kashier.io: any other host is refused and the secret key is never sent', async () => {
    const sent: string[] = [];
    for (const base of ['https://evil.example.com', 'https://api.kashier.io.evil.com', 'http://api.kashier.io', 'https://kashier.io.attacker.net', 'https://evilkashier.io']) {
      const p = new KashierProvider('MID', 'k', undefined, { secretKey: 'sk', apiBase: base, fetch: async (u) => { sent.push(u); return new Response('{}'); } });
      expect(await p.inquire('ord-1')).toBe('unavailable');
      expect(await p.refund({ transactionId: 'TX-1', amountMinor: 100 })).toMatchObject({ ok: false });
      expect(await p.refundStatus!('TX-1')).toBe('unavailable');
      expect(await p.listRefunds!('ord-1')).toBe('unavailable');
      await expect(p.confirm({ event: 'pay', status: 'SUCCESS', orderId: 'o', transactionId: 'TX-1', amountMinor: 1, currency: 'EGP' })).rejects.toThrow();
      expect(p.confirmationReady()).toBe(false);
    }
    expect(sent).toEqual([]);
    const ok = new KashierProvider('MID', 'k', undefined, { secretKey: 'sk', apiBase: 'https://test-api.kashier.io', fetch: async (u) => { sent.push(u); return detailsFetch(u); } });
    expect(await ok.inquire('ord-1')).not.toBe('unavailable');
    expect(sent[0]!.startsWith('https://test-api.kashier.io/')).toBe(true);
  });

  it('HIGH: a held refund is matched only to a real, unconfirmed candidate of the same order and amount; a missing or already-confirmed candidate changes nothing', async () => {
    const a = await setup(61);
    refundAnswer = async () => refundOk('TX-R61', 15000);
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    await hookRefund(a.order, 'TX-W61', '150.00');
    kashierHasRefund(a.order, 'TX-W61', '150.00');
    configurePayments(() => kashier);
    const url = '/card-refunds/held/TX-W61/match';
    await env.DB.prepare("UPDATE card_refunds SET confirmed_at = 1 WHERE kashier_refund_id = 'TX-R61'").run();
    expect(await (await operatorCall(OP1, 'POST', url, {})).json()).toMatchObject({ message: 'not_verified' }); // already confirmed by a webhook
    await env.DB.prepare("UPDATE card_refunds SET confirmed_at = NULL WHERE kashier_refund_id = 'TX-R61'").run();
    await env.DB.prepare("UPDATE card_refunds SET candidate_id = 'gone' WHERE kashier_refund_id = 'TX-W61'").run();
    expect((await operatorCall(OP1, 'POST', url, {})).status).toBe(409); // the candidate does not exist
    expect(await env.DB.prepare("SELECT state FROM card_refunds WHERE kashier_refund_id = 'TX-W61'").first()).toEqual({ state: 'held' });
    await env.DB.prepare("UPDATE card_refunds SET candidate_id = (SELECT id FROM card_refunds WHERE kashier_refund_id = 'TX-R61') WHERE kashier_refund_id = 'TX-W61'").run();
    expect((await operatorCall(OP1, 'POST', url, {})).status).toBe(200); // now valid
    expect(await env.DB.prepare("SELECT count(*) AS n FROM card_refunds WHERE confirmed_at IS NOT NULL AND request_id = ?").bind(a.id).first()).toEqual({ n: 1 });
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['refund', -15000]]);
  });
  it('HIGH: Kashier lists BOTH the held id and our refund id as separate successful refunds: the match is refused and the held refund is debited as the unknown refund it is (P1)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = await setup(62, 5000, { amount: 40000 });
    refundAnswer = async () => refundOk('TX-R62', 5000);
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    await hookRefund(a.order, 'TX-W62', '50.00');
    expect(await env.DB.prepare("SELECT source FROM card_refunds WHERE kashier_refund_id = 'TX-W62'").first()).toEqual({ source: 'held' });
    kashierHasRefund(a.order, 'TX-W62', '50.00');
    kashierHasRefund(a.order, 'TX-R62', '50.00');
    configurePayments(() => kashier);
    const res = await operatorCall(OP1, 'POST', '/card-refunds/held/TX-W62/match', {});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ message: 'separate_refund_debited' });
    expect(await kinds(a.ws)).toEqual([['topup', 40000], ['refund', -5000], ['chargeback', -5000]]);
    expect(alertsOf(spy, 'refund_held_debited').length).toBeGreaterThanOrEqual(1);
    expect(String(alertsOf(spy, 'refund_held_debited')[0]![0])).toContain('"severity":"P1"');
    expect((await hookRefund(a.order, 'TX-W62', '50.00')).status).toBe(200); // a replay posts nothing more
    expect(await kinds(a.ws)).toEqual([['topup', 40000], ['refund', -5000], ['chargeback', -5000]]);
  });

  it('money first, then the state flip: a wallet post that throws once leaves the held row held, and the retry debits exactly once and ends converted', async () => {
    const a = await setup(63, 5000, { amount: 40000 });
    refundAnswer = async () => refundOk('TX-R63', 5000);
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    await hookRefund(a.order, 'TX-W63', '50.00');
    kashierHasRefund(a.order, 'TX-W63', '50.00');
    kashierHasRefund(a.order, 'TX-R63', '50.00');
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.ws));
    let thrown = false;
    const flaky = { ...env, WORKSPACE_DO: { idFromName: (n: string) => env.WORKSPACE_DO.idFromName(n), get: () => ({
      walletView: (n?: number) => real.walletView(n),
      postWallet: async (x: Parameters<typeof real.postWallet>[0], n?: number) => { if (x.kind === 'chargeback' && !thrown) { thrown = true; throw new Error('wallet down'); } return real.postWallet(x, n); },
    }) } } as unknown as typeof env;
    await expect(matchHeldRefund(flaky, { refundId: 'TX-W63', actor: OP1 }, Date.now(), kashier)).rejects.toThrow();
    expect(await env.DB.prepare("SELECT source, state FROM card_refunds WHERE kashier_refund_id = 'TX-W63'").first()).toEqual({ source: 'held', state: 'held' }); // not converted before the money moved
    expect(await matchHeldRefund(flaky, { refundId: 'TX-W63', actor: OP1 }, Date.now(), kashier)).toEqual({ ok: false, reason: 'separate_refund_debited' });
    expect(await kinds(a.ws)).toEqual([['topup', 40000], ['refund', -5000], ['chargeback', -5000]]);
    expect(await env.DB.prepare("SELECT source, state FROM card_refunds WHERE kashier_refund_id = 'TX-W63'").first()).toEqual({ source: 'webhook', state: 'succeeded' });
    expect(await refunded(a.order)).toBe(10000);
  });

  it('an unknown refund whose wallet post throws once is retried by the webhook redelivery and debits exactly once', async () => {
    const a = await setup(64, 5000);
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.ws));
    let thrown = false;
    const flaky = { ...env, WORKSPACE_DO: { idFromName: (n: string) => env.WORKSPACE_DO.idFromName(n), get: () => ({
      walletView: (n?: number) => real.walletView(n),
      postWallet: async (x: Parameters<typeof real.postWallet>[0], n?: number) => { if (x.kind === 'chargeback' && !thrown) { thrown = true; throw new Error('wallet down'); } return real.postWallet(x, n); },
    }) } } as unknown as typeof env;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { body, sig } = await signedWebhook({ merchantOrderId: a.order, transactionId: 'CB-64', amount: '80.00' }, 'refund', 'reversal');
    expect((await handleProviderWebhook(flaky, body, sig, kashier)).status).toBe(500);
    expect((await handleProviderWebhook(flaky, body, sig, kashier)).status).toBe(200);
    expect((await handleProviderWebhook(flaky, body, sig, kashier)).status).toBe(200);
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['chargeback', -8000]]);
    expect(await refunded(a.order)).toBe(8000);
  });

  it('an approval whose debit phase aborted can be run again once the wallet allows: the first chunk is not debited twice, the second is, and the provider is asked once per row', async () => {
    const a = await setup(65, 15000);
    const ws = a.ws;
    await env.DB.prepare('UPDATE refund_requests SET amount_minor = 25000 WHERE id = ?').bind(a.id).run();
    await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at, transaction_id, paid_at) VALUES ('o-kr65b', ?, 10000, 0, 10000, 'EGP', 'paid', 'u', 1, 'TX-KR65b', 6)").bind(ws).run();
    kashierLedger.set('TX-KR65b', { operation: 'pay', status: 'SUCCESS', orderId: 'o-kr65b' });
    await fund(ws, 10000, 'kashier:TX-KR65b');
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));
    let posts = 0;
    const shrinking = { ...env, WORKSPACE_DO: { idFromName: (n: string) => env.WORKSPACE_DO.idFromName(n), get: () => ({
      walletView: (n?: number) => real.walletView(n),
      postWallet: async (x: Parameters<typeof real.postWallet>[0], n?: number) => (x.kind === 'refund' && ++posts === 2 ? { ok: false as const, reason: 'insufficient' as never } : real.postWallet(x, n)),
    }) } } as unknown as typeof env;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await decideRefund(shrinking, { id: a.id, decision: 'approve', actor: OP1 })).toEqual({ ok: false, reason: 'insufficient_balance' });
    refundAnswer = async () => refundOk(`TX-RF65-${puts().length}`, puts().length === 1 ? 20000 : 5000);
    const again = await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    expect(again).toMatchObject({ ok: true });
    expect(await kinds(ws)).toEqual([['topup', 20000], ['topup', 10000], ['refund', -20000], ['refund', -5000]]);
    expect(puts()).toHaveLength(2);
    expect(await req(a.id)).toEqual({ state: 'paid', card_refunded_minor: 25000, manual_minor: 0 });
    expect((await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 })).ok).toBe(false); // finished: never a third run
  });
});

describe('round 5: an approval is run by exactly one run at a time, and a resume replays the recorded plan', () => {
  /** Two top-ups (20000 + 10000), a 25000 request, and a first run whose second wallet debit is refused: chunks 20000 + 5000 are planned, only the first is debited. */
  async function aborted(n: number) {
    const a = await setup(n, 15000);
    await env.DB.prepare('UPDATE refund_requests SET amount_minor = 25000 WHERE id = ?').bind(a.id).run();
    await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at, transaction_id, paid_at) VALUES (?, ?, 10000, 0, 10000, 'EGP', 'paid', 'u', 1, ?, 6)").bind(`o-kr${n}b`, a.ws, `TX-KR${n}b`).run();
    kashierLedger.set(`TX-KR${n}b`, { operation: 'pay', status: 'SUCCESS', orderId: `o-kr${n}b` });
    await fund(a.ws, 10000, `kashier:TX-KR${n}b`);
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.ws));
    let posts = 0;
    const shrinking = { ...env, WORKSPACE_DO: { idFromName: (x: string) => env.WORKSPACE_DO.idFromName(x), get: () => ({
      walletView: (t?: number) => real.walletView(t),
      postWallet: async (x: Parameters<typeof real.postWallet>[0], t?: number) => (x.kind === 'refund' && ++posts === 2 ? { ok: false as const, reason: 'insufficient' as never } : real.postWallet(x, t)),
    }) } } as unknown as typeof env;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await decideRefund(shrinking, { id: a.id, decision: 'approve', actor: OP1 })).toEqual({ ok: false, reason: 'insufficient_balance' });
    const byAmount = (calls: Call[]) => calls.map((c) => (c.body as { transaction: { amount: number } }).transaction.amount);
    return { ...a, byAmount };
  }
  const answerByCall = () => { refundAnswer = async () => refundOk(`TX-RF-${puts().length}`, puts().length === 1 ? 20000 : 5000); };

  it('HIGH: two concurrent resumes (and two concurrent first approvals) send each card refund row to Kashier exactly once', async () => {
    const a = await aborted(70);
    answerByCall();
    const [x, y] = await Promise.all([decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 }), decideRefund(env, { id: a.id, decision: 'approve', actor: OP2 })]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    expect(puts()).toHaveLength(2); // one call per row, not four
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['topup', 10000], ['refund', -20000], ['refund', -5000]]);
    const b = await setup(71);
    refundAnswer = async () => refundOk('TX-RF71', 15000);
    const before = puts().length;
    const [p, q] = await Promise.all([decideRefund(env, { id: b.id, decision: 'approve', actor: OP1 }), decideRefund(env, { id: b.id, decision: 'approve', actor: OP2 })]);
    expect([p.ok, q.ok].filter(Boolean)).toHaveLength(1);
    expect(puts().length - before).toBe(1);
  });

  it('HIGH: a live lease blocks a resume; once it has expired a resume may run; a row already `calling` is never sent again whatever the request says', async () => {
    const a = await aborted(72);
    answerByCall();
    await env.DB.prepare("UPDATE refund_requests SET claimed_by = 'other-run', lease_until = ? WHERE id = ?").bind(Date.now() + 60_000, a.id).run();
    expect(await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 })).toEqual({ ok: false, reason: 'not_pending' });
    expect(puts()).toEqual([]);
    await env.DB.prepare('UPDATE refund_requests SET lease_until = ? WHERE id = ?').bind(Date.now() - 1000, a.id).run();
    await env.DB.prepare("UPDATE card_refunds SET state = 'calling' WHERE id = ?").bind(`cr:${a.id}:1`).run(); // another run is mid-call on row 1
    expect(await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 })).toMatchObject({ ok: true });
    expect(a.byAmount(puts())).toEqual([50]); // only row 2; row 1 was not sent a second time
    expect((await rowsOf(a.id))[0]).toMatchObject({ state: 'calling' });
  });

  it('HIGH: a reject can never close a request whose wallet was already partly debited', async () => {
    const a = await aborted(73);
    expect(await decideRefund(env, { id: a.id, decision: 'reject', actor: OP2, note: 'no' })).toEqual({ ok: false, reason: 'not_pending' });
    expect(await req(a.id)).toMatchObject({ state: 'processing' });
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['topup', 10000], ['refund', -20000]]);
    const fresh = await setup(74);
    expect(await decideRefund(env, { id: fresh.id, decision: 'reject', actor: OP2 })).toMatchObject({ ok: true, request: { state: 'rejected' } });
    expect(await decideRefund(env, { id: fresh.id, decision: 'approve', actor: OP1 })).toEqual({ ok: false, reason: 'not_pending' });
  });

  it('MEDIUM: totals that changed between the first attempt and the resume change nothing: the recorded plan decides every amount, ref and provider call', async () => {
    const a = await aborted(75);
    answerByCall();
    await env.DB.prepare('UPDATE topups SET fee_minor = 999, paid_at = 99 WHERE workspace_id = ?').bind(a.ws).run(); // totals and order moved under it
    await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at, transaction_id, paid_at) VALUES ('o-new75', ?, 99999, 0, 99999, 'EGP', 'paid', 'u', 1, 'TX-NEW75', 1)").bind(a.ws).run();
    expect(await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 })).toMatchObject({ ok: true });
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['topup', 10000], ['refund', -20000], ['refund', -5000]]);
    expect(a.byAmount(puts())).toEqual([200, 50]);
    expect(await env.DB.prepare('SELECT order_id, amount_minor FROM card_refunds WHERE request_id = ? ORDER BY id').bind(a.id).all().then((x) => x.results)).toEqual([{ order_id: `o-kr75`, amount_minor: 20000 }, { order_id: `o-kr75b`, amount_minor: 5000 }]);
  });

  it('two concurrent approvals on one top-up that together exceed it: what is sent to Kashier never exceeds the refundable amount, the rest is a manual payout', async () => {
    const a = await setup(80, 15000);
    await fund(a.ws, 20000, 'kashier:extra-80'); // the wallet could pay both requests; the top-up's card cannot be refunded twice
    const second = await createRefundRequest(env, { workspaceId: a.ws, userId: 'u1', amountMinor: 15000 });
    if (!second.ok) throw new Error(second.reason);
    refundAnswer = async () => refundOk(`TX-RF80-${puts().length}`, puts().length === 1 ? 15000 : 5000);
    const [x, y] = await Promise.all([decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 }), decideRefund(env, { id: second.request.id, decision: 'approve', actor: OP2 })]);
    expect(x.ok && y.ok).toBe(true);
    const sent = puts().map((c) => Math.round((c.body as { transaction: { amount: number } }).transaction.amount * 100));
    expect(sent.reduce((n, v) => n + v, 0)).toBeLessThanOrEqual(20000);
    expect(await refunded(a.order)).toBeLessThanOrEqual(20000);
    const total = [await req(a.id), await req(second.request.id)].reduce((n, r) => n + r!.card_refunded_minor + r!.manual_minor, 0);
    expect(total).toBe(30000); // every piaster is either refunded to the card or owed as a manual payout
  });

  it('at the moment of the call the room is checked again: a row that no longer fits goes to a manual payout with a P1, and nothing is sent', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const a = await setup(82, 15000);
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.ws));
    let posts = 0;
    const dies = { ...env, WORKSPACE_DO: { idFromName: (x: string) => env.WORKSPACE_DO.idFromName(x), get: () => ({
      walletView: (n?: number) => real.walletView(n),
      postWallet: async (x: Parameters<typeof real.postWallet>[0], n?: number) => { if (++posts === 1) throw new Error('wallet down'); return real.postWallet(x, n); },
    }) } } as unknown as typeof env;
    await expect(decideRefund(dies, { id: a.id, decision: 'approve', actor: OP1 })).rejects.toThrow();
    // while it was down, another run took most of the top-up's room
    await env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at) VALUES ('cr:other:1', NULL, ?, ?, 10000, 'api', 'calling', 'TX-OTHER82', 1, 1)").bind(a.order, a.ws).run();
    await env.DB.prepare('UPDATE refund_requests SET lease_until = 1 WHERE id = ?').bind(a.id).run();
    expect(await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 })).toMatchObject({ ok: true, request: { state: 'manual_payout', manualMinor: 15000 } });
    expect(puts()).toEqual([]);
    expect(alertsOf(spy, 'card_refund_over_refundable')).toHaveLength(1);
    expect(String(alertsOf(spy, 'card_refund_over_refundable')[0]![0])).toContain('"severity":"P1"');
  });

  it('a plan is visible as reservations the moment it is recorded: its card refund rows exist before any wallet debit, and a later link cannot take the room', async () => {
    const a = await setup(81, 15000);
    await env.DB.prepare('UPDATE refund_requests SET amount_minor = 20000 WHERE id = ?').bind(a.id).run();
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.ws));
    const dies = { ...env, WORKSPACE_DO: { idFromName: (x: string) => env.WORKSPACE_DO.idFromName(x), get: () => ({
      walletView: (n?: number) => real.walletView(n),
      postWallet: async () => { throw new Error('wallet down'); },
    }) } } as unknown as typeof env;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(decideRefund(dies, { id: a.id, decision: 'approve', actor: OP1 })).rejects.toThrow();
    expect(await env.DB.prepare("SELECT state, amount_minor FROM card_refunds WHERE request_id = ?").bind(a.id).all().then((x) => x.results)).toEqual([{ state: 'planned', amount_minor: 20000 }]);
    await fund(a.ws, 20000, 'kashier:extra-81');
    const other = await createRefundRequest(env, { workspaceId: a.ws, userId: 'u1', amountMinor: 5000 });
    if (!other.ok) throw new Error(other.reason);
    refundAnswer = async () => refundOk('TX-RF81', 5000);
    expect(await decideRefund(env, { id: other.request.id, decision: 'approve', actor: OP2 })).toMatchObject({ ok: true, request: { state: 'manual_payout', manualMinor: 5000 } });
    expect(puts()).toEqual([]); // the planned 20000 already reserves the whole top-up: the other request has no card room
  });

  it('a plan-time row is only a reservation: a refund webhook between the plan and the debit does not reconcile it, and the approval still posts its own chunk afterwards', async () => {
    const a = await setup(83, 15000);
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.ws));
    const dies = { ...env, WORKSPACE_DO: { idFromName: (x: string) => env.WORKSPACE_DO.idFromName(x), get: () => ({
      walletView: (n?: number) => real.walletView(n),
      postWallet: async () => { throw new Error('wallet down'); },
    }) } } as unknown as typeof env;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(decideRefund(dies, { id: a.id, decision: 'approve', actor: OP1 })).rejects.toThrow();
    expect(await rowsOf(a.id)).toEqual([{ state: 'planned', source: 'api', amount_minor: 15000, kashier_refund_id: null }]);
    await hookRefund(a.order, 'TX-EARLY83', '150.00'); // same amount, a real card refund, but our refund was never sent: this is somebody else's
    expect((await rowsOf(a.id))[0]).toMatchObject({ state: 'planned', kashier_refund_id: null }); // not reconciled to the planned row
    await env.DB.prepare('UPDATE refund_requests SET lease_until = 1 WHERE id = ?').bind(a.id).run();
    refundAnswer = async () => refundOk('TX-RF83', 15000);
    await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    expect((await kinds(a.ws)).filter((k) => k[0] === 'refund')).toEqual([['refund', -15000]]); // the approval's chunk was posted, not skipped
    // the early refund took the top-up's room (it is a real, separate refund): our row finds no room, is failed atomically and becomes a manual payout
    expect((await kinds(a.ws)).filter((k) => k[0] === 'chargeback')).toEqual([['chargeback', -15000]]);
    expect((await rowsOf(a.id))[0]).toMatchObject({ state: 'failed', kashier_refund_id: null });
    expect(puts()).toEqual([]);
    expect(await req(a.id)).toMatchObject({ state: 'manual_payout', manual_minor: 15000 });
  });

  it('the over-room transition is one atomic statement: a row a concurrent run just moved to calling is never failed (one provider call OR manual, never both)', async () => {
    const a = await setup(84, 15000);
    await env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, created_at, updated_at) VALUES ('cr:x84:1', ?, ?, ?, 15000, 'api', 'sending', 5, 5)").bind(a.id, a.order, a.ws).run();
    await env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at) VALUES ('cr:y84:1', NULL, ?, ?, 10000, 'api', 'calling', 'TX-Y84', 1, 1)").bind(a.order, a.ws).run();
    let flipped = false;
    const racing = { ...env, DB: new Proxy(env.DB, { get(t, p) {
      if (p === 'prepare') return (sql: string) => {
        if (!flipped && sql.includes("SET state = 'failed'") && sql.includes('card_refunds')) { flipped = true; return { bind: (...b: unknown[]) => ({ run: async () => { await t.prepare("UPDATE card_refunds SET state = 'calling' WHERE id = 'cr:x84:1'").run(); return t.prepare(sql).bind(...b).run(); } }) } as never; }
        return t.prepare(sql);
      };
      const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v;
    } }) } as typeof env;
    const { claimForCall } = await import('../src/core/billing/card-refunds');
    expect(await claimForCall(racing, 'cr:x84:1', Date.now())).toBe('busy');
    expect(await env.DB.prepare("SELECT state FROM card_refunds WHERE id = 'cr:x84:1'").first()).toEqual({ state: 'calling' }); // not failed under the run that is calling Kashier
  });

  it('held and planned rows count as reservations when the room is sized', async () => {
    const a = await setup(85, 15000);
    await env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, kashier_refund_id, created_at, updated_at) VALUES ('held:H85', NULL, ?, ?, 10000, 'held', 'held', 'H85', 1, 1)").bind(a.order, a.ws).run();
    await env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, created_at, updated_at) VALUES ('cr:p85:1', NULL, ?, ?, 5000, 'api', 'planned', 1, 1)").bind(a.order, a.ws).run();
    await fund(a.ws, 20000, 'kashier:extra-85');
    refundAnswer = async () => refundOk('TX-RF85', 5000);
    const r = await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 });
    expect(r).toMatchObject({ ok: true, request: { state: 'manual_payout', cardRefundedMinor: 5000, manualMinor: 10000 } }); // 20000 - 10000 held - 5000 planned = 5000 room: only that much goes to the card
    expect(puts().length).toBeLessThanOrEqual(1);
    const sent = puts().map((c) => Math.round((c.body as { transaction: { amount: number } }).transaction.amount * 100));
    expect(sent.reduce((n, v) => n + v, 0)).toBeLessThanOrEqual(5000);
  });

  it('an insert with a state outside the CHECK fails loudly (a duplicate id is still a quiet no-op): nothing is lost silently', async () => {
    const a = await setup(86, 5000);
    const ins = (id: string, state: string) => env.DB.prepare("INSERT INTO card_refunds (id, request_id, order_id, workspace_id, amount_minor, source, state, created_at, updated_at) VALUES (?, ?, ?, ?, 100, 'api', ?, 1, 1) ON CONFLICT DO NOTHING").bind(id, a.id, a.order, a.ws, state).run();
    await expect(ins('cr:bad86', 'bogus')).rejects.toThrow(/CHECK/i);
    expect((await ins('cr:ok86', 'planned')).meta.changes).toBe(1);
    expect((await ins('cr:ok86', 'planned')).meta.changes).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM card_refunds WHERE id IN ('cr:bad86', 'cr:ok86')").first()).toEqual({ n: 1 });
  });
});

describe('abandoning a partly debited refund request (two operators, money back exactly once)', () => {
  /** Two top-ups, a 25000 request, and a first run whose second wallet debit is refused: chunk 1 (20000) is debited, chunk 2 (5000) never. */
  async function partlyDebited(n: number) {
    const a = await setup(n, 15000);
    await env.DB.prepare('UPDATE refund_requests SET amount_minor = 25000 WHERE id = ?').bind(a.id).run();
    await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at, transaction_id, paid_at) VALUES (?, ?, 10000, 0, 10000, 'EGP', 'paid', 'u', 1, ?, 6)").bind(`o-kr${n}b`, a.ws, `TX-KR${n}b`).run();
    await fund(a.ws, 10000, `kashier:TX-KR${n}b`);
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.ws));
    let posts = 0;
    const shrinking = { ...env, WORKSPACE_DO: { idFromName: (x: string) => env.WORKSPACE_DO.idFromName(x), get: () => ({
      walletView: (t?: number) => real.walletView(t),
      postWallet: async (x: Parameters<typeof real.postWallet>[0], t?: number) => (x.kind === 'refund' && ++posts === 2 ? { ok: false as const, reason: 'insufficient' as never } : real.postWallet(x, t)),
    }) } } as unknown as typeof env;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await decideRefund(shrinking, { id: a.id, decision: 'approve', actor: OP1 })).toEqual({ ok: false, reason: 'insufficient_balance' });
    await env.DB.prepare('UPDATE refund_requests SET lease_until = NULL, claimed_by = NULL WHERE id = ?').bind(a.id).run();
    return a;
  }
  const abandon = (id: string, actor: string, e: typeof env = env) => abandonRefundRequest(e, { id, actor });
  const answerAmounts = () => { refundAnswer = async () => refundOk(`TX-RF-AB-${puts().length}`, puts().length === 1 ? 20000 : 5000); };

  it('first operator asks, a DIFFERENT operator confirms: the wallet chunks that were really posted come back exactly once, open rows close, the request is abandoned and audited', async () => {
    const a = await partlyDebited(90);
    expect(await abandon(a.id, OP1)).toEqual({ ok: true, needsSecond: true });
    expect(await abandon(a.id, OP1)).toEqual({ ok: false, reason: 'second_approver_required' });
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['topup', 10000], ['refund', -20000]]); // nothing moved yet
    expect(await abandon(a.id, OP2)).toEqual({ ok: true });
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['topup', 10000], ['refund', -20000], ['adjustment', 20000]]); // only the posted chunk is reversed
    expect((await ledger(a.ws)).map((r) => r.ref)).toContain(`refund-reversal:${a.id}:1`);
    expect((await workspace(a.ws).walletView()).balanceMinor).toBe(30000);
    expect(await req(a.id)).toEqual({ state: 'abandoned', card_refunded_minor: 0, manual_minor: 0 });
    expect(await rowsOf(a.id)).toEqual([{ state: 'failed', source: 'api', amount_minor: 20000, kashier_refund_id: null }, { state: 'failed', source: 'api', amount_minor: 5000, kashier_refund_id: null }]); // the planned row of the never-debited chunk closes too
    expect(await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE action = 'refund_abandoned' AND workspace_id = ?").bind(a.ws).first()).toEqual({ n: 1 });
    // replays change nothing
    expect(await abandon(a.id, OP2)).toEqual({ ok: true, already: true });
    expect(await abandon(a.id, OP1)).toEqual({ ok: true, already: true });
    expect((await kinds(a.ws)).filter((k) => k[0] === 'adjustment')).toHaveLength(1);
    expect((await decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 })).ok).toBe(false); // an abandoned request cannot be run again
  });

  it('a crash after the credit but before the flip is finished by the retry without crediting twice', async () => {
    const a = await partlyDebited(91);
    await abandon(a.id, OP1);
    let broke = false;
    const flaky = { ...env, DB: new Proxy(env.DB, { get(t, p) {
      if (p === 'prepare') return (sql: string) => { if (!broke && sql.includes("state = 'abandoned'")) { broke = true; throw new Error('db down'); } return t.prepare(sql); };
      const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v;
    } }) } as typeof env;
    await expect(abandon(a.id, OP2, flaky)).rejects.toThrow();
    expect(await req(a.id)).toMatchObject({ state: 'abandoning' }); // no resume can claim it now
    await env.DB.prepare('UPDATE refund_requests SET lease_until = NULL, claimed_by = NULL WHERE id = ?').bind(a.id).run();
    expect(await abandon(a.id, OP2)).toEqual({ ok: true });
    expect((await kinds(a.ws)).filter((k) => k[0] === 'adjustment')).toEqual([['adjustment', 20000]]);
    expect(await req(a.id)).toMatchObject({ state: 'abandoned' });
  });

  it.each(['calling', 'succeeded', 'uncertain', 'pending'])('refused while any row is %s (that money may have left): nothing is credited or closed', async (state) => {
    const a = await partlyDebited(state === 'calling' ? 92 : state === 'succeeded' ? 93 : state === 'uncertain' ? 94 : 95);
    await env.DB.prepare("UPDATE card_refunds SET state = ? WHERE request_id = ?").bind(state, a.id).run();
    await abandon(a.id, OP1);
    expect(await abandon(a.id, OP2)).toEqual({ ok: false, reason: 'money_may_have_left' });
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['topup', 10000], ['refund', -20000]]);
    expect(await req(a.id)).toMatchObject({ state: 'processing' });
  });

  it('refused for a live run (lease) and for a request that is not partly debited (pending, finished)', async () => {
    const a = await partlyDebited(96);
    await abandon(a.id, OP1);
    await env.DB.prepare('UPDATE refund_requests SET claimed_by = ?, lease_until = ? WHERE id = ?').bind('other-run', Date.now() + 60_000, a.id).run();
    expect(await abandon(a.id, OP2)).toEqual({ ok: false, reason: 'in_progress' });
    const fresh = await setup(97);
    expect(await abandon(fresh.id, OP1)).toEqual({ ok: false, reason: 'not_abandonable' });
    const done = await setup(98);
    refundAnswer = async () => refundOk('TX-RF98', 15000);
    await decideRefund(env, { id: done.id, decision: 'approve', actor: OP1 });
    expect(await abandon(done.id, OP1)).toEqual({ ok: false, reason: 'not_abandonable' });
    expect(await abandon('nope', OP1)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('over the operator API: super admin only, a revoked session is refused, the second call by another operator executes', async () => {
    const a = await partlyDebited(99);
    expect((await operatorCall(null, 'POST', `/refund-requests/${a.id}/abandon`, {})).status).toBe(401);
    configureSessionCheck(async () => true);
    expect((await operatorCall(OP1, 'POST', `/refund-requests/${a.id}/abandon`, {})).status).toBe(403);
    configureSessionCheck(async () => false);
    expect(await (await operatorCall(OP1, 'POST', `/refund-requests/${a.id}/abandon`, {})).json()).toMatchObject({ needsSecond: true });
    expect((await operatorCall(OP1, 'POST', `/refund-requests/${a.id}/abandon`, {})).status).toBe(409);
    expect((await operatorCall(OP2, 'POST', `/refund-requests/${a.id}/abandon`, {})).status).toBe(200);
    expect(await req(a.id)).toMatchObject({ state: 'abandoned' });
  });

  it('HIGH: abandon racing a resume ends in exactly one outcome: the refund is sent and nothing is reversed, or the wallet is reversed and nothing is sent', async () => {
    const a = await partlyDebited(100);
    answerAmounts();
    await abandon(a.id, OP1);
    const [ab, rs] = await Promise.all([abandon(a.id, OP2), decideRefund(env, { id: a.id, decision: 'approve', actor: OP1 })]);
    const reversed = (await ledger(a.ws)).some((r) => r.ref.startsWith('refund-reversal:'));
    const sent = puts().length;
    expect(reversed && sent > 0).toBe(false); // never both
    expect(reversed || sent > 0).toBe(true); // one of them happened
    if (reversed) { expect(ab).toMatchObject({ ok: true }); expect(rs.ok).toBe(false); expect(await req(a.id)).toMatchObject({ state: 'abandoned' }); }
    else { expect(ab).toMatchObject({ ok: false }); expect(rs.ok).toBe(true); }
  });

  it('HIGH: a run holding a stale lease cannot post a chunk or send a row after the abandon took over', async () => {
    const a = await partlyDebited(101);
    answerAmounts();
    await abandon(a.id, OP1);
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    let held = false;
    const slow = { ...env, DB: new Proxy(env.DB, { get(t, p) {
      if (p === 'prepare') return (sql: string) => {
        const st = t.prepare(sql);
        if (!held && sql.includes('FROM refund_chunks WHERE request_id')) { held = true; return { bind: (...b: unknown[]) => ({ all: async () => { await gate; return st.bind(...b).all(); } }) } as never; }
        return st;
      };
      const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v;
    } }) } as typeof env;
    const stale = decideRefund(slow, { id: a.id, decision: 'approve', actor: OP1 }); // claims the lease, then waits before posting
    await new Promise((r) => setTimeout(r, 20));
    await env.DB.prepare('UPDATE refund_requests SET lease_until = 1 WHERE id = ?').bind(a.id).run(); // its lease ran out
    expect(await abandon(a.id, OP2)).toEqual({ ok: true });
    release();
    expect((await stale).ok).toBe(false);
    expect(puts()).toEqual([]);
    expect((await kinds(a.ws)).filter((k) => k[0] === 'refund')).toEqual([['refund', -20000]]); // nothing new was debited
    expect(await req(a.id)).toMatchObject({ state: 'abandoned' });
    expect((await kinds(a.ws)).filter((k) => k[0] === 'adjustment')).toEqual([['adjustment', 20000]]);
  });

  it('HIGH: a row that moves to calling after the safety read is not reversed: the abandon stops, the request goes back to processing and nothing is credited for it', async () => {
    const a = await partlyDebited(102);
    await abandon(a.id, OP1);
    let flipped = false;
    const racing = { ...env, DB: new Proxy(env.DB, { get(t, p) {
      if (p === 'prepare') return (sql: string) => {
        if (!flipped && sql.includes("SET state = 'failed'") && sql.includes('card_refunds')) { flipped = true; return { bind: (...b: unknown[]) => ({ run: async () => { await t.prepare("UPDATE card_refunds SET state = 'calling' WHERE request_id = ? AND state IN ('planned', 'sending')").bind(a.id).run(); return t.prepare(sql).bind(...b).run(); } }) } as never; }
        return t.prepare(sql);
      };
      const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v;
    } }) } as typeof env;
    expect(await abandon(a.id, OP2, racing)).toEqual({ ok: false, reason: 'money_may_have_left' });
    expect((await kinds(a.ws)).filter((k) => k[0] === 'adjustment')).toEqual([]);
    expect(await req(a.id)).toMatchObject({ state: 'processing' });
  });

  it('HIGH: a debit that lands after the abandon took over is reversed exactly once, by the run itself (it re-checks right after posting)', async () => {
    const a = await setup(103, 15000);
    // the request is mid-approval: planned, lease taken by a run that is about to post its first chunk
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.ws));
    let abandonedInBetween = false;
    const racing = { ...env, WORKSPACE_DO: { idFromName: (x: string) => env.WORKSPACE_DO.idFromName(x), get: () => ({
      walletView: (n?: number) => real.walletView(n),
      walletRefsPresent: (refs: string[]) => real.walletRefsPresent(refs),
      postWallet: async (x: Parameters<typeof real.postWallet>[0], n?: number) => {
        if (x.kind === 'refund' && !abandonedInBetween) {
          abandonedInBetween = true;
          // the run passed its lease check; its lease then ran out and two operators abandon the request before the debit lands
          await env.DB.prepare('UPDATE refund_requests SET lease_until = 1 WHERE id = ?').bind(a.id).run();
          await abandon(a.id, OP1);
          expect(await abandon(a.id, OP2)).toEqual({ ok: true });
        }
        return real.postWallet(x, n);
      },
    }) } } as unknown as typeof env;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = await decideRefund(racing, { id: a.id, decision: 'approve', actor: OP1 });
    expect(out.ok).toBe(false);
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['refund', -15000], ['adjustment', 15000]]); // debited, then given back once
    expect((await workspace(a.ws).walletView()).balanceMinor).toBe(20000);
    expect(await sweepAbandonedRefunds(env)).toMatchObject({ reversed: 0 }); // the sweep finds nothing left to do
    expect((await kinds(a.ws)).filter((k) => k[0] === 'adjustment')).toHaveLength(1);
    expect(puts()).toEqual([]);
  });

  it('HIGH: the abandon sweep and the daily pass reverse a debit that slipped in after the abandoned flip, once, whichever runs first', async () => {
    const a = await partlyDebited(104);
    await abandon(a.id, OP1);
    expect(await abandon(a.id, OP2)).toEqual({ ok: true });
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.ws));
    await real.postWallet({ kind: 'refund', netMinor: -5000, ref: `refund:${a.id}:2`, actor: OP1, note: 'late chunk' }); // lands after everything
    expect(await sweepAbandonedRefunds(env)).toMatchObject({ reversed: 1 });
    expect(await sweepAbandonedRefunds(env)).toMatchObject({ reversed: 0 });
    await dailyBilling(env);
    expect((await ledger(a.ws)).filter((r) => r.ref.startsWith('refund-reversal:')).map((r) => r.ref).sort()).toEqual([`refund-reversal:${a.id}:1`, `refund-reversal:${a.id}:2`]);
    expect((await workspace(a.ws).walletView()).balanceMinor).toBe(30000);
  });

  it('HIGH: a chunk whose card refund row may have sent money (succeeded, calling, pending, uncertain, linked) is never reversed by any path; the sweep raises a P1 instead', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const [i, state] of ['succeeded', 'calling', 'pending', 'uncertain', 'linked'].entries()) {
      const a = await partlyDebited(110 + i);
      await env.DB.prepare('UPDATE card_refunds SET state = ? WHERE request_id = ?').bind(state, a.id).run();
      await env.DB.prepare("UPDATE refund_requests SET state = 'abandoned', abandoned_at = ? WHERE id = ?").bind(Date.now(), a.id).run(); // however it got there
      expect(await reverseUnreversedChunks(env, a.id, a.ws, 'system', Date.now())).toBe(0);
      await sweepAbandonedRefunds(env);
      expect((await kinds(a.ws)).filter((k) => k[0] === 'adjustment')).toEqual([]);
      expect(spy.mock.calls.some((c) => String(c[0]).includes('refund_reversal_blocked') && String(c[0]).includes(a.id))).toBe(true);
    }
  });

  it('HIGH: only a row this abandon closed (or no row at all) makes a chunk reversible: a row that was already failed for another reason is left alone', async () => {
    const a = await partlyDebited(115);
    await env.DB.prepare("UPDATE card_refunds SET state = 'failed', note = NULL WHERE request_id = ?").bind(a.id).run(); // failed earlier, a manual payout is owed
    await env.DB.prepare("UPDATE refund_requests SET state = 'abandoned', abandoned_at = ? WHERE id = ?").bind(Date.now(), a.id).run();
    expect(await reverseUnreversedChunks(env, a.id, a.ws, 'system', Date.now())).toBe(0);
  });

  it('HIGH: a run that sees the request `abandoning` stops without reversing: that reversal belongs to the abandon (or the sweep once it is abandoned)', async () => {
    const a = await setup(116, 15000);
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.ws));
    const racing = { ...env, WORKSPACE_DO: { idFromName: (x: string) => env.WORKSPACE_DO.idFromName(x), get: () => ({
      walletView: (n?: number) => real.walletView(n),
      walletRefsPresent: (r: string[]) => real.walletRefsPresent(r),
      postWallet: async (x: Parameters<typeof real.postWallet>[0], n?: number) => {
        if (x.kind === 'refund') await env.DB.prepare("UPDATE refund_requests SET state = 'abandoning', claimed_by = 'the-abandon' WHERE id = ?").bind(a.id).run();
        return real.postWallet(x, n);
      },
    }) } } as unknown as typeof env;
    expect((await decideRefund(racing, { id: a.id, decision: 'approve', actor: OP1 })).ok).toBe(false);
    expect(await kinds(a.ws)).toEqual([['topup', 20000], ['refund', -15000]]); // the run did not reverse
    await env.DB.prepare("UPDATE refund_requests SET state = 'abandoned', abandoned_at = 1 WHERE id = ?").bind(a.id).run();
    await env.DB.prepare("UPDATE card_refunds SET state = 'failed', note = ? WHERE request_id = ?").bind(`abandoned:${a.id}`, a.id).run();
    expect(await sweepAbandonedRefunds(env)).toMatchObject({ reversed: 1 }); // once abandoned, the sweep returns it
  });

  it('MEDIUM: 250 abandoned requests are all swept across passes: the sweep marks what it finished, so older rows cannot starve behind newer ones', async () => {
    const a = await setup(117, 5000);
    await fund(a.ws, 1_000_000, 'kashier:big-117');
    const real = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.ws));
    const base = Date.now() - 3 * 86_400_000;
    for (let i = 0; i < 250; i++) {
      const id = `ab-${i}`;
      await env.DB.batch([
        env.DB.prepare("INSERT INTO refund_requests (id, workspace_id, amount_minor, state, requested_by, created_at, decided_at, abandoned_at) VALUES (?, ?, 100, 'abandoned', 'u', 1, ?, ?)").bind(id, a.ws, base + i, base + i),
        env.DB.prepare("INSERT INTO refund_chunks (request_id, n, kind, order_id, transaction_id, amount_minor) VALUES (?, 1, 'manual', NULL, NULL, 100)").bind(id),
      ]);
      await real.postWallet({ kind: 'refund', netMinor: -100, ref: `refund:${id}:1`, actor: 'u', note: 'x' });
    }
    const first = await sweepAbandonedRefunds(env);
    const second = await sweepAbandonedRefunds(env);
    const third = await sweepAbandonedRefunds(env);
    expect(first.reversed + second.reversed + third.reversed).toBe(250);
    expect(first.reversed).toBeLessThanOrEqual(200);
    expect(third.reversed).toBe(0);
    expect((await ledger(a.ws)).filter((r) => r.ref.startsWith('refund-reversal:ab-'))).toHaveLength(250);
  });
});

