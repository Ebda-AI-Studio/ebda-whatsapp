import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { startPackageCheckout } from '../src/core/billing/package-orders';
import { handleProviderWebhook, reconfirmUnconfirmed } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { KEY, detailsFetch, kashierLedger, testKashier } from './helpers/kashier';
import { storeId as W0, useApiKey } from './helpers/api';
import { ledger } from './helpers/billing';
import { useStoreLink } from './helpers/store-link';
import { seedNumber, workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const kashier = testKashier();
const DAY = 86_400_000;
const W = (n: number) => W0(8900 + n);
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
async function signed(data: Record<string, string | number>, label = 'pay', genuine?: string, decoys = false) {
  const keys = ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId', 'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode'];
  const full = { kashierOrderId: 'ko-1', orderReference: 'ref-1', method: 'card', channel: 'online', transactionResponseCode: '00', currency: 'EGP', status: 'SUCCESS', ...data, signatureKeys: keys } as Record<string, unknown>;
  kashierLedger.set(String(full.transactionId), { operation: genuine ?? label, status: String(full.status), orderId: String(full.merchantOrderId) });
  const str = keys.map((k) => `${k}=${encodeURIComponent(String(full[k]))}`).join('&');
  const body = decoys ? { event: label, merchant: 'M-9', data: { ...full, maskedCard: '411111******1111', customerEmail: 'someone@example.test' } } : { event: label, data: full };
  return { body: JSON.stringify(body), sig: await hmac(str) };
}
type Hook = { label?: string; genuine?: string; status?: string; now?: number; e?: typeof env; provider?: PaymentProvider; decoys?: boolean };
const hook = async (orderId: string, tx: string, amount: string, o: Hook = {}) => {
  const { body, sig } = await signed({ merchantOrderId: orderId, transactionId: tx, amount, ...(o.status ? { status: o.status } : {}) }, o.label ?? 'pay', o.genuine, o.decoys);
  return handleProviderWebhook(o.e ?? env, body, sig, o.provider ?? kashier, o.now ?? Date.now());
};
/** A provider whose details API is "not yet" until `ready.on` is set. */
const gated = () => { const ready = { on: false }; return { ready, provider: testKashier(async (u) => (ready.on ? detailsFetch(u) : new Response('not yet', { status: 404 }))) }; };
const inbox = (tx: string, status = 'SUCCESS') => env.DB.prepare('SELECT status, resolution, attempts, resolved_at, raw_body, last_reason FROM unconfirmed_webhooks WHERE event_key = ?').bind(`kashier:${tx}:${status}`).first<{ status: string; resolution: string | null; attempts: number; resolved_at: number | null; raw_body: string; last_reason: string | null }>();
const topupRow = async (id: string, ws: string, o: { state?: string; tx?: string | null } = {}) => {
  await seedNumber(`pn-p4-${ws.slice(-5)}`, ws);
  await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at, transaction_id) VALUES (?, ?, 5000, 150, 5150, 'EGP', ?, 'u1', ?, ?)").bind(id, ws, o.state ?? 'pending', Date.now(), o.tx ?? null).run();
};
async function startPkg(ws: string, now = Date.now()) {
  await seedNumber(`pn-p4-${ws.slice(-5)}`, ws);
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'gold' }, now);
  if (!r.ok) throw new Error(r.reason);
  return r;
}
const alerts = (spy: { mock: { calls: unknown[][] } }, name: string) => spy.mock.calls.filter((c) => String(c[0]).includes(`"${name}"`)).length;
const credits = async (ws: string) => (await workspace(ws).walletView()).aiCredits.balance;
const order = (id: string) => env.DB.prepare('SELECT status, refunded_minor FROM package_orders WHERE order_id = ?').bind(id).first<{ status: string; refunded_minor: number }>();
const sub = (ws: string) => env.DB.prepare('SELECT status FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ status: string }>();
/** Loses the first `n` refund batches of the wrapped env to a competing 1 EGP partial refund. */
const lose = (n: number, competitor: (i: number) => Promise<void>): typeof env => {
  let i = 0;
  return { ...env, DB: new Proxy(env.DB, { get(t, p) { if (p === 'batch') return async (s: D1PreparedStatement[]) => { if (i < n) await competitor(i++); return t.batch(s); }; const v = Reflect.get(t, p) as unknown; return typeof v === 'function' ? v.bind(t) : v; } }) } as typeof env;
};

describe('1. every terminal outcome closes the unconfirmed row', () => {
  /** The first delivery cannot be confirmed; Kashier never retries; the daily pass confirms it. */
  const viaCron = async (orderId: string, tx: string, amount: string, o: Hook = {}) => {
    const g = gated();
    expect((await hook(orderId, tx, amount, { ...o, provider: g.provider })).status).toBe(503);
    expect((await inbox(tx, o.status ?? 'SUCCESS'))?.status).toBe('open');
    g.ready.on = true;
    await reconfirmUnconfirmed(env, g.provider);
    return inbox(tx, o.status ?? 'SUCCESS');
  };
  it('top-up: a failed payment, an amount mismatch, a refused refund and a credited payment all close with a reason', async () => {
    await topupRow('t4-1', W(1));
    expect(await viaCron('t4-1', 'TX-41-F', '51.50', { status: 'FAILURE' })).toMatchObject({ status: 'resolved', resolution: 'failed' });
    await topupRow('t4-2', W(2));
    expect(await viaCron('t4-2', 'TX-42-M', '9.99')).toMatchObject({ status: 'resolved', resolution: 'amount_mismatch' });
    await topupRow('t4-3', W(3));
    await hook('t4-3', 'TX-43-P', '51.50');
    expect(await viaCron('t4-3', 'TX-43-P', '51.50', { label: 'refund', genuine: 'pay' }).then(() => inbox('TX-43-P'))).toMatchObject({ status: 'resolved' });
    await topupRow('t4-4', W(4));
    expect(await viaCron('t4-4', 'TX-44-OK', '51.50')).toMatchObject({ status: 'resolved', resolution: 'credited' });
  });
  it('package: a failed payment, an amount mismatch and a granted payment close with a reason', async () => {
    const a = await startPkg(W(5));
    expect(await viaCron(a.orderId, 'TX-45-F', '500.00', { status: 'FAILURE' })).toMatchObject({ status: 'resolved', resolution: 'failed' });
    const b = await startPkg(W(6));
    expect(await viaCron(b.orderId, 'TX-46-M', '1.00')).toMatchObject({ status: 'resolved', resolution: 'amount_mismatch' });
    const c = await startPkg(W(7));
    expect(await viaCron(c.orderId, 'TX-47-OK', '500.00')).toMatchObject({ status: 'resolved', resolution: 'granted' });
  });
  it('package: a refund that points at the payment\'s own transaction is refused and closes', async () => {
    const ws = W(8);
    const o = await startPkg(ws);
    await hook(o.orderId, 'TX-48-P', '500.00');
    const row = await viaCron(o.orderId, 'TX-48-P', '500.00', { label: 'refund', genuine: 'refund' });
    expect(row).toMatchObject({ status: 'resolved', resolution: 'refund_refused' });
  });
});

describe('1b. a row that can never be confirmed is abandoned after 14 daily attempts', () => {
  it('stops retrying, alerts once', async () => {
    const ws = W(10);
    await topupRow('t4-10', ws);
    const g = gated();
    const calls = { n: 0 };
    const counting = testKashier(async (u) => { calls.n++; return g.ready.on ? detailsFetch(u) : new Response('nope', { status: 404 }); });
    await hook('t4-10', 'TX-410', '51.50', { provider: counting });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let now = Date.now();
    for (let i = 0; i < 16; i++) {
      now += DAY + 1000;
      await reconfirmUnconfirmed(env, counting, now);
    }
    expect(await inbox('TX-410')).toMatchObject({ status: 'abandoned' });
    expect(alerts(spy, 'webhook_unconfirmed_abandoned')).toBe(1);
    const before = calls.n;
    await reconfirmUnconfirmed(env, counting, now + 5 * DAY);
    expect(calls.n).toBe(before);
    expect(await ledger(ws)).toEqual([]);
  });
});

describe('1c. old and finished rows never take the slots of a fresh payment', () => {
  it('150 abandoned rows and 150 not-yet-due rows do not block a fresh payment\'s re-confirmation', async () => {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 150; i++) {
      stmts.push(env.DB.prepare("INSERT INTO unconfirmed_webhooks (event_key, raw_body, signature, order_id, first_seen, last_seen, attempts, status, next_attempt_at) VALUES (?, '{}', 'x', 'nobody', 1, 1, 14, 'abandoned', 1)").bind(`stale-a-${i}`));
      stmts.push(env.DB.prepare("INSERT INTO unconfirmed_webhooks (event_key, raw_body, signature, order_id, first_seen, last_seen, attempts, status, next_attempt_at) VALUES (?, '{}', 'x', 'nobody', 1, 1, 3, 'open', ?)").bind(`stale-o-${i}`, Date.now() + 10 * DAY));
    }
    await env.DB.batch(stmts);
    const ws = W(11);
    await topupRow('t4-11', ws);
    const g = gated();
    await hook('t4-11', 'TX-411', '51.50', { provider: g.provider });
    g.ready.on = true;
    await reconfirmUnconfirmed(env, g.provider);
    expect((await ledger(ws)).filter((r) => r.kind === 'topup')).toHaveLength(1);
  });
});

