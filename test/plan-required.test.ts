import { SELF, createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker, { apiRoutes } from '../src/index';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { seedTemplate } from './helpers/campaigns';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { listReply, rawMessagePayload } from './helpers/payload';
import { WA_1, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, grantPlan, openChat, own, rows, workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const DAY = 86_400_000;
const PLAN_REQUIRED = { error: 'plan_required' };
const TEXT = (id: string) => ({ type: 'text', clientId: id, text: 'hello' });
const uid = () => crypto.randomUUID();

/** A workspace with an own number, an open chat and a utility template, on the baseline test plan. */
async function shop(n: number) {
  const ws = W(n);
  const api = await apiFor(ws);
  await own(ws);
  await seedTemplate(ws, { name: 'util', category: 'UTILITY', components: JSON.stringify([{ type: 'BODY', text: 'hi' }]) });
  const conv = await openChat(ws);
  return { ws, api, conv };
}
const lapse = (ws: string, kind: 'none' | 'expired' | 'cancelled') => (kind === 'none' ? exec(ws, 'DELETE FROM entitlements') : grantPlan(ws, 'growth', kind));

describe('WA-NOFREE-1: no package, no service', () => {
  it.each(['none', 'expired', 'cancelled'] as const)('%s: an API text send, a template send and a media upload are 403 plan_required, and nothing is queued', async (kind) => {
    const { ws, api, conv } = await shop(kind === 'none' ? 1000 : kind === 'expired' ? 1001 : 1002);
    const outBefore = await rows(ws, "SELECT count(*) AS n FROM messages WHERE direction = 'out'");
    await lapse(ws, kind);
    for (const body of [TEXT(uid()), { type: 'template', clientId: uid(), name: 'util', language: 'ar', params: [] }]) {
      const r = await api.call('POST', `/conversations/${conv}/messages`, body);
      expect([r.status, await r.json()], JSON.stringify(body)).toEqual([403, PLAN_REQUIRED]);
    }
    expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE direction = 'out'")).toEqual(outBefore);
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'a.jpg', { type: 'image/jpeg' }));
    const up = await api.call('POST', '/media', form);
    expect([up.status, await up.json()]).toEqual([403, PLAN_REQUIRED]);
  });

  it('number connect, register and the shared number are 403 plan_required with no package', async () => {
    const { ws, api } = await shop(1003);
    await exec(ws, 'DELETE FROM entitlements');
    const withSwitch = (p: string, b: unknown) => worker.fetch(new Request(`https://x/api/v1/stores/${ws}${p}`, { method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }, body: JSON.stringify(b) }),
      { ...env, SHARED_NUMBER_ENABLED: 'true' } as typeof env, createExecutionContext());
    for (const [p, b] of [['/numbers/connect', { code: 'x', event: 'FINISH', wabaId: '9001', phoneNumberId: '8001' }], ['/numbers/1234/register', {}], ['/shared-number/join', { displayName: 'Shop' }]] as const) {
      const r = await withSwitch(p, b);
      expect([r.status, await r.json()], p).toEqual([403, PLAN_REQUIRED]);
    }
  });

  it('reading stays open: inbox, package list, wallet', async () => {
    const { ws, api } = await shop(1004);
    await exec(ws, 'DELETE FROM entitlements');
    for (const p of ['/conversations', '/packages', '/wallet', '/templates']) expect((await api.call('GET', p)).status, p).not.toBe(403);
  });

  it('a message queued while the plan was live fails plan_required at claim and gives its wallet hold back', async () => {
    const { ws, api, conv } = await shop(1005);
    const id = uid();
    const r = await api.call('POST', `/conversations/${conv}/messages`, TEXT(id));
    expect(r.status).toBe(202);
    await exec(ws, 'DELETE FROM entitlements');
    const job = { workspaceId: ws, phoneNumberId: 'pn-x', to: '201001234567', idempotencyKey: `ui:${id}`, kind: 'text', text: 'hello' } as never;
    expect(await workspace(ws).claimSend(job)).toBe('dropped');
    expect(await rows(ws, `SELECT status, error_reason FROM messages WHERE idempotency_key = 'ui:${id}'`)).toEqual([{ status: 'failed', error_reason: 'plan_required' }]);
    expect(await rows(ws, `SELECT state FROM wallet_holds WHERE ref = 'msg:ui:${id}' AND state = 'held'`)).toEqual([]);
  });

  it('an automatic reply (no row yet) is dropped at claim, and the bot / menu / agent stay silent on inbound', async () => {
    const ws = W(1006);
    const pn = await storeWorkspace(ws);
    await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = 0; });
    await exec(ws, 'DELETE FROM entitlements');
    const g = stubGraph();
    const reply = { workspaceId: ws, phoneNumberId: pn, to: WA_1, idempotencyKey: 'bot:x:1', kind: 'text', text: 'hi' } as never;
    expect(await workspace(ws).claimSend(reply)).toBe('dropped');
    expect((await postWebhook(SELF, rawMessagePayload(pn, { id: 'wamid.pr.1', from: WA_1, type: 'text', text: { body: 'مرحبا' } }))).status).toBe(200);
    expect((await postWebhook(SELF, rawMessagePayload(pn, listReply('wamid.pr.2', 'menu:ar:order', 'x')))).status).toBe(200);
    await workspace(ws).runDueTasks();
    expect(g.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'))).toEqual([]);
    expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE direction = 'in'")).toEqual([{ n: 2 }]); // reading is open: the inbound is stored
  });

  it('store-link outbound (OTP, order and COD confirmations) is refused with no package', async () => {
    const ws = W(1007);
    await storeWorkspace(ws);
    await workspace(ws).setStoreLinkSettings({ otpViaWhatsApp: true });
    await exec(ws, 'DELETE FROM entitlements');
    const g = stubGraph();
    const r = await workspace(ws).queueOtp('201001234567', `pn-${ws}`, 'K7Q93X');
    expect(r.ok).toBe(false);
    expect(g.calls.filter((c) => c.method === 'POST')).toEqual([]);
    const sent = await runInDurableObject(workspace(ws), (inst) => {
      const host = (inst as unknown as { host(): never }).host();
      return import('../src/core/store-link/outbound').then((m) => m.queueTemplate(host, { waId: '201001234567', phoneNumberId: `pn-${ws}`, name: 'order_confirmation', language: 'ar', params: ['a', 'b'], idempotencyKey: 'order:x:created' }));
    });
    expect(sent).toMatchObject({ ok: false, reason: 'plan_required' });
  });
});

