import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { repairPackageOrders, startPackageCheckout } from '../src/core/billing/package-orders';
import { handleProviderWebhook, repairTopups } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { storeId as W0, useApiKey } from './helpers/api';
import { ledger } from './helpers/billing';
import { kashierLedger, kashierOrders, detailsFetch, testKashier } from './helpers/kashier';
import { seedNumber, workspace } from './helpers/workspace';
import { useStoreLink } from './helpers/store-link';

useApiKey();
useStoreLink();
const W = (n: number) => W0(9200 + n);
const kashier = testKashier();
beforeEach(async () => {
  configurePayments(() => kashier);
  configureSessionCheck(async () => false);
  await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)").run();
});
afterEach(() => { configurePayments((e) => (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY ? new KashierProvider(e.KASHIER_MERCHANT_ID, e.KASHIER_API_KEY) : null)); configureSessionCheck(null); vi.restoreAllMocks(); });

const stuckTopup = async (orderId: string, ws: string, amount = 5000, fee = 150) => {
  await seedNumber(`pn-ki-${ws.slice(-6)}`, ws);
  await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'EGP', 'pending', 'u1', ?)")
    .bind(orderId, ws, amount, fee, amount + fee, Date.now() - 20 * 60_000).run();
};
/** Kashier knows a payment for `orderId` (list by merchant order id + its own details record), but no webhook ever reached us. */
const paidAtKashier = (orderId: string, tx: string, amount: string, status = 'SUCCESS') => {
  kashierOrders.set(orderId, [...(kashierOrders.get(orderId) ?? []), { transactionId: tx, amount }]);
  kashierLedger.set(tx, { operation: 'pay', status, orderId });
};
const state = (id: string) => env.DB.prepare('SELECT state, transaction_id FROM topups WHERE order_id = ?').bind(id).first<{ state: string; transaction_id: string | null }>();
const alerts = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
const said = (spy: ReturnType<typeof alerts>, what: string) => spy.mock.calls.some((c) => String(c[0]).includes(what));

describe('KashierProvider.inquire: lookup by OUR order id, confirmed with the transaction-details call', () => {
  it('a paid order is SUCCESS with its transaction, amount and currency', async () => {
    paidAtKashier('ord-ki-1', 'TX-KI1', '51.50');
    expect(await kashier.inquire('ord-ki-1')).toEqual({ status: 'SUCCESS', transactionId: 'TX-KI1', amountMinor: 5150, currency: 'EGP' });
  });
  it('asks the fixed host with the secret key, by merchant order id, payments only', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const p = new KashierProvider('MID-1', 'k', undefined, { secretKey: 'sk-test', fetch: async (url, init) => { seen.push({ url, auth: new Headers(init.headers).get('Authorization') }); return detailsFetch(url); } });
    paidAtKashier('ord-ki-2', 'TX-KI2', '10.00');
    await p.inquire('ord-ki-2');
    expect(seen[0]).toEqual({ url: 'https://api.kashier.io/v2/aggregator/transactions?search=ord-ki-2&type=payment&limit=20&page=1', auth: 'sk-test' });
    expect(seen[1]!.url).toBe('https://api.kashier.io/v2/aggregator/transactions/TX-KI2');
  });
  it('no payment found yet is PENDING (the customer has not paid), not a failure', async () => {
    expect(await kashier.inquire('ord-ki-none')).toEqual({ status: 'PENDING', transactionId: null, amountMinor: null, currency: null });
  });
  it('status comes from the details record, not the list: a list row that looks approved but details say FAILURE is FAILURE', async () => {
    paidAtKashier('ord-ki-3', 'TX-KI3', '10.00', 'FAILURE');
    expect((await kashier.inquire('ord-ki-3'))).toMatchObject({ status: 'FAILURE' });
  });
  it('a record for ANOTHER order, a refund, or an unlisted id is never taken as this order\'s payment', async () => {
    kashierOrders.set('ord-ki-4', [{ transactionId: 'TX-KI4', amount: '10.00', merchantOrderId: 'someone-else' }]);
    paidAtKashier('ord-ki-4b', 'TX-KI4b', '10.00');
    kashierOrders.set('ord-ki-4b', [{ transactionId: 'TX-KI4b', amount: '10.00', type: 'REFUND' }]);
    expect((await kashier.inquire('ord-ki-4'))).toMatchObject({ status: 'PENDING' });
    expect((await kashier.inquire('ord-ki-4b'))).toMatchObject({ status: 'PENDING' });
  });
  it('Kashier unreachable / 5xx / garbage / details that disagree is unavailable', async () => {
    paidAtKashier('ord-ki-5', 'TX-KI5', '10.00');
    const mk = (f: (url: string) => Promise<Response>) => testKashier(f);
    expect(await mk(async () => { throw new Error('down'); }).inquire('ord-ki-5')).toBe('unavailable');
    expect(await mk(async () => new Response('x', { status: 503 })).inquire('ord-ki-5')).toBe('unavailable');
    expect(await mk(async () => Response.json({ nope: true })).inquire('ord-ki-5')).toBe('unavailable');
    kashierLedger.set('TX-KI5', { operation: 'pay', status: 'SUCCESS', orderId: 'different-order' });
    expect(await kashier.inquire('ord-ki-5')).toBe('unavailable');
    expect(await kashier.inquire('bad/../id')).toBe('unavailable'); // never put an unplain id in a URL
  });
  it('two successful payments for one order are not guessed between: unavailable and an alert', async () => {
    const spy = alerts();
    paidAtKashier('ord-ki-6', 'TX-KI6a', '10.00');
    paidAtKashier('ord-ki-6', 'TX-KI6b', '10.00');
    expect(await kashier.inquire('ord-ki-6')).toBe('unavailable');
    expect(said(spy, 'inquiry_multiple_success')).toBe(true);
  });
  it('no secret key configured: unavailable (nothing can be confirmed)', async () => {
    expect(await new KashierProvider('MID-1', 'k').inquire('ord-ki-7')).toBe('unavailable');
  });
});

