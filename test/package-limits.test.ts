import { createExecutionContext, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packageDto } from '../src/core/api/contract';
import { orderingActive } from '../src/core/ordering/bot';
import worker from '../src/index';
import { apiFor, apiKey, storeId as W, useApiKey } from './helpers/api';
import { holdAlarm, installWallet, makeCampaign, resetWallet, seedContacts, seedTemplate } from './helpers/campaigns';
import { mintClient } from './helpers/issuer';
import { storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, grantPlan, rows, workspace } from './helpers/workspace';

useApiKey();
afterEach(() => { vi.restoreAllMocks(); resetWallet(); });
const DAY = 86_400_000;

const BODY = { name: 'Eid', template: { name: 'promo', language: 'ar' }, params: [{ kind: 'name', fallback: 'x' }, { kind: 'text', value: '50%' }], audience: { criteria: { everyone: true } } };
async function campaignReady(n: number) {
  const ws = W(n);
  const api = await apiFor(ws);
  await seedTemplate(ws);
  await seedContacts(ws, 2);
  return { ws, api };
}

describe('seeded packages (migration 0014)', () => {
  it('has the approved prices, credits, members and features, exactly', async () => {
    const { results } = await env.DB.prepare('SELECT id, price_minor, ai_credits, max_members, feat_campaigns, feat_order_in_chat, feat_api, priority_support, active FROM packages WHERE id IN (?, ?, ?, ?) ORDER BY price_minor')
      .bind('store-included', 'starter', 'growth', 'pro').all();
    expect(results).toEqual([
      { id: 'store-included', price_minor: 0, ai_credits: 100, max_members: 2, feat_campaigns: 0, feat_order_in_chat: 0, feat_api: 0, priority_support: 0, active: 1 },
      { id: 'starter', price_minor: 69000, ai_credits: 300, max_members: 2, feat_campaigns: 0, feat_order_in_chat: 0, feat_api: 0, priority_support: 0, active: 1 },
      { id: 'growth', price_minor: 149000, ai_credits: 1500, max_members: 5, feat_campaigns: 1, feat_order_in_chat: 1, feat_api: 0, priority_support: 0, active: 1 },
      { id: 'pro', price_minor: 349000, ai_credits: 5000, max_members: 15, feat_campaigns: 1, feat_order_in_chat: 1, feat_api: 1, priority_support: 1, active: 1 },
    ]);
  });

  it('GET /packages lists starter, growth, pro with members, periodMonths and features in key order', async () => {
    const api = await apiFor(W(900));
    const r = await api.call('GET', '/packages');
    expect(r.status).toBe(200);
    const items = ((await r.json()) as { items: unknown[] }).items.map((p) => packageDto.parse(p));
    const by = Object.fromEntries(items.map((p) => [p.id, p]));
    expect(by.starter).toMatchObject({ priceMinor: 69000, aiCredits: 300, maxMembers: 2, periodMonths: 1, features: ['members', 'shared_inbox', 'order_confirmations', 'templates', 'ai_credits'] });
    expect(by.growth!.features).toEqual(['members', 'shared_inbox', 'order_confirmations', 'templates', 'campaigns', 'order_in_chat', 'ai_credits']);
    expect(by.pro).toMatchObject({ maxMembers: 15, features: ['members', 'shared_inbox', 'order_confirmations', 'templates', 'campaigns', 'order_in_chat', 'api', 'priority_support', 'ai_credits'] });
    expect(by['store-included']).toBeUndefined(); // free: not for sale
  });
});

