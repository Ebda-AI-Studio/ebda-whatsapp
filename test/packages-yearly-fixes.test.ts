import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonthsUtc, yearlyRefundQuote } from '../src/core/billing/yearly';
import { createInstapayRequest } from '../src/core/billing/instapay';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { packageRefundQuote, startPackageCheckout } from '../src/core/billing/package-orders';
import { rollRenewals } from '../src/core/billing/subscriptions';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, apiFor, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { KEY, kashierLedger, testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';
import { exec, rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const kashier = testKashier();
const W = (n: number) => W0(9950 + n);
const addMonths = addMonthsUtc;
const PAYEE = { handle: 'ebda@instapay', name: 'Ebda AI Studio', qrUrl: 'https://media.ebda.app/platform/instapay-qr.jpg' };

beforeEach(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)").run();
  configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, {}));
  configureSessionCheck(async () => false);
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
const hook = async (orderId: string, tx: string, amount: string, o: { label?: string } = {}) => {
  const { body, sig } = await signed({ merchantOrderId: orderId, transactionId: tx, amount }, o.label ?? 'pay');
  return handleProviderWebhook(env, body, sig, kashier, Date.now());
};
async function buy(ws: string, packageId: string, amount: string) {
  await seedNumber(`pn-yf-${ws.slice(-5)}`, ws);
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId });
  if (!r.ok) throw new Error(r.reason);
  await hook(r.orderId, `TX-${crypto.randomUUID()}`, amount);
  return r;
}
const sub = (ws: string) => env.DB.prepare('SELECT package_id, status, period_start, period_end, version, queued_periods FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ package_id: string; status: string; period_start: number; period_end: number; version: number; queued_periods: number }>();
const orderRow = (id: string) => env.DB.prepare('SELECT refunded_minor, status FROM package_orders WHERE order_id = ?').bind(id).first<{ refunded_minor: number; status: string }>();
const ledger = (ws: string) => rows<{ ref: string; amount: number; kind: string }>(ws, "SELECT ref, amount, kind FROM credit_ledger WHERE kind IN ('grant', 'expire') ORDER BY id");
const ev = (o: Record<string, unknown> = {}) => ({ version: 1, packageId: 'pro-yearly', status: 'active' as const, periodStart: Date.UTC(2027, 0, 10, 8), periodEnd: addMonths(Date.UTC(2027, 0, 10, 8), 12), aiCredits: 300, periodMonths: 12, ...o });
const count = (ws: string) => rows<{ n: number }>(ws, "SELECT count(*) AS n FROM scheduled_tasks WHERE kind = 'credit_month'").then((r) => r[0]!.n);

describe('Critical 1: credit_month can never run twice for a month', () => {
  it('a leased task plus an entitlement event before it finishes leaves exactly ONE task, and every month is granted exactly once', async () => {
    const ws = W(1);
    const e = ev();
    await workspace(ws).applyEntitlement(e);
    expect(await count(ws)).toBe(1);
    await exec(ws, "UPDATE scheduled_tasks SET lease_until = ? WHERE kind = 'credit_month'", Date.now() + 300_000); // the task is running right now
    await workspace(ws).applyEntitlement({ ...e, version: 2 }); // an event lands meanwhile
    expect(await count(ws)).toBe(1); // not two
    await exec(ws, "UPDATE scheduled_tasks SET lease_until = NULL WHERE kind = 'credit_month'");
    for (let k = 1; k <= 11; k++) {
      await workspace(ws).runDueTasks(addMonths(e.periodStart, k) + 1000);
      expect((await workspace(ws).aiCredits()).balance, `month ${k + 1}`).toBe(300);
    }
    const l = await ledger(ws);
    expect(l.filter((r) => r.kind === 'grant').map((r) => r.ref)).toEqual([0, ...Array.from({ length: 11 }, (_v, i) => i + 1)].map((k) => `grant:${addMonths(e.periodStart, k)}:pro-yearly`));
    expect(l.filter((r) => r.kind === 'expire')).toHaveLength(11);
    expect(l.filter((r) => r.kind === 'expire').every((r) => r.amount === -300)).toBe(true);
    expect(await count(ws)).toBe(0);
  });
  it('a stale duplicate task for a month already granted does nothing (no expiry of the fresh grant)', async () => {
    const ws = W(2);
    const e = ev();
    await workspace(ws).applyEntitlement(e);
    await workspace(ws).runDueTasks(addMonths(e.periodStart, 1) + 1000);
    const before = await ledger(ws);
    await exec(ws, "INSERT INTO scheduled_tasks (kind, due_at, payload) VALUES ('credit_month', 1, ?)", JSON.stringify({ periodStart: e.periodStart, k: 1 }));
    await workspace(ws).runDueTasks(addMonths(e.periodStart, 1) + 2000);
    expect(await ledger(ws)).toEqual(before);
    expect((await workspace(ws).aiCredits()).balance).toBe(300);
  });
});

describe('Important 3 and 4: cancelled-in-effect keeps granting, and a replayed event cannot skip a month', () => {
  it('a yearly plan cancelled while in effect still gets its monthly credits until period_end; past_due does not', async () => {
    const ws = W(3);
    const e = ev();
    await workspace(ws).applyEntitlement(e);
    await workspace(ws).applyEntitlement({ ...e, version: 2, status: 'cancelled', cancelledAt: e.periodStart + 1000 });
    await workspace(ws).runDueTasks(addMonths(e.periodStart, 1) + 1000);
    expect((await ledger(ws)).filter((r) => r.kind === 'grant')).toHaveLength(2);
    expect((await workspace(ws).aiCredits()).balance).toBe(300);
    await workspace(ws).applyEntitlement({ ...e, version: 3, status: 'past_due', pastDueSince: e.periodStart + 5000 });
    await workspace(ws).runDueTasks(addMonths(e.periodStart, 2) + 1000);
    expect((await ledger(ws)).filter((r) => r.kind === 'grant')).toHaveLength(2);
  });
  it('after missed months a replayed event schedules the NEXT ungranted month, and the catch-up grants 2, 3, 4, 5 in order (none skipped)', async () => {
    const ws = W(4);
    const e = ev();
    await workspace(ws).applyEntitlement(e);
    await workspace(ws).runDueTasks(addMonths(e.periodStart, 1) + 1000); // months 0 and 1 granted
    await workspace(ws).applyEntitlement({ ...e, version: 2 }, addMonths(e.periodStart, 5) + 500); // the same period replayed late
    const task = (await rows<{ due_at: number }>(ws, "SELECT due_at FROM scheduled_tasks WHERE kind = 'credit_month'"))[0]!;
    expect(task.due_at).toBe(addMonths(e.periodStart, 2));
    await workspace(ws).runDueTasks(addMonths(e.periodStart, 5) + 1000);
    expect((await ledger(ws)).filter((r) => r.kind === 'grant').map((r) => r.ref)).toEqual([0, 1, 2, 3, 4, 5].map((k) => `grant:${addMonths(e.periodStart, k)}:pro-yearly`));
    expect((await workspace(ws).aiCredits()).balance).toBe(300);
  });
});

describe('Critical 2 + minor: partial refunds are cumulative and can only shorten', () => {
  it('two refunds in a row give exact ends, a sub-month refund changes nothing, and the end never moves later', async () => {
    const ws = W(5);
    const o = await buy(ws, 'starter-yearly', '6210.00');
    const s = (await sub(ws))!;
    const ends: number[] = [];
    for (const [tx, amt] of [['TX-A', '1035.00'], ['TX-B', '1035.00'], ['TX-C', '517.49'], ['TX-D', '3622.50']] as const) {
      await hook(o.orderId, tx, amt, { label: 'partial_refund' });
      ends.push((await sub(ws))!.period_end);
    }
    expect(ends.slice(0, 3)).toEqual([addMonths(s.period_start, 10), addMonths(s.period_start, 8), addMonths(s.period_start, 8)]);
    for (let i = 1; i < ends.length; i++) expect(ends[i]!).toBeLessThanOrEqual(ends[i - 1]!);
    // cumulative: 103500 + 103500 + 51749 + 362250 = 621 - ... = 620999 < 621000, so floor(620999 / 51750) = 11 months in total, capped at the unused ones (1 month kept)
    expect(ends[3]).toBe(addMonths(s.period_start, 1));
    expect((await orderRow(o.orderId))!.refunded_minor).toBe(103500 + 103500 + 51749 + 362250);
  });
  it('repeated small refunds add up (cumulative, not per refund)', async () => {
    const ws = W(6);
    const o = await buy(ws, 'starter-yearly', '6210.00');
    const s = (await sub(ws))!;
    await hook(o.orderId, 'TX-S1', '300.00', { label: 'partial_refund' }); // 30000 < 51750
    expect((await sub(ws))!.period_end).toBe(s.period_end);
    await hook(o.orderId, 'TX-S2', '300.00', { label: 'partial_refund' }); // 60000 total -> 1 month
    expect((await sub(ws))!.period_end).toBe(addMonths(s.period_start, 11));
  });
});

describe('Important 6: the quote is priced on the original amount and the cumulative refunds', () => {
  const start = Date.UTC(2026, 0, 15, 10);
  const q = (o: Record<string, number> = {}) => yearlyRefundQuote({ priceMinor: 621000, periodMonths: 12, periodStart: start, now: start + 86_400_000, debtMinor: 0, ...o });
  it('counts unused months up to the CURRENT end, and nets out money already refunded', () => {
    expect(q({ periodEnd: addMonths(start, 10), refundedMinor: 103500 })).toMatchObject({ unusedMonths: 9, monthlyMinor: 51750, grossMinor: 9 * 51750, refundMinor: 9 * 51750 });
    // 51749 already refunded beyond the 2 months cut: it is deducted from what is left
    expect(q({ periodEnd: addMonths(start, 10), refundedMinor: 155249 })).toMatchObject({ unusedMonths: 9, grossMinor: 9 * 51750 - 51749, refundMinor: 9 * 51750 - 51749 });
  });
  it('never offers more than the amount minus what was refunded', () => {
    expect(q({ paidMinor: 100000 })).toMatchObject({ unusedMonths: 11, grossMinor: 100000, refundMinor: 100000 }); // paid less than the months are worth (an upgrade not yet paid up, a part refund): capped
    expect(q({ paidMinor: 621000, refundedMinor: 621000 })).toMatchObject({ grossMinor: 0, refundMinor: 0 });
  });
  it('the 31 Jan start has two anniversaries in March (3 Mar and 31 Mar): each month index is still granted exactly once', () => {
    const jan31 = Date.UTC(2026, 0, 31, 9);
    expect([1, 2, 3].map((k) => new Date(addMonths(jan31, k)).toISOString().slice(0, 10))).toEqual(['2026-03-03', '2026-03-31', '2026-05-01']);
  });
});

/** Buys `packageId` at `at` (checkout and payment both stamped with `at`): the period then starts at `at`. */
async function buyAt(ws: string, packageId: string, at: number) {
  await seedNumber(`pn-yf-${ws.slice(-5)}`, ws);
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId }, at);
  if (!r.ok) throw new Error(r.reason);
  const { body, sig } = await signed({ merchantOrderId: r.orderId, transactionId: `TX-${crypto.randomUUID()}`, amount: (r.amountMinor / 100).toFixed(2) });
  await handleProviderWebhook(env, body, sig, kashier, at);
  return r;
}
const orderFull = (id: string) => env.DB.prepare('SELECT kind, from_package, period_months, amount_minor, refunded_minor, queued_seq, owns_running, status FROM package_orders WHERE order_id = ?').bind(id).first<Record<string, number | string | null>>();

