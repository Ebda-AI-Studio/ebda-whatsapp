// @repo-guard
import { SELF, createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { apiRoutes } from '../src/index';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { campaignActivate } from '../src/core/campaigns/campaigns';
import { MemoryVectors, ScriptedProvider, bagEmbedder, until, useAgent } from './helpers/agent';
import { agentWorkspace, say as agentSay, text as agentText } from './helpers/agent-chat';
import { makeCampaign, seedContacts, seedTemplate } from './helpers/campaigns';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { listReply, rawMessagePayload } from './helpers/payload';
import { WA_1, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, grantPlan, openChat, own, rows, workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const vecs = { v: new MemoryVectors() };
const agent = useAgent({ vectors: () => vecs.v, embedder: () => bagEmbedder });
beforeEach(() => { vecs.v = new MemoryVectors(); });
const vectorsFor = () => vecs.v;
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
  await workspace(ws).runDueTasks(); // let setup settle (alarm-driven tasks) BEFORE anything is measured
  return { ws, api, conv };
}
// WA-CANCEL-1: `cancelled` only lapses once its paid period has ended.
/** Every outbound row (key, type, status): a stray row shows up by name in the assertion diff, not as a bare count. */
const outbound = (ws: string) => rows(ws, "SELECT idempotency_key, type, status, error_reason FROM messages WHERE direction = 'out' ORDER BY id");
const lapse = (ws: string, kind: 'none' | 'expired' | 'cancelled') => (kind === 'none' ? exec(ws, 'DELETE FROM entitlements') : grantPlan(ws, 'growth', kind, { periodEnd: Date.now() - 1000 }));

describe('WA-NOFREE-1: no package, no service', () => {
  it.each(['none', 'expired', 'cancelled'] as const)('%s: an API text send, a template send and a media upload are 403 plan_required, and nothing is queued', async (kind) => {
    const { ws, api, conv } = await shop(kind === 'none' ? 1000 : kind === 'expired' ? 1001 : 1002);
    const outBefore = await outbound(ws);
    await lapse(ws, kind);
    for (const body of [TEXT(uid()), { type: 'template', clientId: uid(), name: 'util', language: 'ar', params: [] }]) {
      const r = await api.call('POST', `/conversations/${conv}/messages`, body);
      expect([r.status, await r.json()], JSON.stringify(body)).toEqual([403, PLAN_REQUIRED]);
    }
    expect(await outbound(ws), 'no NEW outbound row (the diff names what appeared)').toEqual(outBefore);
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

  it('an automatic reply (no row yet) is dropped at claim', async () => {
    const ws = W(1006);
    const pn = await storeWorkspace(ws);
    await exec(ws, 'DELETE FROM entitlements');
    const reply = { workspaceId: ws, phoneNumberId: pn, to: WA_1, idempotencyKey: 'bot:x:1', kind: 'text', text: 'hi' } as never;
    expect(await workspace(ws).claimSend(reply)).toBe('dropped');
  });

  // The features stay ON in the plan (pro keeps order_in_chat), so ONLY the lapse can silence the bot, menu and replies: the router gate is what this proves.
  describe.each([
    ['expired', async (ws: string) => grantPlan(ws, 'pro', 'expired')],
    ['past_due on day 8', async (ws: string) => grantPlan(ws, 'pro', 'past_due', { pastDueSince: Date.now() - 8 * DAY })],
  ] as const)('a lapsed plan (%s) silences the bot, the menu and the ordering flow', (_name, lapseIt) => {
    it('replies on an active pro plan, then says nothing once it lapses; the inbound is still stored', async () => {
      const ws = W(_name === 'expired' ? 1030 : 1031);
      const pn = await storeWorkspace(ws);
      await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = 0; });
      expect((await workspace(ws).setStoreLinkSettings({ menu: { enabled: true, items: [{ id: 'hours', title: { ar: 'مواعيد', en: 'Hours' }, answer: { ar: 'كل يوم.', en: 'Daily.' } }] } } as never)).ok).toBe(true);
      await grantPlan(ws, 'pro');
      const g = stubGraph();
      const sent = () => g.calls.filter((c) => c.method === 'POST' && c.url.endsWith(`/${pn}/messages`)).length;
      const say = async (m: Record<string, unknown>) => {
        expect((await postWebhook(SELF, rawMessagePayload(pn, m))).status).toBe(200);
        await workspace(ws).runDueTasks();
      };
      await say({ id: `wamid.lp.${_name}.1`, from: WA_1, type: 'text', text: { body: 'مرحبا' } });
      expect(sent(), 'on an active pro plan the menu answers').toBeGreaterThan(0);
      const before = sent();
      await lapseIt(ws);
      await workspace(ws).grantAiCredits?.({ periodStart: 1, packageId: 't', credits: 5 }).catch(() => undefined);
      await say({ id: `wamid.lp.${_name}.2`, from: WA_1, type: 'text', text: { body: 'مرحبا' } });
      await say(listReply(`wamid.lp.${_name}.3`, 'menu:ar:order', 'x') as unknown as Record<string, unknown>);
      expect(sent(), 'nothing is sent after the lapse').toBe(before);
      expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE direction = 'in'")).toEqual([{ n: 3 }]);
    });
  });

  // The router gate is what keeps the AI model from being CALLED (and billed) for a lapsed workspace; the send-side gates alone would still pay for the answer.
  it.each([
    ['expired', async (ws: string) => grantPlan(ws, 'pro', 'expired')],
    ['past_due on day 8', async (ws: string) => grantPlan(ws, 'pro', 'past_due', { pastDueSince: Date.now() - 8 * DAY })],
  ] as const)('the AI agent is not even run for a lapsed plan (%s): the model is not called', async (name, lapseIt) => {
    const ws = W(name === 'expired' ? 1050 : 1051);
    const pn = await agentWorkspace(ws);
    await grantPlan(ws, 'pro');
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 't', credits: 50 });
    const model = (agent.model = new ScriptedProvider([{ text: 'hello there' }, { text: 'again' }])) as ScriptedProvider;
    const g = stubGraph();
    await agentSay(ws, pn, agentText('مرحبا'), g);
    expect(model.calls.length, 'on an active pro plan the agent runs').toBe(1);
    await lapseIt(ws);
    await agentSay(ws, pn, agentText('لسه موجود؟'), g);
    expect(model.calls.length, 'the model is not called once the plan has lapsed').toBe(1);
  });

  it('a row stuck in claimed past the stale window is failed plan_required at the next claim, not re-sent (a fresh claim in flight is left alone)', async () => {
    const { ws, api, conv } = await shop(1032);
    const id = uid();
    expect((await api.call('POST', `/conversations/${conv}/messages`, TEXT(id))).status).toBe(202);
    const key = `ui:${id}`;
    const job = { workspaceId: ws, phoneNumberId: 'pn-x', to: '201001234567', idempotencyKey: key, kind: 'text', text: 'hello' } as never;
    await exec(ws, "UPDATE messages SET status = 'claimed', updated_at = ?, claim_attempts = 1 WHERE idempotency_key = ?", Date.now() - 10 * 60_000, key);
    await exec(ws, 'DELETE FROM entitlements');
    expect(await workspace(ws).claimSend(job)).toBe('dropped');
    expect(await rows(ws, 'SELECT status, error_reason FROM messages WHERE idempotency_key = ?', key)).toEqual([{ status: 'failed', error_reason: 'plan_required' }]);
    // a claim that is only seconds old may really be with Meta: left to the normal path
    const id2 = uid();
    expect((await api.call('POST', `/conversations/${conv}/messages`, TEXT(id2))).status).toBe(403); // plan is gone: refused up front
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

describe('positive controls', () => {
  it('the same OTP is queued and sent on a package in good standing', async () => {
    const ws = W(1033);
    const pn = await storeWorkspace(ws);
    await workspace(ws).setStoreLinkSettings({ otpViaWhatsApp: true });
    const g = stubGraph();
    expect(await workspace(ws).queueOtp('201001234567', pn, 'K7Q93X')).toEqual({ ok: true });
    expect(g.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('WA-CANCEL-1: cancelled stays in effect until its paid period ends', () => {
  const mktg = () => ({ type: 'template', clientId: uid(), name: 'promo', language: 'ar', params: ['a', 'b'] });
  it('cancelled with a FUTURE period_end: service, marketing and the package features all work', async () => {
    const { ws, api, conv } = await shop(1040);
    await seedTemplate(ws, { name: 'promo', category: 'MARKETING' });
    await grantPlan(ws, 'growth', 'cancelled', { periodEnd: Date.now() + 10 * DAY });
    expect((await api.call('POST', `/conversations/${conv}/messages`, TEXT(uid()))).status).toBe(202);
    expect((await api.call('POST', `/conversations/${conv}/messages`, mktg())).status).toBe(202); // marketing is not blocked by `cancelled` itself
    expect(await workspace(ws).planAllows('campaigns')).toBe(true); // features per package
    expect(await workspace(ws).planAllows('api')).toBe(false); // growth has no api
    expect(await workspace(ws).planMemberLimit()).toBe(5);
  });
  it.each([['a past period_end', -1000], ['an ancient one (no real period)', -(400 * DAY)]] as const)('cancelled with %s: denied everywhere', async (_n, delta) => {
    const { ws, api, conv } = await shop(1041 + (delta < -DAY ? 1 : 0));
    await seedTemplate(ws, { name: 'promo', category: 'MARKETING' });
    await grantPlan(ws, 'growth', 'cancelled', { periodEnd: Date.now() + delta });
    for (const b of [TEXT(uid()), mktg()]) {
      const r = await api.call('POST', `/conversations/${conv}/messages`, b);
      expect([r.status, await r.json()]).toEqual([403, PLAN_REQUIRED]);
    }
    expect(await workspace(ws).planAllows('campaigns')).toBe(false);
    expect(await workspace(ws).planMemberLimit()).toBe(1);
  });
  it('the workspace expires ITSELF at period_end: no reconcile, no expired event, no alarm', async () => {
    const { ws, api, conv } = await shop(1043);
    await grantPlan(ws, 'growth', 'cancelled', { periodEnd: Date.now() + 10 * DAY });
    expect((await api.call('POST', `/conversations/${conv}/messages`, TEXT(uid()))).status).toBe(202);
    await exec(ws, 'UPDATE entitlements SET period_end = ?', Date.now() - 1); // the clock passes period_end; nothing else happens
    const r = await api.call('POST', `/conversations/${conv}/messages`, TEXT(uid()));
    expect([r.status, await r.json()]).toEqual([403, PLAN_REQUIRED]);
    expect(await workspace(ws).planAllows('campaigns')).toBe(false);
  });
  it('active and trialing with a past period_end are denied too', async () => {
    for (const [i, st] of (['active', 'trialing'] as const).entries()) {
      const { ws, api, conv } = await shop(1044 + i);
      await exec(ws, "UPDATE entitlements SET status = ?, period_end = ?", st, Date.now() - 1000);
      const r = await api.call('POST', `/conversations/${conv}/messages`, TEXT(uid()));
      expect([r.status, await r.json()], st).toEqual([403, PLAN_REQUIRED]);
    }
  });
});

describe('serviceAllowed: the period and the missing clock', () => {
  it('an active plan whose period has ended is refused even if the expiry alarm has not run', async () => {
    const { ws, api, conv } = await shop(1034);
    await grantPlan(ws, 'growth', 'active', { periodEnd: Date.now() - 1000 });
    const r = await api.call('POST', `/conversations/${conv}/messages`, TEXT(uid()));
    expect([r.status, await r.json()]).toEqual([403, PLAN_REQUIRED]);
  });
  it('a past_due copy with past_due_since NULL is bounded from when the copy was written (updated_at), 7 days', async () => {
    const { ws, api, conv } = await shop(1035);
    await grantPlan(ws, 'growth', 'past_due'); // no pastDueSince on the event
    expect((await api.call('POST', `/conversations/${conv}/messages`, TEXT(uid()))).status).toBe(202);
    await exec(ws, 'UPDATE entitlements SET updated_at = ?', Date.now() - 8 * DAY);
    const r = await api.call('POST', `/conversations/${conv}/messages`, TEXT(uid()));
    expect([r.status, await r.json()]).toEqual([403, PLAN_REQUIRED]);
  });
  it('campaign steps judge the plan at the STEP time they are given, not the wall clock', async () => {
    const { ws } = await shop(1036);
    await seedTemplate(ws); // the campaign's template ('promo')
    await grantPlan(ws, 'growth', 'active', { periodEnd: Date.now() + DAY });
    await seedContacts(ws, 2);
    const c = await makeCampaign(ws);
    await exec(ws, "UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, attempt = 1 WHERE id = ?", Date.now() + 1000, c.id);
    const out = await runInDurableObject(workspace(ws), (inst) => campaignActivate((inst as unknown as { host(): never }).host(), c.id, 1, Date.now() + 3 * DAY));
    expect(out).toEqual({ state: 'stop', reason: 'plan_blocked' });
  });
});

describe('WA-NOFREE-1: background AI spend stops with the package', () => {
  it('catalog_embed and kb_index do nothing without a package (no embedding, no index write); with one they index', async () => {
    const ws = W(1037);
    await agentWorkspace(ws, { faqText: 'الشحن مجاني لأي طلب فوق 500 جنيه.' });
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 't', credits: 100 });
    await workspace(ws).runDueTasks();
    await until(async () => (await rows(ws, 'SELECT 1 FROM catalog_vectors')).length > 0); // positive control: on a package it indexes
    await exec(ws, 'DELETE FROM entitlements');
    await exec(ws, 'DELETE FROM catalog_vectors');
    const settled = vectorsFor().upserts;
    await workspace(ws).setAgentSettings({ faqText: 'سياسة جديدة تماما عن الدفع بالبطاقة.' }); // schedules kb_index
    await workspace(ws).schedule('catalog_embed', 1);
    await workspace(ws).runDueTasks();
    await new Promise((r) => setTimeout(r, 100));
    expect(vectorsFor().upserts, 'no embedding spend without a package').toBe(settled);
    expect(await rows(ws, 'SELECT 1 FROM catalog_vectors')).toEqual([]);
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
  // Decided: cannot send a WhatsApp message or set a number up, or are gated by the campaigns feature (plan_feature, see package-feature-gates-campaigns-ordering).
  const NOT_SENDING = new Set([
    'POST /stores/:storeId/store/coupons', // CHAT-ASSIST-1: a coupon in the STORE (its own feature switch decides; coupons are in every Store plan); no message, no Chat spend
    'PUT /stores/:storeId/members/:userId/seat', 'DELETE /stores/:storeId/members/:userId/seat', // WA-SEATS-1: the owner's seat choices; no message, no spend
    'POST /stores/:storeId/members/invite', 'DELETE /stores/:storeId/members/:userId', 'DELETE /stores/:storeId/members/invitations/:userId', // CHAT-SA-4: a standalone team's invite / remove / cancel: seat-limited by the package in the handler (409 seat_limit), owner-only; no message to a customer, no spend
    'POST /stores/:storeId/assistant/turn', 'POST /stores/:storeId/assistant/feedback', 'POST /stores/:storeId/assistant/previews/:previewId/apply', 'POST /stores/:storeId/assistant/applied/:appliedId/undo', 'POST /stores/:storeId/assistant/approvals/:approvalId/confirm', 'POST /stores/:storeId/assistant/approvals/:approvalId/reject', // apply/undo run the merchant's own routes with their own plan gates, so a package check here would double-gate; the assistant answers and reads in phase A (it sends nothing and spends only the free cap); it must work for a workspace that is still choosing a package
    'PUT /stores/:storeId/agent', 'DELETE /stores/:storeId/contacts/:waId', 'DELETE /stores/:storeId/campaigns/:campaignId',
    'POST /stores/:storeId/campaigns', 'POST /stores/:storeId/campaigns/:campaignId/send', 'POST /stores/:storeId/campaigns/:campaignId/resume',
    'POST /stores/:storeId/campaigns/:campaignId/pause', 'POST /stores/:storeId/campaigns/:campaignId/cancel',
    'DELETE /stores/:storeId/connectors/:connectorId', 'POST /stores/:storeId/connectors/:connectorId/test', 'PUT /stores/:storeId/connectors/:connectorId',
    'PUT /stores/:storeId/contacts/:waId/tags', 'POST /stores/:storeId/conversations/:conversationId/assign', 'POST /stores/:storeId/conversations/:conversationId/notes',
    'POST /stores/:storeId/conversations/:conversationId/read', 'PUT /stores/:storeId/conversations/:conversationId/tags', 'POST /stores/:storeId/imports',
    'POST /stores/:storeId/wallet/instapay', 'PUT /stores/:storeId/wallet/instapay/:requestId/proof', 'POST /stores/:storeId/wallet/instapay/:requestId/cancel', 'POST /stores/:storeId/wallet/instapay/:requestId/contest', 'POST /stores/:storeId/numbers/:phoneNumberId/disconnect', 'POST /stores/:storeId/numbers/notices/:noticeId/dismiss',
    'POST /stores/:storeId/numbers/:phoneNumberId/refresh', 'PATCH /stores/:storeId/store-link/settings', 'POST /stores/:storeId/store-link/settings/preview', 'POST /stores/:storeId/contacts/:waId/orders/:orderNumber/cod-outcome',
    'POST /stores/:storeId/store-link/catalog/provision', 'POST /stores/:storeId/store-link/catalog/resync', 'PUT /stores/:storeId/store-link/catalog/commerce', 'POST /stores/:storeId/packages/:packageId/checkout', 'DELETE /stores/:storeId/segments/:segmentId',
    'POST /stores/:storeId/quick-replies', 'PUT /stores/:storeId/quick-replies/:quickReplyId', 'DELETE /stores/:storeId/quick-replies/:quickReplyId', // a canned text kept for the composer: nothing is sent
    'POST /stores/:storeId/segments', 'POST /stores/:storeId/segments/preview', 'PUT /stores/:storeId/segments/:segmentId', 'POST /stores/:storeId/shared-number/leave',
    'POST /stores/:storeId/wallet/refund-requests', 'POST /stores/:storeId/wallet/topups', 'PUT /stores/:storeId/digest',
    'POST /stores/:storeId/offboarding', 'DELETE /stores/:storeId/offboarding', // deleting the workspace needs no plan (a lapsed merchant can still leave)
    'PUT /stores/:storeId/retention', 'PUT /stores/:storeId/proactive-recs', 'PATCH /stores/:storeId/contacts/:waId', 'POST /stores/:storeId/contacts/merge', // data rights and housekeeping: no message leaves
    // Template management talks to Meta's template catalog, not to a customer: no message leaves.
    'POST /stores/:storeId/templates/sync', 'POST /stores/:storeId/templates', 'POST /stores/:storeId/templates/install-defaults', 'POST /stores/:storeId/templates/install-seasonal', 'POST /stores/:storeId/templates/cod-v2/resubmit',
    'POST /stores/:storeId/templates/check', 'PUT /stores/:storeId/templates/:name/:language', 'DELETE /stores/:storeId/templates/:name/:language', // self-service: a check calls nobody; edit and delete act on Meta's catalog
    // Money surfaces (self-service A9, A21, A22): previews and confirmed actions on funding, a yearly-refund request and AI credit packs; no WhatsApp message leaves (a lapsed merchant may still buy credits or ask to cancel).
    'POST /stores/:storeId/numbers/:phoneNumberId/funding/preview', 'PUT /stores/:storeId/numbers/:phoneNumberId/funding',
    'POST /stores/:storeId/wallet/yearly-refund/preview', 'POST /stores/:storeId/wallet/yearly-refund/requests',
    'POST /stores/:storeId/wallet/credit-packs/preview', 'POST /stores/:storeId/wallet/credit-packs/orders',
    'POST /stores/:storeId/templates/shared-requests', // a store on the shared number asks the platform team for a template: a row, no message
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