describe('the entitlement event carries limits, deny by default', () => {
  it('an event without limits grants nothing and one seat', async () => {
    const ws = workspace(W(901));
    await ws.applyEntitlement({ version: 1, packageId: 'old', status: 'active', periodStart: Date.now() - DAY, periodEnd: Date.now() + DAY });
    for (const f of ['campaigns', 'order_in_chat', 'api'] as const) expect(await ws.planAllows(f)).toBe(false);
    expect(await ws.planMemberLimit()).toBe(1);
  });
  it('a lapsed status denies even a package that has the feature', async () => {
    const id = W(902);
    await grantPlan(id, 'pro');
    expect(await workspace(id).planAllows('api')).toBe(true);
    expect(await workspace(id).planMemberLimit()).toBe(15);
    await grantPlan(id, 'pro', 'past_due');
    expect(await workspace(id).planAllows('api')).toBe(false);
    expect(await workspace(id).planMemberLimit()).toBe(1);
  });
  it('the daily reconcile re-sending the SAME version refreshes limits on a copy written before limits existed', async () => {
    const id = W(903);
    const t = Date.now();
    const base = { version: 7, packageId: 'growth', status: 'active' as const, periodStart: t - DAY, periodEnd: t + DAY, aiCredits: 0 };
    await workspace(id).applyEntitlement(base);
    expect(await workspace(id).planAllows('campaigns')).toBe(false);
    expect(await workspace(id).applyEntitlement({ ...base, limits: { maxMembers: 5, campaigns: true, orderInChat: true, api: false, prioritySupport: false } })).toBe('stale');
    expect(await workspace(id).planAllows('campaigns')).toBe(true);
    // an old-format redelivery of that version does not wipe them
    await workspace(id).applyEntitlement(base);
    expect(await workspace(id).planAllows('campaigns')).toBe(true);
  });
});

describe('Review Focus 1: a workspace whose entitlement was never pushed is denied', () => {
  it('campaigns create / send / resume are 403 plan_feature, and nothing was created', async () => {
    const { ws, api } = await campaignReady(910);
    await exec(ws, 'DELETE FROM entitlements');
    for (const [m, p, b] of [['POST', '/campaigns', BODY], ['POST', `/campaigns/${crypto.randomUUID()}/send`, {}], ['POST', `/campaigns/${crypto.randomUUID()}/resume`, undefined]] as const) {
      const r = await api.call(m, p, b);
      expect([r.status, await r.json()], p).toEqual([403, { error: 'plan_feature', feature: 'campaigns' }]);
    }
    expect((await (await api.call('GET', '/campaigns')).json() as { items: unknown[] }).items).toEqual([]);
  });
  it('the ordering bot is off and the API is denied', async () => {
    const id = W(911);
    await apiFor(id);
    await exec(id, 'DELETE FROM entitlements');
    expect(await workspace(id).planAllows('order_in_chat')).toBe(false);
    expect(await workspace(id).planAllows('api')).toBe(false);
  });
});

describe('campaigns by package', () => {
  it('starter is refused, growth may create', async () => {
    const { ws, api } = await campaignReady(920);
    await grantPlan(ws, 'starter');
    const no = await api.call('POST', '/campaigns', BODY);
    expect([no.status, await no.json()]).toEqual([403, { error: 'plan_feature', feature: 'campaigns' }]);
    await grantPlan(ws, 'growth');
    expect((await api.call('POST', '/campaigns', BODY)).status).toBe(201);
  });
  it('reading and pausing / cancelling stay open on any plan', async () => {
    const { ws, api } = await campaignReady(921);
    await grantPlan(ws, 'starter');
    expect((await api.call('GET', '/campaigns')).status).toBe(200);
    expect((await api.call('POST', `/campaigns/${crypto.randomUUID()}/pause`)).status).toBe(404); // past the gate
    expect((await api.call('POST', `/campaigns/${crypto.randomUUID()}/cancel`)).status).toBe(404);
  });
});