describe('WA-GRACE-1: past_due grace is bounded', () => {
  const now = () => Date.now();
  it('day 3 of past_due: service sends work, marketing is refused', async () => {
    const { ws, api, conv } = await shop(1010);
    await seedTemplate(ws, { name: 'promo', category: 'MARKETING' });
    await grantPlan(ws, 'growth', 'past_due', { pastDueSince: now() - 3 * DAY });
    expect((await api.call('POST', `/conversations/${conv}/messages`, TEXT(uid()))).status).toBe(202);
    const m = await api.call('POST', `/conversations/${conv}/messages`, { type: 'template', clientId: uid(), name: 'promo', language: 'ar', params: ['a', 'b'] });
    expect([m.status, ((await m.json()) as { error: string }).error]).toEqual([409, 'plan_blocked']);
  });
  it('day 8 of past_due: refused (treated as lapsed)', async () => {
    const { ws, api, conv } = await shop(1011);
    await grantPlan(ws, 'growth', 'past_due', { pastDueSince: now() - 8 * DAY });
    const r = await api.call('POST', `/conversations/${conv}/messages`, TEXT(uid()));
    expect([r.status, await r.json()]).toEqual([403, PLAN_REQUIRED]);
  });
  it('past_due on day 3 but past the period end: refused', async () => {
    const { ws, api, conv } = await shop(1012);
    await grantPlan(ws, 'growth', 'past_due', { pastDueSince: now() - 3 * DAY, periodEnd: now() - 1000 });
    const r = await api.call('POST', `/conversations/${conv}/messages`, TEXT(uid()));
    expect([r.status, await r.json()]).toEqual([403, PLAN_REQUIRED]);
  });
});

