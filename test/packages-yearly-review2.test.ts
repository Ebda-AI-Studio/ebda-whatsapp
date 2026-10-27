import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMonthsUtc } from '../src/core/billing/yearly';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { executeYearlyRefund, packageRefundQuote, repairPackageOrders, startPackageCheckout } from '../src/core/billing/package-orders';
import { rollRenewals } from '../src/core/billing/subscriptions';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, operatorCall, storeId as W0, useApiKey } from './helpers/api';
import { KEY, kashierLedger, testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';
import { exec, rows, seedNumber, workspace } from './helpers/workspace';

/**
 * Second independent review of P2 (#32): ten findings, each pinned with exact amounts. Every test here failed before its fix.
 */
useApiKey();
useStoreLink();
const kashier = testKashier();
const W = (n: number) => W0(9700 + n);
const addMonths = addMonthsUtc;
const T0 = Date.now();
const monthK = (k: number) => addMonths(T0, k - 1) + 3_600_000; // an hour into month k (1-based) of a period that started at T0

beforeEach(async () => {
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
const hookAt = async (orderId: string, tx: string, amount: string, at: number, label = 'pay') => {
  const { body, sig } = await signed({ merchantOrderId: orderId, transactionId: tx, amount }, label);
  return handleProviderWebhook(env, body, sig, kashier, at);
};
const hook = (orderId: string, tx: string, amount: string, label = 'pay') => hookAt(orderId, tx, amount, Date.now(), label);
const money = (minor: number) => (minor / 100).toFixed(2);
async function buyAt(ws: string, packageId: string, at: number) {
  await seedNumber(`pn-r2-${ws.slice(-5)}`, ws);
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId }, at);
  if (!r.ok) throw new Error(r.reason);
  await hookAt(r.orderId, `TX-${crypto.randomUUID()}`, money(r.amountMinor), at);
  return r;
}
const checkout = async (ws: string, packageId: string, at: number) => {
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId }, at);
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const sub = (ws: string) => env.DB.prepare('SELECT package_id, status, period_start, period_end, version, queued_periods, source FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ package_id: string; status: string; period_start: number; period_end: number; version: number; queued_periods: number; source: string }>();
const order = (id: string) => env.DB.prepare('SELECT status, granted_at, refunded_minor, owns_running, queued_seq FROM package_orders WHERE order_id = ?').bind(id).first<{ status: string; granted_at: number | null; refunded_minor: number; owns_running: number; queued_seq: number | null }>();
const ledger = (ws: string) => rows<{ ref: string; amount: number; kind: string }>(ws, "SELECT ref, amount, kind FROM credit_ledger WHERE kind IN ('grant', 'expire') ORDER BY id");
/** The period of `ws` ended a second ago and its queued renewal rolled in. */
async function rollNow(ws: string) {
  const ended = Math.floor((Date.now() - 1000) / 1000) * 1000;
  await env.DB.prepare('UPDATE workspace_subscriptions SET period_end = ? WHERE workspace_id = ?').bind(ended, ws).run();
  expect(await rollRenewals(env, ws, Date.now())).toBe(1);
}
const alerts = (spy: ReturnType<typeof vi.spyOn>, name: string) => spy.mock.calls.flat().join('\n').split(`"alert":"${name}"`).length - 1;

describe('IMPORTANT 1: a full refund of an OLD upgrade never touches the current period', () => {
  it('starter -> growth upgrade (7,200), then a paid growth renewal (13,410) rolls in: refunding the old 7,200 leaves the renewal on growth', async () => {
    const ws = W(1);
    await buyAt(ws, 'starter-yearly', T0);
    const u = await buyAt(ws, 'growth-yearly', monthK(1));
    expect((await order(u.orderId))).toMatchObject({ status: 'paid' });
    expect(u.amountMinor).toBe(720000);
    await buyAt(ws, 'growth-yearly', T0 + 2000); // renewal 13,410 queued behind the running period
    await rollNow(ws);
    const cur = (await sub(ws))!;
    expect(cur).toMatchObject({ package_id: 'growth-yearly', queued_periods: 0 });
    await hook(u.orderId, 'TX-OLD-UP', '7200.00', 'refund');
    expect(await order(u.orderId)).toMatchObject({ status: 'refunded', refunded_minor: 720000 });
    expect(await sub(ws)).toEqual(cur); // same package, same version, same period
  });
  it('an upgrade that was paid but NEVER granted (stale) and is then refunded in full does not revert a period it never changed', async () => {
    const ws = W(2);
    const a = await buyAt(ws, 'starter-yearly', T0);
    const up = await checkout(ws, 'growth-yearly', monthK(2));
    const before = (await sub(ws))!;
    // the period rolled meanwhile (a renewal of growth now runs)
    await env.DB.prepare("UPDATE workspace_subscriptions SET period_start = period_end, period_end = ?, package_id = 'growth-yearly', version = version + 1 WHERE workspace_id = ?").bind(addMonths(before.period_end, 12), ws).run();
    await env.DB.prepare('UPDATE package_orders SET owns_running = 0 WHERE order_id = ?').bind(a.orderId).run();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await hookAt(up.orderId, 'TX-STALE-UP', money(up.amountMinor), monthK(2));
    expect(await order(up.orderId)).toMatchObject({ status: 'paid', granted_at: null });
    const cur = (await sub(ws))!;
    await hook(up.orderId, 'TX-STALE-UP-R', money(up.amountMinor), 'refund');
    expect(await order(up.orderId)).toMatchObject({ status: 'refunded' });
    expect(await sub(ws)).toEqual(cur);
  });
});

describe('IMPORTANT 1b: an upgrade that was never granted cannot revert anything, even inside the very period it was quoted for', () => {
  it('paid-but-ungranted upgrade, the subscription happens to be on its package in the same period: a full refund leaves the package alone', async () => {
    const ws = W(16);
    await buyAt(ws, 'starter-yearly', T0);
    const up = await checkout(ws, 'growth-yearly', monthK(1));
    await env.DB.prepare("UPDATE package_orders SET status = 'paid', provider_ref = 'TX-NEVER-GRANTED', paid_at = ? WHERE order_id = ?").bind(Date.now(), up.orderId).run(); // paid, granted_at stays NULL
    await env.DB.prepare("UPDATE workspace_subscriptions SET package_id = 'growth-yearly', version = version + 1 WHERE workspace_id = ?").bind(ws).run(); // e.g. fixed by hand
    const cur = (await sub(ws))!;
    await hook(up.orderId, 'TX-NEVER-GRANTED-R', money(up.amountMinor), 'refund');
    expect(await order(up.orderId)).toMatchObject({ status: 'refunded', granted_at: null });
    expect(await sub(ws)).toEqual(cur);
  });
});

describe('IMPORTANT 2: a refunded upgrade gives its credits back', () => {
  it('starter -> pro in month 12 (2,100.00) tops up +4,700; the full refund reverts the package AND expires those 4,700', async () => {
    const ws = W(3);
    await buyAt(ws, 'starter-yearly', T0);
    const up = await buyAt(ws, 'pro-yearly', monthK(12));
    expect(up.amountMinor).toBe(210000);
    expect((await workspace(ws).aiCredits()).balance).toBe(300 + 4700);
    await hook(up.orderId, 'TX-PRO-R', '2100.00', 'refund');
    expect((await sub(ws))!.package_id).toBe('starter-yearly');
    expect((await workspace(ws).aiCredits()).balance).toBe(300);
    expect((await ledger(ws)).filter((r) => r.kind === 'expire')).toEqual([{ ref: `expire:upgrade-refund:${up.orderId}`, amount: -4700, kind: 'expire' }]);
    await hook(up.orderId, 'TX-PRO-R', '2100.00', 'refund'); // redelivered: nothing more
    expect((await workspace(ws).aiCredits()).balance).toBe(300);
  });
  it('credits already spent stay spent: with 1,000 used only the unused part of the top-up expires', async () => {
    const ws = W(4);
    await buyAt(ws, 'starter-yearly', T0);
    const up = await buyAt(ws, 'pro-yearly', monthK(12));
    const bal = (await workspace(ws).aiCredits()).balance;
    await exec(ws, "INSERT INTO credit_ledger (at, kind, amount, balance_after, ref) VALUES (?, 'ai_charge', -1000, ?, 'ai:used-1')", Date.now(), bal - 1000);
    await hook(up.orderId, 'TX-PRO-R2', '2100.00', 'refund');
    // 5,000 granted - 1,000 used = 4,000 unused; the top-up above the starter allowance is 4,700: min(4,000, 4,700) = 4,000
    expect((await ledger(ws)).filter((r) => r.kind === 'expire').map((r) => r.amount)).toEqual([-4000]);
    expect((await workspace(ws).aiCredits()).balance).toBe(0);
  });
});

describe('IMPORTANT 3: refunding the period OWNER in full tells a person about the paid upgrade left behind', () => {
  it('6,210 owner + 7,200 upgrade: a full refund of the owner raises ONE P1 naming the upgrade, once even when the webhook is redelivered', async () => {
    const ws = W(5);
    const a = await buyAt(ws, 'starter-yearly', T0);
    const u = await buyAt(ws, 'growth-yearly', monthK(1));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await hook(a.orderId, 'TX-OWN-FULL', '6210.00', 'refund');
    expect(await order(u.orderId)).toMatchObject({ status: 'paid' }); // still paid, unrefunded
    expect(alerts(log, 'upgrade_stranded_by_owner_refund')).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toContain(u.orderId);
    await hook(a.orderId, 'TX-OWN-FULL', '6210.00', 'refund');
    expect(alerts(log, 'upgrade_stranded_by_owner_refund')).toBe(1);
  });
});

describe('IMPORTANT 4: the quote and the execute path agree, and a queued renewal is never stranded', () => {
  it('while a renewal is queued the yearly refund is refused (409 queued_periods) by BOTH the quote and the execute, and nothing changes', async () => {
    const ws = W(6);
    const a = await buyAt(ws, 'starter-yearly', T0);
    const q = await buyAt(ws, 'starter-yearly', T0 + 2000);
    const before = (await sub(ws))!;
    expect(before.queued_periods).toBe(1);
    expect(await packageRefundQuote(env, a.orderId, Date.now())).toBe('queued_periods');
    expect(await executeYearlyRefund(env, a.orderId, { actor: 'op', reason: 'merchant left' })).toEqual({ ok: false, reason: 'queued_periods' });
    const res = await operatorCall(OP1, 'POST', `/package-orders/${a.orderId}/yearly-refund`, { reason: 'merchant left' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ message: 'queued_periods' });
    expect((await operatorCall(OP1, 'GET', `/package-orders/${a.orderId}/refund-quote`)).status).toBe(409);
    expect(await sub(ws)).toEqual(before);
    // the queued order itself: the quote and the execute both say it is queued (its refund is the full payment through the provider)
    expect(await packageRefundQuote(env, q.orderId, Date.now())).toBe('order_queued');
    expect(await executeYearlyRefund(env, q.orderId, { actor: 'op', reason: 'merchant left' })).toEqual({ ok: false, reason: 'order_queued' });
    // refunding the queued payment in full removes just that period; the yearly refund then works
    await hook(q.orderId, 'TX-Q-FULL', '6210.00', 'refund');
    expect((await sub(ws))!.queued_periods).toBe(0);
    expect(await executeYearlyRefund(env, a.orderId, { actor: 'op', reason: 'merchant left' })).toMatchObject({ ok: true, shortenedMonths: 11 });
  });
});

describe('IMPORTANT 5: a stale or expired quote is never granted', () => {
  it('starter -> pro quoted in month 3 at 21,000.00 and paid in month 5 is NOT granted (it would overpay 4 months already gone): paid, ungranted, alerted', async () => {
    const ws = W(7);
    await buyAt(ws, 'starter-yearly', T0);
    const up = await checkout(ws, 'pro-yearly', monthK(3));
    expect(up.amountMinor).toBe(2100000);
    const before = (await sub(ws))!;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await hookAt(up.orderId, 'TX-LATE', '21000.00', monthK(5));
    expect(await sub(ws)).toEqual(before);
    expect(await order(up.orderId)).toMatchObject({ status: 'paid', granted_at: null });
    expect(alerts(log, 'switch_order_stale')).toBe(1);
  });
  it('paid in the SAME month as the quote it is still granted (the guard is the month, not the clock)', async () => {
    const ws = W(8);
    await buyAt(ws, 'starter-yearly', T0);
    const up = await checkout(ws, 'pro-yearly', monthK(3));
    await hookAt(up.orderId, 'TX-SAME', '21000.00', monthK(3) + 600_000);
    expect((await sub(ws))!.package_id).toBe('pro-yearly');
    expect(await order(up.orderId)).toMatchObject({ status: 'paid' });
  });
  it('an EXPIRED upgrade order that is then paid (even in the same month) is recorded as paid but never granted', async () => {
    const ws = W(9);
    await buyAt(ws, 'starter-yearly', T0);
    const up = await checkout(ws, 'growth-yearly', monthK(2));
    await repairPackageOrders(env, monthK(2) + 25 * 3_600_000, null); // 24 h passed: the pending order expires
    expect(await order(up.orderId)).toMatchObject({ status: 'expired' });
    const before = (await sub(ws))!;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await hookAt(up.orderId, 'TX-EXPIRED', money(up.amountMinor), monthK(2) + 26 * 3_600_000);
    expect(await sub(ws)).toEqual(before);
    expect(await order(up.orderId)).toMatchObject({ status: 'paid', granted_at: null }); // the money is recorded (a refund can match it)
    expect(alerts(log, 'switch_order_stale')).toBe(1);
  });
});

describe('IMPORTANT 6: only a PURCHASE-sourced period can be refunded as a yearly order', () => {
  it('an operator comps pro-yearly over an old starter-yearly order: the old order no longer owns anything and its yearly refund pays nothing', async () => {
    const ws = W(10);
    const a = await buyAt(ws, 'starter-yearly', T0);
    expect((await order(a.orderId))!.owns_running).toBe(1);
    const res = await operatorCall(OP1, 'PUT', `/workspaces/${ws}/subscription`, { packageId: 'pro-yearly', status: 'active', periodEnd: addMonths(Date.now(), 12), reason: 'sales deal 7' });
    expect(res.status).toBe(200);
    expect((await order(a.orderId))!.owns_running).toBe(0);
    expect(await executeYearlyRefund(env, a.orderId, { actor: 'op', reason: 'wrong order' })).toEqual({ ok: false, reason: 'not_running' });
    expect(await packageRefundQuote(env, a.orderId, Date.now())).toMatchObject({ unusedMonths: 0, refundMinor: 0 });
    expect(await sub(ws)).toMatchObject({ package_id: 'pro-yearly', source: 'operator', status: 'active' });
  });
  it('even if a stale owns_running flag is left behind, a period whose source is not "purchase" is never refundable', async () => {
    const ws = W(11);
    const a = await buyAt(ws, 'starter-yearly', T0);
    await env.DB.prepare("UPDATE workspace_subscriptions SET source = 'operator' WHERE workspace_id = ?").bind(ws).run(); // owns_running is still 1
    expect(await executeYearlyRefund(env, a.orderId, { actor: 'op', reason: 'wrong order' })).toEqual({ ok: false, reason: 'not_running' });
    expect(await packageRefundQuote(env, a.orderId, Date.now())).toMatchObject({ unusedMonths: 0, refundMinor: 0 });
  });
});

describe('MINOR 7: the refund plan is guarded by what the quote was computed on', () => {
  it('a webhook partial refund that lands between the quote and the batch makes the plan refuse (quote_changed); asking again prices the new total', async () => {
    const ws = W(12);
    const a = await buyAt(ws, 'starter-yearly', T0);
    const real = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (stmts: D1PreparedStatement[]) => {
      await env.DB.prepare('UPDATE package_orders SET refunded_minor = refunded_minor + 103500 WHERE order_id = ?').bind(a.orderId).run(); // 1,035.00 lands now
      return real(stmts);
    });
    const first = await executeYearlyRefund(env, a.orderId, { actor: 'op', reason: 'merchant left' });
    expect(first).toEqual({ ok: false, reason: 'quote_changed' });
    expect((await sub(ws))!.status).toBe('active');
    expect(await rows(ws, 'SELECT 1 FROM wallet_ledger WHERE ref = ?', `yearly-refund-debt:${a.orderId}`)).toHaveLength(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM package_refund_plans WHERE order_id = ?').bind(a.orderId).first()).toEqual({ n: 0 });
    const again = await executeYearlyRefund(env, a.orderId, { actor: 'op', reason: 'merchant left' });
    // 11 unused months x 517.50 = 5,692.50 less the 1,035.00 already refunded = 4,657.50
    expect(again).toMatchObject({ ok: true, shortenedMonths: 11, cashRefundMinor: 465750 });
  });
});

describe('MINOR 8: a debt credit that never reached the wallet is posted by the daily pass', () => {
  it('the plan is applied in D1 but the wallet call failed: the next repair posts the fixed ref exactly once', async () => {
    const ws = W(13);
    const a = await buyAt(ws, 'starter-yearly', T0);
    expect((await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -100000, ref: `debt-${ws}`, actor: 'op', note: 'test debt' })).ok).toBe(true);
    const realGet = env.WORKSPACE_DO.get.bind(env.WORKSPACE_DO);
    vi.spyOn(env.WORKSPACE_DO, 'get').mockImplementation((id) => {
      const s = realGet(id);
      return { walletView: (n?: number) => s.walletView(n), postWallet: async () => { throw new Error('do down'); } } as unknown as ReturnType<typeof realGet>;
    });
    await expect(executeYearlyRefund(env, a.orderId, { actor: 'op', reason: 'merchant left' })).rejects.toThrow('do down');
    vi.restoreAllMocks();
    configureSessionCheck(async () => false);
    expect(await env.DB.prepare('SELECT applied, debt_settled_minor FROM package_refund_plans WHERE order_id = ?').bind(a.orderId).first()).toEqual({ applied: 1, debt_settled_minor: 100000 });
    expect((await workspace(ws).walletView()).balanceMinor).toBe(-100000);
    await repairPackageOrders(env, Date.now(), null);
    expect((await workspace(ws).walletView()).balanceMinor).toBe(0);
    await repairPackageOrders(env, Date.now(), null); // and again: no second credit
    expect(await rows(ws, 'SELECT kind, amount_minor FROM wallet_ledger WHERE ref = ?', `yearly-refund-debt:${a.orderId}`)).toEqual([{ kind: 'adjustment', amount_minor: 100000 }]);
  });
});

