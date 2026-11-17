import { SELF, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { buttonReply, listReply, rawMessagePayload } from './helpers/payload';
import { BUYER_KEY_1, PHONE_1, WA_1, storeWorkspace, useStoreLink } from './helpers/store-link';
import { workspace } from './helpers/workspace';

// "نفس العنوان بتاع المرة اللي فاتت؟": the ordering flow asks a returning customer with a default address one question with two buttons (Ruling CHAT-AGENT-3).
const link = useStoreLink();
const W = (n: number) => `00000000-0000-4000-8000-0000000074${String(n).padStart(2, '0')}`;
let seq = 0;
const wamid = () => `wamid.addr.${++seq}.${Date.now()}`;
type Sent = { kind: string; body: Record<string, any> };
const sentOf = (g: ReturnType<typeof stubGraph>, pn: string, from = 0): Sent[] => g.calls.filter((c) => c.method === 'POST' && c.url.endsWith(`/${pn}/messages`) && c.body?.status !== 'read').slice(from).map((c) => {
  const b = c.body as Record<string, any>;
  return { kind: b.type === 'interactive' ? (b.interactive.type === 'list' ? 'list' : 'buttons') : b.type, body: b };
});
async function say(ws: string, pn: string, message: Record<string, unknown>, g: ReturnType<typeof stubGraph>) {
  const from = sentOf(g, pn).length;
  expect((await postWebhook(SELF, rawMessagePayload(pn, message))).status).toBe(200);
  await workspace(ws).runDueTasks();
  return sentOf(g, pn, from);
}
const text = (t: string) => ({ id: wamid(), from: WA_1, type: 'text', text: { body: t } });
const tapList = (id: string) => listReply(wamid(), id, 'x');
const tapBtn = (id: string) => buttonReply('', wamid(), id, 'x');
async function toPayment(ws: string, pn: string, g: ReturnType<typeof stubGraph>) {
  await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = 0; });
  await say(ws, pn, text('السلام عليكم'), g);
  await say(ws, pn, tapList('v:v2'), g);
  await say(ws, pn, tapBtn('q:2'), g);
  await say(ws, pn, tapBtn('cart:checkout'), g);
  return say(ws, pn, tapBtn('pay:cod'), g);
}
const saved = [{ id: 'a1', label: 'البيت', area: 'المعادي', street: 'شارع 9' }, { id: 'a2', label: null, area: 'الدقي', street: 'شارع 1' }];
const profile = (defaultId: string) => ({ firstName: 'منى', preferredLocale: 'ar' as const, defaultAddress: { id: defaultId, label: null, area: 'x', street: 'y', governorate: null, buildingNumber: null, notes: null }, recentOrders: [] });

describe('same address as last time', () => {
  it('a customer with a default address gets two buttons; "yes" orders to that address with no new address saved', async () => {
    const ws = W(1);
    const pn = await storeWorkspace(ws);
    link.fake.addresses.set(BUYER_KEY_1, saved);
    link.fake.profiles.set(PHONE_1, profile('a1'));
    const g = stubGraph();
    const ask = await toPayment(ws, pn, g);
    expect(ask).toHaveLength(1);
    expect(ask[0]!.kind).toBe('buttons');
    expect(ask[0]!.body.interactive.body.text).toBe('نفس العنوان بتاع المرة اللي فاتت؟\nشارع 9, المعادي');
    const buttons = ask[0]!.body.interactive.action.buttons as { reply: { id: string; title: string } }[];
    expect(buttons.map((b) => b.reply.id)).toEqual(['addr:a1', 'addr:new']);
    expect(buttons.map((b) => b.reply.title)).toEqual(['أيوه، نفس العنوان', 'عنوان تاني']);
    const done = await say(ws, pn, tapBtn('addr:a1'), g);
    expect(done[0]!.body.text.body).toContain('اتسجّل');
    expect((link.fake.lastCall('createOrderFromChat')[1] as { addressId: string }).addressId).toBe('a1');
    expect(link.fake.count('saveCustomerAddress')).toBe(0);
  });

  it('"a new address" asks for the typed address', async () => {
    const ws = W(2);
    const pn = await storeWorkspace(ws);
    link.fake.addresses.set(BUYER_KEY_1, saved);
    link.fake.profiles.set(PHONE_1, profile('a2'));
    const g = stubGraph();
    await toPayment(ws, pn, g);
    const next = await say(ws, pn, tapBtn('addr:new'), g);
    expect(next[0]!.kind).toBe('text');
    expect(next[0]!.body.text.body).toContain('عنوان التوصيل');
  });

  it('no profile (unknown customer, or the Store failed): the saved-address list as before', async () => {
    const ws = W(3);
    const pn = await storeWorkspace(ws);
    link.fake.addresses.set(BUYER_KEY_1, saved);
    const g = stubGraph();
    const ask = await toPayment(ws, pn, g);
    expect(ask[0]!.kind).toBe('list');
  });

  it('a default address that is not among the saved ones is never offered (no order to an address the Store did not list)', async () => {
    const ws = W(4);
    const pn = await storeWorkspace(ws);
    link.fake.addresses.set(BUYER_KEY_1, saved);
    link.fake.profiles.set(PHONE_1, profile('zzz'));
    const g = stubGraph();
    expect((await toPayment(ws, pn, g))[0]!.kind).toBe('list');
  });

  it('the English copy asks in English', async () => {
    const ws = W(5);
    const pn = await storeWorkspace(ws);
    link.fake.addresses.set(BUYER_KEY_1, saved);
    link.fake.profiles.set(PHONE_1, profile('a1'));
    const g = stubGraph();
    await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = 0; });
    await say(ws, pn, text('menu'), g);
    await say(ws, pn, tapList('v:v2'), g);
    await say(ws, pn, tapBtn('q:2'), g);
    await say(ws, pn, tapBtn('cart:checkout'), g);
    const ask = await say(ws, pn, tapBtn('pay:cod'), g);
    expect(ask[0]!.body.interactive.body.text).toMatch(/^(Same address as last time\?|نفس العنوان)/);
  });
});
