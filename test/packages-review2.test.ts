import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { startPackageCheckout } from '../src/core/billing/package-orders';
import { rollRenewals } from '../src/core/billing/subscriptions';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { KEY, detailsFetch, kashierLedger, testKashier } from './helpers/kashier';
import { storeId as W0, useApiKey } from './helpers/api';
import { ledger } from './helpers/billing';
import { useStoreLink } from './helpers/store-link';
import { rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
const link = useStoreLink();
const kashier = testKashier();
const DAY = 86_400_000;
const W = (n: number) => W0(8700 + n);
beforeEach(async () => {
  configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, {}));
  configureSessionCheck(async () => false);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)"),
    env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('pro', 'Pro', 90000, 900, 1, 1)"),
  ]);
});
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

async function hmac(text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** A signed body with `label` as its (unsigned) event; `genuine` is what Kashier's own record says the transaction really is. */
async function signed(data: Record<string, string | number>, label = 'pay', genuine?: string) {
  const keys = ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId', 'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode'];
  const full = { kashierOrderId: 'ko-1', orderReference: 'ref-1', method: 'card', channel: 'online', transactionResponseCode: '00', currency: 'EGP', status: 'SUCCESS', ...data, signatureKeys: keys } as Record<string, unknown>;
  kashierLedger.set(String(full.transactionId), { operation: genuine ?? label, status: String(full.status), orderId: String(full.merchantOrderId) });
  const str = keys.map((k) => `${k}=${encodeURIComponent(String(full[k]))}`).join('&');
  return { body: JSON.stringify({ event: label, data: full }), sig: await hmac(str) };
}
type Hook = { label?: string; genuine?: string; now?: number; e?: typeof env; provider?: PaymentProvider };
const hook = async (orderId: string, tx: string, amount: string, o: Hook = {}) => {
  const { body, sig } = await signed({ merchantOrderId: orderId, transactionId: tx, amount }, o.label ?? 'pay', o.genuine);
  return handleProviderWebhook(o.e ?? env, body, sig, o.provider ?? kashier, o.now ?? Date.now());
};
const labelTrusting = Object.assign(Object.create(kashier) as PaymentProvider, { confirm: async (e: never) => e }); // second layer only: the label is believed
async function start(ws: string, packageId = 'gold', now = Date.now()) {
  await seedNumber(`pn-p2-${ws.slice(-5)}`, ws);
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId }, now);
  if (!r.ok) throw new Error(r.reason);
  return r;
}
const buy = async (ws: string, pkg = 'gold', now = Date.now(), tx = `TX-${crypto.randomUUID()}`) => { const o = await start(ws, pkg, now); await hook(o.orderId, tx, pkg === 'gold' ? '500.00' : '900.00', { now }); return { ...o, tx }; };
const order = (id: string) => env.DB.prepare('SELECT status, provider_ref, granted_at, queued, owns_running, queued_seq, refunded_minor, revoked_period_start FROM package_orders WHERE order_id = ?').bind(id).first<Record<string, number | string | null>>();
const sub = (ws: string) => env.DB.prepare('SELECT package_id, status, version, source, period_start, period_end, queued_periods FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ package_id: string; status: string; version: number; source: string | null; period_start: number; period_end: number; queued_periods: number }>();
const ledgerOf = (ws: string) => rows<{ kind: string; ref: string; amount: number }>(ws, 'SELECT kind, ref, amount FROM credit_ledger ORDER BY id');
const credits = async (ws: string) => (await workspace(ws).walletView()).aiCredits.balance;
const alerts = (spy: { mock: { calls: unknown[][] } }, name: string) => spy.mock.calls.filter((c) => String(c[0]).includes(`"${name}"`)).length;
const topupRow = async (id: string, ws: string, amount = 5000, fee = 150) => {
  await seedNumber(`pn-p2-${ws.slice(-5)}`, ws);
  await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'EGP', 'pending', 'u1', ?)").bind(id, ws, amount, fee, amount + fee, Date.now()).run();
};
const wallet = async (ws: string) => (await ledger(ws)).map((r) => ({ kind: r.kind as string, amount_minor: r.amount_minor as number }));

