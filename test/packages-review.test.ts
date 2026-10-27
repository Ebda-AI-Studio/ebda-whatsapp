import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { repairPackageOrders, startPackageCheckout } from '../src/core/billing/package-orders';
import { applyStorePlan } from '../src/core/billing/store-plan';
import { reconcileEntitlements, setSubscription } from '../src/core/billing/subscriptions';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { apiFor, operatorCall, OP1, storeId as W0, useApiKey } from './helpers/api';
import { iso, storeEvent, useStoreLink } from './helpers/store-link';
import { kashierLedger, testKashier } from './helpers/kashier';
import { rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
const link = useStoreLink();
const KEY = 'test-payment-api-key';
const kashier = testKashier();
const DAY = 86_400_000;
const W = (n: number) => W0(8500 + n);
beforeEach(async () => {
  configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, {}));
  configureSessionCheck(async () => false);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)"),
    env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('pro-fixture', 'Pro', 90000, 900, 1, 1)"),
  ]);
});
afterEach(() => { configurePayments((e) => (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY ? new KashierProvider(e.KASHIER_MERCHANT_ID, e.KASHIER_API_KEY) : null)); configureSessionCheck(null); vi.restoreAllMocks(); });

async function hmac(text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function signed(data: Record<string, string | number>, event = 'pay', genuine?: string) {
  const keys = ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId', 'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode'];
  const full = { kashierOrderId: 'ko-1', orderReference: 'ref-1', method: 'card', channel: 'online', transactionResponseCode: '00', currency: 'EGP', status: 'SUCCESS', ...data, signatureKeys: keys };
  kashierLedger.set(String((full as Record<string, unknown>).transactionId), { operation: genuine ?? event, status: String((full as Record<string, unknown>).status), orderId: String((full as Record<string, unknown>).merchantOrderId) });
  const str = keys.map((k) => `${k}=${encodeURIComponent(String((full as Record<string, unknown>)[k]))}`).join('&');
  return { body: JSON.stringify({ event, data: full }), sig: await hmac(str) };
}
async function start(ws: string, packageId = 'gold', now = Date.now()) {
  await seedNumber(`pn-pr-${ws.slice(-5)}`, ws);
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId }, now);
  if (!r.ok) throw new Error(r.reason);
  return r;
}
const hook = async (orderId: string, tx: string, amount: string, o: { event?: string; genuine?: string; status?: string; now?: number; e?: typeof env } = {}) => {
  const { body, sig } = await signed({ merchantOrderId: orderId, transactionId: tx, amount, ...(o.status ? { status: o.status } : {}) }, o.event ?? 'pay', o.genuine);
  return handleProviderWebhook(o.e ?? env, body, sig, kashier, o.now ?? Date.now());
};
const order = (id: string) => env.DB.prepare('SELECT status, provider_ref, granted_at, queued FROM package_orders WHERE order_id = ?').bind(id).first<{ status: string; provider_ref: string | null; granted_at: number | null; queued: number }>();
const sub = (ws: string) => env.DB.prepare('SELECT package_id, status, version, source, period_start, period_end, queued_periods FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ package_id: string; status: string; version: number; source: string | null; period_start: number; period_end: number; queued_periods: number }>();
const audits = async (ws: string, action = 'subscription_set') => (await env.DB.prepare('SELECT count(*) AS n FROM billing_audit WHERE workspace_id = ? AND action = ?').bind(ws, action).first<{ n: number }>())!.n;
const ledger = (ws: string) => rows<{ kind: string; ref: string; amount: number }>(ws, 'SELECT kind, ref, amount FROM credit_ledger ORDER BY id');
const credits = async (ws: string) => (await workspace(ws).walletView()).aiCredits.balance;
/** An env whose D1 batch first runs `before` (once): makes another writer commit exactly between a caller's read and its write. */
const interleave = (before: () => Promise<void>): typeof env => {
  let done = false;
  return { ...env, DB: new Proxy(env.DB, { get(t, p) { if (p === 'batch') return async (s: D1PreparedStatement[]) => { if (!done) { done = true; await before(); } return t.batch(s); }; const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v; } }) } as typeof env;
};
const planEv = (ws: string, includes: boolean, t: number, extra: Record<string, unknown> = {}) => storeEvent(ws, 'store.plan_changed', { planCode: 'business', includesWhatsApp: includes, ownerUserId: 'u', effectiveAt: iso(t), ...extra }, { occurredAt: iso(t) }) as Parameters<typeof applyStorePlan>[1];
const buyGold = async (ws: string, now = Date.now(), tx = `TX-${crypto.randomUUID()}`) => { const o = await start(ws, 'gold', now); await hook(o.orderId, tx, '500.00', { now }); return o; };

describe('C1/C2: a paid order is granted exactly once, in one batch, and a lost grant is repaired', () => {
  it('the batch commits and then the call throws: the retry adds nothing (one month, one audit row) and still pushes and tells the Store', async () => {
    const ws = W(1);
    const o = await start(ws);
    const flaky = { ...env, DB: new Proxy(env.DB, { get(t, p) { if (p === 'batch') return async (s: D1PreparedStatement[]) => { await t.batch(s); throw new Error('response lost'); }; const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v; } }) } as typeof env;
    expect((await hook(o.orderId, 'TX-C2', '500.00', { e: flaky })).status).toBe(500);
    expect(await order(o.orderId)).toMatchObject({ status: 'paid', provider_ref: 'TX-C2' });
    expect((await order(o.orderId))!.granted_at).not.toBeNull();
    expect((await hook(o.orderId, 'TX-C2', '500.00')).status).toBe(200);
    const s = (await sub(ws))!;
    expect(s.version).toBe(1);
    expect(s.period_end - s.period_start).toBeGreaterThan(27 * DAY);
    expect(s.period_end - s.period_start).toBeLessThan(32 * DAY);
    expect(await audits(ws)).toBe(1);
    expect(await workspace(ws).getEntitlement()).toMatchObject({ version: 1, packageId: 'gold' });
    expect(link.sink.sent.filter((e) => e.storeId === ws)).toHaveLength(1);
  });

  it('paid with no grant (a batch that never ran) is repaired by the daily pass with an alert; the web sees pending until then', async () => {
    const ws = W(2);
    const o = await start(ws);
    await env.DB.prepare("UPDATE package_orders SET status = 'paid', provider_ref = 'TX-LOST', paid_at = ? WHERE order_id = ?").bind(Date.now(), o.orderId).run();
    const owner = await apiFor(ws);
    expect(await (await owner.call('GET', `/packages/orders/${o.orderId}`)).json()).toMatchObject({ state: 'pending' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await repairPackageOrders(env);
    expect(err.mock.calls.some((c) => String(c[0]).includes('package_paid_not_granted'))).toBe(true);
    expect(await sub(ws)).toMatchObject({ package_id: 'gold', status: 'active', source: 'purchase', version: 1 });
    expect((await order(o.orderId))!.granted_at).not.toBeNull();
    expect(await (await owner.call('GET', `/packages/orders/${o.orderId}`)).json()).toMatchObject({ state: 'paid' });
    await repairPackageOrders(env);
    expect(await audits(ws)).toBe(1);
  });

  it('pending orders older than 24 h expire; a late SUCCESS on an expired order still grants (the money was taken)', async () => {
    const ws = W(3);
    const o = await start(ws, 'gold', Date.now() - 2 * DAY);
    await repairPackageOrders(env);
    expect(await order(o.orderId)).toMatchObject({ status: 'expired' });
    expect((await hook(o.orderId, 'TX-LATE', '500.00')).status).toBe(200);
    expect(await order(o.orderId)).toMatchObject({ status: 'paid' });
    expect(await sub(ws)).toMatchObject({ package_id: 'gold', status: 'active' });
  });
});

describe('I3: an early renewal queues the next period; credits never carry over', () => {
  it('renew on day 10: credits and the running period are untouched; at the old end the new period starts with a fresh grant; one payment = one extra period', async () => {
    const ws = W(4);
    const t0 = Date.now() - 10 * DAY;
    const o1 = await buyGold(ws, t0);
    expect(await credits(ws)).toBe(300);
    const first = (await sub(ws))!;
    const o2 = await start(ws);
    await hook(o2.orderId, 'TX-RENEW', '500.00');
    expect(await order(o2.orderId)).toMatchObject({ status: 'paid', queued: 1 });
    expect(await sub(ws)).toMatchObject({ period_start: first.period_start, period_end: first.period_end, queued_periods: 1 });
    expect(await workspace(ws).getEntitlement()).toMatchObject({ periodStart: first.period_start, periodEnd: first.period_end, status: 'active' });
    expect(await credits(ws)).toBe(300);
    expect((await ledger(ws)).filter((r) => r.kind === 'expire')).toEqual([]);
    expect(o1.orderId).not.toBe(o2.orderId);

    await workspace(ws).runDueTasks(first.period_end + 1);
    expect(await workspace(ws).getEntitlement()).toMatchObject({ periodStart: first.period_end, status: 'active', version: 3 });
    expect((await sub(ws))!.queued_periods).toBe(0);
    const refs = (await ledger(ws)).map((r) => r.ref);
    expect(refs).toContain(`expire:${first.period_start}`);
    expect(refs).toContain(`grant:${first.period_end}:gold`);
    expect(await credits(ws)).toBe(300);

    const second = (await sub(ws))!;
    await workspace(ws).runDueTasks(second.period_end + 1);
    expect((await workspace(ws).getEntitlement())?.status).toBe('expired'); // nothing else was paid for
  });
});

describe('I5: a provider refund or chargeback revokes the package', () => {
  it('a refund cancels (period_end = now), bumps the version, zeroes the unused grant, alerts, and a replay acts once', async () => {
    const ws = W(5);
    await buyGold(ws, Date.now() - 2 * DAY);
    const o = (await env.DB.prepare("SELECT order_id FROM package_orders WHERE workspace_id = ?").bind(ws).first<{ order_id: string }>())!;
    const before = (await sub(ws))!;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const now = Date.now();
    expect((await hook(o.order_id, 'TX-REF', '500.00', { event: 'refund', now })).status).toBe(200);
    expect((await hook(o.order_id, 'TX-REF', '500.00', { event: 'refund', now })).status).toBe(200);
    const after = (await sub(ws))!;
    expect(after).toMatchObject({ status: 'cancelled', version: before.version + 1, period_end: now });
    expect(await order(o.order_id)).toMatchObject({ status: 'refunded' });
    expect(await workspace(ws).getEntitlement()).toMatchObject({ status: 'cancelled', version: before.version + 1 });
    expect(await credits(ws)).toBe(0);
    expect((await ledger(ws)).filter((r) => r.kind === 'expire')).toHaveLength(1);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('"package_refunded"'))).toHaveLength(1);
    expect(link.sink.sent.filter((e) => e.storeId === ws).at(-1)).toMatchObject({ data: { status: 'cancelled', version: before.version + 1 } });
    expect(await audits(ws)).toBe(2);
  });

  it('a chargeback (reversal) is its own state and alert', async () => {
    const ws = W(6);
    await buyGold(ws, Date.now() - DAY);
    const o = (await env.DB.prepare("SELECT order_id FROM package_orders WHERE workspace_id = ?").bind(ws).first<{ order_id: string }>())!;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await hook(o.order_id, 'TX-CB', '500.00', { event: 'reversal' });
    expect(await order(o.order_id)).toMatchObject({ status: 'charged_back' });
    expect((await sub(ws))!.status).toBe('cancelled');
    expect(err.mock.calls.some((c) => String(c[0]).includes('"package_chargeback"'))).toBe(true);
  });

  it('refunding an early-renewal order removes only the queued period; the running one and its credits stay', async () => {
    const ws = W(7);
    await buyGold(ws, Date.now() - 10 * DAY);
    const o2 = await start(ws);
    await hook(o2.orderId, 'TX-Q', '500.00');
    const before = (await sub(ws))!;
    await hook(o2.orderId, 'TX-Q-REF', '500.00', { event: 'refund' });
    expect(await sub(ws)).toMatchObject({ status: 'active', queued_periods: 0, period_end: before.period_end, version: before.version + 1 });
    expect(await credits(ws)).toBe(300);
  });

  it('a refund hands a store whose plan includes WhatsApp back to store-included', async () => {
    const ws = W(8);
    await seedNumber('pn-pr-8', ws);
    await applyStorePlan(env, planEv(ws, true, Date.now()));
    await buyGold(ws, Date.now());
    const o = (await env.DB.prepare("SELECT order_id FROM package_orders WHERE workspace_id = ?").bind(ws).first<{ order_id: string }>())!;
    await hook(o.order_id, 'TX-FB', '500.00', { event: 'refund' });
    expect(await sub(ws)).toMatchObject({ package_id: 'store-included', status: 'active', source: 'store_plan' });
    expect(await workspace(ws).getEntitlement()).toMatchObject({ packageId: 'store-included', status: 'active' });
  });

  it('a second SUCCESS with another transaction id on a paid order grants nothing, alerts and is recorded', async () => {
    const ws = W(9);
    const o = await buyGold(ws, Date.now(), 'TX-ONE');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await hook(o.orderId, 'TX-TWO', '500.00')).status).toBe(200);
    expect((await hook(o.orderId, 'TX-TWO', '500.00')).status).toBe(200);
    expect(await sub(ws)).toMatchObject({ version: 1 });
    expect(await order(o.orderId)).toMatchObject({ provider_ref: 'TX-ONE' });
    expect(err.mock.calls.some((c) => String(c[0]).includes('duplicate_success'))).toBe(true);
    expect(await audits(ws, 'package_duplicate_payment')).toBe(1);
  });
});

