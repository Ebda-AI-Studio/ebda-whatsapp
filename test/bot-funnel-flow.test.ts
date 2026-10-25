import { SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { buttonReply, catalogOrder, listReply, rawMessagePayload } from './helpers/payload';
import { WA_1, storeWorkspace, useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

useStoreLink();
const W = (n: number) => `00000000-0000-4000-8000-0000000071${String(n).padStart(2, '0')}`;
const WA_2 = '201009876543';
let seq = 0;
const wamid = () => `wamid.fn.${++seq}.${Date.now()}`;

async function setup(n: number) {
  const ws = W(n);
  const pn = await storeWorkspace(ws);
  await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = 0; });
  return { ws, pn };
}
async function say(ws: string, pn: string, message: Record<string, unknown>) {
  expect((await postWebhook(SELF, rawMessagePayload(pn, message))).status).toBe(200);
  await workspace(ws).runDueTasks();
}
const text = (t: string, from = WA_1) => ({ id: wamid(), from, type: 'text', text: { body: t } });
const tapList = (id: string) => listReply(wamid(), id, 'x');
const tapBtn = (id: string) => buttonReply('', wamid(), id, 'x');
const counts = async (ws: string) => Object.fromEntries((await rows<{ step: string; n: number }>(ws, 'SELECT step, count(*) AS n FROM bot_funnel_markers GROUP BY step')).map((r) => [r.step, r.n]));

/** hi -> pick v2 -> 2 -> checkout -> COD -> typed address -> order placed. */
async function orderCod(ws: string, pn: string, from = WA_1) {
  await say(ws, pn, text('hi', from));
  await say(ws, pn, { ...tapList('v:v2'), from });
  await say(ws, pn, { ...tapBtn('q:2'), from });
  await say(ws, pn, { ...tapBtn('cart:checkout'), from });
  await say(ws, pn, { ...tapBtn('pay:cod'), from });
  await say(ws, pn, text('المعادي، شارع 9 عمارة 4', from));
}

describe('bot funnel at the bot\'s transitions', () => {
  beforeEach(() => { stubGraph(); }); // per test: setup.ts restores every mock after each test

  it('each transition records its step once: conversation, browse, cart, checkout, order', async () => {
    const { ws, pn } = await setup(1);
    await say(ws, pn, text('hi'));
    expect(await counts(ws)).toEqual({ conversation: 1, browse: 1 });
    await say(ws, pn, tapList('v:v2'));
    expect(await counts(ws)).toEqual({ conversation: 1, browse: 1 }); // a quantity question is not a cart yet
    await say(ws, pn, tapBtn('q:2'));
    expect(await counts(ws)).toEqual({ conversation: 1, browse: 1, cart: 1 });
    await say(ws, pn, tapBtn('cart:checkout'));
    expect(await counts(ws)).toEqual({ conversation: 1, browse: 1, cart: 1, checkout: 1 });
    await say(ws, pn, tapBtn('pay:cod'));
    await say(ws, pn, text('المعادي، شارع 9 عمارة 4'));
    expect(await counts(ws)).toEqual({ conversation: 1, browse: 1, cart: 1, checkout: 1, order: 1 });
  });

  it('a customer who never gets to the end stops where they stopped, and another customer is counted separately', async () => {
    const { ws, pn } = await setup(2);
    await say(ws, pn, text('hi'));
    await say(ws, pn, text('hello', WA_2));
    await say(ws, pn, { ...tapList('v:v2'), from: WA_2 });
    await say(ws, pn, { ...tapBtn('q:1'), from: WA_2 });
    expect(await counts(ws)).toEqual({ conversation: 2, browse: 2, cart: 1 });
  });

  it('repeating a step, a Meta redelivery and a re-run task never count twice', async () => {
    const { ws, pn } = await setup(3);
    const hi = text('hi');
    await say(ws, pn, hi);
    await postWebhook(SELF, rawMessagePayload(pn, hi)); // Meta redelivers the same wamid
    await workspace(ws).runDueTasks();
    const [msg] = await rows<{ id: number }>(ws, "SELECT id FROM messages WHERE direction = 'in'");
    await workspace(ws).schedule('bot_turn', Date.now(), { messageId: msg!.id, wamid: 'x', from: WA_1, phoneNumberId: pn, profileName: null, type: 'text', text: 'hi', reply: null, order: null } as never);
    await workspace(ws).runDueTasks();
    await say(ws, pn, text('طلب جديد')); // browsing again the same day
    expect(await counts(ws)).toEqual({ conversation: 1, browse: 1 });
  });

  it('a whole order replayed after it completed leaves the counts as they were', async () => {
    const { ws, pn } = await setup(4);
    await orderCod(ws, pn);
    const before = await counts(ws);
    expect(before).toEqual({ conversation: 1, browse: 1, cart: 1, checkout: 1, order: 1 });
    await orderCod(ws, pn); // the same customer orders again the same day: still one customer at each step
    expect(await counts(ws)).toEqual(before);
  });

  it('a cart sent from Meta\'s catalog counts as a cart', async () => {
    const { ws, pn } = await setup(5);
    await say(ws, pn, catalogOrder(wamid(), [{ id: 'v2', qty: 1, price: 105 }]));
    expect(await counts(ws)).toMatchObject({ cart: 1 });
  });

  it('erasing the customer removes their markers', async () => {
    const { ws, pn } = await setup(6);
    await orderCod(ws, pn);
    await say(ws, pn, text('hello', WA_2));
    await workspace(ws).eraseContact(WA_1);
    expect(await counts(ws)).toEqual({ conversation: 1, browse: 1 });
  });

  it('the markers hold no phone number', async () => {
    const { ws, pn } = await setup(7);
    await orderCod(ws, pn);
    const dump = JSON.stringify(await rows(ws, 'SELECT * FROM bot_funnel_markers'));
    expect(dump).not.toContain(WA_1);
    expect(dump).not.toContain(WA_1.slice(2));
  });
});

describe('side steps: menu and handoff', () => {
  beforeEach(() => { stubGraph(); }); // per test: setup.ts restores every mock after each test
  const MENU = { enabled: true, items: [{ id: 'hours', title: { ar: 'مواعيد', en: 'Hours' }, answer: { ar: 'كل يوم', en: 'Daily' } }] };

  it('a service menu sent counts as menu, Talk to a person as handoff', async () => {
    const { ws, pn } = await setup(10);
    expect((await workspace(ws).setStoreLinkSettings({ menu: MENU } as never)).ok).toBe(true);
    await say(ws, pn, text('القائمة'));
    expect(await counts(ws)).toEqual({ conversation: 1, menu: 1 });
    await say(ws, pn, tapList('menu:ar:human'));
    expect(await counts(ws)).toEqual({ conversation: 1, menu: 1, handoff: 1 });
    await say(ws, pn, text('القائمة')); // the handoff silences the bot: not a new conversation, no menu
    expect(await counts(ws)).toEqual({ conversation: 1, menu: 1, handoff: 1 });
  });
});
