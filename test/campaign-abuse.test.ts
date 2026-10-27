import { afterEach, expect, it } from 'vitest';
import { NEW_WORKSPACE_CAP, configureNewWorkspaceCap } from '../src/core/campaigns/campaigns';
import { PN, makeCampaign, resetWallet, seedContacts, seedTemplate, setTier } from './helpers/campaigns';
import { storeId as W, useApiKey } from './helpers/api';
import { exec, own, rows, seedPlan, workspace } from './helpers/workspace';

// F5: a new workspace has a daily campaign cap, and every campaign passes a simple content guard.
useApiKey();
afterEach(() => resetWallet());
const DAY = 86_400_000;
const running = (ws: string, id: string) => exec(ws, "UPDATE campaigns SET status = 'running', started_at = 1, attempt = 1 WHERE id = ?", id);
const page = (ws: string, id: string, n: number) => workspace(ws).campaignPage(id, 1, n);

it('a new workspace queues at most the daily cap in any rolling 24 h, however big its tier', async () => {
  const prev = configureNewWorkspaceCap({ days: 14, perDay: 3 });
  try {
    const ws = W(8101);
    await seedTemplate(ws);
    await seedContacts(ws, 6);
    await setTier(ws, 1000);
    await own(ws);
    const c = await makeCampaign(ws);
    await running(ws, c.id);
    expect(await page(ws, c.id, 0)).toEqual({ state: 'next', count: 3 });
    const wait = await page(ws, c.id, 1);
    const first = (await rows<{ at: number }>(ws, 'SELECT min(at) AS at FROM campaign_recipients'))[0]!.at;
    expect(wait).toEqual({ state: 'wait', until: first + DAY + 1000 });
    await exec(ws, 'UPDATE campaign_recipients SET at = at - ?', DAY + 5000);
    expect(await page(ws, c.id, 1)).toMatchObject({ count: 3 }); // the next allowance
  } finally { configureNewWorkspaceCap(prev); }
});

it('the cap counts every campaign of the workspace together, and ends when the workspace is old enough', async () => {
  const prev = configureNewWorkspaceCap({ days: 14, perDay: 2 });
  try {
    const ws = W(8102);
    await seedTemplate(ws);
    await seedContacts(ws, 6);
    await setTier(ws, 1000);
    await own(ws);
    const a = await makeCampaign(ws);
    const b = await makeCampaign(ws);
    await running(ws, a.id);
    await running(ws, b.id);
    expect(await page(ws, a.id, 0)).toEqual({ state: 'next', count: 2 });
    expect((await page(ws, b.id, 0)).state).toBe('wait'); // the first campaign used the day's allowance
    await exec(ws, 'UPDATE _migrations SET applied_at = applied_at - ? WHERE version = 1', 15 * DAY); // the workspace is 15 days old
    expect((await page(ws, b.id, 0)).state).toBe('done'); // all 6 fit once the cap is lifted
  } finally { configureNewWorkspaceCap(prev); }
});

it('the default is 250 recipients a day for the first 14 days', () => expect(NEW_WORKSPACE_CAP).toEqual({ days: 14, perDay: 250 }));

const create = async (ws: string, params: unknown) => {
  await seedTemplate(ws);
  await seedContacts(ws, 2);
  await seedPlan(ws);
  return workspace(ws).createCampaign({ name: 'x', template: { name: 'promo', language: 'ar' }, params: params as never, audience: { criteria: { everyone: true } as never }, phoneNumberId: PN, actor: 'u1' });
};
const text = (t: string) => [{ kind: 'name', fallback: 'عميلنا' }, { kind: 'text', value: t }];

it('the content guard refuses link shorteners, raw-IP and plain-http links and scam patterns, with a reason code', async () => {
  const bad: [string, string][] = [
    ['عرض https://bit.ly/abc123', 'link_shortener'], ['go to tinyurl.com/x', 'link_shortener'], ['https://cutt.ly/zz', 'link_shortener'],
    ['https://203.0.113.9/win', 'link_ip'], ['http://shop.example.com/sale', 'link_not_https'], ['https://xn--pple-43d.com/id', 'link_punycode'],
    ['ضاعف أموالك مع الفوركس', 'pattern'], ['guaranteed profit with crypto signals', 'pattern'], ['ربح مضمون 100%', 'pattern'],
  ];
  let i = 0;
  for (const [t, why] of bad) {
    const r = await create(W(8110 + i++), text(t));
    expect(r, t).toMatchObject({ ok: false, reason: 'invalid_params', message: `content_blocked:${why}` });
  }
});

it('an ordinary offer with an https link is accepted (negative control)', async () => {
  const r = await create(W(8130), text('خصم 20% على كل المنتجات https://shop.example.com/sale'));
  expect(r.ok).toBe(true);
});
