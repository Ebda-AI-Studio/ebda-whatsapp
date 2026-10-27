import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KashierProvider, configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { startPackageCheckout } from '../src/core/billing/package-orders';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { useApiKey, storeId as W0 } from './helpers/api';
import { kashierLedger, testKashier } from './helpers/kashier';
import { stubGraph } from './helpers/graph';
import { flush, storeWorkspace, useStoreLink } from './helpers/store-link';
import { seedNumber, seedPlan, workspace } from './helpers/workspace';

// T32: billing notifications, EVIDENCED. Each row of docs/billing.md "Notifications" has a test here that drives the trigger and checks that the notification
// is produced: an alert to a human (Telegram + Sentry via alert()), a flag the merchant's screen shows, or an event the Store is told. A notification with no
// test here is not promised anywhere.
useApiKey();
const link = useStoreLink();
const agent = useAgent();
const kashier = testKashier();
const KEY = 'test-payment-api-key';
const W = (n: number) => W0(9800 + n);
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
afterEach(() => { configurePayments((e) => (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY ? new KashierProvider(e.KASHIER_MERCHANT_ID, e.KASHIER_API_KEY) : null)); configureSessionCheck(null); vi.restoreAllMocks(); });

const alerts = (logs: string[], name: string) => logs.filter((l) => l.includes(`"alert":"${name}"`)).length;
const capture = () => { const logs: string[] = []; vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logs.push(String(m)); }); return logs; };

describe('N1 wallet running low: an alert once a day, and the flag on the merchant\'s screen', () => {
  it('fires when a charge takes the available balance under the threshold, not again the same day, again the next day', async () => {
    const ws = W(1);
    await seedPlan(ws);
    const logs = capture();
    const post = (ref: string, net: number, at: number) => workspace(ws).postWallet({ kind: 'adjustment', netMinor: net, ref, actor: 'op', note: 'test' }, at);
    await post('n1-top', 5000, T0); // 50 EGP: above the 20 EGP floor
    expect(alerts(logs, 'wallet_low_balance')).toBe(0);
    await post('n1-a', -3500, T0 + 1000); // 15 EGP left: under
    expect(alerts(logs, 'wallet_low_balance')).toBe(1);
    await post('n1-b', -100, T0 + 2000);
    expect(alerts(logs, 'wallet_low_balance')).toBe(1);
    await post('n1-c', -100, T0 + DAY + 3000);
    expect(alerts(logs, 'wallet_low_balance')).toBe(2);
    expect((await workspace(ws).walletView(T0 + DAY + 4000)).lowBalance).toBe(true);
  });
});

describe('N2 AI credits running low and out', () => {
  it('low: the alert and the wallet flag (tests in growth-credits-thresholds.test.ts); out: the customer is handed to a person and the alert fires', async () => {
    const ws = W(2);
    const pn = await agentWorkspace(ws);
    agent.model = new ScriptedProvider([{ text: 'never called' }]);
    const logs = capture();
    const g = stubGraph();
    const out = await say(ws, pn, text('مرحبا'), g); // no credits at all
    expect(alerts(logs, 'agent_no_credits')).toBe(1);
    expect(out.map((s) => s.text).join(' ')).toMatch(/فريقنا/);
    expect((agent.model as ScriptedProvider).callCount).toBe(0); // no model call, nothing charged
    g.restore();
  });
});

describe('N3 the Store is told when the package changes (the Store shows the plan and switches automation)', () => {
  it('a paid package order announces whatsapp.entitlement_changed with the package and its status', async () => {
    const ws = W(3);
    await storeWorkspace(ws);
    await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)").run();
    configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, {}));
    configureSessionCheck(async () => false);
    await seedNumber('pn-n3', ws);
    const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'gold' }, Date.now());
    if (!r.ok) throw new Error(r.reason);
    const keys = ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId', 'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode'];
    const full = { kashierOrderId: 'ko-1', orderReference: 'ref-1', method: 'card', channel: 'online', transactionResponseCode: '00', currency: 'EGP', status: 'SUCCESS', merchantOrderId: r.orderId, transactionId: 'TX-N3', amount: '500.00', signatureKeys: keys };
    kashierLedger.set('TX-N3', { operation: 'pay', status: 'SUCCESS', orderId: r.orderId });
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const str = [...keys].sort().map((x) => `${x}=${encodeURIComponent(String((full as Record<string, unknown>)[x]))}`).join('&');
    const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(str)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect((await handleProviderWebhook(env, JSON.stringify({ event: 'pay', data: full }), sig, kashier, Date.now())).status).toBe(200);
    await flush(ws);
    expect(link.sink.sent.filter((e) => e.type === 'whatsapp.entitlement_changed' && e.storeId === ws).at(-1)).toMatchObject({ data: { packageId: 'gold', status: 'active' } });
  });
});

describe('N4 what the merchant\'s wallet screen is told', () => {
  it('debt, a past-due plan and a plan ending soon each have a field the screen reads', async () => {
    const ws = W(4);
    await seedPlan(ws);
    await workspace(ws).applyEntitlement({ version: 1, packageId: 'pro', status: 'past_due', periodStart: T0 - 20 * DAY, periodEnd: T0 + 3 * DAY, aiCredits: 100 });
    await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -3000, ref: 'n4-debt', actor: 'op', note: 'test' }, T0);
    const v = await workspace(ws).walletView(T0);
    expect(v).toMatchObject({ debtMinor: 3000, lowBalance: true, plan: { status: 'past_due', periodEnd: T0 + 3 * DAY } });
  });
});
