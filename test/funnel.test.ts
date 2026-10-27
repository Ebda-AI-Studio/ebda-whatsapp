import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onNumberConnected } from '../src/core/numbers/numbers';
import { startPackageCheckout } from '../src/core/billing/package-orders';
import { configurePayments, KashierProvider, type PaymentProvider } from '../src/core/billing/payments';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { useApiKey, storeId as W0 } from './helpers/api';
import { kashierLedger, testKashier } from './helpers/kashier';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { inboundPayload } from './helpers/payload';
import { deliver, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { seedNumber, workspace } from './helpers/workspace';

// T12: the signup-to-paid funnel as Analytics Engine events (docs/analytics.md has the SQL). One point per step: blobs [funnel.<step>, workspaceId, detail], doubles [1].
useApiKey();
useStoreLink();
const agent = useAgent();
const kashier = testKashier();
const KEY = 'test-payment-api-key';
const W = (n: number) => W0(9600 + n);
type Point = AnalyticsEngineDataPoint;
const steps = (ae: { mock: { calls: unknown[][] } }, ws?: string): string[] =>
  ae.mock.calls.map((c) => c[0] as Point).filter((p) => String(p.blobs?.[0]).startsWith('funnel.') && (!ws || p.blobs?.[1] === ws)).map((p) => String(p.blobs![0]).slice(7));

beforeEach(() => { configurePayments(() => Object.assign(Object.create(kashier) as PaymentProvider, {})); configureSessionCheck(async () => false); });
afterEach(() => { configurePayments((e) => (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY ? new KashierProvider(e.KASHIER_MERCHANT_ID, e.KASHIER_API_KEY) : null)); configureSessionCheck(null); vi.restoreAllMocks(); });

async function hmac(t: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function signed(data: Record<string, string | number>) {
  const d = data as { transactionId: string; merchantOrderId: string; amount: string };
  const keys = ['amount', 'channel', 'currency', 'kashierOrderId', 'merchantOrderId', 'method', 'orderReference', 'status', 'transactionId', 'transactionResponseCode'];
  const full = { kashierOrderId: 'ko-1', orderReference: 'ref-1', method: 'card', channel: 'online', transactionResponseCode: '00', currency: 'EGP', status: 'SUCCESS', ...data, signatureKeys: keys };
  kashierLedger.set(d.transactionId, { operation: 'pay', status: 'SUCCESS', orderId: d.merchantOrderId });
  const str = [...keys].sort().map((k) => `${k}=${encodeURIComponent(String((full as Record<string, unknown>)[k]))}`).join('&');
  return { body: JSON.stringify({ event: 'pay', data: full }), sig: await hmac(str) };
}

it('store.linked is the first funnel step, once per workspace however often the Store repeats it', async () => {
  const ws = W(1);
  await storeWorkspace(ws);
  const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
  await deliver([storeEvent(ws, 'store.linked', { ownerUserId: 'u' })]);
  await deliver([storeEvent(ws, 'store.linked', { ownerUserId: 'u' })]);
  expect(steps(ae, ws)).toEqual(['linked']);
});

it('a connected number is a step; the point carries the step, the workspace and a fixed detail, never a number', async () => {
  const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
  await seedNumber('pn-fn-2', W(2));
  await onNumberConnected(env, { workspaceId: W(2), phoneNumberId: 'pn-fn-2', wabaId: 'waba-fn-2', kind: 'own' });
  expect(steps(ae, W(2))).toEqual(['number_connected']);
  const p = ae.mock.calls.map((c) => c[0] as Point).find((x) => x.blobs?.[0] === 'funnel.number_connected')!;
  expect(p.blobs).toEqual(['funnel.number_connected', W(2), '']);
  expect(p.doubles).toEqual([1]);
  expect(p.indexes).toEqual(['funnel.number_connected']);
  expect(JSON.stringify(p)).not.toContain('pn-fn-2');
});

it('the first inbound message is a step, the second and third are not', async () => {
  await seedNumber('pn-fn-3', W(3));
  const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
  for (const id of ['wamid.fn3.a', 'wamid.fn3.b']) await postWebhook(SELF, inboundPayload('pn-fn-3', [{ id, text: 'hi', ts: Math.floor(Date.now() / 1000) }]));
  expect(steps(ae, W(3))).toEqual(['first_inbound']);
});

it('the first AI reply is a step (once), and every AI turn writes its token use for the cost view', async () => {
  const ws = W(4);
  const pn = await agentWorkspace(ws);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 100 });
  agent.model = new ScriptedProvider([{ text: 'أهلاً', usage: { inputTokens: 120, outputTokens: 30 } }, { text: 'تمام', usage: { inputTokens: 80, outputTokens: 20 } }]);
  const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
  const g = stubGraph();
  await say(ws, pn, text('مرحبا'), g);
  await say(ws, pn, text('شكراً'), g);
  expect(steps(ae, ws).filter((s) => s === 'first_ai_reply')).toEqual(['first_ai_reply']);
  const turns = ae.mock.calls.map((c) => c[0] as Point).filter((p) => p.blobs?.[0] === 'ai_turn' && p.blobs?.[1] === ws);
  expect(turns).toHaveLength(2);
  expect(turns[0]!.doubles!.slice(0, 3)).toEqual([120, 30, 1]); // input tokens, output tokens, model rounds
  expect(turns[1]!.doubles!.slice(0, 3)).toEqual([80, 20, 1]);
  expect(turns[0]!.blobs![2]).toBe('reply');
  g.restore();
});