describe('the D1 side of past_due_since', () => {
  it('is set when a subscription first becomes past_due, kept while it stays past_due, and cleared when active', async () => {
    const ws = W(1020);
    await apiFor(ws);
    const { setSubscription } = await import('../src/core/billing/subscriptions');
    const t = Date.now();
    const base = { workspaceId: ws, packageId: 'starter', periodStart: t - DAY, periodEnd: t + 20 * DAY, source: 'operator' as const, ref: 'r' };
    const since = async () => (await env.DB.prepare('SELECT past_due_since AS s FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ s: number | null }>())?.s;
    await setSubscription(env, { ...base, status: 'active' }, t);
    expect(await since()).toBeNull();
    await setSubscription(env, { ...base, status: 'past_due' }, t + 1000);
    expect(await since()).toBe(t + 1000);
    await setSubscription(env, { ...base, status: 'past_due' }, t + 5000);
    expect(await since()).toBe(t + 1000); // the FIRST failed renewal
    await setSubscription(env, { ...base, status: 'active' }, t + 9000);
    expect(await since()).toBeNull();
  });
});

describe('route walk: every non-GET store route is decided (sends and number setup are gated)', () => {
  const GATED = new Set([
    'POST /stores/:storeId/conversations/:conversationId/messages', 'POST /stores/:storeId/media', 'POST /stores/:storeId/numbers/connect',
    'POST /stores/:storeId/numbers/:phoneNumberId/register', 'POST /stores/:storeId/shared-number/join',
  ]);
  // Decided: cannot send a WhatsApp message or set a number up, or are gated by the campaigns feature (plan_feature, see package-limits-review).
  const NOT_SENDING = new Set([
    'PUT /stores/:storeId/agent', 'DELETE /stores/:storeId/contacts/:waId', 'DELETE /stores/:storeId/campaigns/:campaignId',
    'POST /stores/:storeId/campaigns', 'POST /stores/:storeId/campaigns/:campaignId/send', 'POST /stores/:storeId/campaigns/:campaignId/resume',
    'POST /stores/:storeId/campaigns/:campaignId/pause', 'POST /stores/:storeId/campaigns/:campaignId/cancel',
    'DELETE /stores/:storeId/connectors/:connectorId', 'POST /stores/:storeId/connectors/:connectorId/test', 'PUT /stores/:storeId/connectors/:connectorId',
    'PUT /stores/:storeId/contacts/:waId/tags', 'POST /stores/:storeId/conversations/:conversationId/assign', 'POST /stores/:storeId/conversations/:conversationId/notes',
    'POST /stores/:storeId/conversations/:conversationId/read', 'PUT /stores/:storeId/conversations/:conversationId/tags', 'POST /stores/:storeId/imports',
    'POST /stores/:storeId/wallet/instapay', 'PUT /stores/:storeId/wallet/instapay/:requestId/proof', 'POST /stores/:storeId/numbers/:phoneNumberId/disconnect',
    'POST /stores/:storeId/numbers/:phoneNumberId/refresh', 'PATCH /stores/:storeId/store-link/settings', 'POST /stores/:storeId/contacts/:waId/orders/:orderNumber/cod-outcome',
    'POST /stores/:storeId/store-link/catalog/provision', 'POST /stores/:storeId/packages/:packageId/checkout', 'DELETE /stores/:storeId/segments/:segmentId',
    'POST /stores/:storeId/segments', 'POST /stores/:storeId/segments/preview', 'PUT /stores/:storeId/segments/:segmentId', 'POST /stores/:storeId/shared-number/leave',
    'POST /stores/:storeId/wallet/refund-requests', 'POST /stores/:storeId/wallet/topups',
    // Template management talks to Meta's template catalog, not to a customer: no message leaves.
    'POST /stores/:storeId/templates/sync', 'POST /stores/:storeId/templates', 'POST /stores/:storeId/templates/install-defaults',
  ]);
  const mutating = (apiRoutes.routes as { method: string; path: string }[])
    .filter((r) => r.path.startsWith('/stores/:storeId/') && !['GET', 'HEAD', 'OPTIONS', 'ALL'].includes(r.method))
    .map((r) => `${r.method} ${r.path}`);
  it('has a decision for every mutating route (a new route must be added to GATED or NOT_SENDING)', () => {
    expect(mutating.length).toBeGreaterThan(30);
    expect(mutating.filter((r) => !GATED.has(r) && !NOT_SENDING.has(r)), 'routes with no plan decision').toEqual([]);
    for (const g of GATED) expect(mutating, g).toContain(g);
  });
});