describe('Review Focus 2: a downgrade while a campaign is mid-send', () => {
  it('the next page is refused (paused, plan_blocked), send / resume are 403, and nothing already queued or created is reversed', async () => {
    const ws = W(930);
    const api = await apiFor(ws);
    await holdAlarm(ws);
    await seedTemplate(ws);
    await seedContacts(ws, 4);
    installWallet({ perMessage: 100 });
    await grantPlan(ws, 'growth');
    const c = await makeCampaign(ws); // makeCampaign seeds the baseline plan first; growth is already newer-or-equal, so re-assert it
    await grantPlan(ws, 'growth');
    await exec(ws, "UPDATE campaigns SET status = 'running', started_at = 1, attempt = 1 WHERE id = ?", c.id);
    await runInDurableObject(workspace(ws), (inst) => { (inst as unknown as { campaignPageSize: number }).campaignPageSize = 2; });
    const first = await workspace(ws).campaignPage(c.id, 1, 0);
    expect(first).not.toMatchObject({ state: 'stop' }); // page 0 went out on growth
    const queued = await rows(ws, "SELECT count(*) AS n FROM messages WHERE idempotency_key LIKE 'camp:%'");
    await grantPlan(ws, 'starter'); // downgrade mid-send
    expect(await workspace(ws).campaignPage(c.id, 1, 1)).toEqual({ state: 'stop', reason: 'plan_blocked' });
    expect(await workspace(ws).getCampaign(c.id)).toMatchObject({ status: 'paused', pauseReason: 'plan_blocked' });
    expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE idempotency_key LIKE 'camp:%'")).toEqual(queued); // nothing more went out, nothing reversed
    for (const p of ['send', 'resume']) {
      const r = await api.call('POST', `/campaigns/${c.id}/${p}`, {});
      expect([r.status, ((await r.json()) as { error: string }).error], p).toEqual([403, 'plan_feature']);
    }
    expect(await workspace(ws).getCampaign(c.id)).toMatchObject({ name: 'Eid sale' }); // the campaign itself is kept
  });
});

describe('the ordering bot needs order_in_chat', () => {
  useStoreLink();
  it('orderingActive follows the plan: on with the baseline plan and growth, off on starter, on no entitlement and after a lapse', async () => {
    const id = W(940);
    await storeWorkspace(id);
    const active = () => runInDurableObject(workspace(id), (inst) => orderingActive((inst as unknown as { host(): Parameters<typeof orderingActive>[0] }).host()));
    expect(await active()).toBe(true); // every other switch is on, so this proves the plan is the only thing that can turn it off below
    await grantPlan(id, 'starter');
    expect(await active()).toBe(false);
    await grantPlan(id, 'growth');
    expect(await active()).toBe(true);
    await grantPlan(id, 'growth', 'past_due');
    expect(await active()).toBe(false);
    await exec(id, 'DELETE FROM entitlements');
    expect(await active()).toBe(false);
  });
});

describe('Review Focus 3: an integration token needs the api feature on EVERY route', () => {
  const live = { INTEGRATOR_TOKENS_ENABLED: 'true', ACCOUNTS: { isRevoked: async () => false } };
  const call = async (store: string, token: string, path: string) =>
    worker.fetch(new Request(`https://x/api/v1/stores/${store}${path}`, { headers: { authorization: `Bearer ${token}` } }), { ...env, ...live } as typeof env, createExecutionContext());
  const tok = (store: string) => mintClient(apiKey(), { storeId: store, scope: 'conversations:read contacts:read templates:read campaigns:read' });

  it('growth: 403 plan_feature api on GET /me and the data routes; pro: allowed', async () => {
    const store = W(950);
    await apiFor(store);
    await grantPlan(store, 'growth');
    const t = await tok(store);
    for (const p of ['/me', '/conversations', '/templates', '/contacts', '/campaigns']) {
      const r = await call(store, t, p);
      expect([r.status, await r.json()], p).toEqual([403, { error: 'plan_feature', feature: 'api' }]);
    }
    await grantPlan(store, 'pro');
    for (const p of ['/me', '/conversations', '/templates', '/contacts', '/campaigns']) expect((await call(store, t, p)).status, p).toBe(200);
  });
  it('a store whose entitlement was never pushed is denied, and a person token is unaffected', async () => {
    const store = W(951);
    const api = await apiFor(store);
    await exec(store, 'DELETE FROM entitlements');
    expect((await call(store, await tok(store), '/me')).status).toBe(403);
    expect((await api.call('GET', '/me')).status).toBe(200);
  });
});
