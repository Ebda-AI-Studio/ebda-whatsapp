import { SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { EBDA_ORDERING_COPY } from '../src/addons/ebda/store-copy';
import apiWorker, { apiRoutes } from '../src/index';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { holdAlarm, installWallet, makeCampaign, resetWallet, seedContacts, seedTemplate } from './helpers/campaigns';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { listReply, rawMessagePayload } from './helpers/payload';
import { WA_1, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, grantPlan, rows, workspace } from './helpers/workspace';

void apiWorker;
useApiKey();
useStoreLink();
afterEach(() => resetWallet());

async function ready(n: number, category: 'UTILITY' | 'MARKETING') {
  const ws = W(n);
  await apiFor(ws);
  await holdAlarm(ws);
  await seedTemplate(ws, { category });
  await seedContacts(ws, 4);
  installWallet({ perMessage: 100 });
  await grantPlan(ws, 'growth');
  const c = await makeCampaign(ws);
  return { ws, c };
}
const queued = (ws: string) => rows(ws, "SELECT count(*) AS n FROM messages WHERE idempotency_key LIKE 'camp:%'");

describe('the campaigns feature gates EVERY category and EVERY way a campaign runs', () => {
  it('a UTILITY campaign mid-send pauses with plan_blocked at its next page after a downgrade; nothing new is queued', async () => {
    const { ws, c } = await ready(960, 'UTILITY');
    expect(c.category).toBe('UTILITY');
    await exec(ws, "UPDATE campaigns SET status = 'running', started_at = 1, attempt = 1 WHERE id = ?", c.id);
    await runInDurableObject(workspace(ws), (inst) => { (inst as unknown as { campaignPageSize: number }).campaignPageSize = 2; });
    expect(await workspace(ws).campaignPage(c.id, 1, 0)).not.toMatchObject({ state: 'stop' });
    const before = await queued(ws);
    await grantPlan(ws, 'starter');
    expect(await workspace(ws).campaignPage(c.id, 1, 1)).toEqual({ state: 'stop', reason: 'plan_blocked' });
    expect(await workspace(ws).getCampaign(c.id)).toMatchObject({ status: 'paused', pauseReason: 'plan_blocked' });
    expect(await queued(ws)).toEqual(before);
  });

  it('a scheduled campaign does not become running when its time comes on a plan without campaigns', async () => {
    const { ws, c } = await ready(961, 'UTILITY');
    await exec(ws, "UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, attempt = 1 WHERE id = ?", Date.now() + 60_000, c.id);
    await grantPlan(ws, 'starter');
    expect(await workspace(ws).campaignActivate(c.id, 1)).toEqual({ state: 'stop', reason: 'plan_blocked' });
    expect(await workspace(ws).getCampaign(c.id)).toMatchObject({ status: 'paused', pauseReason: 'plan_blocked' });
    expect(await queued(ws)).toEqual([{ n: 0 }]);
  });

  it('the sweep parks (and never re-launches) a scheduled or running campaign on a plan without campaigns', async () => {
    const { ws, c } = await ready(962, 'UTILITY');
    await exec(ws, "UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, attempt = 1 WHERE id = ?", Date.now() + 60_000, c.id);
    await grantPlan(ws, 'starter');
    await workspace(ws).schedule('campaign_step', Date.now() - 1);
    await workspace(ws).runDueTasks();
    expect(await workspace(ws).getCampaign(c.id)).toMatchObject({ status: 'paused', pauseReason: 'plan_blocked' });
    expect((await rows<{ attempt: number }>(ws, 'SELECT attempt FROM campaigns'))[0]!.attempt).toBe(1); // not re-launched
  });

  // Every route that can start, send or resume a campaign must be refused without the feature. The walk enumerates the router, so a NEW campaign route
  // fails here until its author puts it in GATED (and gates it) or in SAFE (stopping / reading only).
  const GATED = new Set(['POST /stores/:storeId/campaigns', 'POST /stores/:storeId/campaigns/:campaignId/send', 'POST /stores/:storeId/campaigns/:campaignId/resume']);
  const SAFE = new Set(['POST /stores/:storeId/campaigns/:campaignId/pause', 'POST /stores/:storeId/campaigns/:campaignId/cancel']);
  const routes = (apiRoutes.routes as { method: string; path: string }[])
    .filter((r) => r.path.startsWith('/stores/:storeId/') && /campaign/i.test(r.path) && !['GET', 'HEAD', 'OPTIONS'].includes(r.method) && r.method !== 'DELETE')
    .map((r) => `${r.method} ${r.path}`);

  it('every campaign-mutating route is decided: gated or safe', () => {
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(routes.filter((r) => !GATED.has(r) && !SAFE.has(r)), 'campaign routes with no plan decision').toEqual([]);
    for (const g of GATED) expect(routes, g).toContain(g);
  });

  it.each([...GATED])('%s answers 403 plan_feature without the feature (a plan without it AND no entitlement)', async (route) => {
    const path = route.split(' ')[1]!.replace('/stores/:storeId', '').replace(':campaignId', crypto.randomUUID());
    for (const [i, plan] of (['starter', 'none'] as const).entries()) {
      const ws = W(970 + i + (route.length % 7) * 3 + (route.endsWith('send') ? 1 : route.endsWith('resume') ? 2 : 0) * 20);
      const api = await apiFor(ws);
      if (plan === 'none') await exec(ws, 'DELETE FROM entitlements'); else await grantPlan(ws, 'starter');
      const r = await api.call('POST', path, route.endsWith('/campaigns') ? { name: 'Eid', template: { name: 'promo', language: 'ar' }, params: [], audience: { criteria: { everyone: true } } } : {});
      expect([r.status, await r.json()], `${route} on ${plan}`).toEqual([403, { error: 'plan_feature', feature: 'campaigns' }]);
    }
  });
});

describe('ordering off: the customer is never left without a reply', () => {
  const MENU = { enabled: true, items: [{ id: 'hours', title: { ar: 'مواعيد الشغل', en: 'Opening hours' }, answer: { ar: 'بنفتح كل يوم.', en: 'Open daily.' } }] };
  let seq = 0;
  async function setup(n: number) {
    const ws = W(n);
    const pn = await storeWorkspace(ws);
    await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = 0; });
    expect((await workspace(ws).setStoreLinkSettings({ menu: MENU } as never)).ok).toBe(true);
    return { ws, pn };
  }
  const sentTo = (g: ReturnType<typeof stubGraph>, pn: string) => g.calls.filter((c) => c.method === 'POST' && c.url.endsWith(`/${pn}/messages`));
  async function say(ws: string, pn: string, message: Record<string, unknown>, g: ReturnType<typeof stubGraph>) {
    const from = sentTo(g, pn).length;
    expect((await postWebhook(SELF, rawMessagePayload(pn, message))).status).toBe(200);
    await workspace(ws).runDueTasks();
    return sentTo(g, pn).slice(from).map((c) => c.body as Record<string, any>);
  }
  const text = (t: string) => ({ id: `wamid.po.${++seq}.${Date.now()}`, from: WA_1, type: 'text', text: { body: t } });
  const isMenu = (b: Record<string, any>) => b.type === 'interactive' && b.interactive.type === 'list' && (b.interactive.action.sections[0].rows as { id: string }[]).every((r) => r.id.startsWith('menu:'));

  it('a customer mid-order whose plan lost order_in_chat gets the menu, not silence', async () => {
    const { ws, pn } = await setup(980);
    const g = stubGraph();
    await say(ws, pn, listReply(`wamid.po.${++seq}.${Date.now()}`, 'menu:ar:order', 'x'), g);
    await say(ws, pn, listReply(`wamid.po.${++seq}.${Date.now()}`, 'v:v2', 'x'), g);
    expect((await rows<{ state: string }>(ws, 'SELECT state FROM bot_sessions'))[0]!.state).not.toBe('idle');
    await grantPlan(ws, 'starter');
    const out = await say(ws, pn, text('كلام تاني'), g);
    expect(out.length).toBe(1);
    expect(isMenu(out[0]!)).toBe(true);
  });

  it('an ordering keyword on a plan without order_in_chat gets the menu, not silence', async () => {
    const { ws, pn } = await setup(981);
    const g = stubGraph();
    await grantPlan(ws, 'starter');
    const out = await say(ws, pn, text(EBDA_ORDERING_COPY.restartWords[0]!), g);
    expect(out.length).toBe(1);
    expect(isMenu(out[0]!)).toBe(true);
  });
});