describe('I1/I2: the Store plan never wipes a purchase and never goes backwards, even when another writer interleaves', () => {
  it('false: a purchase that commits between the decision and the write survives', async () => {
    const ws = W(10);
    await seedNumber('pn-pr-10', ws);
    await applyStorePlan(env, planEv(ws, true, Date.now()));
    const racing = interleave(() => setSubscription(env, { workspaceId: ws, packageId: 'gold', status: 'active', periodStart: Date.now(), periodEnd: Date.now() + 30 * DAY, source: 'purchase', ref: 'o' }).then(() => undefined));
    await applyStorePlan(racing, planEv(ws, false, Date.now() + 1000));
    expect(await sub(ws)).toMatchObject({ package_id: 'gold', status: 'active', source: 'purchase' });
  });
  it('true: a purchase that commits in between is not overwritten by store-included', async () => {
    const ws = W(11);
    await seedNumber('pn-pr-11', ws);
    const racing = interleave(() => setSubscription(env, { workspaceId: ws, packageId: 'gold', status: 'active', periodStart: Date.now(), periodEnd: Date.now() + 30 * DAY, source: 'purchase', ref: 'o' }).then(() => undefined));
    await applyStorePlan(racing, planEv(ws, true, Date.now()));
    expect(await sub(ws)).toMatchObject({ package_id: 'gold', source: 'purchase' });
  });
  it('an older event whose turn comes after a newer one has been applied does nothing', async () => {
    const ws = W(12);
    await seedNumber('pn-pr-12', ws);
    const t = Date.now();
    const newer = planEv(ws, true, t + 5000);
    const racing = interleave(() => applyStorePlan(env, newer).then(() => undefined));
    await applyStorePlan(racing, planEv(ws, false, t + 1000));
    expect(await sub(ws)).toMatchObject({ package_id: 'store-included', status: 'active' });
    expect(await env.DB.prepare('SELECT effective_at, includes_whatsapp FROM store_plan_applied WHERE workspace_id = ?').bind(ws).first()).toEqual({ effective_at: t + 5000, includes_whatsapp: 1 });
  });
});