describe('2. losing every race on a refund is never answered 200', () => {
  it('six lost races: 5xx and the delivery is kept; the daily pass then applies it once', async () => {
    const ws = W(20);
    const o = await startPkg(ws);
    await hook(o.orderId, 'TX-420-P', '500.00');
    const racing = lose(6, async (i) => { await hook(o.orderId, `TX-420-C${i}`, '1.00', { label: 'partial_refund' }); });
    const r = await hook(o.orderId, 'TX-420-R', '100.00', { label: 'partial_refund', e: racing });
    expect(r.status).toBe(500);
    expect(await inbox('TX-420-R')).toMatchObject({ status: 'open', last_reason: 'refund_contention' });
    expect((await order(o.orderId))!.refunded_minor).toBe(600);
    await reconfirmUnconfirmed(env, kashier);
    expect(await inbox('TX-420-R')).toMatchObject({ status: 'resolved' });
    expect((await order(o.orderId))!.refunded_minor).toBe(10600);
  });
});

describe('3. a refund confirmed before its payment is held and applied once the payment is credited', () => {
  it('package: refund first, then the payment: net zero, revoked', async () => {
    const ws = W(30);
    const o = await startPkg(ws);
    expect((await hook(o.orderId, 'TX-430-R', '500.00', { label: 'refund' })).status).toBe(200);
    expect(await inbox('TX-430-R')).toMatchObject({ status: 'open', last_reason: 'payment_pending' });
    expect(await sub(ws)).toBeNull();
    await hook(o.orderId, 'TX-430-P', '500.00');
    expect(await order(o.orderId)).toMatchObject({ status: 'refunded' });
    expect((await sub(ws))!.status).toBe('cancelled');
    expect(await credits(ws)).toBe(0);
    expect(await inbox('TX-430-R')).toMatchObject({ status: 'resolved' });
  });
  it('top-up: refund first, then the payment: the wallet nets to zero', async () => {
    const ws = W(31);
    await topupRow('t4-31', ws);
    expect((await hook('t4-31', 'TX-431-R', '50.00', { label: 'refund' })).status).toBe(200);
    expect(await inbox('TX-431-R')).toMatchObject({ status: 'open', last_reason: 'payment_pending' });
    await hook('t4-31', 'TX-431-P', '51.50');
    expect((await workspace(ws).walletView()).balanceMinor).toBe(0);
    expect((await ledger(ws)).map((r) => r.kind)).toEqual(['topup', 'chargeback']);
    expect(await inbox('TX-431-R')).toMatchObject({ status: 'resolved' });
  });
});

