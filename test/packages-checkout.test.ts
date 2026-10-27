import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { startPackageCheckout } from '../src/core/billing/package-orders';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import worker from '../src/index';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { kashierLedger, testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';
import { seedNumber, workspace } from './helpers/workspace';

useApiKey();
const link = useStoreLink();
const KEY = 'test-payment-api-key';
const kashier = testKashier();
const DAY = 86_400_000;
beforeEach(async () => {
  configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, {}));
  configureSessionCheck(async () => false);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)"),
    env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('retired', 'Old', 10000, 10, 0, 1)"),
  ]);
});
afterEach(() => { configurePayments((e) => (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY ? new KashierProvider(e.KASHIER_MERCHANT_ID, e.KASHIER_API_KEY) : null)); configureSessionCheck(null); });

async function hmac(text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function signed(data: Record<string, string | number>, sigOverride?: string) {
  const keys = ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId', 'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode'];
  const full = { kashierOrderId: 'ko-1', orderReference: 'ref-1', method: 'card', channel: 'online', transactionResponseCode: '00', currency: 'EGP', status: 'SUCCESS', ...data, signatureKeys: keys };
  kashierLedger.set(String((full as Record<string, unknown>).transactionId), { operation: 'pay', status: String((full as Record<string, unknown>).status), orderId: String((full as Record<string, unknown>).merchantOrderId) });
  const str = keys.map((k) => `${k}=${encodeURIComponent(String((full as Record<string, unknown>)[k]))}`).join('&');
  return { body: JSON.stringify({ event: 'pay', data: full }), sig: sigOverride ?? (await hmac(str)) };
}
const order = (id: string) => env.DB.prepare('SELECT status, amount_minor, provider_ref, package_id FROM package_orders WHERE order_id = ?').bind(id).first<{ status: string; amount_minor: number; provider_ref: string | null; package_id: string }>();
const grants = async (ws: string) => (await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE workspace_id = ? AND action = 'subscription_set'").bind(ws).first<{ n: number }>())!.n;
async function start(ws: string, packageId = 'gold') {
  await seedNumber(`pn-pc-${ws.slice(-4)}`, ws);
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId });
  if (!r.ok) throw new Error(r.reason);
  return r;
}