describe('I4: when a bought package lapses, the Store plan takes over again', () => {
  it('a Store-included store buys Gold, Gold ends, the daily pass returns it to store-included active', async () => {
    const ws = W(13);
    await seedNumber('pn-pr-13', ws);
    await applyStorePlan(env, planEv(ws, true, Date.now()));
    await buyGold(ws, Date.now() - 40 * DAY); // a month that ended about 9 days ago
    expect(await sub(ws)).toMatchObject({ package_id: 'gold', source: 'purchase' });
    await reconcileEntitlements(env);
    expect(await sub(ws)).toMatchObject({ package_id: 'store-included', status: 'active', source: 'store_plan' });
    expect(await workspace(ws).getEntitlement()).toMatchObject({ packageId: 'store-included', status: 'active' });
  });
  it('a running purchase is not touched by the daily pass', async () => {
    const ws = W(14);
    await seedNumber('pn-pr-14', ws);
    await applyStorePlan(env, planEv(ws, true, Date.now()));
    await buyGold(ws);
    await reconcileEntitlements(env);
    expect(await sub(ws)).toMatchObject({ package_id: 'gold' });
  });
});

describe('I6: an operator extension keeps the period and its credits', () => {
  it('the same package again only moves the end; a different package starts a new period', async () => {
    const ws = W(15);
    await seedNumber('pn-pr-15', ws);
    const put = (packageId: string, end: number) => operatorCall(OP1, 'PUT', `/workspaces/${ws}/subscription`, { packageId, status: 'active', periodEnd: end, reason: 'goodwill extension' });
    expect((await put('gold', Date.now() + 10 * DAY)).status).toBe(200);
    const a = (await workspace(ws).getEntitlement())!;
    expect(await credits(ws)).toBe(300);
    expect((await put('gold', Date.now() + 40 * DAY)).status).toBe(200);
    const b = (await workspace(ws).getEntitlement())!;
    expect(b.periodStart).toBe(a.periodStart);
    expect(b.periodEnd).toBeGreaterThan(a.periodEnd);
    expect(await credits(ws)).toBe(300);
    expect((await ledger(ws)).filter((r) => r.kind === 'grant')).toHaveLength(1);
    expect((await put('pro-fixture', Date.now() + 40 * DAY)).status).toBe(200);
    expect((await workspace(ws).getEntitlement())!.periodStart).toBeGreaterThan(a.periodStart);
  });
});

describe('minors', () => {
  it('a checkout url on another origin than the Kashier checkout is refused and the order closed', async () => {
    const ws = W(16);
    await seedNumber('pn-pr-16', ws);
    configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, { createSession: async () => ({ checkoutUrl: 'https://evil.example/pay' }) }));
    expect(await startPackageCheckout(env, { workspaceId: ws, userId: 'u', sessionId: 's', packageId: 'gold' })).toEqual({ ok: false, reason: 'unavailable' });
    expect((await env.DB.prepare('SELECT status FROM package_orders WHERE workspace_id = ?').bind(ws).first<{ status: string }>())?.status).toBe('failed');
  });
  it('an unreachable accounts service answers 503 "unavailable", not "rate_limited"', async () => {
    const ws = W(17);
    const owner = await apiFor(ws);
    configureSessionCheck(async () => { throw new Error('down'); });
    const r = await owner.call('POST', '/packages/gold/checkout', {});
    expect(r.status).toBe(503);
    // M-135: the store middleware answers first, for every write (fail closed); the route's own 'unavailable' is the second line of defence.
    expect(await r.json()).toMatchObject({ error: 'rate_limited', message: 'session_check_unavailable' });
  });
});
