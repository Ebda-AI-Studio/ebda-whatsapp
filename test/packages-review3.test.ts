import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { startPackageCheckout } from '../src/core/billing/package-orders';
import { handleProviderWebhook, reconfirmUnconfirmed, startTopup } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { KEY, detailsFetch, kashierLedger, testKashier } from './helpers/kashier';
import { storeId as W0, useApiKey } from './helpers/api';
import { ledger } from './helpers/billing';
import { useStoreLink } from './helpers/store-link';
import { rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const kashier = testKashier();
const DAY = 86_400_000;
const W = (n: number) => W0(8800 + n);
beforeEach(async () => {
  configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, {}));
  configureSessionCheck(async () => false);
  await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)").run();
});
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

async function hmac(text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function signed(data: Record<string, string | number>, label = 'pay', genuine?: string) {
  const keys = ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId', 'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode'];
  const full = { kashierOrderId: 'ko-1', orderReference: 'ref-1', method: 'card', channel: 'online', transactionResponseCode: '00', currency: 'EGP', status: 'SUCCESS', ...data, signatureKeys: keys } as Record<string, unknown>;
  kashierLedger.set(String(full.transactionId), { operation: genuine ?? label, status: String(full.status), orderId: String(full.merchantOrderId) });
  const str = keys.map((k) => `${k}=${encodeURIComponent(String(full[k]))}`).join('&');
  return { body: JSON.stringify({ event: label, data: full }), sig: await hmac(str) };
}
const hook = async (orderId: string, tx: string, amount: string, o: { label?: string; now?: number; e?: typeof env; provider?: PaymentProvider } = {}) => {
  const { body, sig } = await signed({ merchantOrderId: orderId, transactionId: tx, amount }, o.label ?? 'pay');
  return handleProviderWebhook(o.e ?? env, body, sig, o.provider ?? kashier, o.now ?? Date.now());
};
async function startPkg(ws: string, now = Date.now()) {
  await seedNumber(`pn-p3-${ws.slice(-5)}`, ws).catch(() => {});
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'gold' }, now);
  if (!r.ok) throw new Error(r.reason);
  return r;
}
const buyGold = async (ws: string, now = Date.now()) => { const o = await startPkg(ws, now); await hook(o.orderId, `TX-${crypto.randomUUID()}`, '500.00', { now }); return o; };
const order = (id: string) => env.DB.prepare('SELECT status, refunded_minor FROM package_orders WHERE order_id = ?').bind(id).first<{ status: string; refunded_minor: number }>();
const sub = (ws: string) => env.DB.prepare('SELECT status, period_end, version FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ status: string; period_end: number; version: number }>();
const credits = async (ws: string) => (await workspace(ws).walletView()).aiCredits.balance;
const alerts = (spy: { mock: { calls: unknown[][] } }, name: string) => spy.mock.calls.filter((c) => String(c[0]).includes(`"${name}"`)).length;
const topupRow = async (id: string, ws: string, o: { state?: string; tx?: string | null } = {}) => {
  await seedNumber(`pn-p3-${ws.slice(-5)}`, ws).catch(() => {});
  await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at, transaction_id) VALUES (?, ?, 5000, 150, 5150, 'EGP', ?, 'u1', ?, ?)").bind(id, ws, o.state ?? 'pending', Date.now(), o.tx ?? null).run();
};
const interleave = (before: () => Promise<void>): typeof env => {
  let done = false;
  return { ...env, DB: new Proxy(env.DB, { get(t, p) { if (p === 'batch') return async (s: D1PreparedStatement[]) => { if (!done) { done = true; await before(); } return t.batch(s); }; const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v; } }) } as typeof env;
};
const failFirst = (method: string): typeof env => {
  let n = 0;
  return {
    ...env,
    WORKSPACE_DO: new Proxy(env.WORKSPACE_DO, {
      get(t, p) {
        if (p !== 'get') return Reflect.get(t, p) as unknown;
        return (id: DurableObjectId) => {
          const stub = t.get(id);
          return new Proxy(stub, { get(s, q) { if (q === method) return async (...a: unknown[]) => { if (n++ === 0) throw new Error('credit service down'); return (s as never as Record<string, (...x: unknown[]) => unknown>)[method]!(...a); }; return Reflect.get(s, q) as unknown; } });
        };
      },
    }),
  } as typeof env;
};