describe('repairTopups with a real inquiry', () => {
  it('a stuck top-up Kashier confirms as paid is credited exactly once, even when the repair runs twice or races the late webhook', async () => {
    const ws = W(1);
    await stuckTopup('ord-ki-t1', ws);
    paidAtKashier('ord-ki-t1', 'TX-T1', '51.50');
    expect(await repairTopups(env, kashier)).toMatchObject({ credited: 1 });
    expect(await repairTopups(env, kashier)).toMatchObject({ credited: 0 });
    // the webhook finally arrives
    const { signedWebhook } = await import('./helpers/kashier-webhook');
    const { body, sig } = await signedWebhook({ merchantOrderId: 'ord-ki-t1', transactionId: 'TX-T1', amount: '51.50' });
    expect((await handleProviderWebhook(env, body, sig, kashier)).status).toBe(200);
    expect((await ledger(ws)).map((r) => [r.kind, r.amount_minor, r.ref])).toEqual([['topup', 5000, 'kashier:TX-T1']]);
    expect(await state('ord-ki-t1')).toEqual({ state: 'paid', transaction_id: 'TX-T1' });
    expect((await workspace(ws).walletView()).balanceMinor).toBe(5000);
  });
  it('Kashier unreachable: nothing credited, still pending, retried on the next pass', async () => {
    const ws = W(2);
    await stuckTopup('ord-ki-t2', ws);
    paidAtKashier('ord-ki-t2', 'TX-T2', '51.50');
    const down = testKashier(async () => { throw new Error('down'); });
    expect(await repairTopups(env, down)).toMatchObject({ credited: 0 });
    expect(await ledger(ws)).toEqual([]);
    expect((await state('ord-ki-t2'))!.state).toBe('pending');
    expect(await repairTopups(env, kashier)).toMatchObject({ credited: 1 });
    expect((await ledger(ws)).map((r) => r.ref)).toEqual(['kashier:TX-T2']);
  });
  it('a paid answer for another amount alerts and credits nothing', async () => {
    const spy = alerts();
    const ws = W(3);
    await stuckTopup('ord-ki-t3', ws);
    paidAtKashier('ord-ki-t3', 'TX-T3', '10.00');
    await repairTopups(env, kashier);
    expect(said(spy, 'topup_amount_mismatch')).toBe(true);
    expect(await ledger(ws)).toEqual([]);
    expect((await state('ord-ki-t3'))!.state).toBe('pending');
  });
  it('a paid answer whose amount Kashier did not state alerts and credits nothing', async () => {
    const spy = alerts();
    const ws = W(4);
    await stuckTopup('ord-ki-t4', ws);
    kashierOrders.set('ord-ki-t4', [{ transactionId: 'TX-T4', amount: 'n/a' }]);
    kashierLedger.set('TX-T4', { operation: 'pay', status: 'SUCCESS', orderId: 'ord-ki-t4' });
    await repairTopups(env, kashier);
    expect(said(spy, 'topup_amount_mismatch')).toBe(true);
    expect(await ledger(ws)).toEqual([]);
  });
});