describe('4. only what re-verification needs is stored', () => {
  it('the signed fields, the signature and the order id; nothing else from the body', async () => {
    await topupRow('t4-40', W(40));
    const g = gated();
    await hook('t4-40', 'TX-440', '51.50', { provider: g.provider, decoys: true });
    const row = (await inbox('TX-440'))!;
    const stored = JSON.parse(row.raw_body) as { data: Record<string, unknown> } & Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(['data']);
    const keys = stored.data.signatureKeys as string[];
    expect(Object.keys(stored.data).sort()).toEqual([...keys, 'signatureKeys'].sort());
    expect(JSON.stringify(stored)).not.toContain('411111');
    expect(JSON.stringify(stored)).not.toContain('someone@example.test');
    g.ready.on = true;
    await reconfirmUnconfirmed(env, g.provider); // still re-verifies and applies from the reduced body
    expect(await inbox('TX-440')).toMatchObject({ status: 'resolved', resolution: 'credited' });
  });
  it('abandoned rows are deleted 30 days after they were abandoned, resolved ones 30 days after they resolved', async () => {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO unconfirmed_webhooks (event_key, raw_body, signature, order_id, first_seen, last_seen, attempts, status, next_attempt_at, resolved_at) VALUES ('del-a', '{}', 'x', 'n', 1, 1, 14, 'abandoned', 1, ?)").bind(now - 31 * DAY),
      env.DB.prepare("INSERT INTO unconfirmed_webhooks (event_key, raw_body, signature, order_id, first_seen, last_seen, attempts, status, next_attempt_at, resolved_at) VALUES ('keep-a', '{}', 'x', 'n', 1, 1, 14, 'abandoned', 1, ?)").bind(now - 5 * DAY),
    ]);
    await reconfirmUnconfirmed(env, kashier, now);
    expect(await env.DB.prepare("SELECT event_key FROM unconfirmed_webhooks WHERE event_key IN ('del-a', 'keep-a')").all().then((r) => r.results.map((x) => x.event_key))).toEqual(['keep-a']);
  });
});
