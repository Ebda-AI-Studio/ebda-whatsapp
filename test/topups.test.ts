import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KashierProvider, configurePayments, egpToMinor, type Inquiry, type PaymentProvider, type RefundResult } from '../src/core/billing/payments';
import { feeFor, handleProviderWebhook, repairTopups, startTopup } from '../src/core/billing/topups';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { fund, ledger } from './helpers/billing';
import { rows, seedNumber, workspace } from './helpers/workspace';
import { kashierLedger, testKashier } from './helpers/kashier';

useApiKey();
const KEY = 'test-payment-api-key';
const kashier = testKashier();
afterEach(() => configurePayments((e) => (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY ? new KashierProvider(e.KASHIER_MERCHANT_ID, e.KASHIER_API_KEY) : null)));
const useKashier = (extra: Partial<PaymentProvider> = {}) => configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, extra));

async function hmac(text: string, key = KEY): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** A webhook signed the documented way: sorted signatureKeys, URL-encoded values joined with &, HMAC-SHA256 hex. */
async function signed(data: Record<string, string | number>, event = 'pay', key = KEY, genuine?: string) {
  const keys = ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId', 'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode'];
  const full = { kashierOrderId: 'ko-1', orderReference: 'ref-1', method: 'card', channel: 'online | e-commerce', transactionResponseCode: '00', currency: 'EGP', status: 'SUCCESS', ...data, signatureKeys: [...keys].reverse() };
  kashierLedger.set(String((full as Record<string, unknown>).transactionId), { operation: genuine ?? event, status: String((full as Record<string, unknown>).status), orderId: String((full as Record<string, unknown>).merchantOrderId) });
  const str = [...keys].sort().map((k) => `${k}=${encodeURIComponent(String((full as Record<string, unknown>)[k]))}`).join('&');
  return { body: JSON.stringify({ event, data: full }), sig: await hmac(str, key) };
}
const pending = async (orderId: string, ws: string, amount = 5000, fee = 150) => {
  await seedNumber(`pn-${ws.slice(-6)}`, ws).catch(() => {});
  await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'EGP', 'pending', 'u1', ?)")
    .bind(orderId, ws, amount, fee, amount + fee, Date.now() - 20 * 60_000).run();
};

describe('Kashier webhook signature (documented scheme)', () => {
  it('accepts the documented construction and returns the fields the money logic uses', async () => {
    const { body, sig } = await signed({ merchantOrderId: 'o1', transactionId: 'TX-1', amount: '51.50' });
    expect(await kashier.verifyWebhook(body, sig)).toEqual({ event: 'pay', status: 'SUCCESS', orderId: 'o1', transactionId: 'TX-1', amountMinor: 5150, currency: 'EGP', eventKey: 'kashier:TX-1:SUCCESS' });
    expect(await kashier.verifyWebhook(body, sig.toUpperCase())).not.toBeNull(); // hex compared case-insensitively
  });
  it('pins the documented example string: values URL-encoded ("online | e-commerce" -> online%20%7C%20e-commerce)', async () => {
    const s = 'amount=1&channel=online%20%7C%20e-commerce&currency=EGP&kashierOrderId=9ad06b17-755b-4e21-9774-aff3e2726ac9&merchantOrderId=1653481557813&method=card&orderReference=TEST-ORD-38855&status=SUCCESS&transactionId=TX-249893963&transactionResponseCode=00';
    const { body, sig } = await signed({ merchantOrderId: '1653481557813', transactionId: 'TX-249893963', amount: 1, kashierOrderId: '9ad06b17-755b-4e21-9774-aff3e2726ac9', orderReference: 'TEST-ORD-38855' });
    expect(sig).toBe(await hmac(s));
    expect(await kashier.verifyWebhook(body, sig)).toMatchObject({ amountMinor: 100 });
  });
  it.each([
    ['a tampered amount', async () => { const { body, sig } = await signed({ merchantOrderId: 'o', transactionId: 't', amount: '10.00' }); return [body.replace('"10.00"', '"1000.00"'), sig] as const; }],
    ['a different key', async () => { const { body, sig } = await signed({ merchantOrderId: 'o', transactionId: 't', amount: '10.00' }, 'pay', 'other-key'); return [body, sig] as const; }],
    ['no header', async () => { const { body } = await signed({ merchantOrderId: 'o', transactionId: 't', amount: '10.00' }); return [body, null] as const; }],
    ['not json', async () => ['{{', 'abc'] as const],
    ['signatureKeys that leave out the amount', async () => {
      const { body } = await signed({ merchantOrderId: 'o', transactionId: 't', amount: '10.00' });
      const j = JSON.parse(body); j.data.signatureKeys = j.data.signatureKeys.filter((k: string) => k !== 'amount');
      const keys = [...j.data.signatureKeys].sort();
      const sig = await hmac(keys.map((k: string) => `${k}=${encodeURIComponent(String(j.data[k]))}`).join('&'));
      return [JSON.stringify(j), sig] as const;
    }],
  ])('rejects %s', async (_n, make) => {
    const [body, sig] = await make();
    expect(await kashier.verifyWebhook(body, sig)).toBeNull();
  });
  it('amounts are exact decimals, never floats', () => {
    expect([egpToMinor('0.10'), egpToMinor(12.3), egpToMinor('7'), egpToMinor('1.005'), egpToMinor('abc'), egpToMinor(-1)]).toEqual([10, 1230, 700, null, null, null]);
  });
});