let n6 = 0;
describe('1. the unsigned event label is never applied', () => {
  it('top-up: a refund relabelled as a payment (its own transaction id) credits nothing a second time', async () => {
    const ws = W(1);
    await topupRow('t-1', ws);
    await hook('t-1', 'TX-PAY-1', '51.50');
    await hook('t-1', 'TX-REF-1', '51.50', { label: 'pay', genuine: 'refund' });
    expect((await wallet(ws)).filter((r) => r.kind === 'topup')).toEqual([{ kind: 'topup', amount_minor: 5000 }]);
  });
  it('top-up: a payment relabelled as a refund books no debt', async () => {
    const ws = W(2);
    await topupRow('t-2', ws);
    await hook('t-2', 'TX-PAY-2', '51.50');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await hook('t-2', 'TX-PAY-2', '51.50', { label: 'refund', genuine: 'pay' })).status).toBe(200);
    expect((await wallet(ws)).map((r) => r.kind)).toEqual(['topup']);
    expect((await workspace(ws).walletView()).debtMinor).toBe(0);
    expect(alerts(spy, 'topup_refunded_by_provider')).toBe(0);
  });
  it('package: a payment relabelled as a refund revokes nothing', async () => {
    const ws = W(3);
    const b = await buy(ws);
    const before = await sub(ws);
    expect((await hook(b.orderId, b.tx, '500.00', { label: 'refund', genuine: 'pay' })).status).toBe(200);
    expect(await order(b.orderId)).toMatchObject({ status: 'paid' });
    expect(await sub(ws)).toEqual(before);
    expect(await credits(ws)).toBe(300);
  });
  it('the transaction-id rules hold on their own even if the label were believed: pay->refund with the payment id is refused, a second success is a duplicate', async () => {
    const wsT = W(4);
    await topupRow('t-4', wsT);
    await hook('t-4', 'TX-P4', '51.50');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await hook('t-4', 'TX-P4', '51.50', { label: 'refund', provider: labelTrusting });
    expect(alerts(spy, 'refund_refused')).toBe(1);
    expect((await wallet(wsT)).map((r) => r.kind)).toEqual(['topup']);
    await hook('t-4', 'TX-OTHER', '51.50', { label: 'pay', provider: labelTrusting });
    expect(alerts(spy, 'duplicate_success')).toBe(1);
    expect((await wallet(wsT)).filter((r) => r.kind === 'topup')).toHaveLength(1);
    const wsP = W(5);
    const b = await buy(wsP);
    await hook(b.orderId, b.tx, '500.00', { label: 'refund', provider: labelTrusting });
    expect(alerts(spy, 'refund_refused')).toBe(2);
    expect(await order(b.orderId)).toMatchObject({ status: 'paid' });
  });
  it('the event key is built from signed values only: a relabelled body has the same key as the genuine one', async () => {
    const a = await signed({ merchantOrderId: 'o', transactionId: 'TX-K', amount: '1.00' }, 'pay');
    const b = await signed({ merchantOrderId: 'o', transactionId: 'TX-K', amount: '1.00' }, 'refund');
    expect((await kashier.verifyWebhook(a.body, a.sig))?.eventKey).toBe('kashier:TX-K:SUCCESS');
    expect((await kashier.verifyWebhook(b.body, b.sig))?.eventKey).toBe('kashier:TX-K:SUCCESS');
  });
  it.each([
    ['Kashier cannot be reached', async () => { throw new Error('network'); }],
    ['Kashier does not know the transaction yet (404)', async () => new Response('nope', { status: 404 })],
    ['Kashier answers for another transaction', async () => Response.json({ body: { transactionId: 'OTHER', trxType: 'pay', status: 'SUCCESS' } })],
    ['Kashier says the transaction belongs to another order', async () => Response.json({ body: { transactionId: 'TX-U', trxType: 'pay', status: 'SUCCESS', merchantOrderId: 'someone-else' } })],
    ['Kashier reports a different status than the signed body', async () => Response.json({ body: { transactionId: 'TX-U', trxType: 'pay', status: 'PENDING' } })],
    ['Kashier reports an operation we do not know', async () => Response.json({ body: { transactionId: 'TX-U', trxType: 'mystery', status: 'SUCCESS' } })],
  ])('%s: 503, nothing is credited or granted (top-up and package)', async (_n, answer) => {
    const bad = testKashier(answer as never);
    const k = n6++;
    const wsT = W(100 + k);
    await topupRow(`t-6-${k}`, wsT);
    expect((await hook(`t-6-${k}`, 'TX-U', '51.50', { provider: bad })).status).toBe(503);
    expect(await wallet(wsT)).toEqual([]);
    const wsP = W(200 + k);
    const o = await start(wsP);
    expect((await hook(o.orderId, 'TX-U', '500.00', { provider: bad })).status).toBe(503);
    expect(await sub(wsP)).toBeNull();
    expect(await order(o.orderId)).toMatchObject({ status: 'pending' });
  });
  it('without the Kashier secret key nothing is applied (503)', async () => {
    const ws = W(8);
    await topupRow('t-8', ws);
    const { KashierProvider } = await import('../src/core/billing/payments');
    expect((await hook('t-8', 'TX-N', '51.50', { provider: new KashierProvider('MID-1', KEY, undefined, { fetch: detailsFetch }) })).status).toBe(503);
    expect(await wallet(ws)).toEqual([]);
  });
});

