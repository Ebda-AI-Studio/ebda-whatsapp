import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { yearlyRefundQuote } from '../src/core/billing/yearly';
import { confirmInstapay, createInstapayRequest, storeProof } from '../src/core/billing/instapay';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { startPackageCheckout } from '../src/core/billing/package-orders';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, OP2, apiFor, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { KEY, kashierLedger, testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';
import { exec, rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const kashier = testKashier();
const W = (n: number) => W0(9900 + n);
const DAY = 86_400_000;
const MONTHLY_TWIN: Record<string, string> = { 'starter-yearly': 'starter', 'growth-yearly': 'growth', 'pro-yearly': 'pro' };
/** The calendar rule the code uses: whole months, UTC. */
const addMonths = (ms: number, n: number) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + n); return d.getTime(); };

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
const hook = async (orderId: string, tx: string, amount: string, o: { label?: string; now?: number } = {}) => {
  const { body, sig } = await signed({ merchantOrderId: orderId, transactionId: tx, amount }, o.label ?? 'pay');
  return handleProviderWebhook(env, body, sig, kashier, o.now ?? Date.now());
};
async function buy(ws: string, packageId: string, amount: string, now = Date.now()) {
  await seedNumber(`pn-y-${ws.slice(-5)}`, ws);
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId }, now);
  if (!r.ok) throw new Error(r.reason);
  await hook(r.orderId, `TX-${crypto.randomUUID()}`, amount, { now });
  return r;
}
const sub = (ws: string) => env.DB.prepare('SELECT package_id, status, period_start, period_end, version FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ package_id: string; status: string; period_start: number; period_end: number; version: number }>();
const grants = (ws: string) => rows<{ ref: string; amount: number; kind: string }>(ws, "SELECT ref, amount, kind FROM credit_ledger WHERE kind IN ('grant', 'expire') ORDER BY id");

describe('seeded yearly packages (migration 0016)', () => {
  it('has the approved yearly prices (9 x monthly) with the same per-month credits and limits as the monthly twins, period_months 12; monthly packages stay 1', async () => {
    const { results } = await env.DB.prepare('SELECT id, price_minor, ai_credits, max_members, feat_campaigns, feat_order_in_chat, feat_api, priority_support, period_months, active FROM packages WHERE id IN (?, ?, ?, ?, ?, ?, ?) ORDER BY id')
      .bind('starter', 'growth', 'pro', 'starter-yearly', 'growth-yearly', 'pro-yearly', 'store-included').all<Record<string, number | string>>();
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    expect([by['starter-yearly']!.price_minor, by['growth-yearly']!.price_minor, by['pro-yearly']!.price_minor]).toEqual([621000, 1341000, 3141000]);
    for (const [y, m] of Object.entries(MONTHLY_TWIN)) {
      const { id: _a, price_minor: _b, period_months: ym, ...yearly } = by[y]!;
      const { id: _c, price_minor: monthlyPrice, period_months: mm, ...monthly } = by[m]!;
      expect(yearly, y).toEqual(monthly);
      expect(ym, y).toBe(12);
      expect(mm, m).toBe(1);
      expect(Number(by[y]!.price_minor), y).toBe(Number(monthlyPrice) * 9);
    }
    expect(by['store-included']).toMatchObject({ price_minor: 0, period_months: 1 });
  });
  it('GET /packages lists them with periodMonths 12, and the monthly ones with 1', async () => {
    const api = await apiFor(W(1));
    const items = ((await (await api.call('GET', '/packages')).json()) as { items: { id: string; periodMonths: number; priceMinor: number; features: string[] }[] }).items;
    const by = Object.fromEntries(items.map((p) => [p.id, p]));
    expect(by['pro-yearly']).toMatchObject({ periodMonths: 12, priceMinor: 3141000 });
    expect(by['pro-yearly']!.features).toEqual(by['pro']!.features);
    expect(by['pro']!.periodMonths).toBe(1);
    expect(by['gold']!.periodMonths).toBe(1);
  });
});

describe('a purchase sets the package\'s own period', () => {
  it('Kashier: a yearly order is a 12-month period; a monthly one is exactly one month, as before', async () => {
    const t = Date.now();
    const y = W(10);
    await buy(y, 'starter-yearly', '6210.00', t);
    const s = (await sub(y))!;
    expect(s).toMatchObject({ package_id: 'starter-yearly', status: 'active' });
    expect(s.period_end).toBe(addMonths(s.period_start, 12));
    const m = W(11);
    await buy(m, 'gold', '500.00', t);
    const g = (await sub(m))!;
    expect(g.period_end).toBe(addMonths(g.period_start, 1));
  });
  it('InstaPay: a yearly package request is a 12-month period once confirmed', async () => {
    const ws = W(12);
    await seedNumber(`pn-y-${ws.slice(-5)}`, ws);
    const PAYEE = { handle: 'ebda@instapay', name: 'Ebda AI Studio', qrUrl: 'https://media.ebda.app/platform/instapay-qr.jpg' };
    const r = await createInstapayRequest(env, { workspaceId: ws, userId: 'merchant-1', sessionId: 's1', input: { kind: 'package', packageId: 'growth-yearly' }, payee: PAYEE });
    if (!r.ok) throw new Error(r.reason);
    expect(r.request.amountMinor).toBe(1341000);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    await storeProof(env, { workspaceId: ws, requestId: r.request.id, sessionId: 's1', bytes: png.buffer.slice(0) as ArrayBuffer, contentType: 'image/png' }, Date.now());
    const first = await confirmInstapay(env, { id: r.request.id, actor: OP1 });
    if (first.ok && first.needsSecond) await confirmInstapay(env, { id: r.request.id, actor: OP2 });
    const s = (await sub(ws))!;
    expect(s.package_id).toBe('growth-yearly');
    expect(s.period_end).toBe(addMonths(s.period_start, 12));
  });
  it('an early yearly renewal queues a 12-month period behind the running one', async () => {
    const ws = W(13);
    await buy(ws, 'starter-yearly', '6210.00');
    const before = (await sub(ws))!;
    await buy(ws, 'starter-yearly', '6210.00');
    expect(await env.DB.prepare('SELECT queued_periods FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first()).toEqual({ queued_periods: 1 });
    // the running period ends: the queued one starts and is 12 months long
    const ended = Math.floor((Date.now() - 1000) / 1000) * 1000; // whole seconds: SQLite month arithmetic is second-precise
    await env.DB.prepare('UPDATE workspace_subscriptions SET period_end = ? WHERE workspace_id = ?').bind(ended, ws).run();
    const { rollRenewals } = await import('../src/core/billing/subscriptions');
    expect(await rollRenewals(env, ws, Date.now())).toBe(1);
    const after = (await sub(ws))!;
    expect(after.period_end).toBe(addMonths(after.period_start, 12));
    expect(after.period_start).toBe(ended); // the queued period starts where the running one ended
    expect(before.period_end).toBe(addMonths(before.period_start, 12));
  });
});

describe('AI credits are granted monthly inside a yearly period, never 12x upfront', () => {
  const ev = (o: Record<string, unknown> = {}) => ({ version: 1, packageId: 'pro-yearly', status: 'active' as const, periodStart: Date.now(), periodEnd: addMonths(Date.now(), 12), aiCredits: 300, periodMonths: 12, ...o });
  it('the first month\'s allowance lands at the start (300, not 3600), and the next month\'s grant is scheduled for the monthly anniversary', async () => {
    const ws = W(20);
    const e = ev();
    await workspace(ws).applyEntitlement(e);
    expect((await workspace(ws).aiCredits()).balance).toBe(300);
    const tasks = await rows<{ due_at: number; payload: string }>(ws, "SELECT due_at, payload FROM scheduled_tasks WHERE kind = 'credit_month'");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.due_at).toBe(addMonths(e.periodStart, 1));
    expect(JSON.parse(tasks[0]!.payload)).toMatchObject({ periodStart: e.periodStart });
    expect(await rows(ws, 'SELECT period_months FROM entitlements')).toEqual([{ period_months: 12 }]);
  });
  it('12 monthly grants in a year: each anniversary grants one month and expires the previous month\'s unused grant; the balance never exceeds one month', async () => {
    const ws = W(21);
    const e = ev();
    await workspace(ws).applyEntitlement(e);
    for (let k = 1; k <= 11; k++) {
      await workspace(ws).runDueTasks(addMonths(e.periodStart, k) + 1000); // time travel to the anniversary
      expect((await workspace(ws).aiCredits()).balance, `month ${k + 1}`).toBe(300);
    }
    const g = await grants(ws);
    expect(g.filter((r) => r.kind === 'grant')).toHaveLength(12);
    expect(g.filter((r) => r.kind === 'grant').every((r) => r.amount === 300)).toBe(true);
    expect(new Set(g.map((r) => r.ref)).size).toBe(g.length); // every grant and expiry is its own row
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'credit_month'")).toEqual([]); // no 13th month
  });
  it('credits used in a month are not expired twice and purchased credits roll over', async () => {
    const ws = W(22);
    const e = ev();
    await workspace(ws).applyEntitlement(e);
    await workspace(ws).postAiCredits({ kind: 'purchase', amount: 40, ref: 'buy-1' });
    expect((await workspace(ws).aiCredits()).balance).toBe(340);
    await workspace(ws).runDueTasks(addMonths(e.periodStart, 1) + 1000);
    expect((await workspace(ws).aiCredits()).balance).toBe(340); // the unused 300 expired, the new 300 landed, the 40 stayed
  });
  it('a renewal (a new period) expires the last month\'s unused grant and grants the first month of the next year; a shortened period stops the monthly grants', async () => {
    const ws = W(23);
    const first = ev();
    await workspace(ws).applyEntitlement(first);
    // a refund shortened the period to 2 months: month 3's grant must not happen
    await workspace(ws).applyEntitlement({ ...first, version: 2, periodEnd: addMonths(first.periodStart, 2) });
    await workspace(ws).runDueTasks(addMonths(first.periodStart, 1) + 1000); // month 2 (k=1) is inside the shortened period
    expect((await grants(ws)).filter((r) => r.kind === 'grant')).toHaveLength(2);
    await workspace(ws).runDueTasks(addMonths(first.periodStart, 2) + 1000); // k=2 starts at the new end: nothing
    expect((await grants(ws)).filter((r) => r.kind === 'grant')).toHaveLength(2);
    // the next year
    await workspace(ws).applyEntitlement({ ...first, version: 3, periodStart: addMonths(first.periodStart, 2), periodEnd: addMonths(first.periodStart, 14) });
    expect((await workspace(ws).aiCredits()).balance).toBe(300); // last month's unused 300 expired, the new month's 300 landed
  });
  it('a monthly package is untouched: one grant per period, no monthly task, period_months 1', async () => {
    const ws = W(24);
    const t = Date.now();
    await workspace(ws).applyEntitlement({ version: 1, packageId: 'pro', status: 'active', periodStart: t, periodEnd: addMonths(t, 1), aiCredits: 5000 });
    expect((await workspace(ws).aiCredits()).balance).toBe(5000);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'credit_month'")).toEqual([]);
    expect(await rows(ws, 'SELECT period_months FROM entitlements')).toEqual([{ period_months: 1 }]);
    await workspace(ws).applyEntitlement({ version: 2, packageId: 'pro', status: 'active', periodStart: addMonths(t, 1), periodEnd: addMonths(t, 2), aiCredits: 5000 });
    expect((await workspace(ws).aiCredits()).balance).toBe(5000); // last period's unused expired, as always
  });
});

describe('Review Focus 5: the yearly refund rule', () => {
  const start = Date.UTC(2026, 0, 15, 10);
  const q = (o: Partial<Parameters<typeof yearlyRefundQuote>[0]> = {}) => yearlyRefundQuote({ priceMinor: 3141000, periodMonths: 12, periodStart: start, now: start + DAY, debtMinor: 0, ...o });
  it('unused WHOLE months x floor(price / 12); the current month is never refunded', () => {
    expect(q()).toMatchObject({ monthlyMinor: 261750, unusedMonths: 11, grossMinor: 11 * 261750, refundMinor: 11 * 261750 });
    expect(q({ now: addMonths(start, 1) - 1 })).toMatchObject({ unusedMonths: 11 }); // still month 1
    expect(q({ now: addMonths(start, 1) })).toMatchObject({ unusedMonths: 10 }); // month 2 began: month 1 is used, month 2 is current
    expect(q({ now: addMonths(start, 5) + DAY })).toMatchObject({ unusedMonths: 6, refundMinor: 6 * 261750 });
  });
  it('a refund in the last month returns 0, and so does a period that has ended', () => {
    expect(q({ now: addMonths(start, 11) + DAY })).toMatchObject({ unusedMonths: 0, refundMinor: 0 });
    expect(q({ now: addMonths(start, 12) + DAY })).toMatchObject({ unusedMonths: 0, refundMinor: 0 });
  });
  it('the floor of price / 12 is used (no rounding up), and a monthly package refunds nothing here (the current month is never refunded)', () => {
    expect(q({ priceMinor: 621000 }).monthlyMinor).toBe(51750);
    expect(q({ priceMinor: 100001 }).monthlyMinor).toBe(8333);
    expect(q({ priceMinor: 149000, periodMonths: 1 })).toMatchObject({ unusedMonths: 0, refundMinor: 0 });
  });
  it('the wallet\'s debt is settled FIRST out of the refund; more debt than the refund leaves 0 to pay out', () => {
    expect(q({ debtMinor: 1_000_000 })).toMatchObject({ grossMinor: 2879250, debtSettledMinor: 1_000_000, refundMinor: 1879250 });
    expect(q({ debtMinor: 5_000_000 })).toMatchObject({ debtSettledMinor: 2879250, refundMinor: 0 });
  });
  it('the operator can read the exact quote for an order (GET /operator/package-orders/:id/refund-quote); an unknown order is 404', async () => {
    const ws = W(30);
    const o = await buy(ws, 'pro-yearly', '31410.00');
    const res = await operatorCall(OP1, 'GET', `/package-orders/${o.orderId}/refund-quote`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ periodMonths: 12, monthlyMinor: 261750, unusedMonths: 11, refundMinor: 11 * 261750, debtMinor: 0 });
    expect((await operatorCall(OP1, 'GET', '/package-orders/nope/refund-quote')).status).toBe(404);
  });
  it('a partial provider refund of a yearly order shortens the period by the refunded WHOLE months (and never the current month); a refund below one month shortens nothing', async () => {
    const ws = W(31);
    const o = await buy(ws, 'starter-yearly', '6210.00');
    const before = (await sub(ws))!;
    await hook(o.orderId, 'TX-Y-A', '1035.00', { label: 'partial_refund' }); // 2 x 517.50
    expect((await sub(ws))!.period_end).toBe(addMonths(before.period_start, 10));
    await hook(o.orderId, 'TX-Y-B', '517.49', { label: 'partial_refund' }); // just under one month
    expect((await sub(ws))!.period_end).toBe(addMonths(before.period_start, 10));
    await hook(o.orderId, 'TX-Y-C', '3622.50', { label: 'partial_refund' }); // 7 months of value, but only 8 - 1 are unused: capped, current month kept
    const end = (await sub(ws))!.period_end;
    expect(end).toBeGreaterThanOrEqual(addMonths(before.period_start, 1));
    expect(await env.DB.prepare('SELECT refunded_minor FROM package_orders WHERE order_id = ?').bind(o.orderId).first()).toMatchObject({ refunded_minor: 103500 + 51749 + 362250 });
  });
  it('a full refund of a yearly order still cancels now and expires only the unused part of the CURRENT month\'s grant', async () => {
    const ws = W(32);
    const o = await buy(ws, 'starter-yearly', '6210.00');
    expect((await workspace(ws).aiCredits()).balance).toBe(300);
    await hook(o.orderId, 'TX-Y-FULL', '6210.00', { label: 'refund' });
    expect((await sub(ws))!.status).toBe('cancelled');
    expect((await workspace(ws).aiCredits()).balance).toBe(0);
  });
  it('a MONTHLY package partial refund is still proportional, exactly as before', async () => {
    const ws = W(33);
    const o = await buy(ws, 'gold', '500.00');
    const before = (await sub(ws))!;
    await hook(o.orderId, 'TX-M-A', '250.00', { label: 'partial_refund' });
    const after = (await sub(ws))!;
    expect(after.period_end).toBeLessThan(before.period_end);
    expect(after.period_end).toBeGreaterThan(before.period_start);
  });
});