describe('starting a top-up', () => {
  const owner = { workspaceId: 'x', userId: 'u1', sessionId: 's1', amountMinor: 5000 };
  it('is off unless TOPUPS_ENABLED is true, and refuses without a provider or an accounts binding (fail closed)', async () => {
    useKashier();
    expect(await startTopup({ ...env, TOPUPS_ENABLED: undefined } as never, owner)).toEqual({ ok: false, reason: 'disabled' });
    configurePayments(() => null);
    expect(await startTopup(env, owner)).toEqual({ ok: false, reason: 'unavailable' });
    useKashier();
    expect(await startTopup(env, owner)).toEqual({ ok: false, reason: 'unavailable' }); // no ACCOUNTS binding: cannot check the session
    expect(await rows('x', 'SELECT 1')).toBeDefined();
  });
  it('refuses a revoked session and out-of-range amounts, writes nothing for any refusal', async () => {
    useKashier();
    const ws = W(900);
    await seedNumber('pn-tu1', ws);
    const accounts = (revoked: boolean) => ({ ...env, ACCOUNTS: { isRevoked: async () => revoked } }) as never;
    expect(await startTopup(accounts(true), { ...owner, workspaceId: ws })).toEqual({ ok: false, reason: 'session_revoked' });
    expect(await startTopup(accounts(false), { ...owner, workspaceId: ws, amountMinor: 10 })).toEqual({ ok: false, reason: 'invalid_amount' });
    expect(await startTopup(accounts(false), { ...owner, workspaceId: ws, amountMinor: 9_000_000 })).toEqual({ ok: false, reason: 'invalid_amount' });
    expect((await env.DB.prepare('SELECT count(*) AS n FROM topups WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n).toBe(0);
  });
  it('WA-TOPUP-FEE-1: the merchant pays the fee on top; the pending row records the exact amount and the total; the link carries the signed total', async () => {
    useKashier();
    const ws = W(901);
    await seedNumber('pn-tu2', ws);
    const e = { ...env, KASHIER_FEE_BPS: '250', KASHIER_FEE_FIXED_MINOR: '100', ACCOUNTS: { isRevoked: async () => false } } as never;
    const r = await startTopup(e, { workspaceId: ws, userId: 'u1', sessionId: 's1', amountMinor: 10_000 });
    expect(r).toMatchObject({ ok: true, amountMinor: 10_000, feeMinor: 350, totalMinor: 10_350 }); // 2.5% = 250, + 1.00 EGP
    if (!r.ok) throw new Error('x');
    const u = new URL(r.checkoutUrl);
    expect(u.searchParams.get('amount')).toBe('103.50');
    expect(u.searchParams.get('hash')).toBe(await hmac(`/?payment=MID-1.${r.orderId}.103.50.EGP`));
    expect(await env.DB.prepare('SELECT state, amount_minor, fee_minor, total_minor FROM topups WHERE order_id = ?').bind(r.orderId).first()).toEqual({ state: 'pending', amount_minor: 10_000, fee_minor: 350, total_minor: 10_350 });
    expect(feeFor({ ...env, KASHIER_FEE_BPS: '125' } as never, 10_100)).toBe(126); // 126.25 -> 126; 12.5 would round to even
    expect(feeFor({ ...env, KASHIER_FEE_BPS: 'x' } as never, 10_000)).toBe(0);
  });
  it('the route is owner-only, validates the body, and fails closed without the accounts binding', async () => {
    useKashier();
    const ws = W(902);
    const staff = await apiFor(ws, 'staff');
    const api = await apiFor(ws, 'owner');
    expect((await staff.call('POST', '/wallet/topups', { amountMinor: 5000 })).status).toBe(403);
    expect((await api.call('POST', '/wallet/topups', { amountMinor: 5 })).status).toBe(400);
    expect((await api.call('POST', '/wallet/topups', { amountMinor: 5000 })).status).toBe(503);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM topups WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n).toBe(0);
  });
});

describe('crediting', () => {
  it('a verified SUCCESS webhook credits the exact amount (not the fee), once, from OUR row; a replay and the daily repair add nothing', async () => {
    useKashier();
    const ws = W(910);
    await pending('ord-910', ws, 5000, 150);
    const { body, sig } = await signed({ merchantOrderId: 'ord-910', transactionId: 'TX-910', amount: '51.50' });
    expect((await handleProviderWebhook(env, body, sig, kashier)).status).toBe(200);
    expect((await handleProviderWebhook(env, body, sig, kashier)).status).toBe(200);
    expect((await ledger(ws)).map((r) => [r.kind, r.amount_minor, r.ref])).toEqual([['topup', 5000, 'kashier:TX-910']]);
    expect(await env.DB.prepare('SELECT state, transaction_id FROM topups WHERE order_id = ?').bind('ord-910').first()).toEqual({ state: 'paid', transaction_id: 'TX-910' });
    expect(await repairTopups(env, { ...kashier, inquire: async () => ({ status: 'SUCCESS', transactionId: 'TX-910', amountMinor: 5150, currency: 'EGP' }) } as never)).toMatchObject({ credited: 0 });
    expect((await ledger(ws)).length).toBe(1);
  });

  it('debt is settled first: a top-up added to a negative balance reports how much of it paid debt', async () => {
    useKashier();
    const ws = W(911);
    await pending('ord-911', ws, 1000, 0);
    await workspace(ws).postWallet({ kind: 'chargeback', netMinor: -300, ref: 'cb:911' });
    const { body, sig } = await signed({ merchantOrderId: 'ord-911', transactionId: 'TX-911', amount: '10.00' });
    await handleProviderWebhook(env, body, sig, kashier);
    expect(await workspace(ws).walletView()).toMatchObject({ balanceMinor: 700, debtMinor: 0 });
    expect((await ledger(ws)).at(-1)).toMatchObject({ kind: 'topup', balance_after: 700 });
  });

  it.each([
    ['a wrong signature', async () => { const s = await signed({ merchantOrderId: 'ord-912', transactionId: 'TX-1', amount: '10.00' }, 'pay', 'bad'); return { ...s, status: 401 }; }],
    ['an amount that is not the order total', async () => ({ ...(await signed({ merchantOrderId: 'ord-912', transactionId: 'TX-2', amount: '9.00' })), status: 200 })],
    ['a different currency', async () => ({ ...(await signed({ merchantOrderId: 'ord-912', transactionId: 'TX-3', amount: '10.00', currency: 'USD' })), status: 200 })],
    ['an order we never created', async () => ({ ...(await signed({ merchantOrderId: 'ord-nobody', transactionId: 'TX-4', amount: '10.00' })), status: 200 })],
    ['a PENDING status', async () => ({ ...(await signed({ merchantOrderId: 'ord-912', transactionId: 'TX-5', amount: '10.00', status: 'PENDING' })), status: 200 })],
    ['a FAILURE status', async () => ({ ...(await signed({ merchantOrderId: 'ord-912', transactionId: 'TX-6', amount: '10.00', status: 'FAILURE' })), status: 200 })],
  ])('credits nothing for %s', async (_n, make) => {
    useKashier();
    const ws = W(912);
    await env.DB.prepare('DELETE FROM topups WHERE order_id = ?').bind('ord-912').run();
    await pending('ord-912', ws, 1000, 0);
    const { body, sig, status } = await make();
    expect((await handleProviderWebhook(env, body, sig, kashier)).status).toBe(status);
    expect(await ledger(ws)).toEqual([]);
  });

  it('the workspace is whatever OUR row says: a payload cannot name another one', async () => {
    useKashier();
    const a = W(913);
    const b = W(914);
    await pending('ord-913', a, 1000, 0);
    await seedNumber('pn-tu914', b);
    const { body, sig } = await signed({ merchantOrderId: 'ord-913', transactionId: 'TX-913', amount: '10.00' });
    const j = JSON.parse(body); j.data.workspaceId = b; j.data.storeId = b;
    const out = await handleProviderWebhook(env, JSON.stringify(j), sig, kashier);
    expect(out.status).toBe(200); // extra, unsigned fields are not part of the signature and are ignored
    expect((await ledger(a)).length).toBe(1);
    expect(await ledger(b)).toEqual([]);
  });

  it('the browser redirect credits nothing: reading the order shows pending until a webhook or the repair says otherwise', async () => {
    useKashier();
    const ws = W(915);
    const api = await apiFor(ws, 'owner');
    await pending('ord-915', ws, 1000, 0);
    const r = await api.call('GET', '/wallet/topups/ord-915');
    expect(await r.json()).toMatchObject({ state: 'pending', amountMinor: 1000 });
    expect(await ledger(ws)).toEqual([]);
    expect((await apiFor(W(916), 'owner')).call).toBeDefined();
    expect((await (await apiFor(W(916), 'owner')).call('GET', '/wallet/topups/ord-915')).status).toBe(404); // another workspace's order is not visible
  });

  it('the public webhook route: 401 on a bad signature, 200 and a credit on a good one', async () => {
    useKashier();
    const ws = W(917);
    await pending('ord-917', ws, 1000, 0);
    const { body, sig } = await signed({ merchantOrderId: 'ord-917', transactionId: 'TX-917', amount: '10.00' });
    expect((await SELF.fetch('https://x/kashier/webhook', { method: 'POST', body, headers: { 'x-kashier-signature': 'deadbeef' } })).status).toBe(401);
    expect((await SELF.fetch('https://x/kashier/webhook', { method: 'POST', body, headers: { 'x-kashier-signature': sig } })).status).toBe(200);
    expect((await ledger(ws)).length).toBe(1);
  });

  it('a workspace that cannot be reached answers 5xx so the provider retries; nothing is half-recorded', async () => {
    useKashier();
    const ws = W(918);
    await pending('ord-918', ws, 1000, 0);
    const { body, sig } = await signed({ merchantOrderId: 'ord-918', transactionId: 'TX-918', amount: '10.00' });
    const broken = { ...env, WORKSPACE_DO: { get: () => { throw new Error('do down'); }, idFromName: () => ({}) } } as never;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await handleProviderWebhook(broken, body, sig, kashier)).status).toBe(500);
    expect(await env.DB.prepare('SELECT state FROM topups WHERE order_id = ?').bind('ord-918').first()).toEqual({ state: 'pending' });
    expect((await handleProviderWebhook(env, body, sig, kashier)).status).toBe(200);
    expect((await ledger(ws)).length).toBe(1);
  });

  it('a provider refund or chargeback becomes a negative row (debt is allowed) and an alert', async () => {
    useKashier();
    const spy = vi.spyOn(console, 'error');
    const ws = W(919);
    await pending('ord-919', ws, 1000, 0);
    const paid = await signed({ merchantOrderId: 'ord-919', transactionId: 'TX-P919', amount: '10.00' });
    await handleProviderWebhook(env, paid.body, paid.sig, kashier);
    const { body, sig } = await signed({ merchantOrderId: 'ord-919', transactionId: 'TX-R1', amount: '20.00' }, 'refund');
    await handleProviderWebhook(env, body, sig, kashier);
    await handleProviderWebhook(env, body, sig, kashier);
    expect((await ledger(ws)).map((r) => [r.kind, r.amount_minor, r.balance_after])).toEqual([['topup', 1000, 1000], ['chargeback', -2000, -1000]]);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('topup_refunded_by_provider'))).toBe(true);
    expect((await workspace(ws).walletView()).debtMinor).toBe(1000);
  });
});