describe('WA-YEARLY-SWITCH-2 (Important 5): upgrades pay the prorated difference, downgrades queue, a queue cannot be switched', () => {
  const T0 = Date.now();
  const monthK = (k: number) => addMonths(T0, k - 1) + 3_600_000; // an hour into month k (1-based)

  it.each([[1, 720000], [6, 420000], [12, 60000]] as const)('upgrade starter-yearly to growth-yearly in month %i costs exactly %i minor ((111750 - 51750) x the remaining months, the current month included), same end, new package at once', async (k, price) => {
    const ws = W(60 + k);
    await buyAt(ws, 'starter-yearly', T0);
    const before = (await sub(ws))!;
    const up = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'growth-yearly' }, monthK(k));
    if (!up.ok) throw new Error(up.reason);
    expect(up.amountMinor).toBe(price);
    expect(await orderFull(up.orderId)).toMatchObject({ kind: 'upgrade', from_package: 'starter-yearly', period_months: 12, amount_minor: price, status: 'pending' });
    const { body, sig } = await signed({ merchantOrderId: up.orderId, transactionId: `TX-UP-${k}`, amount: (price / 100).toFixed(2) });
    await handleProviderWebhook(env, body, sig, kashier, monthK(k));
    const after = (await sub(ws))!;
    expect(after).toMatchObject({ package_id: 'growth-yearly', status: 'active', period_start: before.period_start, period_end: before.period_end, queued_periods: 0 });
    expect(after.version).toBeGreaterThan(before.version);
    expect(await orderFull(up.orderId)).toMatchObject({ status: 'paid', owns_running: 0, queued_seq: null });
  });
  it('rounds the money DOWN to a whole EGP (multiple of 100 minor), in the merchant\'s favour, and only the money', async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at, max_members, feat_campaigns, feat_order_in_chat, feat_api, priority_support, period_months) VALUES ('mid-yearly', 'Mid (yearly)', 1000003, 1500, 1, 0, 5, 1, 1, 0, 0, 12)").run();
    const ws = W(30);
    await buyAt(ws, 'starter-yearly', T0);
    const up = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'mid-yearly' }, monthK(7));
    if (!up.ok) throw new Error(up.reason);
    // floor(1000003 / 12) = 83333; (83333 - 51750) x 6 remaining months (7..12) = 189498 -> floor to 189400
    expect(up.amountMinor).toBe(189400);
  });
  it('the credits switch to the new allowance from the CURRENT month: the difference is added once, used credits are kept, later months grant the new allowance', async () => {
    const ws = W(31);
    await buyAt(ws, 'starter-yearly', T0);
    await workspace(ws).runDueTasks(monthK(6)); // catch up to month 6
    expect((await workspace(ws).aiCredits()).balance).toBe(300);
    await workspace(ws).postAiCredits({ kind: 'adjustment', amount: -100, ref: 'used-100', actor: 'op', note: 'used this month' });
    const up = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'growth-yearly' }, monthK(6));
    if (!up.ok) throw new Error(up.reason);
    const pay = async () => { const { body, sig } = await signed({ merchantOrderId: up.orderId, transactionId: 'TX-UP-CR', amount: '4200.00' }); return handleProviderWebhook(env, body, sig, kashier, monthK(6)); };
    await pay();
    expect((await workspace(ws).aiCredits()).balance).toBe(200 + 1200); // 300 -> 1500 allowance; the 100 used stays used
    await pay(); // the payment is replayed
    expect((await workspace(ws).aiCredits()).balance).toBe(1400);
    const v = (await sub(ws))!.version;
    await pay();
    expect((await sub(ws))!.version).toBe(v);
    await workspace(ws).runDueTasks(monthK(7)); // month 7 grants the NEW allowance
    expect((await workspace(ws).aiCredits()).balance).toBe(1500);
  });
  it('a downgrade (a lower yearly, or any monthly) is queued for the next renewal with no refund; the current package runs to its end, and then the queued one starts for 12 months at its own price', async () => {
    const ws = W(32);
    await buyAt(ws, 'growth-yearly', T0);
    const before = (await sub(ws))!;
    const low = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'starter-yearly' }, monthK(3));
    if (!low.ok) throw new Error(low.reason);
    expect(low.amountMinor).toBe(621000);
    expect(await orderFull(low.orderId)).toMatchObject({ kind: 'queued_switch', from_package: 'growth-yearly', period_months: 12 });
    const { body, sig } = await signed({ merchantOrderId: low.orderId, transactionId: 'TX-DOWN', amount: '6210.00' });
    await handleProviderWebhook(env, body, sig, kashier, monthK(3));
    expect(await sub(ws)).toMatchObject({ package_id: 'growth-yearly', period_end: before.period_end, queued_periods: 1 });
    expect((await workspace(ws).getEntitlement())!.packageId).toBe('growth-yearly');
    expect(await orderFull(low.orderId)).toMatchObject({ status: 'paid', queued_seq: 1, owns_running: 0 });
    const ended = Math.floor((Date.now() - 1000) / 1000) * 1000;
    await env.DB.prepare('UPDATE workspace_subscriptions SET period_end = ? WHERE workspace_id = ?').bind(ended, ws).run();
    expect(await rollRenewals(env, ws, Date.now())).toBe(1);
    expect(await sub(ws)).toMatchObject({ package_id: 'starter-yearly', period_start: ended, period_end: addMonths(ended, 12), queued_periods: 0 });
  });
  it('a monthly package bought during a yearly plan is also a queued downgrade (no refund)', async () => {
    const ws = W(33);
    await buyAt(ws, 'growth-yearly', T0);
    const m = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'gold' }, monthK(2));
    if (!m.ok) throw new Error(m.reason);
    expect(await orderFull(m.orderId)).toMatchObject({ kind: 'queued_switch', amount_minor: 50000, period_months: 1 });
  });
  it('a QUEUED period cannot be switched: 409 yearly_queued from card and InstaPay; renewing the running package is still fine', async () => {
    const ws = W(34);
    const api = await apiFor(ws);
    await buyAt(ws, 'growth-yearly', T0);
    await buyAt(ws, 'growth-yearly', T0 + 1000); // a queued renewal of the same package
    expect((await sub(ws))!.queued_periods).toBe(1);
    expect(await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'pro-yearly' }, monthK(2))).toEqual({ ok: false, reason: 'yearly_queued' });
    expect(await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'gold' }, monthK(2))).toEqual({ ok: false, reason: 'yearly_queued' });
    expect(await createInstapayRequest(env, { workspaceId: ws, userId: 'merchant-1', sessionId: 's1', input: { kind: 'package', packageId: 'pro-yearly' }, payee: PAYEE }, monthK(2))).toEqual({ ok: false, reason: 'yearly_queued' });
    const res = await api.call('POST', '/packages/starter-yearly/checkout');
    expect([res.status, await res.json()]).toEqual([409, { error: 'yearly_queued' }]);
    expect((await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'growth-yearly' }, monthK(2))).ok).toBe(true);
    // a queued SWITCH also blocks everything (even a renewal)
    const ws2 = W(35);
    await buyAt(ws2, 'growth-yearly', T0);
    await buyAt(ws2, 'starter-yearly', T0 + 1000); // queued downgrade
    expect(await startPackageCheckout(env, { workspaceId: ws2, userId: 'u1', sessionId: 's1', packageId: 'growth-yearly' }, monthK(2))).toEqual({ ok: false, reason: 'yearly_queued' });
  });
  it('upgrade -> downgrade -> upgrade cannot produce a free month of the higher plan: the total paid covers every month used at its rate, to the whole EGP', async () => {
    const ws = W(36);
    await buyAt(ws, 'starter-yearly', T0);
    const up = await buyAt(ws, 'growth-yearly', monthK(6)); // upgrade in month 6
    expect(up.amountMinor).toBe(420000);
    const down = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'starter-yearly' }, monthK(8));
    expect(down.ok).toBe(true); // a queued downgrade for the next year: its own full price, no credit for the higher plan
    if (down.ok) {
      const { body, sig } = await signed({ merchantOrderId: down.orderId, transactionId: 'TX-CYC-D', amount: '6210.00' });
      await handleProviderWebhook(env, body, sig, kashier, monthK(8));
    }
    // the second upgrade is refused while a period is queued
    expect(await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'pro-yearly' }, monthK(9))).toEqual({ ok: false, reason: 'yearly_queued' });
    const paidForThisPeriod = 621000 + 420000; // starter-yearly + the month-6 upgrade
    const usedAtRates = 5 * 51750 + 7 * 111750; // months 1-5 at the starter rate, months 6-12 at the growth rate
    expect(paidForThisPeriod).toBeGreaterThanOrEqual(usedAtRates);
    expect(paidForThisPeriod).toBe(1041000);
  });
  it('a partial refund after an upgrade is measured at the CURRENT package\'s price/12, cumulatively across the period\'s orders', async () => {
    const ws = W(37);
    const a = await buyAt(ws, 'starter-yearly', T0);
    const u = await buyAt(ws, 'growth-yearly', monthK(1)); // upgraded in month 1: paid 621000 + 720000
    const s = (await sub(ws))!;
    await hook(u.orderId, 'TX-UR-1', '2235.00', { label: 'partial_refund' }); // 223500 = 2 x 111750
    expect((await sub(ws))!.period_end).toBe(addMonths(s.period_start, 10));
    await hook(a.orderId, 'TX-UR-2', '1117.50', { label: 'partial_refund' }); // + 111750 on the original order: 335250 in total = 3 months
    expect((await sub(ws))!.period_end).toBe(addMonths(s.period_start, 9));
  });
  it('the refund quote after an upgrade prices the remaining months at the CURRENT package\'s price/12 and caps at everything paid for the period minus refunds', async () => {
    const ws = W(38);
    const a = await buyAt(ws, 'starter-yearly', T0);
    await buyAt(ws, 'growth-yearly', monthK(1));
    const q = await packageRefundQuote(env, a.orderId, monthK(1) + 1000);
    expect(q).toMatchObject({ unusedMonths: 11, monthlyMinor: 111750, grossMinor: 11 * 111750, refundMinor: 11 * 111750 });
    await hook(a.orderId, 'TX-QR-1', '1117.50', { label: 'partial_refund' }); // one month's worth refunded
    expect(await packageRefundQuote(env, a.orderId, monthK(1) + 1000)).toMatchObject({ unusedMonths: 10, grossMinor: 10 * 111750, refundMinor: 10 * 111750 });
  });
  it('over HTTP an upgrade checkout answers with the prorated amount', async () => {
    const ws = W(39);
    const api = await apiFor(ws);
    await buyAt(ws, 'starter-yearly', Date.now());
    const res = await api.call('POST', '/packages/growth-yearly/checkout');
    expect(res.status).toBe(201);
    expect(((await res.json()) as { amountMinor: number }).amountMinor).toBe(720000);
  });
  it('a queued yearly period rolls as 12 months because the ORDER was bought as 12, whatever the package row says later', async () => {
    const ws = W(40);
    await buy(ws, 'starter-yearly', '6210.00');
    await buy(ws, 'starter-yearly', '6210.00');
    expect((await sub(ws))!.queued_periods).toBe(1);
    await env.DB.prepare("UPDATE packages SET period_months = 1 WHERE id = 'starter-yearly'").run();
    const ended = Math.floor((Date.now() - 1000) / 1000) * 1000;
    await env.DB.prepare('UPDATE workspace_subscriptions SET period_end = ? WHERE workspace_id = ?').bind(ended, ws).run();
    expect(await rollRenewals(env, ws, Date.now())).toBe(1);
    const after = (await sub(ws))!;
    expect(after.period_start).toBe(ended);
    expect(after.period_end).toBe(addMonths(ended, 12));
    await env.DB.prepare("UPDATE packages SET period_months = 12 WHERE id = 'starter-yearly'").run();
  });
});