it('a paid top-up is a step once per top-up, and a replayed webhook adds nothing', async () => {
  const ws = W(5);
  await seedNumber('pn-fn-5', ws);
  await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at) VALUES ('fn-top-1', ?, 5000, 150, 5150, 'EGP', 'pending', 'u1', ?)").bind(ws, Date.now() - 60_000).run();
  const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
  const { body, sig } = await signed({ merchantOrderId: 'fn-top-1', transactionId: 'TX-FN-1', amount: '51.50' });
  expect((await handleProviderWebhook(env, body, sig, kashier, Date.now())).status).toBe(200);
  expect((await handleProviderWebhook(env, body, sig, kashier, Date.now())).status).toBe(200);
  expect(steps(ae, ws)).toEqual(['topup_credited']);
});

it('a package purchase is a step with the package id as its detail, once per paid order', async () => {
  const ws = W(6);
  await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)").run();
  await seedNumber('pn-fn-6', ws);
  const r = await startPackageCheckout(env, { workspaceId: ws, userId: 'u1', sessionId: 's1', packageId: 'gold' }, Date.now());
  if (!r.ok) throw new Error(r.reason);
  const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
  const { body, sig } = await signed({ merchantOrderId: r.orderId, transactionId: 'TX-FN-6', amount: '500.00' });
  await handleProviderWebhook(env, body, sig, kashier, Date.now());
  await handleProviderWebhook(env, body, sig, kashier, Date.now());
  expect(steps(ae, ws)).toEqual(['package_purchased']);
  expect(ae.mock.calls.map((c) => c[0] as Point).find((p) => p.blobs?.[0] === 'funnel.package_purchased')!.blobs).toEqual(['funnel.package_purchased', ws, 'gold']);
});

describe('the funnel never breaks the path it measures', () => {
  it('an Analytics Engine that throws does not fail the webhook', async () => {
    await seedNumber('pn-fn-7', W(7));
    vi.spyOn(env.USAGE, 'writeDataPoint').mockImplementation(() => { throw new Error('analytics down'); });
    expect((await postWebhook(SELF, inboundPayload('pn-fn-7', [{ id: 'wamid.fn7', text: 'hi', ts: Math.floor(Date.now() / 1000) }]))).status).toBe(200);
  });
});
