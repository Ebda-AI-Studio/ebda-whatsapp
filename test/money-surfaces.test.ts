// Self-service money surfaces: A21 (who pays Meta for an own number), A22 (yearly-refund quote + request), A9 Chat half (AI credit packs).
// Every guard here has a test that fails when the guard is removed (see the PR's mutation check).
import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { executeYearlyRefund, startPackageCheckout } from '../src/core/billing/package-orders';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { repairCreditOrders, creditPacks, startCreditPack } from '../src/core/billing/credit-packs';
import { setOwnNumberCard } from '../src/core/billing/funding';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, apiFor, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { KEY, kashierLedger, testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';
import { rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const kashier = testKashier();
const W = (n: number) => W0(7700 + n);
const DAY = 86_400_000;

beforeEach(async () => {
  configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, {}));
  configureSessionCheck(async () => false);
  await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)").run();
});
afterEach(() => { configurePayments((e) => (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY ? new KashierProvider(e.KASHIER_MERCHANT_ID, e.KASHIER_API_KEY) : null)); configureSessionCheck(null); vi.restoreAllMocks(); });

async function hmac(text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function signed(data: Record<string, string | number>, label = 'pay') {
  const keys = ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId', 'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode'];
  const full = { kashierOrderId: 'ko-1', orderReference: 'ref-1', method: 'card', channel: 'online', transactionResponseCode: '00', currency: 'EGP', status: 'SUCCESS', ...data, signatureKeys: keys } as Record<string, unknown>;
  kashierLedger.set(String(full.transactionId), { operation: label, status: String(full.status), orderId: String(full.merchantOrderId) });
  const str = keys.map((k) => `${k}=${encodeURIComponent(String(full[k]))}`).join('&');
  return { body: JSON.stringify({ event: label, data: full }), sig: await hmac(str) };
}
const hook = async (orderId: string, tx: string, amount: string, label = 'pay') => {
  const { body, sig } = await signed({ merchantOrderId: orderId, transactionId: tx, amount }, label);
  return handleProviderWebhook(env, body, sig, kashier, Date.now());
};
/** What the screen sends back: the id and the token only. */
const tok = (c: { confirmId: string; token: string }) => ({ confirmId: c.confirmId, token: c.token });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const fundingOf = (pn: string) => env.DB.prepare('SELECT funding FROM number_funding WHERE phone_number_id = ?').bind(pn).first<{ funding: string }>();

describe('A21: who pays Meta for an own number', () => {
  const path = (pn: string, tail = '') => `/numbers/${pn}/funding${tail}`;
  async function unknownNumber(ws: string, pn: string) {
    await seedNumber(pn, ws);
    await env.DB.prepare('DELETE FROM number_funding WHERE phone_number_id = ?').bind(pn).run(); // what a number with no recorded payer looks like
  }
  it('owner previews, confirms once: the card is recorded, an audit row is written, a replay of the same confirmation is refused', async () => {
    const ws = W(1);
    await unknownNumber(ws, 'pn-f1');
    const a = await apiFor(ws);
    const p = await a.call('POST', path('pn-f1', '/preview'), { funding: 'merchant_card' });
    expect(p.status).toBe(200);
    const prev = await json(p);
    expect(prev).toMatchObject({ phoneNumberId: 'pn-f1', current: 'unknown', funding: 'merchant_card' });
    expect(await fundingOf('pn-f1')).toBeNull(); // a preview writes nothing
    const ok = await a.call('PUT', path('pn-f1'), { funding: 'merchant_card', ...tok(prev.confirm) });
    expect(ok.status).toBe(200);
    expect(await fundingOf('pn-f1')).toEqual({ funding: 'merchant_card' });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE action = 'number_funding_set_by_merchant' AND workspace_id = ?").bind(ws).first()).toEqual({ n: 1 });
    const again = await a.call('PUT', path('pn-f1'), { funding: 'merchant_card', ...tok(prev.confirm) });
    expect(again.status).toBe(409);
    expect((await json(again)).message).toBe('confirmation_used');
  });
  it('the platform line is refused to a merchant, on the preview and on the write, and nothing changes', async () => {
    const ws = W(2);
    await unknownNumber(ws, 'pn-f2');
    const a = await apiFor(ws);
    const p = await a.call('POST', path('pn-f2', '/preview'), { funding: 'platform_line' });
    expect(p.status).toBe(403);
    expect((await json(p)).message).toBe('platform_line_is_operator_only');
    const good = await json(await a.call('POST', path('pn-f2', '/preview'), { funding: 'merchant_card' }));
    const put = await a.call('PUT', path('pn-f2'), { funding: 'platform_line', ...tok(good.confirm) });
    expect(put.status).toBe(403);
    expect(await fundingOf('pn-f2')).toBeNull();
  });
  it('a number the operator put on the platform line is not taken back by the merchant', async () => {
    const ws = W(3);
    await seedNumber('pn-f3', ws);
    await env.DB.prepare("UPDATE number_funding SET funding = 'platform_line' WHERE phone_number_id = 'pn-f3'").run();
    const a = await apiFor(ws);
    expect((await a.call('POST', path('pn-f3', '/preview'), { funding: 'merchant_card' })).status).toBe(409);
    expect(await fundingOf('pn-f3')).toEqual({ funding: 'platform_line' });
  });
  it('the write itself never overwrites the platform line, even when an operator wins the race after the checks', async () => {
    const ws = W(9);
    await seedNumber('pn-f9', ws);
    await env.DB.prepare("UPDATE number_funding SET funding = 'platform_line' WHERE phone_number_id = 'pn-f9'").run();
    expect(await setOwnNumberCard(env, { workspaceId: ws, phoneNumberId: 'pn-f9', actor: 'u1' })).toBe('operator_funded');
    expect(await fundingOf('pn-f9')).toEqual({ funding: 'platform_line' });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE action = 'number_funding_set_by_merchant' AND workspace_id = ?").bind(ws).first()).toEqual({ n: 0 });
  });
  it('staff are refused; a number of another store is a 404 for both calls and for a confirmation issued to another store', async () => {
    const ws = W(4);
    const other = W(5);
    await unknownNumber(ws, 'pn-f4');
    await unknownNumber(other, 'pn-f5');
    const staff = await apiFor(ws, 'staff');
    expect((await staff.call('POST', path('pn-f4', '/preview'), { funding: 'merchant_card' })).status).toBe(403);
    expect((await staff.call('PUT', path('pn-f4'), { funding: 'merchant_card', confirmId: crypto.randomUUID(), token: 'a'.repeat(64) })).status).toBe(403);
    const a = await apiFor(ws);
    expect((await a.call('POST', path('pn-f5', '/preview'), { funding: 'merchant_card' })).status).toBe(404);
    const b = await apiFor(other);
    const prevB = await json(await b.call('POST', path('pn-f5', '/preview'), { funding: 'merchant_card' }));
    expect((await a.call('PUT', path('pn-f5'), { funding: 'merchant_card', ...tok(prevB.confirm) })).status).toBe(404);
    expect((await a.call('PUT', path('pn-f4'), { funding: 'merchant_card', ...tok(prevB.confirm) })).status).toBe(409); // store B's confirmation means nothing to store A
    expect(await fundingOf('pn-f4')).toBeNull();
    expect(await fundingOf('pn-f5')).toBeNull();
  });
  it('a confirmation issued for one number cannot be spent on another of the same store (edited payload)', async () => {
    const ws = W(6);
    await unknownNumber(ws, 'pn-f6a');
    await unknownNumber(ws, 'pn-f6b');
    const a = await apiFor(ws);
    const prev = await json(await a.call('POST', path('pn-f6a', '/preview'), { funding: 'merchant_card' }));
    const r = await a.call('PUT', path('pn-f6b'), { funding: 'merchant_card', ...tok(prev.confirm) });
    expect(r.status).toBe(409);
    expect((await json(r)).message).toBe('confirmation_mismatch');
    expect(await fundingOf('pn-f6b')).toBeNull();
  });
  it('an expired confirmation is refused', async () => {
    const ws = W(7);
    await unknownNumber(ws, 'pn-f7');
    const a = await apiFor(ws);
    const prev = await json(await a.call('POST', path('pn-f7', '/preview'), { funding: 'merchant_card' }));
    await env.DB.prepare('UPDATE money_confirmations SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, prev.confirm.confirmId).run();
    const r = await a.call('PUT', path('pn-f7'), { funding: 'merchant_card', ...tok(prev.confirm) });
    expect((await json(r)).message).toBe('confirmation_expired');
    expect(await fundingOf('pn-f7')).toBeNull();
  });
  it('the shared platform number is not an own number: 404 for a merchant', async () => {
    const ws = W(8);
    await seedNumber('pn-f8', ws);
    await env.DB.prepare("INSERT OR IGNORE INTO shared_numbers (phone_number_id, display_phone, waba_id, created_at) VALUES ('pn-shared-f8', '+20 100 000 0000', 'waba-s', 0)").run().catch(() => undefined);
    await env.DB.prepare("INSERT OR IGNORE INTO number_funding (phone_number_id, funding, updated_at) VALUES ('pn-shared-f8', 'platform_line', 0)").run();
    const a = await apiFor(ws);
    expect((await a.call('POST', path('pn-shared-f8', '/preview'), { funding: 'merchant_card' })).status).toBe(404);
    expect(await fundingOf('pn-shared-f8')).toEqual({ funding: 'platform_line' });
  });
});

/** A paid yearly order for `ws`. */
async function buyYearly(ws: string, packageId = 'pro-yearly', amount = '31410.00') {
  await seedNumber(`pn-y-${ws.slice(-5)}`, ws);
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId });
  if (!r.ok) throw new Error(r.reason);
  await hook(r.orderId, `TX-${crypto.randomUUID()}`, amount);
  return r.orderId;
}
const walletFacts = async (ws: string, orderId: string) => ({
  ledger: await rows(ws, 'SELECT count(*) AS n FROM wallet_ledger'),
  sub: await env.DB.prepare('SELECT status, period_end, version FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first(),
  order: await env.DB.prepare('SELECT refunded_minor, status FROM package_orders WHERE order_id = ?').bind(orderId).first(),
  plans: await env.DB.prepare('SELECT count(*) AS n FROM package_refund_plans WHERE workspace_id = ?').bind(ws).first(),
});

describe('A22: the yearly-refund quote and request', () => {
  it('the merchant quote equals what the operator route quotes AND what the operator action then executes', async () => {
    const ws = W(10);
    const orderId = await buyYearly(ws);
    await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -300_000, ref: 'debt-1', actor: 'op', note: 'debt' });
    const a = await apiFor(ws);
    const view = await json(await a.call('GET', '/wallet/yearly-refund'));
    const op = await json(await operatorCall(OP1, 'GET', `/package-orders/${orderId}/refund-quote`));
    expect(view.quote).toEqual({ orderId, packageId: op.packageId, periodMonths: op.periodMonths, monthlyMinor: op.monthlyMinor, unusedMonths: op.unusedMonths, grossMinor: op.grossMinor, debtMinor: op.debtMinor, debtSettledMinor: op.debtSettledMinor, refundMinor: op.refundMinor });
    expect(view.quote.debtSettledMinor).toBeGreaterThan(0);
    const done = await executeYearlyRefund(env, orderId, { actor: OP1, reason: 'merchant asked to leave' });
    expect(done).toMatchObject({ ok: true, shortenedMonths: view.quote.unusedMonths, debtSettledMinor: view.quote.debtSettledMinor, cashRefundMinor: view.quote.refundMinor });
  });
  it('confirm files a request and moves NO money: wallet ledger, subscription, order and refund plans are untouched', async () => {
    const ws = W(11);
    const orderId = await buyYearly(ws);
    const a = await apiFor(ws);
    const before = await walletFacts(ws, orderId);
    const prev = await json(await a.call('POST', '/wallet/yearly-refund/preview', {}));
    expect(prev.quote.unusedMonths).toBeGreaterThan(0);
    const r = await a.call('POST', '/wallet/yearly-refund/requests', tok(prev.confirm));
    expect(r.status).toBe(201);
    expect(await json(r)).toMatchObject({ orderId, state: 'pending', unusedMonths: prev.quote.unusedMonths, refundMinor: prev.quote.refundMinor });
    expect(await walletFacts(ws, orderId)).toEqual(before);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM yearly_refund_requests WHERE workspace_id = ? AND state = 'pending'").bind(ws).first()).toEqual({ n: 1 });
  });
  it('a double click is one request; a second preview while one is pending is refused', async () => {
    const ws = W(12);
    await buyYearly(ws);
    const a = await apiFor(ws);
    const prev = await json(await a.call('POST', '/wallet/yearly-refund/preview', {}));
    const [x, y] = await Promise.all([a.call('POST', '/wallet/yearly-refund/requests', tok(prev.confirm)), a.call('POST', '/wallet/yearly-refund/requests', tok(prev.confirm))]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM yearly_refund_requests WHERE workspace_id = ?').bind(ws).first()).toEqual({ n: 1 });
    const again = await a.call('POST', '/wallet/yearly-refund/preview', {});
    const second = await a.call('POST', '/wallet/yearly-refund/requests', tok((await json(again)).confirm));
    expect((await json(second)).message).toBe('request_pending');
  });
  it('a quote that moved between preview and confirm (new debt) is refused with confirmation_mismatch and files nothing', async () => {
    const ws = W(13);
    await buyYearly(ws);
    const a = await apiFor(ws);
    const prev = await json(await a.call('POST', '/wallet/yearly-refund/preview', {}));
    await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -200_000, ref: 'debt-13', actor: 'op', note: 'debt' });
    const r = await a.call('POST', '/wallet/yearly-refund/requests', tok(prev.confirm));
    expect(r.status).toBe(409);
    expect((await json(r)).message).toBe('confirmation_mismatch');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM yearly_refund_requests WHERE workspace_id = ?').bind(ws).first()).toEqual({ n: 0 });
  });
  it('owner only; a staff member and another store get nothing (403, and store B never sees store A figures)', async () => {
    const ws = W(14);
    const other = W(15);
    await buyYearly(ws);
    await seedNumber('pn-y14b', other);
    const staff = await apiFor(ws, 'staff');
    for (const [m, p] of [['GET', '/wallet/yearly-refund'], ['POST', '/wallet/yearly-refund/preview'], ['POST', '/wallet/yearly-refund/requests']] as const) expect((await staff.call(m, p, m === 'GET' ? undefined : {})).status, `${m} ${p}`).toBe(403);
    const b = await apiFor(other);
    expect((await json(await b.call('GET', '/wallet/yearly-refund'))).quote).toBeNull(); // no yearly package of its own
    expect((await b.call('POST', '/wallet/yearly-refund/preview', {})).status).toBe(409);
  });
  it('a monthly package and a last-month yearly have nothing to refund: no preview, no token', async () => {
    const ws = W(16);
    await seedNumber('pn-y16', ws);
    const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'gold' });
    if (!r.ok) throw new Error(r.reason);
    await hook(r.orderId, 'TX-M16', '500.00');
    const a = await apiFor(ws);
    expect((await json(await a.call('GET', '/wallet/yearly-refund'))).reason).toBe('not_yearly');
    const p = await a.call('POST', '/wallet/yearly-refund/preview', {});
    expect(p.status).toBe(409);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM money_confirmations WHERE workspace_id = ?').bind(ws).first()).toEqual({ n: 0 });
  });
  it('in the last month of a yearly package there is nothing to refund: the quote says so, no token is issued, no request can be filed', async () => {
    const ws = W(18);
    const orderId = await buyYearly(ws);
    await env.DB.prepare('UPDATE workspace_subscriptions SET period_start = ?, period_end = ? WHERE workspace_id = ?').bind(Date.now() - 11 * 30 * DAY - 5 * DAY, Date.now() + 20 * DAY, ws).run();
    const a = await apiFor(ws);
    const view = await json(await a.call('GET', '/wallet/yearly-refund'));
    expect(view.quote).toMatchObject({ orderId, unusedMonths: 0, grossMinor: 0, refundMinor: 0 });
    const p = await a.call('POST', '/wallet/yearly-refund/preview', {});
    expect(p.status).toBe(409);
    expect((await json(p)).message).toBe('nothing_to_refund');
    const forged = await a.call('POST', '/wallet/yearly-refund/requests', { confirmId: crypto.randomUUID(), token: 'a'.repeat(64) });
    expect(forged.status).toBe(409);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM yearly_refund_requests WHERE workspace_id = ?').bind(ws).first()).toEqual({ n: 0 });
  });
  it('the operator lists the request and executing the yearly refund closes it', async () => {
    const ws = W(17);
    const orderId = await buyYearly(ws);
    const a = await apiFor(ws);
    const prev = await json(await a.call('POST', '/wallet/yearly-refund/preview', {}));
    await a.call('POST', '/wallet/yearly-refund/requests', tok(prev.confirm));
    const list = await json(await operatorCall(OP1, 'GET', '/yearly-refund-requests'));
    expect(list.items.filter((x: any) => x.workspaceId === ws)).toHaveLength(1);
    expect((await operatorCall(OP1, 'POST', `/package-orders/${orderId}/yearly-refund`, { reason: 'merchant asked to leave' })).status).toBe(200);
    expect((await json(await operatorCall(OP1, 'GET', '/yearly-refund-requests'))).items.filter((x: any) => x.workspaceId === ws)).toHaveLength(0);
    expect((await json(await a.call('GET', '/wallet/yearly-refund'))).request).toMatchObject({ state: 'executed' });
  });
});