describe('1. a refund only acts on a top-up that was really credited', () => {
  it('a top-up bound to a transaction but never credited (still pending) books no debt when a refund arrives', async () => {
    const ws = W(1);
    await topupRow('t3-1', ws, { state: 'pending', tx: 'TX-BOUND-1' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await hook('t3-1', 'TX-REFUND-1', '51.50', { label: 'refund' })).status).toBe(200);
    expect(await ledger(ws)).toEqual([]);
    expect(alerts(spy, 'refund_refused')).toBe(0); // not a refusal: the refund is held until the payment is credited
    expect((await env.DB.prepare("SELECT last_reason FROM unconfirmed_webhooks WHERE event_key = 'kashier:TX-REFUND-1:SUCCESS'").first<{ last_reason: string }>())?.last_reason).toBe('payment_pending');
  });
});

describe('2. credits that expire are counted once, and purchased credits are never touched', () => {
  const setup = async (n: number) => {
    const ws = W(n);
    const o = await buyGold(ws, Date.now() - DAY);
    await workspace(ws).postAiCredits({ kind: 'purchase', amount: 40, ref: `p3-purchase-${n}` });
    expect(await credits(ws)).toBe(340);
    return { ws, o };
  };
  it('a partial refund and then the rest: the grant expires once, the 40 purchased credits stay', async () => {
    const { ws, o } = await setup(10);
    await hook(o.orderId, 'TX-10-A', '250.00', { label: 'partial_refund' });
    expect(await credits(ws)).toBe(190);
    await hook(o.orderId, 'TX-10-B', '250.00', { label: 'partial_refund' });
    expect(await order(o.orderId)).toMatchObject({ status: 'refunded' });
    expect(await credits(ws)).toBe(40);
  });
  it('a partial refund and then the period end', async () => {
    const { ws, o } = await setup(11);
    await hook(o.orderId, 'TX-11-A', '250.00', { label: 'partial_refund' });
    expect(await credits(ws)).toBe(190);
    await workspace(ws).runDueTasks((await sub(ws))!.period_end + 1);
    expect(await credits(ws)).toBe(40);
  });
  it('two partial refunds', async () => {
    const { ws, o } = await setup(12);
    await hook(o.orderId, 'TX-12-A', '250.00', { label: 'partial_refund' });
    await hook(o.orderId, 'TX-12-B', '125.00', { label: 'partial_refund' });
    expect(await credits(ws)).toBe(115);
  });
});

describe('3. two concurrent partial refunds decide inside the batch', () => {
  it('two halves, the second committing between the first\'s decision and its write, end as ONE full refund', async () => {
    const ws = W(20);
    const o = await buyGold(ws, Date.now() - DAY);
    const racing = interleave(async () => { await hook(o.orderId, 'TX-20-B', '250.00', { label: 'partial_refund' }); });
    expect((await hook(o.orderId, 'TX-20-A', '250.00', { label: 'partial_refund', e: racing })).status).toBe(200);
    expect(await order(o.orderId)).toMatchObject({ status: 'refunded', refunded_minor: 50000 });
    expect((await sub(ws))!.status).toBe('cancelled');
    expect(await credits(ws)).toBe(0);
  });
});