describe('MINOR 9: a refund is counted at the rate in effect when it was made', () => {
  it('517.50 refunded on starter (1 month cut at 517.50), then upgraded to growth, then 2,235.00 refunded: 2 more months (at 1,117.50), not 1', async () => {
    const ws = W(14);
    const a = await buyAt(ws, 'starter-yearly', T0);
    const s = (await sub(ws))!;
    await hook(a.orderId, 'TX-M1', '517.50', 'partial_refund');
    expect((await sub(ws))!.period_end).toBe(addMonths(s.period_start, 11));
    const u = await buyAt(ws, 'growth-yearly', monthK(1));
    expect(u.amountMinor).toBe(660000); // 11 remaining months x (1,117.50 - 517.50)
    await hook(u.orderId, 'TX-M2', '2235.00', 'partial_refund');
    // 51,750 (already spent on the first month) + 223,500 = 275,250; the first month used 51,750 of it; 223,500 / 111,750 = 2 months
    expect((await sub(ws))!.period_end).toBe(addMonths(s.period_start, 9));
  });
});

describe('MINOR 10: a stale switch order alerts once, not every day', () => {
  it('three daily repairs of one paid-but-ungranted stale upgrade raise ONE switch_order_stale', async () => {
    const ws = W(15);
    await buyAt(ws, 'starter-yearly', T0);
    const up = await checkout(ws, 'growth-yearly', monthK(2));
    const before = (await sub(ws))!;
    await env.DB.prepare('UPDATE workspace_subscriptions SET period_start = period_end, period_end = ?, version = version + 1 WHERE workspace_id = ?').bind(addMonths(before.period_end, 12), ws).run();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await hookAt(up.orderId, 'TX-STALE-D', money(up.amountMinor), monthK(2));
    for (let d = 1; d <= 3; d++) await repairPackageOrders(env, monthK(2) + d * 86_400_000, null);
    expect(alerts(log, 'switch_order_stale')).toBe(1);
  });
});