describe('2. credits after a refund are zeroed even if the first attempt fails', () => {
  it('the first expire throws (5xx), the redelivery zeroes it exactly once', async () => {
    const ws = W(10);
    const b = await buy(ws, 'gold', Date.now() - DAY);
    expect(await credits(ws)).toBe(300);
    let n = 0;
    const flaky = {
      ...env,
      WORKSPACE_DO: new Proxy(env.WORKSPACE_DO, {
        get(t, p) {
          if (p !== 'get') return Reflect.get(t, p) as unknown;
          return (id: DurableObjectId) => {
            const stub = t.get(id);
            return new Proxy(stub, { get(s, q) { if (q === 'expireAiCredits') return async () => { if (n++ === 0) throw new Error('credit service down'); return (s as never as Record<string, (...a: unknown[]) => unknown>).expireAiCredits!(); }; return Reflect.get(s, q) as unknown; } });
          };
        },
      }),
    } as typeof env;
    expect((await hook(b.orderId, 'TX-R10', '500.00', { label: 'refund', e: flaky })).status).toBe(500);
    expect(await credits(ws)).toBe(300);
    expect((await hook(b.orderId, 'TX-R10', '500.00', { label: 'refund' })).status).toBe(200);
    expect(await credits(ws)).toBe(0);
    expect((await ledgerOf(ws)).filter((r) => r.kind === 'expire').map((r) => r.ref)).toEqual([`expire:refund:${b.orderId}`]);
    await hook(b.orderId, 'TX-R10', '500.00', { label: 'refund' });
    expect((await ledgerOf(ws)).filter((r) => r.kind === 'expire')).toHaveLength(1);
  });
});

describe('3. a paid period is never expired because of a transient failure after a roll', () => {
  it('the roll committed in D1 but never reached the workspace: the task applies it instead of expiring', async () => {
    const ws = W(11);
    await buy(ws, 'gold', Date.now() - 10 * DAY);
    const o2 = await start(ws);
    await hook(o2.orderId, 'TX-RR', '500.00');
    const first = (await sub(ws))!;
    expect(await rollRenewals(env, ws, first.period_end + 1)).toBe(1); // D1 rolled; the push to the workspace "failed"
    expect((await workspace(ws).getEntitlement())!.periodStart).toBe(first.period_start);
    await workspace(ws).runDueTasks(first.period_end + 1);
    expect(await workspace(ws).getEntitlement()).toMatchObject({ status: 'active', periodStart: first.period_end });
  });
});