describe('A9 Chat: AI credit packs', () => {
  const buyPath = '/wallet/credit-packs';
  async function preview(a: Awaited<ReturnType<typeof apiFor>>, packId = 'credits-100') {
    const r = await a.call('POST', `${buyPath}/preview`, { packId });
    expect(r.status).toBe(200);
    return json(r);
  }
  it('packs are priced from the dearest per-credit paid monthly package, in whole piastres', async () => {
    const packs = await creditPacks(env);
    const unit = (await env.DB.prepare('SELECT max((price_minor + ai_credits - 1) / ai_credits) AS u FROM packages WHERE active = 1 AND price_minor > 0 AND ai_credits > 0 AND period_months = 1').first<{ u: number }>())!.u;
    expect(packs.map((p) => [p.credits, p.priceMinor])).toEqual([[100, unit * 100], [500, unit * 500], [1000, unit * 1000]]);
    expect(packs.every((p) => Number.isSafeInteger(p.priceMinor))).toBe(true);
  });
  it('preview then order: a pending order and a checkout link, no credit yet; the webhook adds the credits once per payment id', async () => {
    const ws = W(20);
    await seedNumber('pn-c20', ws);
    const a = await apiFor(ws);
    const before = (await workspace(ws).aiCredits()).balance;
    const prev = await preview(a);
    const o = await a.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prev.confirm) });
    expect(o.status).toBe(201);
    const order = await json(o);
    expect(order).toMatchObject({ state: 'pending', credits: 100, amountMinor: prev.pack.priceMinor });
    expect(order.checkoutUrl).toMatch(/^https:\/\//);
    expect((await workspace(ws).aiCredits()).balance).toBe(before); // paying is not crediting
    const amount = (prev.pack.priceMinor / 100).toFixed(2);
    expect((await hook(order.orderId, 'TX-C20', amount)).status).toBe(200);
    expect((await workspace(ws).aiCredits()).balance).toBe(before + 100);
    for (let i = 0; i < 3; i++) await hook(order.orderId, 'TX-C20', amount); // redelivery
    expect((await workspace(ws).aiCredits()).balance).toBe(before + 100);
    expect(await rows(ws, "SELECT kind, amount, ref FROM credit_ledger WHERE kind = 'purchase'")).toEqual([{ kind: 'purchase', amount: 100, ref: 'credit-pack:TX-C20' }]);
    expect((await json(await a.call('GET', `${buyPath}/orders/${order.orderId}`))).state).toBe('paid');
  });
  it('a second, different payment on the same order adds nothing, and a wrong amount adds nothing', async () => {
    const ws = W(21);
    await seedNumber('pn-c21', ws);
    const a = await apiFor(ws);
    const before = (await workspace(ws).aiCredits()).balance;
    const prev = await preview(a);
    const order = await json(await a.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prev.confirm) }));
    await hook(order.orderId, 'TX-C21-WRONG', '1.00');
    expect((await workspace(ws).aiCredits()).balance).toBe(before);
    const amount = (prev.pack.priceMinor / 100).toFixed(2);
    await hook(order.orderId, 'TX-C21-A', amount);
    await hook(order.orderId, 'TX-C21-B', amount);
    expect((await workspace(ws).aiCredits()).balance).toBe(before + 100);
  });
  it('a failed payment closes the order and adds nothing', async () => {
    const ws = W(22);
    await seedNumber('pn-c22', ws);
    const a = await apiFor(ws);
    const before = (await workspace(ws).aiCredits()).balance;
    const prev = await preview(a);
    const order = await json(await a.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prev.confirm) }));
    const { body, sig } = await signed({ merchantOrderId: order.orderId, transactionId: 'TX-C22', amount: (prev.pack.priceMinor / 100).toFixed(2), status: 'FAILURE' });
    await handleProviderWebhook(env, body, sig, kashier, Date.now());
    expect((await workspace(ws).aiCredits()).balance).toBe(before);
    expect((await json(await a.call('GET', `${buyPath}/orders/${order.orderId}`))).state).toBe('failed');
  });
  it('a double click on Buy is one order: the confirmation is single-use', async () => {
    const ws = W(23);
    await seedNumber('pn-c23', ws);
    const a = await apiFor(ws);
    const prev = await preview(a);
    const [x, y] = await Promise.all([a.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prev.confirm) }), a.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prev.confirm) })]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM credit_orders WHERE workspace_id = ?').bind(ws).first()).toEqual({ n: 1 });
  });
  it('an edited pack (a confirmation for 100 credits spent on 1000) is refused and creates no order', async () => {
    const ws = W(24);
    await seedNumber('pn-c24', ws);
    const a = await apiFor(ws);
    const prev = await preview(a, 'credits-100');
    const r = await a.call('POST', `${buyPath}/orders`, { packId: 'credits-1000', ...tok(prev.confirm) });
    expect(r.status).toBe(409);
    expect((await json(r)).message).toBe('confirmation_mismatch');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM credit_orders WHERE workspace_id = ?').bind(ws).first()).toEqual({ n: 0 });
  });
  it('a price that moved after the preview is refused (the confirmation binds the price shown)', async () => {
    const ws = W(25);
    await seedNumber('pn-c25', ws);
    const a = await apiFor(ws);
    const prev = await preview(a);
    await env.DB.prepare("INSERT INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('dear-25', 'Dear', 900000, 100, 1, 1)").run();
    try {
      const r = await a.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prev.confirm) });
      expect((await json(r)).message).toBe('confirmation_mismatch');
    } finally {
      await env.DB.prepare("DELETE FROM packages WHERE id = 'dear-25'").run();
    }
  });
  it('owner only; tenant comes from the session: staff 403, a token for store B cannot buy for store A', async () => {
    const ws = W(26);
    const other = W(27);
    await seedNumber('pn-c26', ws);
    await seedNumber('pn-c27', other);
    const staff = await apiFor(ws, 'staff');
    for (const [m, p, b] of [['GET', buyPath, undefined], ['POST', `${buyPath}/preview`, { packId: 'credits-100' }], ['POST', `${buyPath}/orders`, { packId: 'credits-100', confirmId: crypto.randomUUID(), token: 'a'.repeat(64) }]] as const) expect((await staff.call(m, p, b)).status, `${m} ${p}`).toBe(403);
    const b = await apiFor(other);
    const prevB = await preview(b);
    const a = await apiFor(ws);
    const r = await a.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prevB.confirm) });
    expect(r.status).toBe(409); // store B's confirmation is not store A's
    expect(await env.DB.prepare('SELECT count(*) AS n FROM credit_orders WHERE workspace_id IN (?, ?)').bind(ws, other).first()).toEqual({ n: 0 });
    const prevOwn = await preview(b);
    const orderB = await json(await b.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prevOwn.confirm) }));
    expect((await a.call('GET', `${buyPath}/orders/${orderB.orderId}`)).status).toBe(404); // store A cannot read store B's order
  });
  it('a revoked session cannot start a payment and writes nothing', async () => {
    const ws = W(28);
    await seedNumber('pn-c28', ws);
    const a = await apiFor(ws);
    const prev = await preview(a);
    configureSessionCheck(async () => true);
    const r = await a.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prev.confirm) });
    expect(r.status).toBe(403); // the auth layer refuses a revoked session before the route runs
    expect(await env.DB.prepare('SELECT count(*) AS n FROM credit_orders WHERE workspace_id = ?').bind(ws).first()).toEqual({ n: 0 });
  });
  it('a revoked session is refused at the money layer too (not only by the auth layer)', async () => {
    const ws = W(32);
    await seedNumber('pn-c32', ws);
    configureSessionCheck(async () => true);
    expect(await startCreditPack(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packId: 'credits-100', confirmId: crypto.randomUUID(), token: 'a'.repeat(64) })).toEqual({ ok: false, reason: 'session_revoked' });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM credit_orders WHERE workspace_id = ?').bind(ws).first()).toEqual({ n: 0 });
  });
  it('when the provider session cannot be opened the order is closed as failed, never left pending', async () => {
    const ws = W(29);
    await seedNumber('pn-c29', ws);
    const a = await apiFor(ws);
    const prev = await preview(a);
    configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, { createSession: async () => { throw new Error('down'); } }));
    const r = await a.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prev.confirm) });
    expect(r.status).toBe(503);
    expect(await env.DB.prepare('SELECT state FROM credit_orders WHERE workspace_id = ?').bind(ws).all().then((x) => x.results)).toEqual([{ state: 'failed' }]);
  });
  it('the daily repair credits a paid order whose webhook never came, once', async () => {
    const ws = W(30);
    await seedNumber('pn-c30', ws);
    const a = await apiFor(ws);
    const before = (await workspace(ws).aiCredits()).balance;
    const prev = await preview(a);
    const order = await json(await a.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prev.confirm) }));
    await env.DB.prepare('UPDATE credit_orders SET created_at = ? WHERE order_id = ?').bind(Date.now() - 20 * 60_000, order.orderId).run();
    const fake = { ...kashier, name: 'fake', inquire: async (o: string) => (o === order.orderId ? { status: 'SUCCESS' as const, transactionId: 'TX-C30', amountMinor: prev.pack.priceMinor, currency: 'EGP' } : ('unavailable' as const)), confirmationReady: () => true } as unknown as PaymentProvider;
    expect(await repairCreditOrders(env, fake)).toMatchObject({ credited: 1 });
    expect(await repairCreditOrders(env, fake)).toMatchObject({ credited: 0 });
    expect((await workspace(ws).aiCredits()).balance).toBe(before + 100);
  });
  it('a refund of the payment never silently takes credits back: it raises a P1 for a person', async () => {
    const ws = W(31);
    await seedNumber('pn-c31', ws);
    const a = await apiFor(ws);
    const prev = await preview(a);
    const order = await json(await a.call('POST', `${buyPath}/orders`, { packId: 'credits-100', ...tok(prev.confirm) }));
    const amount = (prev.pack.priceMinor / 100).toFixed(2);
    await hook(order.orderId, 'TX-C31', amount);
    const spy = vi.spyOn(console, 'error');
    await hook(order.orderId, 'TX-C31-R', amount, 'refund');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('credit_pack_refunded'))).toBe(true);
    expect((await workspace(ws).aiCredits()).balance).toBeGreaterThanOrEqual(100);
  });
});

