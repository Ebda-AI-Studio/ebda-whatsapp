import { SELF, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { apiFor, storeId, useApiKey } from './helpers/api';
import { configureStoreLink } from '../src/core/store-link';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { FakeStore } from './helpers/fake-store';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { listReply, rawMessagePayload } from './helpers/payload';
import { WA_1, storeWorkspace, useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

const link = useStoreLink();
useApiKey();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000061${String(n).padStart(2, '0')}`;
let seq = 0;
const wamid = () => `wamid.menu.${++seq}.${Date.now()}`;

type Sent = { kind: string; body: Record<string, any> };
function sentOf(g: ReturnType<typeof stubGraph>, pn: string, from = 0): Sent[] {
  return g.calls.filter((c) => c.method === 'POST' && c.url.endsWith(`/${pn}/messages`)).slice(from).map((c) => {
    const b = c.body as Record<string, any>;
    return { kind: b.type === 'interactive' ? (b.interactive.type === 'list' ? 'list' : 'buttons') : b.type, body: b };
  });
}
async function say(ws: string, pn: string, message: Record<string, unknown>, g: ReturnType<typeof stubGraph>) {
  const from = sentOf(g, pn).length;
  expect((await postWebhook(SELF, rawMessagePayload(pn, message))).status).toBe(200);
  await workspace(ws).runDueTasks();
  return sentOf(g, pn, from);
}
const text = (t: string) => ({ id: wamid(), from: WA_1, type: 'text', text: { body: t } });
const tap = (id: string) => listReply(wamid(), id, 'x');
const rowsOf = (s: Sent) => s.body.interactive.action.sections[0].rows as { id: string; title: string; description?: string }[];

const MENU = {
  enabled: true,
  items: [
    { id: 'hours', title: { ar: 'مواعيد الشغل', en: 'Opening hours' }, answer: { ar: 'بنفتح كل يوم من ١٠ لـ ١٠.', en: 'We open every day from 10 to 10.' } },
    { id: 'delivery', title: { ar: 'التوصيل', en: 'Delivery' }, answer: { ar: 'التوصيل خلال يومين.', en: 'Delivery takes two days.' } },
  ],
};

async function setup(n: number, menu: unknown = MENU) {
  const ws = W(n);
  const pn = await storeWorkspace(ws);
  await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = 0; });
  if (menu) expect((await workspace(ws).setStoreLinkSettings({ menu } as never)).ok).toBe(true);
  return { ws, pn };
}

describe('service menu', () => {
  it('a greeting gets ONE list: order, the FAQ rows, talk to a person; limits respected', async () => {
    const { ws, pn } = await setup(1);
    const g = stubGraph();
    const out = await say(ws, pn, text('السلام عليكم'), g);
    expect(out.map((s) => s.kind)).toEqual(['list']);
    const r = rowsOf(out[0]!);
    expect(r.map((x) => x.id)).toEqual(['menu:ar:order', 'menu:ar:faq:hours', 'menu:ar:faq:delivery', 'menu:ar:human']);
    expect(r[1]!.title).toBe('مواعيد الشغل');
    for (const x of r) expect(Array.from(x.title).length).toBeLessThanOrEqual(24);
    expect(Array.from(out[0]!.body.interactive.action.button).length).toBeLessThanOrEqual(20);
  });

  it('the menu words and an unknown text while idle open the menu; an English customer gets English', async () => {
    const { ws, pn } = await setup(2);
    const g = stubGraph();
    expect((await say(ws, pn, text('القائمة'), g)).map((s) => s.kind)).toEqual(['list']);
    const en = await say(ws, pn, text('what do you sell around here'), g);
    expect(en.map((s) => s.kind)).toEqual(['list']);
    expect(rowsOf(en[0]!).map((x) => x.id)[1]).toBe('menu:en:faq:hours');
    expect(rowsOf(en[0]!)[1]!.title).toBe('Opening hours');
  });

  it('a tapped FAQ row gets its answer in the customer language, and nothing else', async () => {
    const { ws, pn } = await setup(3);
    const g = stubGraph();
    const ar = await say(ws, pn, tap('menu:ar:faq:hours'), g);
    expect(ar.map((s) => [s.kind, s.body.text?.body])).toEqual([['text', 'بنفتح كل يوم من ١٠ لـ ١٠.']]);
    const en = await say(ws, pn, tap('menu:en:faq:delivery'), g);
    expect(en.map((s) => [s.kind, s.body.text?.body])).toEqual([['text', 'Delivery takes two days.']]);
  });

  it('a row of an item the merchant has since removed shows the menu again', async () => {
    const { ws, pn } = await setup(4);
    const g = stubGraph();
    const out = await say(ws, pn, tap('menu:ar:faq:gone'), g);
    expect(out.map((s) => s.kind)).toEqual(['list']);
  });

  it('Talk to a person opens a handoff: tag, confirmation, then the bot stays silent', async () => {
    const { ws, pn } = await setup(5);
    const g = stubGraph();
    const out = await say(ws, pn, tap('menu:ar:human'), g);
    expect(out.map((s) => s.kind)).toEqual(['text']);
    expect(await rows(ws, 'SELECT reason FROM agent_handoffs')).toEqual([{ reason: 'asked' }]);
    expect(await rows(ws, "SELECT 1 FROM conversation_tags WHERE tag = 'needs_human'")).toHaveLength(1);
    expect(await say(ws, pn, text('hello?'), g)).toEqual([]);
  });

  it('the Order row opens the existing catalog flow', async () => {
    const { ws, pn } = await setup(6);
    const g = stubGraph();
    const out = await say(ws, pn, tap('menu:ar:order'), g);
    expect(out.at(-1)!.kind).toBe('list');
    expect(rowsOf(out.at(-1)!)[0]!.id).toBe('v:v1');
  });

  it('without a Store the Order row is not offered', async () => {
    const { ws, pn } = await setup(7);
    configureStoreLink({ bridge: () => null });
    const g = stubGraph();
    const out = await say(ws, pn, text('مرحبا'), g);
    expect(rowsOf(out[0]!).map((x) => x.id)).toEqual(['menu:ar:faq:hours', 'menu:ar:faq:delivery', 'menu:ar:human']);
  });

  it('mid-order, free text stays with the ordering bot (the menu does not hijack it)', async () => {
    const { ws, pn } = await setup(8);
    const g = stubGraph();
    await say(ws, pn, tap('menu:ar:order'), g);
    await say(ws, pn, tap('v:v2'), g); // choosing a quantity
    const out = await say(ws, pn, text('كلام تاني'), g);
    expect(out.some((s) => s.kind === 'list' && rowsOf(s)[0]!.id.startsWith('menu:'))).toBe(false);
    expect(out[0]!.body.text?.body ?? out[0]!.body.interactive?.body?.text).toBeTruthy();
  });

  it('keeps the list within 10 rows when the FAQ is full', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, title: { ar: `سؤال ${i}`, en: `Q ${i}` }, answer: { ar: 'تمام', en: 'ok' } }));
    const { ws, pn } = await setup(9, { enabled: true, items });
    const g = stubGraph();
    const r = rowsOf((await say(ws, pn, text('مرحبا'), g))[0]!);
    expect(r.length).toBeLessThanOrEqual(10);
    expect(r[0]!.id).toBe('menu:ar:order');
    expect(r.at(-1)!.id).toBe('menu:ar:human');
  });

  it('disabled or empty menu behaves exactly as before: the greeting opens the catalog', async () => {
    for (const [n, menu] of [[10, { enabled: false, items: MENU.items }], [11, { enabled: true, items: [] }], [12, null]] as const) {
      const { ws, pn } = await setup(n, menu);
      const g = stubGraph();
      const out = await say(ws, pn, text('hi'), g);
      expect(out.map((s) => s.kind)).toEqual(['text', ...Array(9).fill('image'), 'list']);
      expect(rowsOf(out.at(-1)!)[0]!.id).toBe('v:v1');
    }
  });
});

describe('service menu with the AI agent on', () => {
  it('the menu word opens the menu without asking the model; free text still goes to the agent', async () => {
    const { ws, pn } = await setup(13);
    expect((await workspace(ws).setAgentSettings({ enabled: true })).ok).toBe(true);
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 100 });
    const model = (agent.model = new ScriptedProvider([{ text: 'أهلاً، أقدر أساعدك إزاي؟' }])) as ScriptedProvider;
    const g = stubGraph();
    expect((await say(ws, pn, text('القائمة'), g)).map((s) => s.kind)).toEqual(['list']);
    expect(model.calls).toHaveLength(0);
    const out = await say(ws, pn, text('عندكم ورد؟'), g);
    expect(out.map((s) => s.body.text?.body)).toEqual(['أهلاً، أقدر أساعدك إزاي؟']);
    expect(model.calls).toHaveLength(1);
  });
});

describe('service menu settings route', () => {
  const item = (over: Record<string, unknown> = {}) => ({ id: 'a', title: { ar: 'س', en: 'Q' }, answer: { ar: 'ج', en: 'A' }, ...over });
  it('saves a valid menu for the owner, refuses staff, and holds Meta limits at the edge', async () => {
    const id = storeId(6101);
    const owner = await apiFor(id);
    const staff = await apiFor(id, 'staff');
    const ok = await owner.call('PATCH', '/store-link/settings', { menu: { enabled: true, items: [item()] } });
    expect(ok.status).toBe(200);
    expect((await (await owner.call('GET', '/store-link/settings')).json() as any).menu.items).toHaveLength(1);
    expect((await staff.call('PATCH', '/store-link/settings', { menu: { enabled: false, items: [] } })).status).toBe(403);
    const bad = (menu: unknown) => owner.call('PATCH', '/store-link/settings', { menu }).then((r) => r.status);
    expect(await bad({ enabled: true, items: [item({ title: { ar: 'س'.repeat(25), en: 'Q' } })] })).toBe(400);
    expect(await bad({ enabled: true, items: [item({ answer: { ar: 'ج'.repeat(1025), en: 'A' } })] })).toBe(400);
    expect(await bad({ enabled: true, items: Array.from({ length: 9 }, (_, i) => item({ id: `i${i}` })) })).toBe(400);
    expect(await bad({ enabled: true, items: [item(), item()] })).toBe(400); // duplicate id
    expect(await bad({ enabled: true, items: [item({ id: 'Bad Id' })] })).toBe(400);
    expect(await bad({ enabled: true, items: [item({ title: { ar: '', en: 'Q' } })] })).toBe(400);
  });
});