describe('4/5. a refund takes back exactly the period its order paid for', () => {
  it('N1: a queued Gold month refunded after the merchant switched to Pro leaves neither the money nor the month', async () => {
    const ws = W(12);
    await buy(ws, 'gold', Date.now() - 10 * DAY);
    const q = await start(ws);
    await hook(q.orderId, 'TX-Q12', '500.00');
    expect((await sub(ws))!.queued_periods).toBe(1);
    await buy(ws, 'pro');
    expect(await sub(ws)).toMatchObject({ package_id: 'pro', queued_periods: 1 });
    await hook(q.orderId, 'TX-Q12-R', '500.00', { label: 'refund' });
    expect(await sub(ws)).toMatchObject({ package_id: 'pro', status: 'active', queued_periods: 0 });
    expect(await order(q.orderId)).toMatchObject({ status: 'refunded', queued_seq: null });
  });
  it('N2: buy O1, renew early with O2, refund O1: O2\'s month starts now', async () => {
    const ws = W(13);
    const o1 = await buy(ws, 'gold', Date.now() - 10 * DAY);
    const o2 = await start(ws);
    await hook(o2.orderId, 'TX-O2', '500.00');
    const before = (await sub(ws))!;
    const now = Date.now();
    await hook(o1.orderId, 'TX-O1-R', '500.00', { label: 'refund', now });
    const after = (await sub(ws))!;
    expect(after).toMatchObject({ status: 'active', queued_periods: 0, period_start: now, version: before.version + 1 });
    expect(after.period_end).toBeGreaterThan(now + 27 * DAY);
    expect(await order(o2.orderId)).toMatchObject({ owns_running: 1, queued_seq: null });
    expect(await order(o1.orderId)).toMatchObject({ status: 'refunded', owns_running: 0 });
    expect(await workspace(ws).getEntitlement()).toMatchObject({ periodStart: now, status: 'active' });
  });
  it('N2: once O2\'s period is running, refunding O1 changes nothing', async () => {
    const ws = W(14);
    const o1 = await buy(ws, 'gold', Date.now() - 10 * DAY);
    const o2 = await start(ws);
    await hook(o2.orderId, 'TX-O2b', '500.00');
    const end = (await sub(ws))!.period_end;
    await rollRenewals(env, ws, end + 1);
    const running = (await sub(ws))!;
    await hook(o1.orderId, 'TX-O1b-R', '500.00', { label: 'refund' });
    expect(await sub(ws)).toEqual(running);
    expect(await order(o1.orderId)).toMatchObject({ status: 'refunded' });
    expect(await order(o2.orderId)).toMatchObject({ owns_running: 1 });
  });
  it('N2: refunding a queued order moves the later ones up', async () => {
    const ws = W(15);
    await buy(ws, 'gold', Date.now() - 10 * DAY);
    const o2 = await start(ws); await hook(o2.orderId, 'TX-15-2', '500.00');
    const o3 = await start(ws); await hook(o3.orderId, 'TX-15-3', '500.00');
    expect(await order(o3.orderId)).toMatchObject({ queued_seq: 2 });
    await hook(o2.orderId, 'TX-15-2R', '500.00', { label: 'refund' });
    expect(await order(o3.orderId)).toMatchObject({ queued_seq: 1 });
    expect((await sub(ws))!.queued_periods).toBe(1);
  });
});

describe('6. a partial refund shortens the period and its unused credits by the same fraction', () => {
  it('50% back: half the period, half the unused credits, a higher version, an alert; a replay does nothing; the rest completes a full refund', async () => {
    const ws = W(16);
    const b = await buy(ws, 'gold', Date.now() - 10 * DAY);
    const before = (await sub(ws))!;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const now = Date.now();
    await hook(b.orderId, 'TX-PR1', '250.00', { label: 'partial_refund', now });
    const after = (await sub(ws))!;
    expect(after.period_end).toBe(Math.max(now, before.period_start + Math.floor(((before.period_end - before.period_start) * 25000) / 50000)));
    expect(after).toMatchObject({ status: 'active', version: before.version + 1, period_start: before.period_start });
    expect(await workspace(ws).getEntitlement()).toMatchObject({ periodEnd: after.period_end, version: before.version + 1 });
    expect(await credits(ws)).toBe(150);
    expect(alerts(spy, 'package_partial_refund')).toBe(1);
    expect(link.sink.sent.filter((e) => e.storeId === ws).at(-1)).toMatchObject({ data: { version: before.version + 1 } });
    expect(await order(b.orderId)).toMatchObject({ status: 'paid', refunded_minor: 25000 });
    await hook(b.orderId, 'TX-PR1', '250.00', { label: 'partial_refund', now });
    expect(await sub(ws)).toEqual(after);
    expect(await credits(ws)).toBe(150);
    await hook(b.orderId, 'TX-PR2', '250.00', { label: 'partial_refund' });
    expect(await order(b.orderId)).toMatchObject({ status: 'refunded' });
    expect((await sub(ws))!.status).toBe('cancelled');
    expect(await credits(ws)).toBe(0);
  });
});