describe('confirmation tokens', () => {
  it('only the hash of the token is stored', async () => {
    const ws = W(40);
    await seedNumber('pn-t40', ws);
    const a = await apiFor(ws);
    const prev = await json(await a.call('POST', '/wallet/credit-packs/preview', { packId: 'credits-100' }));
    const row = await env.DB.prepare('SELECT token_hash, payload_hash FROM money_confirmations WHERE id = ?').bind(prev.confirm.confirmId).first<{ token_hash: string; payload_hash: string }>();
    expect(row!.token_hash).not.toBe(prev.confirm.token);
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM money_confirmations WHERE token_hash = ?').bind(prev.confirm.token).first()).toEqual({ n: 0 });
  });
  it('a wrong token is refused as missing and does not spend the real one', async () => {
    const ws = W(41);
    await seedNumber('pn-t41', ws);
    const a = await apiFor(ws);
    const prev = await json(await a.call('POST', '/wallet/credit-packs/preview', { packId: 'credits-100' }));
    const bad = await a.call('POST', '/wallet/credit-packs/orders', { packId: 'credits-100', confirmId: prev.confirm.confirmId, token: '0'.repeat(64) });
    expect((await json(bad)).message).toBe('confirmation_missing');
    expect((await a.call('POST', '/wallet/credit-packs/orders', { packId: 'credits-100', ...tok(prev.confirm) })).status).toBe(201);
  });
  it('a new preview replaces the open one: the old card can no longer be confirmed', async () => {
    const ws = W(42);
    await seedNumber('pn-t42', ws);
    const a = await apiFor(ws);
    const first = await json(await a.call('POST', '/wallet/credit-packs/preview', { packId: 'credits-100' }));
    await a.call('POST', '/wallet/credit-packs/preview', { packId: 'credits-100' });
    expect((await json(await a.call('POST', '/wallet/credit-packs/orders', { packId: 'credits-100', ...tok(first.confirm) }))).message).toBe('confirmation_missing');
  });
});