describe('repair of stuck package orders', () => {
  const startOrder = async (ws: string, ageMs = 20 * 60_000) => {
    await seedNumber(`pn-kp-${ws.slice(-5)}`, ws);
    const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'gold' }, Date.now() - ageMs);
    if (!r.ok) throw new Error(r.reason);
    return r.orderId;
  };
  const order = (id: string) => env.DB.prepare('SELECT status, provider_ref, granted_at FROM package_orders WHERE order_id = ?').bind(id).first<{ status: string; provider_ref: string | null; granted_at: number | null }>();
  const sub = (ws: string) => env.DB.prepare('SELECT package_id, status, version FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first();

  it('a pending order Kashier confirms as paid is granted exactly once (the webhook path), also after a second run and the late webhook', async () => {
    const ws = W(10);
    const id = await startOrder(ws);
    paidAtKashier(id, 'TX-P1', '500.00');
    expect(await repairPackageOrders(env, Date.now(), kashier)).toMatchObject({ confirmed: 1 });
    expect(await repairPackageOrders(env, Date.now(), kashier)).toMatchObject({ confirmed: 0 });
    const { signedWebhook } = await import('./helpers/kashier-webhook');
    const { body, sig } = await signedWebhook({ merchantOrderId: id, transactionId: 'TX-P1', amount: '500.00' });
    expect((await handleProviderWebhook(env, body, sig, kashier)).status).toBe(200);
    expect(await order(id)).toMatchObject({ status: 'paid', provider_ref: 'TX-P1' });
    expect((await order(id))!.granted_at).not.toBeNull();
    expect(await sub(ws)).toMatchObject({ package_id: 'gold', status: 'active', version: 1 });
  });
  it('a 24 h+ order that expired but was paid is still granted by the repair', async () => {
    const ws = W(11);
    const id = await startOrder(ws, 30 * 3_600_000);
    paidAtKashier(id, 'TX-P2', '500.00');
    await repairPackageOrders(env, Date.now(), kashier);
    expect(await order(id)).toMatchObject({ status: 'paid', provider_ref: 'TX-P2' });
    expect(await sub(ws)).toMatchObject({ package_id: 'gold' });
  });
  it('Kashier unreachable: nothing granted, the order is retried; an unpaid one still expires', async () => {
    const ws = W(12);
    const id = await startOrder(ws, 30 * 3_600_000);
    paidAtKashier(id, 'TX-P3', '500.00');
    await repairPackageOrders(env, Date.now(), testKashier(async () => { throw new Error('down'); }));
    expect(await order(id)).toMatchObject({ status: 'expired' });
    expect(await sub(ws)).toBeNull();
    await repairPackageOrders(env, Date.now(), kashier);
    expect(await order(id)).toMatchObject({ status: 'paid' });
    expect(await sub(ws)).toMatchObject({ package_id: 'gold' });
  });
  it('a mismatching amount alerts and grants nothing', async () => {
    const spy = alerts();
    const ws = W(13);
    const id = await startOrder(ws);
    paidAtKashier(id, 'TX-P4', '5.00');
    await repairPackageOrders(env, Date.now(), kashier);
    expect(said(spy, 'package_amount_mismatch')).toBe(true);
    expect(await sub(ws)).toBeNull();
    expect(await order(id)).toMatchObject({ status: 'pending', granted_at: null });
  });
  it('switch off (PACKAGE_CHECKOUT_ENABLED unset): no inquiry is made', async () => {
    const ws = W(14);
    const id = await startOrder(ws);
    paidAtKashier(id, 'TX-P5', '500.00');
    const off = { ...env, PACKAGE_CHECKOUT_ENABLED: undefined } as typeof env;
    await repairPackageOrders(off, Date.now(), kashier);
    expect(await order(id)).toMatchObject({ status: 'pending' });
  });
});