describe('starting a checkout', () => {
  it('WA-NOFREE-1: a workspace with NO package can start a checkout (a merchant must be able to buy)', async () => {
    const ws = W(8409);
    await seedNumber('pn-pc-8409', ws);
    await workspace(ws).applyEntitlement({ version: 1, packageId: 'old', status: 'expired', periodStart: 1, periodEnd: 2 });
    expect((await workspace(ws).getEntitlement())?.status).toBe('expired');
    const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'gold' });
    expect(r.ok).toBe(true);
  });
  it('takes the amount from packages.price_minor only and signs the link with it', async () => {
    const ws = W(8401);
    const r = await start(ws);
    expect(r.amountMinor).toBe(50000);
    expect(await order(r.orderId)).toEqual({ status: 'pending', amount_minor: 50000, provider_ref: null, package_id: 'gold' });
    const u = new URL(r.checkoutUrl);
    expect(u.searchParams.get('amount')).toBe('500.00');
    expect(u.searchParams.get('hash')).toBe(await hmac(`/?payment=MID-1.${r.orderId}.500.00.EGP`));
  });
  it('refuses when off, with an unknown, retired or free package, a revoked session, or an unreachable accounts service; writes nothing', async () => {
    const ws = W(8402);
    await seedNumber('pn-pc-8402', ws);
    const a = { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'gold' };
    expect(await startPackageCheckout({ ...env, PACKAGE_CHECKOUT_ENABLED: undefined } as never, a)).toEqual({ ok: false, reason: 'disabled' });
    expect(await startPackageCheckout(env, { ...a, packageId: 'nope' })).toEqual({ ok: false, reason: 'unknown_package' });
    expect(await startPackageCheckout(env, { ...a, packageId: 'retired' })).toEqual({ ok: false, reason: 'unknown_package' });
    expect(await startPackageCheckout(env, { ...a, packageId: 'store-included' })).toEqual({ ok: false, reason: 'unknown_package' });
    configureSessionCheck(async () => true);
    expect(await startPackageCheckout(env, a)).toEqual({ ok: false, reason: 'session_revoked' });
    configureSessionCheck(async () => { throw new Error('down'); });
    expect(await startPackageCheckout(env, a)).toEqual({ ok: false, reason: 'unavailable' });
    expect((await env.DB.prepare('SELECT count(*) AS n FROM package_orders WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n).toBe(0);
  });
});

describe('the webhook grants a paid package', () => {
  it('a verified SUCCESS for the stored amount activates the package for one month, tells the Store, and a replay grants nothing more', async () => {
    const ws = W(8410);
    const o = await start(ws);
    const { body, sig } = await signed({ merchantOrderId: o.orderId, transactionId: 'TX-1', amount: '500.00' });
    const t0 = Date.now();
    expect((await handleProviderWebhook(env, body, sig, kashier)).status).toBe(200);
    expect((await handleProviderWebhook(env, body, sig, kashier)).status).toBe(200);
    expect(await order(o.orderId)).toMatchObject({ status: 'paid', provider_ref: 'TX-1' });
    const sub = await env.DB.prepare('SELECT package_id, status, source, version, period_start, period_end FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<Record<string, number | string>>();
    expect(sub).toMatchObject({ package_id: 'gold', status: 'active', source: 'purchase', version: 1 });
    expect((sub!.period_end as number) - t0).toBeGreaterThan(27 * DAY);
    expect((sub!.period_end as number) - t0).toBeLessThan(32 * DAY);
    expect(await workspace(ws).getEntitlement()).toMatchObject({ packageId: 'gold', status: 'active', aiCredits: 300 });
    expect(await grants(ws)).toBe(1);
    const events = link.sink.sent.filter((e) => e.storeId === ws);
    expect(events.map((e) => e.type)).toEqual(['whatsapp.entitlement_changed', 'whatsapp.entitlement_changed']);
    expect(new Set(events.map((e) => e.id)).size).toBe(1); // the replay re-announces under the SAME id: the Store dedupes it
  });

  it('two concurrent identical webhooks grant exactly once', async () => {
    const ws = W(8411);
    const o = await start(ws);
    const { body, sig } = await signed({ merchantOrderId: o.orderId, transactionId: 'TX-2', amount: '500.00' });
    const rs = await Promise.all([handleProviderWebhook(env, body, sig, kashier), handleProviderWebhook(env, body, sig, kashier)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(await grants(ws)).toBe(1);
    expect(await env.DB.prepare('SELECT version FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first()).toEqual({ version: 1 });
  });

  it('a tampered amount is refused: no grant, the order stays pending, an alert is logged', async () => {
    const ws = W(8412);
    const o = await start(ws);
    const { body, sig } = await signed({ merchantOrderId: o.orderId, transactionId: 'TX-3', amount: '1.00' });
    expect((await handleProviderWebhook(env, body, sig, kashier)).status).toBe(200);
    expect(await order(o.orderId)).toMatchObject({ status: 'pending', provider_ref: null });
    expect(await grants(ws)).toBe(0);
  });

  it('a bad signature is 401 and changes nothing', async () => {
    const ws = W(8413);
    const o = await start(ws);
    const { body } = await signed({ merchantOrderId: o.orderId, transactionId: 'TX-4', amount: '500.00' }, 'deadbeef');
    expect((await handleProviderWebhook(env, body, 'deadbeef', kashier)).status).toBe(401);
    expect(await order(o.orderId)).toMatchObject({ status: 'pending' });
    expect(await grants(ws)).toBe(0);
  });

  it('a FAILURE closes the order without a grant', async () => {
    const ws = W(8414);
    const o = await start(ws);
    const f = await signed({ merchantOrderId: o.orderId, transactionId: 'TX-5', amount: '500.00', status: 'FAILURE' });
    await handleProviderWebhook(env, f.body, f.sig, kashier);
    expect(await order(o.orderId)).toMatchObject({ status: 'failed' });
    expect(await grants(ws)).toBe(0);
  });
});

describe('routes', () => {
  beforeEach(() => { configureSessionCheck(async () => false); });
  it('GET lists the active, paid packages for owner and staff', async () => {
    const ws = W(8420);
    for (const role of ['owner', 'staff'] as const) {
      const api = await apiFor(ws, role);
      const r = await api.call('GET', '/packages');
      expect(r.status).toBe(200);
      const j = (await r.json()) as { items: { id: string; priceMinor: number; aiCredits: number }[] };
      expect(j.items.find((p) => p.id === 'gold')).toMatchObject({ priceMinor: 50000, aiCredits: 300 });
      expect(j.items.map((p) => p.id)).not.toContain('retired');
      expect(j.items.map((p) => p.id)).not.toContain('store-included');
    }
  });
  it('checkout is owner-only (staff 403), validates, and answers with the checkout url; the client sends no amount', async () => {
    const ws = W(8421);
    const staff = await apiFor(ws, 'staff');
    const owner = await apiFor(ws, 'owner');
    expect((await staff.call('POST', '/packages/gold/checkout', {})).status).toBe(403);
    expect((await owner.call('POST', '/packages/nope/checkout', {})).status).toBe(404);
    const r = await owner.call('POST', '/packages/gold/checkout', { amountMinor: 1 });
    expect(r.status).toBe(201);
    const j = (await r.json()) as { orderId: string; amountMinor: number; checkoutUrl: string; state: string };
    expect(j).toMatchObject({ amountMinor: 50000, state: 'pending' });
    expect(new URL(j.checkoutUrl).searchParams.get('amount')).toBe('500.00');
    const s = await owner.call('GET', `/packages/orders/${j.orderId}`);
    expect(await s.json()).toMatchObject({ orderId: j.orderId, state: 'pending', packageId: 'gold' });
    expect((await staff.call('GET', `/packages/orders/${j.orderId}`)).status).toBe(403);
    expect((await (await apiFor(W(8499))).call('GET', `/packages/orders/${j.orderId}`)).status).toBe(404);
  });
  it('an expired token is refused and a revoked session is 403 (session_revoked) with nothing written', async () => {
    const ws = W(8422);
    const owner = await apiFor(ws, 'owner');
    configureSessionCheck(async () => true);
    expect((await owner.call('POST', '/packages/gold/checkout', {})).status).toBe(403); // M-135: refused by the middleware on every write (403 session_revoked), before the route's own check
    expect((await env.DB.prepare('SELECT count(*) AS n FROM package_orders WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n).toBe(0);
    const { tokenFor } = await import('./helpers/api');
    const { SELF } = await import('cloudflare:test');
    const old = await tokenFor(ws, -3600);
    expect((await SELF.fetch(`https://x/api/v1/stores/${ws}/packages`, { headers: { authorization: `Bearer ${old}` } })).status).toBe(401);
  });
  it('with the switch off every route is 404', async () => {
    const ws = W(8423);
    const owner = await apiFor(ws, 'owner');
    const off = { ...env, PACKAGE_CHECKOUT_ENABLED: undefined } as never;
    for (const [method, path] of [['GET', '/packages'], ['POST', '/packages/gold/checkout'], ['GET', '/packages/orders/x']] as const) {
      const res = await worker.fetch(new Request(`https://x/api/v1/stores/${ws}${path}`, { method, headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) }), off, createExecutionContext());
      expect(res.status).toBe(404);
    }
  });
});