describe('Important 7: the operator cancels a yearly plan, sees the quote and executes the refund debt-first', () => {
  const debt = async (ws: string, minor: number) => { expect((await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -minor, ref: `debt-${ws}`, actor: 'op', note: 'test debt' })).ok).toBe(true); };
  it('settles the wallet debt FIRST (idempotent ledger row), shortens by the quote\'s months, cancels at the end of the current month, and the later cash refund does not shorten again', async () => {
    const ws = W(11);
    const o = await buy(ws, 'starter-yearly', '6210.00');
    await debt(ws, 100000);
    const s = (await sub(ws))!;
    const quote = await (await operatorCall(OP1, 'GET', `/package-orders/${o.orderId}/refund-quote`)).json();
    expect(quote).toMatchObject({ unusedMonths: 11, grossMinor: 569250, debtMinor: 100000, debtSettledMinor: 100000, refundMinor: 469250 });
    const res = await operatorCall(OP1, 'POST', `/package-orders/${o.orderId}/yearly-refund`, { reason: 'merchant asked to leave' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orderId: o.orderId, shortenedMonths: 11, debtSettledMinor: 100000, cashRefundMinor: 469250, noMoneyOut: false, periodEnd: addMonths(s.period_start, 1) });
    const after = (await sub(ws))!;
    expect(after).toMatchObject({ status: 'cancelled', period_end: addMonths(s.period_start, 1) });
    expect((await workspace(ws).walletView()).balanceMinor).toBe(0);
    expect(await rows(ws, "SELECT kind, amount_minor FROM wallet_ledger WHERE ref = ?", `yearly-refund-debt:${o.orderId}`)).toEqual([{ kind: 'adjustment', amount_minor: 100000 }]);
    expect((await orderRow(o.orderId))!.refunded_minor).toBe(100000);
    // replay: the same answer, no second ledger row, no second shortening
    const again = await operatorCall(OP1, 'POST', `/package-orders/${o.orderId}/yearly-refund`, { reason: 'merchant asked to leave' });
    expect(await again.json()).toMatchObject({ shortenedMonths: 11, debtSettledMinor: 100000, cashRefundMinor: 469250 });
    expect(await rows(ws, "SELECT 1 FROM wallet_ledger WHERE ref = ?", `yearly-refund-debt:${o.orderId}`)).toHaveLength(1);
    expect((await sub(ws))!.period_end).toBe(addMonths(s.period_start, 1));
    // the operator sends the cash through the provider's dashboard; its webhook adds to refunded_minor and shortens nothing more
    await hook(o.orderId, 'TX-CASH', '4692.50', { label: 'partial_refund' });
    expect((await sub(ws))!.period_end).toBe(addMonths(s.period_start, 1));
    expect((await orderRow(o.orderId))!.refunded_minor).toBe(100000 + 469250);
  });
  it('debt at or above the refund value: no money goes out, and it says so', async () => {
    const ws = W(12);
    const o = await buy(ws, 'starter-yearly', '6210.00');
    await debt(ws, 700000);
    const res = await operatorCall(OP1, 'POST', `/package-orders/${o.orderId}/yearly-refund`, { reason: 'merchant asked to leave' });
    expect(await res.json()).toMatchObject({ shortenedMonths: 11, debtSettledMinor: 569250, cashRefundMinor: 0, noMoneyOut: true });
    expect((await workspace(ws).walletView()).balanceMinor).toBe(-130750);
  });
  it('nothing to refund (last month) is a 409; a monthly order or an unknown one is refused; a non-operator (a store owner) gets 403 on both routes', async () => {
    const ws = W(13);
    const api = await apiFor(ws);
    const o = await buy(ws, 'starter-yearly', '6210.00');
    const own = (path: string, method: string) => SELF.fetch(`https://x/api/v1/operator${path}`, { method, headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{"reason":"nope nope"}' } : {}) });
    expect((await own(`/package-orders/${o.orderId}/refund-quote`, 'GET')).status).toBe(403);
    expect((await own(`/package-orders/${o.orderId}/yearly-refund`, 'POST')).status).toBe(403);
    expect((await sub(ws))!.status).toBe('active'); // untouched
    const mo = await buy(W(14), 'gold', '500.00');
    expect((await operatorCall(OP1, 'POST', `/package-orders/${mo.orderId}/yearly-refund`, { reason: 'monthly one' })).status).toBe(409);
    expect((await operatorCall(OP1, 'POST', '/package-orders/nope/yearly-refund', { reason: 'unknown one' })).status).toBe(404);
    expect((await operatorCall(OP1, 'POST', `/package-orders/${o.orderId}/yearly-refund`, {})).status).toBe(400); // a reason is required
  });
  it('the quote read re-checks the operator session (fails closed when the accounts service is down)', async () => {
    const ws = W(15);
    const o = await buy(ws, 'starter-yearly', '6210.00');
    configureSessionCheck(async () => { throw new Error('down'); });
    expect((await operatorCall(OP1, 'GET', `/package-orders/${o.orderId}/refund-quote`)).status).toBe(503);
  });
});

describe('a webhook retry after the store-plan fallback is safe', () => {
  it('replaying a full refund of a yearly order leaves the credit ledger and the balance exactly as they were (postCredit refs are idempotent)', async () => {
    const ws = W(16);
    const o = await buy(ws, 'starter-yearly', '6210.00');
    await hook(o.orderId, 'TX-FULL', '6210.00', { label: 'refund' });
    const once = await ledger(ws);
    const balance = (await workspace(ws).aiCredits()).balance;
    await hook(o.orderId, 'TX-FULL', '6210.00', { label: 'refund' });
    expect(await ledger(ws)).toEqual(once);
    expect((await workspace(ws).aiCredits()).balance).toBe(balance);
  });
});