describe('review follow-ups (m1 m2 m3)', () => {
  it('m1: when the webhook already credited the order, the repair reports a duplicate (not credited) and does not run held refunds', async () => {
    const ws = W(20);
    await stuckTopup('ord-ki-m1', ws);
    paidAtKashier('ord-ki-m1', 'TX-M1', '51.50');
    // the webhook won the race: wallet credited and transaction bound, state still pending when the repair read the row
    await env.DB.prepare("UPDATE topups SET transaction_id = 'TX-M1' WHERE order_id = 'ord-ki-m1'").run();
    await workspace(ws).postWallet({ kind: 'topup', netMinor: 5000, ref: 'kashier:TX-M1', note: 'top-up ord-ki-m1' }, Date.now());
    expect(await repairTopups(env, kashier)).toMatchObject({ credited: 0 });
    expect((await ledger(ws)).map((r) => r.ref)).toEqual(['kashier:TX-M1']);
  });
  it('m1: a duplicate payment delivery does not re-run held refunds', async () => {
    const ws = W(21);
    await stuckTopup('ord-ki-m1b', ws);
    const { signedWebhook } = await import('./helpers/kashier-webhook');
    const refund = await signedWebhook({ merchantOrderId: 'ord-ki-m1b', transactionId: 'TX-M1b-R', amount: '10.00' }, 'refund');
    await handleProviderWebhook(env, refund.body, refund.sig, kashier); // payment not credited yet: held (payment_pending)
    await env.DB.prepare("UPDATE topups SET transaction_id = 'TX-M1b', state = 'paid' WHERE order_id = 'ord-ki-m1b'").run();
    await workspace(ws).postWallet({ kind: 'topup', netMinor: 5000, ref: 'kashier:TX-M1b', note: 'x' }, Date.now());
    await env.DB.prepare("UPDATE topups SET state = 'pending' WHERE order_id = 'ord-ki-m1b'").run();
    const pay = await signedWebhook({ merchantOrderId: 'ord-ki-m1b', transactionId: 'TX-M1b', amount: '51.50' });
    expect((await handleProviderWebhook(env, pay.body, pay.sig, kashier)).status).toBe(200);
    expect((await ledger(ws)).map((r) => r.kind)).toEqual(['topup']); // the held refund was NOT run by a duplicate
  });
  it('m2: a success beyond the first 20 rows is found, and the multiple-success alert looks at every page', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ transactionId: `TX-M2-${i}`, amount: '10.00' }));
    kashierOrders.set('ord-ki-m2', many);
    for (const m of many) kashierLedger.set(m.transactionId, { operation: 'pay', status: 'FAILURE', orderId: 'ord-ki-m2' });
    kashierLedger.set('TX-M2-23', { operation: 'pay', status: 'SUCCESS', orderId: 'ord-ki-m2' });
    expect(await kashier.inquire('ord-ki-m2')).toEqual({ status: 'SUCCESS', transactionId: 'TX-M2-23', amountMinor: 1000, currency: 'EGP' });
    const spy = alerts();
    kashierLedger.set('TX-M2-24', { operation: 'pay', status: 'SUCCESS', orderId: 'ord-ki-m2' });
    expect(await kashier.inquire('ord-ki-m2')).toBe('unavailable');
    expect(said(spy, 'inquiry_multiple_success')).toBe(true);
  });
  it('m2: more than 5 full pages is not guessed at: unavailable', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ transactionId: `TX-M2b-${i}`, amount: '1.00' }));
    kashierOrders.set('ord-ki-m2b', rows);
    for (const r of rows) kashierLedger.set(r.transactionId, { operation: 'pay', status: 'FAILURE', orderId: 'ord-ki-m2b' });
    expect(await kashier.inquire('ord-ki-m2b')).toBe('unavailable');
  });
  it('m3: a mismatch alerts once per order, not on every daily pass (top-up and package)', async () => {
    const spy = alerts();
    const ws = W(22);
    await stuckTopup('ord-ki-m3', ws);
    paidAtKashier('ord-ki-m3', 'TX-M3', '10.00');
    await repairTopups(env, kashier);
    await repairTopups(env, kashier);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('topup_amount_mismatch'))).toHaveLength(1);
    const wsp = W(23);
    await seedNumber('pn-km3', wsp);
    const r = await startPackageCheckout(env, { workspaceId: wsp, userId: 'u1', sessionId: 's1', packageId: 'gold' }, Date.now() - 20 * 60_000);
    if (!r.ok) throw new Error(r.reason);
    paidAtKashier(r.orderId, 'TX-M3p', '5.00');
    await repairPackageOrders(env, Date.now(), kashier);
    await repairPackageOrders(env, Date.now(), kashier);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('package_amount_mismatch'))).toHaveLength(1);
  });
});

export type _ = PaymentProvider;