describe('the daily repair of lost webhooks', () => {
  /** Answers `q` for `order` only (the file shares one D1, so other tests' pending orders must stay untouched). */
  const fake = (q: Inquiry | 'unsupported' | 'unavailable', order?: string): PaymentProvider => ({ ...kashier, name: 'fake', inquire: async (o: string) => (order && o !== order ? 'unavailable' : q), refund: async (): Promise<RefundResult> => ({ ok: false, reason: 'unsupported' }), verifyWebhook: async () => null, confirm: async (e) => e, createSession: async () => ({ checkoutUrl: 'https://x' }) });
  it('credits a paid order whose webhook never came, closes a failed one, expires a week-old one, and alerts when the provider cannot be asked', async () => {
    const ws = W(920);
    await pending('ord-920a', ws, 1000, 0);
    await pending('ord-920b', ws, 1000, 0);
    await env.DB.prepare("UPDATE topups SET created_at = ? WHERE order_id = 'ord-920b'").bind(Date.now() - 8 * 86_400_000).run();
    const r = await repairTopups(env, fake({ status: 'SUCCESS', transactionId: 'TX-920', amountMinor: 1000, currency: 'EGP' }, 'ord-920a'));
    expect(r).toMatchObject({ credited: 1 });
    expect((await ledger(ws)).map((x) => x.ref)).toEqual(['kashier:TX-920']);
    expect(await env.DB.prepare("SELECT order_id, state FROM topups WHERE workspace_id = ? ORDER BY order_id").bind(ws).all().then((x) => x.results)).toEqual([{ order_id: 'ord-920a', state: 'paid' }, { order_id: 'ord-920b', state: 'expired' }]);
    const ws2 = W(921);
    await pending('ord-921', ws2, 1000, 0);
    await repairTopups(env, fake({ status: 'FAILURE', transactionId: null, amountMinor: null, currency: null }, 'ord-921'));
    expect(await env.DB.prepare("SELECT state FROM topups WHERE order_id = 'ord-921'").first()).toEqual({ state: 'failed' });
    const ws3 = W(922);
    await pending('ord-922', ws3, 1000, 0);
    const spy = vi.spyOn(console, 'error');
    expect(await repairTopups(env, fake('unsupported', 'ord-922'))).toMatchObject({ unsupported: true, credited: 0 });
    expect(spy.mock.calls.some((c) => String(c[0]).includes('topup_inquiry_unsupported'))).toBe(true);
    expect(await ledger(ws3)).toEqual([]);
  });
  it('a paid answer for the wrong amount credits nothing', async () => {
    const ws = W(923);
    await pending('ord-923', ws, 1000, 0);
    await repairTopups(env, fake({ status: 'SUCCESS', transactionId: 'TX-923', amountMinor: 1, currency: 'EGP' }, 'ord-923'));
    expect(await ledger(ws)).toEqual([]);
  });
});