describe('4. a delivery that cannot be confirmed is kept and re-confirmed by the daily pass', () => {
  it('the first confirm 404s, Kashier never retries, the cron confirms: credited exactly once; an aged one alerts', async () => {
    const ws = W(30);
    await topupRow('t3-30', ws);
    let ready = false;
    const provider = testKashier(async (u) => (ready ? detailsFetch(u) : new Response('not yet', { status: 404 })));
    const first = await hook('t3-30', 'TX-30', '51.50', { provider });
    expect(first.status).toBe(503);
    expect(await ledger(ws)).toEqual([]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM unconfirmed_webhooks WHERE resolved_at IS NULL AND event_key = 'kashier:TX-30:SUCCESS'").first<{ n: number }>())!.n).toBe(1);
    expect(await reconfirmUnconfirmed(env, provider)).toMatchObject({ resolved: 0 }); // still not queryable
    ready = true;
    expect(await reconfirmUnconfirmed(env, provider, Date.now() + 2 * DAY)).toMatchObject({ resolved: 1 }); // one attempt a day: due again tomorrow
    expect((await ledger(ws)).filter((r) => r.kind === 'topup')).toHaveLength(1);
    expect(await reconfirmUnconfirmed(env, provider, Date.now() + 2 * DAY)).toMatchObject({ resolved: 0 });
    expect((await ledger(ws)).filter((r) => r.kind === 'topup')).toHaveLength(1);

    const ws2 = W(31);
    await topupRow('t3-31', ws2);
    ready = false;
    await hook('t3-31', 'TX-31', '51.50', { provider });
    await env.DB.prepare("UPDATE unconfirmed_webhooks SET first_seen = ? WHERE event_key = 'kashier:TX-31:SUCCESS'").bind(Date.now() - 25 * 3_600_000).run();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await reconfirmUnconfirmed(env, provider);
    expect(alerts(spy, 'webhook_unconfirmed_aged')).toBe(1);
    expect(await ledger(ws2)).toEqual([]);
  });
});

/** An env whose `prepare` runs `before` once, right before the first statement containing `needle`: another writer commits at exactly that point. */
const beforeStatement = (needle: string, before: () => Promise<void>): typeof env => {
  let done = false;
  return { ...env, DB: new Proxy(env.DB, { get(t, p) { if (p === 'prepare') return (sql: string) => { const stmt = t.prepare(sql); if (!done && sql.includes(needle)) { done = true; return new Proxy(stmt, { get(s, q) { if (q === 'bind') return (...a: unknown[]) => { const bound = s.bind(...a); return new Proxy(bound, { get(b, w) { if (w === 'run' || w === 'first') return async (...x: unknown[]) => { await before(); return (b as never as Record<string, (...y: unknown[]) => unknown>)[w as string]!(...x); }; const v = Reflect.get(b, w) as unknown; return typeof v === 'function' ? v.bind(b) : v; } }); }; const v = Reflect.get(s, q) as unknown; return typeof v === 'function' ? v.bind(s) : v; } }); } return stmt; }; const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v; } }) } as typeof env;
};

describe('4b. the daily re-confirm and a late live webhook are ONE effect, whichever confirms first', () => {
  it('top-up: the live webhook completes between the cron\'s claim and its credit', async () => {
    const ws = W(32);
    await topupRow('t3-32', ws);
    let ready = false;
    const provider = testKashier(async (u) => (ready ? detailsFetch(u) : new Response('not yet', { status: 404 })));
    await hook('t3-32', 'TX-32', '51.50', { provider });
    ready = true;
    const racing = beforeStatement('SET transaction_id = ? WHERE order_id = ?', async () => { expect((await hook('t3-32', 'TX-32', '51.50', { provider })).status).toBe(200); });
    await reconfirmUnconfirmed(racing, provider);
    expect((await ledger(ws)).filter((r) => r.kind === 'topup')).toHaveLength(1);
    expect((await env.DB.prepare("SELECT resolved_at FROM unconfirmed_webhooks WHERE event_key = 'kashier:TX-32:SUCCESS'").first<{ resolved_at: number | null }>())?.resolved_at).not.toBeNull();
  });
  it('package: the live webhook completes right before the cron\'s grant batch', async () => {
    const ws = W(33);
    const o = await startPkg(ws);
    let ready = false;
    const provider = testKashier(async (u) => (ready ? detailsFetch(u) : new Response('not yet', { status: 404 })));
    await hook(o.orderId, 'TX-33', '500.00', { provider });
    ready = true;
    const racing = interleave(async () => { expect((await hook(o.orderId, 'TX-33', '500.00', { provider })).status).toBe(200); });
    await reconfirmUnconfirmed(racing, provider);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM billing_audit WHERE workspace_id = ? AND action = 'subscription_set'").bind(ws).first<{ n: number }>())!.n).toBe(1);
    expect(await sub(ws)).toMatchObject({ version: 1 });
  });
});

describe('5. checkout is refused when webhooks could not be confirmed', () => {
  it('no Kashier secret key: a top-up and a package checkout both refuse (unavailable)', async () => {
    configurePayments(() => new KashierProvider('MID-1', KEY, undefined, { fetch: detailsFetch }));
    const ws = W(40);
    await seedNumber('pn-p3-40', ws);
    const e = { ...env, ACCOUNTS: { isRevoked: async () => false } } as typeof env;
    expect(await startTopup(e, { workspaceId: ws, userId: 'u', sessionId: 's', amountMinor: 5000 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await startPackageCheckout(env, { workspaceId: ws, userId: 'u', sessionId: 's', packageId: 'gold' })).toEqual({ ok: false, reason: 'unavailable' });
    expect((await env.DB.prepare('SELECT count(*) AS n FROM package_orders WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n).toBe(0);
  });
});

describe('6/7. the details call only goes where it should', () => {
  it('a transaction id outside [A-Za-z0-9_-]{1,64} is never put in a URL; a non-https API origin is refused', async () => {
    const calls: string[] = [];
    const spy = testKashier(async (u) => { calls.push(u); return detailsFetch(u); });
    const wsA = W(50);
    await topupRow('t3-50', wsA);
    expect((await hook('t3-50', 'a/../b?x=1', '51.50', { provider: spy })).status).toBe(503);
    expect((await hook('t3-50', 'x'.repeat(65), '51.50', { provider: spy })).status).toBe(503);
    expect(calls).toEqual([]);
    const wsB = W(51);
    await topupRow('t3-51', wsB);
    const http = new KashierProvider('MID-1', KEY, undefined, { secretKey: 'sk', apiBase: 'http://api.kashier.io', fetch: async (u) => { calls.push(u); return detailsFetch(u); } });
    expect((await hook('t3-51', 'TX-51', '51.50', { provider: http })).status).toBe(503);
    expect(calls).toEqual([]);
    expect(await ledger(wsA)).toEqual([]);
    expect(await ledger(wsB)).toEqual([]);
  });
});

describe('8. a retried credit expiry uses the fraction decided with its own refund', () => {
  it('partial 1\'s credit step fails, partial 2 lands, the redelivery of partial 1 still expires half of what is unused', async () => {
    const ws = W(60);
    const o = await buyGold(ws, Date.now() - DAY);
    await workspace(ws).postAiCredits({ kind: 'purchase', amount: 40, ref: 'p3-purchase-60' });
    expect((await hook(o.orderId, 'TX-60-A', '250.00', { label: 'partial_refund', e: failFirst('expireAiCreditsFraction') })).status).toBe(500);
    expect(await credits(ws)).toBe(340);
    await hook(o.orderId, 'TX-60-B', '125.00', { label: 'partial_refund' });
    expect(await credits(ws)).toBe(190);
    await hook(o.orderId, 'TX-60-A', '250.00', { label: 'partial_refund' });
    expect(await credits(ws)).toBe(115);
    expect((await rows<{ n: number }>(ws, "SELECT count(*) AS n FROM credit_ledger WHERE kind = 'expire'"))[0]!.n).toBe(2);
  });
});
