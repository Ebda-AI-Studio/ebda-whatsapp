import { beforeEach, describe, expect, it } from 'vitest';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { useApiKey } from './helpers/api';
import { CAT, freshMeta, graph } from './helpers/catalogue';
import { BUYER_KEY_1, WA_1, useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

/** Product recommendations in the Chat agent: what is suggested, to whom, how often, and what is never suggested. */
useApiKey();
const link = useStoreLink();
const agent = useAgent();
beforeEach(() => freshMeta());
const W = (n: number) => `00000000-0000-4000-8000-0000000061${String(n).padStart(2, '0')}`;
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0]) => (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;

async function shop(ws: string, settings: Record<string, unknown> = {}) {
  const pn = await agentWorkspace(ws, settings);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  await workspace(ws).setStoreLinkSettings({ catalogId: CAT }, { catalogWabaId: 'waba-1' });
  graph();
  await workspace(ws).schedule('catalog_reconcile', Date.now() - 1);
  await workspace(ws).runDueTasks(Date.now());
  return pn;
}
const rec = (args: Record<string, unknown>) => ({ name: 'recommend_products', arguments: args });
const retailerIdsIn = (out: { body: Record<string, any> }[]) => out.flatMap((s) => {
  const i = s.body.interactive as { type?: string; action?: Record<string, any> } | undefined;
  if (i?.type === 'product') return [i.action!.product_retailer_id as string];
  if (i?.type === 'product_list') return (i.action!.sections as { product_items: { product_retailer_id: string }[] }[]).flatMap((x) => x.product_items.map((p) => p.product_retailer_id));
  return [];
});
const lastTool = (m: ScriptedProvider) => JSON.parse((m.calls.at(-1)!.messages.at(-1) as { content: string }).content) as Record<string, any>;

describe('recommend_products', () => {
  it('"عايز حاجة شبه دي" (similar): cards for what the Store returns, priced by the Store', async () => {
    const id = W(1);
    const pn = await shop(id);
    link.fake.recs.v1 = ['v2', 'v3'];
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'دول قريبين منه 👇' }]);
    const out = await say(id, pn, text('عايز حاجة شبه v1 بس مختلفة'), graph());
    expect(retailerIdsIn(out)).toEqual(['v2', 'v3']);
    expect(link.fake.lastCall('getRecommendations')).toEqual([id, { seedIds: ['v1'], mode: 'similar', limit: 8 }]);
    expect(lastTool(m).products.map((p: { id: string; price: number }) => [p.id, p.price])).toEqual([['v2', 105], ['v3', 110]]);
  });

  it('Franco ("a3mel eh law el fostan khalas?") and Egyptian asks get the same plumbing; the persona stays in the prompt', async () => {
    const id = W(2);
    const pn = await shop(id, { persona: 'انتي مساعدة بتتكلم بالمصري وبتقولي يا فندم' });
    link.fake.recs.v1 = ['v4'];
    const m = model([{ tools: [rec({ basis: 'complement', productId: 'v1' })] }, { text: 'ممكن يعجبك ده كمان يا فندم' }]);
    const out = await say(id, pn, text('el fostan khalas, 3ayez 7aga tet7at ma3ah'), graph());
    expect(retailerIdsIn(out)).toEqual(['v4']);
    expect(m.calls[0]!.system).toContain('انتي مساعدة بتتكلم بالمصري');
    expect(m.calls[0]!.system).toContain('recommend_products');
    expect(m.calls[0]!.tools.map((t) => t.name)).toContain('recommend_products');
  });

  it('never recommends an out-of-stock, inactive or non-public product (the Store drops them; the agent re-checks stock)', async () => {
    const id = W(3);
    const pn = await shop(id);
    link.fake.recs.v1 = ['v2', 'v3', 'v4', 'v5'];
    link.fake.stock.v3 = 0; // out of stock
    link.fake.hidden.add('v4'); // inactive / private: the Store re-read drops it
    model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'تمام' }]);
    const out = await say(id, pn, text('حاجة شبهه'), graph());
    expect(retailerIdsIn(out)).toEqual(['v2', 'v5']);
  });

  it('when nothing is in stock it says so plainly and sends no cards', async () => {
    const id = W(4);
    const pn = await shop(id);
    link.fake.recs.v1 = ['v2'];
    link.fake.stock.v2 = 0;
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'مفيش حاجة شبهه متاحة دلوقتي' }]);
    const out = await say(id, pn, text('حاجة شبهه'), graph());
    expect(retailerIdsIn(out)).toEqual([]);
    expect(lastTool(m)).toMatchObject({ error: 'nothing_to_recommend' });
  });

  it('the tenant is the workspace store, never the model: a store id in the arguments is ignored', async () => {
    const id = W(5);
    const pn = await shop(id);
    link.fake.recs.v1 = ['v2'];
    model([{ tools: [rec({ basis: 'similar', productId: 'v1', storeId: '99999999-9999-4999-8999-999999999999', phoneE164: '+201111111111' })] }, { text: 'تمام' }]);
    await say(id, pn, text('حاجة شبهه'), graph());
    const [store, req] = link.fake.lastCall('getRecommendations') as [string, Record<string, unknown>];
    expect(store).toBe(id);
    expect(Object.keys(req).sort()).toEqual(['limit', 'mode', 'seedIds']);
  });

  it('a Store that refuses (not linked / unavailable) never leaks an error text to the customer path: the model gets store_unavailable', async () => {
    const id = W(6);
    const pn = await shop(id);
    link.fake.failNext.set('getRecommendations', 'unavailable');
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'هراجع وأرد عليك' }]);
    const out = await say(id, pn, text('حاجة شبهه'), graph());
    expect(retailerIdsIn(out)).toEqual([]);
    expect(lastTool(m)).toMatchObject({ error: 'store_unavailable' });
  });

  it('the merchant toggle: off means the tool is not offered and a forced call does nothing', async () => {
    const id = W(7);
    const pn = await shop(id, { recommendProducts: false });
    link.fake.recs.v1 = ['v2'];
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'تمام' }]);
    const out = await say(id, pn, text('حاجة شبهه'), graph());
    expect(m.calls[0]!.tools.map((t) => t.name)).not.toContain('recommend_products');
    expect(lastTool(m)).toMatchObject({ error: 'unavailable' });
    expect(retailerIdsIn(out)).toEqual([]);
    expect(link.fake.count('getRecommendations')).toBe(0);
  });

  it('is on by default for a workspace that never saved the setting', async () => {
    const id = W(8);
    const pn = await shop(id);
    expect((await rows<{ n: number }>(id, "SELECT count(*) AS n FROM agent_state WHERE key = 'setting.recommendProducts' AND value = '0'"))[0]!.n).toBe(0);
    model([{ text: 'تمام' }]);
    const m = agent.model as ScriptedProvider;
    await say(id, pn, text('اهلا'), graph());
    expect(m.calls[0]!.tools.map((t) => t.name)).toContain('recommend_products');
  });

  it('rations suggestions: three sets in 24 h, the fourth is refused; and the same product is never suggested twice', async () => {
    const id = W(9);
    const pn = await shop(id);
    link.fake.recs = { v1: ['v2'], v3: ['v4'], v5: ['v6'], v7: ['v8'] };
    const g = graph();
    const ask = (seed: string) => rec({ basis: 'similar', productId: seed });
    const m = model([
      { tools: [ask('v1')] }, { text: 'a' }, { tools: [ask('v1')] }, { text: 'b' }, // repeat: v2 was already suggested
      { tools: [ask('v3')] }, { text: 'c' }, { tools: [ask('v5')] }, { text: 'd' }, { tools: [ask('v7')] }, { text: 'e' },
    ]);
    expect(retailerIdsIn(await say(id, pn, text('1'), g))).toEqual(['v2']);
    expect(retailerIdsIn(await say(id, pn, text('2'), g))).toEqual([]);
    expect(lastTool(m)).toMatchObject({ error: 'nothing_to_recommend' });
    expect(retailerIdsIn(await say(id, pn, text('3'), g))).toEqual(['v4']);
    expect(retailerIdsIn(await say(id, pn, text('4'), g))).toEqual(['v6']);
    expect(retailerIdsIn(await say(id, pn, text('5'), g))).toEqual([]);
    expect(lastTool(m)).toMatchObject({ error: 'rate_limited' });
  });

  it('one set per turn: a second call in the same turn is refused', async () => {
    const id = W(10);
    const pn = await shop(id);
    link.fake.recs = { v1: ['v2'], v3: ['v4'] };
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' }), rec({ basis: 'similar', productId: 'v3' })] }, { text: 'تمام' }]);
    const out = await say(id, pn, text('حاجات'), graph());
    expect(retailerIdsIn(out)).toEqual(['v2']);
    const tools = m.calls[1]!.messages.filter((x) => x.role === 'tool').map((x) => (x as { content: string }).content);
    expect(tools[1]).toContain('already_recommended_this_turn');
  });

  it('after an order: seeds are the customer\'s own latest order, the key is derived from the chat', async () => {
    const id = W(11);
    const pn = await shop(id);
    const made = await link.fake.createOrderFromChat(id, { items: [{ variantId: 'v1', quantity: 1 }], buyer: { buyerKey: BUYER_KEY_1, phoneE164: `+${WA_1}`, name: null, locale: 'ar' }, paymentMethod: 'cod', idempotencyKey: 'idem-recs-1' });
    expect(made.ok).toBe(true);
    link.fake.recs.v1 = ['v5'];
    model([{ tools: [rec({ basis: 'after_order' })] }, { text: 'شكراً على طلبك، ده ممكن يعجبك 👇' }]);
    const out = await say(id, pn, text('شكرا على الاوردر'), graph());
    expect(retailerIdsIn(out)).toEqual(['v5']);
    expect(link.fake.lastCall('getRecommendations')).toEqual([id, expect.objectContaining({ mode: 'complement', buyerKey: BUYER_KEY_1, phoneE164: `+${WA_1}`, orderNumber: expect.any(String) })]);
  });

  it('after an order for a customer with no orders: no_order, nothing sent', async () => {
    const id = W(12);
    const pn = await shop(id);
    const m = model([{ tools: [rec({ basis: 'after_order' })] }, { text: 'تمام' }]);
    const out = await say(id, pn, text('thanks'), graph());
    expect(retailerIdsIn(out)).toEqual([]);
    expect(lastTool(m)).toMatchObject({ error: 'no_order' });
  });

  it('budget ("هدية تحت 105 جنيه"): searches the Store and keeps only in-stock items within the budget', async () => {
    const id = W(13);
    const pn = await shop(id);
    link.fake.stock.v1 = 0;
    model([{ tools: [rec({ basis: 'budget', query: 'item', maxPrice: 110 })] }, { text: 'دي في ميزانيتك' }]);
    const out = await say(id, pn, text('3ayez hadeya ta7t 110 geneh'), graph());
    expect(retailerIdsIn(out)).toEqual(['v2', 'v3']);
  });

  it('invalid arguments (similar without a product) come back as an error, not a crash', async () => {
    const id = W(14);
    const pn = await shop(id);
    const m = model([{ tools: [rec({ basis: 'similar' })] }, { text: 'تمام' }]);
    await say(id, pn, text('حاجة شبهه'), graph());
    expect(lastTool(m)).toMatchObject({ error: 'invalid_arguments' });
    expect(link.fake.count('getRecommendations')).toBe(0);
  });
});
