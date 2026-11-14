import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { EBDA_ORDERING_COPY } from '../src/addons/ebda/store-copy';
import { sendCatalogMessage, sendProduct, sendProductList } from '../src/core/meta/client';
import { sendJobSchema } from '../src/core/send-queue';
import { buildCatalogCard, buildProductCards, type CardRow } from '../src/core/store-link/product-cards';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, sentOf, text } from './helpers/agent-chat';
import { CAT, freshMeta, graph, row } from './helpers/catalogue';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { buttonReply, catalogOrder, listReply, rawMessagePayload } from './helpers/payload';
import { useApiKey } from './helpers/api';
import { WA_1, useStoreLink } from './helpers/store-link';
import { FakeStore } from './helpers/fake-store';
import { rows, workspace } from './helpers/workspace';

/** The store inside WhatsApp: product cards from the agent, the catalogue button, and a cart that becomes one real order. */
useApiKey();
const link = useStoreLink();
const agent = useAgent();
beforeEach(() => freshMeta());
const W = (n: number) => `00000000-0000-4000-8000-0000000047${String(n).padStart(2, '0')}`;
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0]) => (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;
let seq = 0;
const wm = () => `wamid.cat.${++seq}.${Date.now()}`;

/** A workspace whose catalogue is connected and filled (the first pass ran), the agent on with credits. */
async function shop(ws: string, opts: { connect?: boolean } = {}) {
  const pn = await agentWorkspace(ws);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  if (opts.connect !== false) {
    await workspace(ws).setStoreLinkSettings({ catalogId: CAT }, { catalogWabaId: 'waba-1' });
    graph();
    await workspace(ws).schedule('catalog_reconcile', Date.now() - 1);
    await workspace(ws).runDueTasks(Date.now());
  }
  return pn;
}
const search = (q: string) => ({ name: 'search_catalog', arguments: { query: q } });
const show = (...ids: string[]) => ({ name: 'show_products', arguments: { ids } });
const interactive = (s: { body: Record<string, any> }) => s.body.interactive as Record<string, any>;

describe('the agent sends product cards', () => {
  it('one product: the reply text, then a product card from the connected catalogue (catalog_id + the retailer id)', async () => {
    const ws = W(1);
    const pn = await shop(ws);
    model([{ tools: [search('item v3')] }, { tools: [show('v3')] }, { text: 'ده الموديل اللي سألت عليه 👇' }]);
    const g = graph();
    const out = await say(ws, pn, text('عايز أشوف item v3'), g);
    expect(out.map((s) => s.kind === 'buttons' ? interactive(s).type : s.kind)).toEqual(['text', 'product']);
    expect(out[0]!.text).toBe('ده الموديل اللي سألت عليه 👇');
    expect(interactive(out[1]!)).toMatchObject({ type: 'product', action: { catalog_id: CAT, product_retailer_id: 'v3' } });
    expect(interactive(out[1]!).body.text).toContain('Item 3 (ع)');
    const stored = await rows<{ type: string; author: string }>(ws, "SELECT type, author FROM messages WHERE direction = 'out' ORDER BY id");
    expect(stored).toEqual([{ type: 'text', author: 'agent' }, { type: 'interactive', author: 'agent' }]);
    expect(await rows(ws, "SELECT 1 FROM agent_state WHERE key LIKE 'cards:%'")).toEqual([]); // nothing of the card is kept once it left
  });

  it('several products: one multi-product message with a text header and the ids in a section', async () => {
    const ws = W(2);
    const pn = await shop(ws);
    model([{ tools: [show('v1', 'v2', 'v3')] }, { text: 'دول أقرب ٣ اختيارات' }]);
    const out = await say(ws, pn, text('عايز أشوف اختياراتكم'), graph());
    const list = interactive(out.find((s) => s.body.interactive?.type === 'product_list')!);
    expect(list.header).toEqual({ type: 'text', text: expect.any(String) });
    expect(list.action.catalog_id).toBe(CAT);
    expect(list.action.sections).toHaveLength(1);
    expect(list.action.sections[0].product_items).toEqual([{ product_retailer_id: 'v1' }, { product_retailer_id: 'v2' }, { product_retailer_id: 'v3' }]);
  });

  it('a product that is out of stock gets no card (the model is told)', async () => {
    const ws = W(3);
    const pn = await shop(ws);
    link.fake.stock['v3'] = 0;
    const m = model([{ tools: [show('v3')] }, { text: 'للأسف الموديل ده خلص' }]);
    const out = await say(ws, pn, text('عايز item 3'), graph());
    expect(out.map((s) => s.kind)).toEqual(['text']);
    expect(JSON.parse((m.calls[1]!.messages.at(-1) as { content: string }).content)).toEqual({ error: 'not_available' });
  });

  it('no catalogue connected: the model gets the products with their links and answers in text; nothing interactive is sent', async () => {
    const ws = W(4);
    const pn = await shop(ws, { connect: false });
    const m = model([{ tools: [show('v3')] }, { text: 'Item 3 بسعر 110 جنيه: https://shop.example/p/p3' }]);
    const out = await say(ws, pn, text('عايز item 3'), graph());
    expect(out.map((s) => s.kind)).toEqual(['text']);
    expect(out[0]!.text).toContain('https://shop.example/p/p3'); // the link came from the tool result, so the reply guard lets it through
    expect(JSON.parse((m.calls[1]!.messages.at(-1) as { content: string }).content)).toMatchObject({ cards_unavailable: true, products: [{ id: 'v3', link: 'https://shop.example/p/p3' }] });
  });

  it('a product Meta does not have yet (left out of the catalogue: no picture) falls back to text', async () => {
    link.fake = new FakeStore('*', { catalog: [row('v1', 'p1', { imageUrl: null }), row('v2', 'p2')] });
    const ws = W(5);
    const pn = await shop(ws);
    const m = model([{ tools: [show('v1')] }, { text: 'تمام' }]);
    const out = await say(ws, pn, text('v1'), graph());
    expect(out.map((s) => s.kind)).toEqual(['text']);
    expect(JSON.parse((m.calls[1]!.messages.at(-1) as { content: string }).content)).toMatchObject({ cards_unavailable: true });
  });

  it('open_catalog sends the catalogue message with a thumbnail from the catalogue', async () => {
    const ws = W(6);
    const pn = await shop(ws);
    model([{ tools: [{ name: 'open_catalog', arguments: {} }] }, { text: 'دي كل منتجاتنا' }]);
    const out = await say(ws, pn, text('عندكم إيه؟'), graph());
    const cat = interactive(out.find((s) => s.body.interactive?.type === 'catalog_message')!);
    expect(cat.action.name).toBe('catalog_message');
    expect(cat.action.parameters.thumbnail_product_retailer_id).toEqual(expect.stringMatching(/^v\d+$/));
    expect(cat.body.text.length).toBeLessThanOrEqual(1024);
    expect(cat.footer.text.length).toBeLessThanOrEqual(60);
  });

  it('open_catalog without a catalogue answers catalogue_unavailable', async () => {
    const ws = W(7);
    const pn = await shop(ws, { connect: false });
    const m = model([{ tools: [{ name: 'open_catalog', arguments: {} }] }, { text: 'تعالى نكمل هنا' }]);
    const out = await say(ws, pn, text('عندكم إيه؟'), graph());
    expect(out.map((s) => s.kind)).toEqual(['text']);
    expect(JSON.parse((m.calls[1]!.messages.at(-1) as { content: string }).content)).toEqual({ error: 'catalogue_unavailable' });
  });
});

describe('product message builders and senders obey Meta\'s limits', () => {
  const rowsOf = (n: number, variantsEach = 1): CardRow[] => Array.from({ length: n }, (_, i) => Array.from({ length: variantsEach }, (_, j) => ({
    retailerId: `r${i}-${j}`, productId: `p${i}`, title: `Product number ${i} with a rather long name`, titleAr: `منتج رقم ${i} باسم طويل جداً جداً جداً`, priceMinor: 12_345, currency: 'EGP',
  }))).flat();
  const built = (r: CardRow[], l: 'ar' | 'en' = 'ar') => buildProductCards(r, CAT, EBDA_ORDERING_COPY, l);
  const itemsOf = (b: ReturnType<typeof built>) => b.flatMap((c) => (c.spec.kind === 'product_list' ? c.spec.productList.sections.flatMap((s) => s.retailerIds) : []));

  it('one row is a product card; none is nothing', () => {
    expect(built([])).toEqual([]);
    const [c] = built(rowsOf(1));
    expect(c!.spec).toMatchObject({ kind: 'product', product: { catalogId: CAT, retailerId: 'r0-0' } });
  });

  it('never more than 30 products: 45 rows are cut to 30, in order', () => {
    const b = built(rowsOf(45));
    expect(b).toHaveLength(1);
    expect(itemsOf(b)).toEqual(rowsOf(30).map((r) => r.retailerId));
  });

  it('never more than 10 sections: 14 products of 2 variants each are grouped into at most 10, and at most 30 items', () => {
    const b = built(rowsOf(14, 2));
    const spec = b[0]!.spec;
    if (spec.kind !== 'product_list') throw new Error('expected a list');
    expect(spec.productList.sections.length).toBeLessThanOrEqual(10);
    expect(itemsOf(b).length).toBe(28);
    expect(sendJobSchema.safeParse({ workspaceId: 'w', phoneNumberId: 'p', to: 't', idempotencyKey: 'k', kind: 'product_list', productList: spec.productList }).success).toBe(true);
  });

  it('variants of one product share a section titled with the product; titles stay within 24 characters, the header within 60', () => {
    const b = built(rowsOf(3, 2));
    const spec = b[0]!.spec;
    if (spec.kind !== 'product_list') throw new Error('expected a list');
    expect(spec.productList.sections).toHaveLength(3);
    for (const s of spec.productList.sections) expect(Array.from(s.title).length).toBeLessThanOrEqual(24);
    expect(Array.from(spec.productList.header).length).toBeLessThanOrEqual(60);
  });

  it('the send job schema refuses what Meta refuses: 31 items, 11 sections, a long section title, a missing header', () => {
    const base = { workspaceId: 'w', phoneNumberId: 'p', to: 't', idempotencyKey: 'k', kind: 'product_list' as const };
    const ok = { catalogId: CAT, header: 'h', body: 'b', sections: [{ title: 't', retailerIds: ['a'] }] };
    expect(sendJobSchema.safeParse({ ...base, productList: ok }).success).toBe(true);
    expect(sendJobSchema.safeParse({ ...base, productList: { ...ok, sections: [{ title: 't', retailerIds: Array.from({ length: 31 }, (_, i) => `r${i}`) }] } }).success).toBe(false);
    expect(sendJobSchema.safeParse({ ...base, productList: { ...ok, sections: Array.from({ length: 11 }, (_, i) => ({ title: `s${i}`, retailerIds: [`r${i}`] })) } }).success).toBe(false);
    expect(sendJobSchema.safeParse({ ...base, productList: { ...ok, sections: [{ title: 'x'.repeat(25), retailerIds: ['a'] }] } }).success).toBe(false);
    expect(sendJobSchema.safeParse({ ...base, productList: { ...ok, header: '' } }).success).toBe(false);
    expect(sendJobSchema.safeParse({ ...base, kind: 'product' }).success).toBe(false); // a product job without its payload
  });

  it('the senders put exactly the documented JSON on the wire', async () => {
    const g = stubGraph();
    const base = { token: 't', graphVersion: 'v25.0', phoneNumberId: 'pn1', to: '2010' };
    await sendProduct({ ...base, catalogId: CAT, retailerId: 'sku1', body: 'b', footer: 'f' });
    await sendProductList({ ...base, catalogId: CAT, header: 'h', body: 'b', sections: [{ title: 's', retailerIds: ['a', 'b'] }] });
    await sendCatalogMessage({ ...base, body: 'b', footer: 'f', thumbnailRetailerId: 'sku1' });
    const [p, l, c] = g.calls.map((x) => x.body);
    expect(p).toMatchObject({ messaging_product: 'whatsapp', type: 'interactive', interactive: { type: 'product', body: { text: 'b' }, footer: { text: 'f' }, action: { catalog_id: CAT, product_retailer_id: 'sku1' } } });
    expect(l.interactive).toEqual({ type: 'product_list', header: { type: 'text', text: 'h' }, body: { text: 'b' }, action: { catalog_id: CAT, sections: [{ title: 's', product_items: [{ product_retailer_id: 'a' }, { product_retailer_id: 'b' }] }] } });
    expect(c.interactive).toEqual({ type: 'catalog_message', body: { text: 'b' }, action: { name: 'catalog_message', parameters: { thumbnail_product_retailer_id: 'sku1' } }, footer: { text: 'f' } });
  });

  it('the catalogue card has a body of at most 1024 and a footer of at most 60 characters in both languages', () => {
    for (const l of ['ar', 'en'] as const) {
      const c = buildCatalogCard(EBDA_ORDERING_COPY, l, 'sku');
      if (c.spec.kind !== 'catalog') throw new Error('x');
      expect(c.spec.catalog.body.length).toBeLessThanOrEqual(1024);
      expect(c.spec.catalog.footer!.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('a cart sent from the catalogue becomes one real Store order', () => {
  const tapBtn = (id: string) => buttonReply('', wm(), id, 'x');
  const tapList = (id: string) => listReply(wm(), id, 'x');
  const body = (s: { body: Record<string, any> }) => JSON.stringify(s.body);

  async function cartShop(n: number) {
    const ws = W(n);
    const pn = await shop(ws);
    return { ws, pn, g: graph() };
  }

  it('prices, stock and existence come from the Store: unknown and sold-out lines are dropped with a message, stale prices are replaced', async () => {
    const { ws, pn, g } = await cartShop(20);
    link.fake.stock['v2'] = 0;
    const out = await say(ws, pn, catalogOrder(wm(), [{ id: 'v1', qty: 2, price: 90 }, { id: 'v2', qty: 1, price: 105 }, { id: 'ghost', qty: 1, price: 1 }], WA_1, CAT), g);
    const all = out.map(body).join('\n');
    expect(all).toContain('خلصوا من المخزون');
    expect(all).toContain('Item v1'.replace('Item v1', 'Item 1 (ع)'));
    expect(all).toContain('مبقاش متاح'); // the unknown id
    expect(all).toContain('الأسعار اتحدثت'); // Meta said 90.00, the Store says 100.00
    const summary = out.at(-1)!;
    expect(summary.body.interactive.body.text).toContain('2 × Item 1 (ع)');
    expect(summary.body.interactive.body.text).toContain('200 جنيه');
    expect(summary.body.interactive.body.text).not.toContain('ghost');
  });

  it('a cart whose lines are all gone says so and offers no checkout', async () => {
    const { ws, pn, g } = await cartShop(21);
    const out = await say(ws, pn, catalogOrder(wm(), [{ id: 'ghost', qty: 1, price: 1 }], WA_1, CAT), g);
    expect(out.map(body).join('\n')).toContain('مبقتش متاحة');
    expect(out.some((s) => s.body.interactive?.action?.buttons)).toBe(false);
  });

  it('a cart from another catalogue is not read (its ids could collide with ours)', async () => {
    const { ws, pn, g } = await cartShop(22);
    const out = await say(ws, pn, catalogOrder(wm(), [{ id: 'v1', qty: 1, price: 100 }], WA_1, '999999999'), g);
    expect(link.fake.count('getProducts')).toBe(0);
    expect(out.map(body).join('\n')).toContain('مبقتش متاحة');
  });

  it('cart -> checkout -> COD -> address -> a real order priced by the Store, confirmed to the customer', async () => {
    const { ws, pn, g } = await cartShop(23);
    const cartMsg = wm();
    await say(ws, pn, catalogOrder(cartMsg, [{ id: 'v1', qty: 2, price: 100 }, { id: 'v5', qty: 1, price: 99 }], WA_1, CAT), g);
    await say(ws, pn, tapBtn('cart:checkout'), g);
    await say(ws, pn, tapBtn('pay:cod'), g);
    const done = await say(ws, pn, text('المعادي، شارع 9 عمارة 4'), g);
    expect(done.map(body).join('\n')).toContain('اتسجّل');
    const req = link.fake.lastCall('createOrderFromChat')[1] as { items: unknown[]; idempotencyKey: string };
    expect(req.items).toEqual([{ variantId: 'v1', quantity: 2 }, { variantId: 'v5', quantity: 1 }]);
    expect(req.idempotencyKey).toBe(`bot:${ws}:cart:${cartMsg}`); // derived from the cart message, never random
    expect(link.fake.orders.size).toBe(1);
    expect([...link.fake.orders.values()][0]!.totalMinor).toBe(2 * 10_000 + 12_000); // v5 costs 120.00 in the Store, not Meta's 99
  });

  it('webhook replay: the same order message delivered twice is one cart and, once checked out, one order', async () => {
    const { ws, pn, g } = await cartShop(24);
    const cartMsg = wm();
    const msg = catalogOrder(cartMsg, [{ id: 'v1', qty: 1, price: 100 }], WA_1, CAT);
    const first = await say(ws, pn, msg, g);
    const again = await say(ws, pn, msg, g); // Meta redelivers the same wamid
    expect(first.some((s) => s.body.interactive?.action?.buttons)).toBe(true);
    expect(again).toEqual([]); // nothing is sent twice
    await say(ws, pn, tapBtn('cart:checkout'), g);
    await say(ws, pn, tapBtn('pay:cod'), g);
    await say(ws, pn, text('المعادي، شارع 9 عمارة 4'), g);
    expect(link.fake.orders.size).toBe(1);
    // a replay of the order message AFTER the order was placed starts nothing
    expect(await say(ws, pn, msg, g)).toEqual([]);
    expect(link.fake.orders.size).toBe(1);
  });

  it('the order key is stable across a retried placement: the Store returns the same order for the same cart message', async () => {
    const { ws, pn, g } = await cartShop(25);
    await say(ws, pn, catalogOrder(wm(), [{ id: 'v1', qty: 1, price: 100 }], WA_1, CAT), g);
    await say(ws, pn, tapBtn('cart:checkout'), g);
    await say(ws, pn, tapBtn('pay:cod'), g);
    link.fake.failNext.set('createOrderFromChat', 'unavailable');
    await say(ws, pn, text('المعادي، شارع 9 عمارة 4'), g); // the Store is down: nothing placed
    expect(link.fake.orders.size).toBe(0);
    await say(ws, pn, text('المعادي، شارع 9 عمارة 4'), g);
    expect(link.fake.orders.size).toBe(1);
    const keys = link.fake.calls.filter((c) => c.method === 'createOrderFromChat').map((c) => (c.args[1] as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('an item sold out between the cart and the order is removed by the Store\'s answer, with a clear message', async () => {
    const { ws, pn, g } = await cartShop(26);
    await say(ws, pn, catalogOrder(wm(), [{ id: 'v1', qty: 1, price: 100 }, { id: 'v5', qty: 1, price: 120 }], WA_1, CAT), g);
    await say(ws, pn, tapBtn('cart:checkout'), g);
    await say(ws, pn, tapBtn('pay:cod'), g);
    link.fake.stock['v5'] = 0; // sold out while the customer typed the address
    const out = await say(ws, pn, text('المعادي، شارع 9 عمارة 4'), g);
    expect(out.map(body).join('\n')).toContain('خلصوا من المخزون');
    expect(link.fake.orders.size).toBe(0);
  });

  it('the webhook route accepts the order message end to end (parse -> bot task)', async () => {
    const { ws, pn, g } = await cartShop(27);
    expect((await postWebhook(SELF, rawMessagePayload(pn, catalogOrder(wm(), [{ id: 'v1', qty: 1, price: 100 }], WA_1, CAT)))).status).toBe(200);
    await workspace(ws).runDueTasks();
    expect(sentOf(g).some((s) => s.body.interactive?.action?.buttons)).toBe(true);
    void tapList;
  });
});
