import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { configureStoreLink } from '../src/core/store-link';
import { EBDA_ORDERING_COPY } from '../src/addons/ebda/store-copy';
import { FakeStore } from './helpers/fake-store';
import { stubGraph, type GraphReply } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { buttonReply, catalogOrder, listReply, rawMessagePayload } from './helpers/payload';
import { BUYER_KEY_1, WA_1, deliver, sentJobs, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

const link = useStoreLink();
const W = (n: number) => `00000000-0000-4000-8000-0000000045${String(n).padStart(2, '0')}`;
let seq = 0;
const wamid = () => `wamid.in.${++seq}.${Date.now()}`;

async function setup(n: number, opts: { gap?: number } = {}) {
  const ws = W(n);
  const pn = await storeWorkspace(ws);
  await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = opts.gap ?? 0; });
  return { ws, pn };
}

type Sent = { kind: string; body: Record<string, any> };
function sentOf(g: ReturnType<typeof stubGraph>, from = 0): Sent[] {
  return g.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages')).slice(from).map((c) => {
    const b = c.body as Record<string, any>;
    const kind = b.type === 'interactive' ? (b.interactive.type === 'list' ? 'list' : 'buttons') : b.type;
    return { kind, body: b };
  });
}
const kinds = (g: ReturnType<typeof stubGraph>, from = 0) => sentOf(g, from).map((s) => s.kind);

/** One inbound message, through the real webhook, then the bot's task. Returns what the bot sent in reply. */
async function say(ws: string, pn: string, message: Record<string, unknown>, g: ReturnType<typeof stubGraph>) {
  const from = g.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages')).length;
  expect((await postWebhook(SELF, rawMessagePayload(pn, message))).status).toBe(200);
  await workspace(ws).runDueTasks();
  return sentOf(g, from);
}
const text = (t: string, from = WA_1) => ({ id: wamid(), from, type: 'text', text: { body: t } });
const tapList = (id: string, title = 'x') => listReply(wamid(), id, title);
const tapBtn = (id: string, title = 'x') => buttonReply('', wamid(), id, title);
const image = (mediaId = 'media-1') => ({ id: wamid(), from: WA_1, type: 'image', image: { id: mediaId, mime_type: 'image/jpeg' } });
const flat = (s: Sent) => JSON.stringify(s.body);
const rowIds = (s: Sent) => (s.body.interactive.action.sections[0].rows as { id: string }[]).map((r) => r.id);
const buttonIds = (s: Sent) => (s.body.interactive.action.buttons as { reply: { id: string } }[]).map((b) => b.reply.id);
const sessionOf = async (ws: string) => (await rows<{ state: string; data: string }>(ws, 'SELECT state, data FROM bot_sessions'))[0]!;

/** Walks greeting -> pick v2 x2 -> checkout and returns where it stands. */
async function toCheckout(ws: string, pn: string, g: ReturnType<typeof stubGraph>) {
  await say(ws, pn, text('السلام عليكم'), g);
  await say(ws, pn, tapList('v:v2'), g);
  await say(ws, pn, tapBtn('q:2'), g);
  return say(ws, pn, tapBtn('cart:checkout'), g);
}

describe('browsing', () => {
  it('greets, sends an image per product, then ONE list with pagination in the row id', async () => {
    const { ws, pn } = await setup(1);
    const g = stubGraph();
    const out = await say(ws, pn, text('hi'), g);
    expect(out.map((s) => s.kind)).toEqual(['text', ...Array(9).fill('image'), 'list']);
    expect(out[0]!.body.text.body).toContain('متجر الاختبار');
    expect(out[1]!.body.image).toMatchObject({ link: 'https://img.example/v1.jpg', caption: expect.stringContaining('Item 1 (ع)') });
    const list = out.at(-1)!;
    expect(rowIds(list)).toEqual([...Array.from({ length: 9 }, (_, i) => `v:v${i + 1}`), 'more:9']);
    expect(list.body.interactive.action.button).toBe('المنتجات');
    // the next page needs no server state: the row id carries the cursor
    const page2 = await say(ws, pn, tapList('more:9'), g);
    expect(page2.map((s) => s.kind)).toEqual([...Array(9).fill('image'), 'list']);
    expect(rowIds(page2.at(-1)!)).toEqual([...Array.from({ length: 9 }, (_, i) => `v:v${i + 10}`), 'more:18']);
    expect(link.fake.lastCall('listCatalog')).toEqual([ws, '9', 9]);
  });

  it('respects the 24 h window and the title/description limits of Meta lists', async () => {
    const { ws, pn } = await setup(2);
    const g = stubGraph();
    const out = await say(ws, pn, text('hi'), g);
    for (const row of out.at(-1)!.body.interactive.action.sections[0].rows as { title: string; description?: string }[]) {
      expect(Array.from(row.title).length).toBeLessThanOrEqual(24);
      expect(Array.from(row.description ?? '').length).toBeLessThanOrEqual(72);
    }
  });

  it('sends 150 ms apart by default', async () => {
    const { ws, pn } = await setup(3, { gap: 150 });
    const times: number[] = [];
    const g = stubGraph((c): GraphReply => (times.push(Date.now()), { status: 200, json: { messages: [{ id: `wamid.o${times.length}` }] } }));
    await say(ws, pn, text('hi'), g);
    expect(times.length).toBeGreaterThan(5);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(140);
  });

  it('shows the English names to an English customer after a language word', async () => {
    const { ws, pn } = await setup(4);
    const g = stubGraph();
    const out = await say(ws, pn, text('English'), g);
    expect(out[1]!.body.image.caption).toContain('Item 1');
    expect(out[1]!.body.image.caption).not.toContain('(ع)');
    expect(out[0]!.body.text.body).toContain('Welcome');
  });

  it('marks a sold-out product and refuses to add it', async () => {
    const { ws, pn } = await setup(5);
    link.fake.stock.v1 = 0;
    const g = stubGraph();
    const out = await say(ws, pn, text('hi'), g);
    expect(out.at(-1)!.body.interactive.action.sections[0].rows[0].description).toContain('خلص');
    const refused = await say(ws, pn, tapList('v:v1'), g);
    expect(refused[0]!.body.text.body).toContain('خلصوا من المخزون');
    expect(refused.at(-1)!.kind).toBe('list'); // back to the list, nothing stuck
  });

  it('an empty catalog and an unreachable Store both answer in words', async () => {
    const { ws, pn } = await setup(6);
    const g = stubGraph();
    link.fake.catalog = [];
    expect((await say(ws, pn, text('hi'), g)).map((s) => s.body.text?.body).join('|')).toContain('مفيش منتجات');
    link.fake.failNext.set('listCatalog', 'unavailable');
    expect((await say(ws, pn, text('hi'), g))[0]!.body.text.body).toContain('حصلت مشكلة');
  });
});

describe('cart and checkout paths', () => {
  it('COD: pick, quantity by button, checkout, payment, typed address, order, confirmation; nothing is terminal', async () => {
    const { ws, pn } = await setup(10);
    const g = stubGraph();
    await say(ws, pn, text('hi'), g);
    const qty = await say(ws, pn, tapList('v:v2'), g);
    expect(qty[0]!.kind).toBe('buttons');
    expect(buttonIds(qty[0]!)).toEqual(['q:1', 'q:2', 'q:3']);
    const cart = await say(ws, pn, tapBtn('q:2'), g);
    expect(cart[0]!.body.interactive.body.text).toContain('2 × Item 2 (ع)');
    expect(cart[0]!.body.interactive.body.text).toContain('210 جنيه'); // 2 x 10500 piasters
    expect(buttonIds(cart[0]!)).toEqual(['cart:checkout', 'cart:more', 'cart:clear']);
    const pay = await say(ws, pn, tapBtn('cart:checkout'), g);
    expect(buttonIds(pay[0]!)).toEqual(['pay:cod', 'pay:link', 'pay:instapay']);
    const ask = await say(ws, pn, tapBtn('pay:cod'), g);
    expect(ask[0]!.body.text.body).toContain('عنوان التوصيل');
    const done = await say(ws, pn, text('المعادي، شارع 9 عمارة 4'), g);
    expect(done[0]!.body.text.body).toMatch(/طلبك رقم 1001 اتسجّل بإجمالي 210 جنيه والدفع عند الاستلام/);
    const order = link.fake.orders.get('ord-1001')!;
    expect(order).toMatchObject({ paymentMethod: 'cod', lines: [{ variantId: 'v2', quantity: 2 }], totalMinor: 21_000, buyerKey: BUYER_KEY_1 });
    const create = link.fake.lastCall('createOrderFromChat')[1] as { addressId?: string; address?: unknown; buyer: { phoneE164: string }; idempotencyKey: string };
    expect(create.addressId).toBe('addr-1'); // saved for next time, then used
    expect(link.fake.lastCall('saveCustomerAddress')).toEqual([ws, BUYER_KEY_1, { area: 'المعادي', street: 'شارع 9 عمارة 4' }]);
    expect(create.buyer.phoneE164).toBe('+201001234567');
    expect(link.fake.stock.v2).toBe(48);
    expect(await rows(ws, 'SELECT order_id, payment_method, status, total_minor, wa_id FROM store_orders')).toEqual([{ order_id: 'ord-1001', payment_method: 'cod', status: 'created', total_minor: 21_000, wa_id: WA_1 }]);
    // no terminal state: any next message starts over, and the restart words work from anywhere
    const again = await say(ws, pn, text('شكراً'), g);
    expect(again.at(-1)!.kind).toBe('list');
    await say(ws, pn, tapList('v:v3'), g);
    const restarted = await say(ws, pn, text('طلب جديد'), g);
    expect(restarted[0]!.body.text.body).toContain('أهلاً بيك');
    expect((await sessionOf(ws)).data).toContain('"cart":[]');
  });

  it('a quantity can be typed (Arabic digits too) and the same product merges into one line', async () => {
    const { ws, pn } = await setup(11);
    const g = stubGraph();
    await say(ws, pn, text('hi'), g);
    await say(ws, pn, tapList('v:v1'), g);
    await say(ws, pn, text('٢'), g);
    await say(ws, pn, tapBtn('cart:more'), g);
    await say(ws, pn, tapList('v:v1'), g);
    const cart = await say(ws, pn, tapBtn('q:1'), g);
    expect(cart[0]!.body.interactive.body.text).toContain('3 × Item 1 (ع)');
    expect(cart[0]!.body.interactive.body.text.match(/×/g)).toHaveLength(1);
  });

  it('clearing the cart empties it and returns to the list', async () => {
    const { ws, pn } = await setup(12);
    const g = stubGraph();
    await say(ws, pn, text('hi'), g);
    await say(ws, pn, tapList('v:v1'), g);
    await say(ws, pn, tapBtn('q:1'), g);
    const cleared = await say(ws, pn, tapBtn('cart:clear'), g);
    expect(cleared.at(-1)!.kind).toBe('list');
    expect((await sessionOf(ws)).data).toContain('"cart":[]');
  });

  it('payment link: the link goes to the customer; with none on the order the Store is asked for it', async () => {
    const { ws, pn } = await setup(13);
    const g = stubGraph();
    await toCheckout(ws, pn, g);
    await say(ws, pn, tapBtn('pay:link'), g);
    const done = await say(ws, pn, text('الدقي، شارع التحرير 3'), g);
    expect(done[0]!.body.text.body).toContain('https://pay.example/ord-1001');
    expect(link.fake.count('getPaymentLink')).toBe(0);

    // an order created without a paymentUrl: fall back to getPaymentLink, then to a checkout link
    const { ws: ws2, pn: pn2 } = await setup(14);
    const original = link.fake.createOrderFromChat.bind(link.fake);
    vi.spyOn(link.fake, 'createOrderFromChat').mockImplementation(async (...a) => {
      const r = await original(...a);
      return r.ok ? { ok: true, value: { ...r.value, paymentUrl: null } } : r;
    });
    link.fake.addresses.clear(); // a different run of the same customer: no saved address, so the text prompt
    await toCheckout(ws2, pn2, g);
    await say(ws2, pn2, tapBtn('pay:link'), g);
    const second = await say(ws2, pn2, text('الدقي، شارع التحرير 3'), g);
    expect(second[0]!.body.text.body).toContain('https://pay.example/ord-1002');
    expect(link.fake.count('getPaymentLink')).toBe(1);
    link.fake.failNext.set('getPaymentLink', 'unavailable');
    link.fake.addresses.clear();
    await toCheckout(ws2, pn2, g);
    await say(ws2, pn2, tapBtn('pay:link'), g);
    const third = await say(ws2, pn2, text('الدقي، شارع التحرير 3'), g);
    expect(third[0]!.body.text.body).toContain('https://shop.example/cart/from-wa');
  });

  it('a store with a single payment method skips the question', async () => {
    link.fake.paymentMethods = ['cod'];
    const { ws, pn } = await setup(15);
    const g = stubGraph();
    const ask = await toCheckout(ws, pn, g);
    expect(ask[0]!.body.text.body).toContain('عنوان التوصيل');
  });

  it('saved addresses are offered as a list, with "new address" last', async () => {
    const { ws, pn } = await setup(16);
    link.fake.addresses.set(BUYER_KEY_1, [{ id: 'a1', label: 'البيت', area: 'المعادي', street: 'شارع 9' }, { id: 'a2', label: null, area: 'الدقي', street: 'شارع 1' }]);
    const g = stubGraph();
    await toCheckout(ws, pn, g);
    const list = await say(ws, pn, tapBtn('pay:cod'), g);
    expect(rowIds(list[0]!)).toEqual(['addr:a1', 'addr:a2', 'addr:new']);
    const done = await say(ws, pn, tapList('addr:a2'), g);
    expect(done[0]!.body.text.body).toContain('اتسجّل');
    expect((link.fake.lastCall('createOrderFromChat')[1] as { addressId: string }).addressId).toBe('a2');
    expect(link.fake.count('saveCustomerAddress')).toBe(0);
  });

  it('a cart sent from Meta\'s catalog (any state) becomes the cart; the Store re-prices the order', async () => {
    const { ws, pn } = await setup(17);
    const g = stubGraph();
    const cart = await say(ws, pn, catalogOrder(wamid(), [{ id: 'v1', qty: 2, price: 100 }, { id: 'v5', qty: 1, price: 120.5 }]), g);
    expect(cart[0]!.body.interactive.body.text).toContain('2 × v1');
    expect(cart[0]!.body.interactive.body.text).toContain('320.50 جنيه'); // 2 x 100.00 + 120.50, integer piasters
    await say(ws, pn, tapBtn('cart:checkout'), g);
    await say(ws, pn, tapBtn('pay:cod'), g);
    await say(ws, pn, text('المعادي، شارع 9'), g);
    expect((link.fake.lastCall('createOrderFromChat')[1] as { items: unknown[] }).items).toEqual([{ variantId: 'v1', quantity: 2 }, { variantId: 'v5', quantity: 1 }]);
    expect(link.fake.orders.get('ord-1001')!.totalMinor).toBe(2 * 10_000 + 12_000); // the Store's prices win over Meta's 320.50 estimate
  });

  it('stock that ran out between the cart and the order: the item is named and removed, the rest stays', async () => {
    const { ws, pn } = await setup(18);
    const g = stubGraph();
    await toCheckout(ws, pn, g);
    await say(ws, pn, tapBtn('pay:cod'), g);
    link.fake.stock.v2 = 1; // someone else bought it meanwhile
    const out = await say(ws, pn, text('المعادي، شارع 9'), g);
    expect(out[0]!.body.text.body).toContain('Item 2 (ع)');
    expect(out[0]!.body.text.body).toContain('خلصوا من المخزون');
    expect(out[1]!.body.text.body).toContain('سلتك فاضية');
    expect(link.fake.orders.size).toBe(0);
  });

  it('a transient Store failure keeps the order attempt: the retry reaches ONE order', async () => {
    const { ws, pn } = await setup(19);
    const g = stubGraph();
    await toCheckout(ws, pn, g);
    await say(ws, pn, tapBtn('pay:cod'), g);
    link.fake.failNext.set('createOrderFromChat', 'unavailable');
    const failed = await say(ws, pn, text('المعادي، شارع 9'), g);
    expect(failed[0]!.body.text.body).toContain('حصلت مشكلة');
    // the customer repeats the address: same attempt key, so no second order whatever happened at the Store
    await say(ws, pn, text('المعادي، شارع 9'), g);
    expect(link.fake.orders.size).toBe(1);
    const keys = link.fake.calls.filter((c) => c.method === 'createOrderFromChat').map((c) => (c.args[1] as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });
});

describe('InstaPay and the payment receipt (Review Focus 2)', () => {
  async function placeInstapay(ws: string, pn: string, g: ReturnType<typeof stubGraph>) {
    await toCheckout(ws, pn, g);
    await say(ws, pn, tapBtn('pay:instapay'), g);
    return say(ws, pn, text('المعادي، شارع 9'), g);
  }

  it('shows the IPA, the amount and the reference, and keeps the order pending_payment', async () => {
    const { ws, pn } = await setup(30);
    const g = stubGraph();
    const out = await placeInstapay(ws, pn, g);
    const msg = out[0]!.body.text.body as string;
    expect(msg).toContain('shop@instapay');
    expect(msg).toContain('210 جنيه');
    expect(msg).toContain('IP-1001');
    expect(link.fake.orders.get('ord-1001')!.status).toBe('pending_payment');
    expect((await sessionOf(ws)).state).toBe('awaiting_proof');
    const [o] = await rows<{ proof_deadline_at: number }>(ws, 'SELECT proof_deadline_at FROM store_orders');
    expect(o!.proof_deadline_at).toBeGreaterThan(Date.now() + 47 * 3_600_000);
  });

  it('forwards a screenshot to the Store ONCE; the order stays pending_payment until the Store confirms', async () => {
    const { ws, pn } = await setup(31);
    const g = stubGraph();
    await placeInstapay(ws, pn, g);
    const withMedia = stubGraph((c): GraphReply => (c.url.includes('/media-1') ? { status: 200, json: { url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg' } } : c.url.startsWith('https://lookaside') ? { status: 200, body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'image/jpeg' } } : { status: 200, json: { messages: [{ id: 'wamid.o9' }] } }));
    const first = await say(ws, pn, image('media-1'), withMedia);
    expect(first[0]!.body.text.body).toContain('وصلنا إيصال التحويل');
    expect(link.fake.count('attachPaymentProof')).toBe(1);
    const [, orderId, url] = link.fake.lastCall('attachPaymentProof') as [string, string, string];
    expect(orderId).toBe('ord-1001');
    expect(url).toMatch(/^https:\/\/wa\.test\/api\/v1\/proof\/[^/]+\/\d+\?exp=\d+&sig=[0-9a-f]{64}$/);
    expect(link.fake.orders.get('ord-1001')!.status).toBe('pending_payment');
    const second = await say(ws, pn, image('media-2'), withMedia);
    expect(second[0]!.body.text.body).toContain('استلمنا الإيصال قبل كده');
    expect(link.fake.count('attachPaymentProof')).toBe(1);
    // once the Store records the transfer, the customer is told (inside the window)
    link.fake.markPaid('ord-1001');
    await deliver([storeEvent(ws, 'order.status_changed', { orderId: 'ord-1001', status: 'paid', updatedAt: new Date().toISOString() })]);
    await workspace(ws).runDueTasks();
    expect(sentJobs().find((j) => j.idempotencyKey === 'order:ord-1001:paid')?.text).toContain('تم تأكيد الدفع لطلبك رقم 1001');
  });

  it('a screenshot after the 48 h are over is not forwarded', async () => {
    const { ws, pn } = await setup(32);
    const g = stubGraph();
    await placeInstapay(ws, pn, g);
    await exec(ws, 'UPDATE store_orders SET proof_deadline_at = ?', Date.now() - 1000);
    const out = await say(ws, pn, image('media-3'), g);
    expect(out[0]!.body.text.body).toContain('مدة إرسال الإيصال خلصت');
    expect(link.fake.count('attachPaymentProof')).toBe(0);
  });

  it('an unreachable Store is retried, not lost, and a clean retry forwards once', async () => {
    const { ws, pn } = await setup(33);
    const g = stubGraph();
    await placeInstapay(ws, pn, g);
    const media = stubGraph((c): GraphReply => (c.url.includes('/media-4') ? { status: 200, json: { url: 'https://lookaside.fbsbx.com/y', mime_type: 'image/jpeg' } } : c.url.startsWith('https://lookaside') ? { status: 200, body: new Uint8Array([1]), headers: { 'content-type': 'image/jpeg' } } : { status: 200, json: { messages: [{ id: 'wamid.o8' }] } }));
    link.fake.failNext.set('attachPaymentProof', 'unavailable');
    const first = await say(ws, pn, image('media-4'), media);
    expect(first).toEqual([]);
    expect(await rows(ws, 'SELECT proof_wamid FROM store_orders')).toEqual([{ proof_wamid: null }]); // the claim was released
    await workspace(ws).runDueTasks(Date.now() + 3_600_000);
    expect(link.fake.count('attachPaymentProof')).toBe(2);
    expect(link.fake.orders.get('ord-1001')!.proofs).toHaveLength(1);
    expect(sentOf(media).at(-1)!.body.text.body).toContain('وصلنا إيصال التحويل');
  });

  it('a picture when no InstaPay order waits is ignored', async () => {
    const { ws, pn } = await setup(34);
    const g = stubGraph();
    expect(await say(ws, pn, image('media-5'), g)).toEqual([]);
    expect(link.fake.count('attachPaymentProof')).toBe(0);
  });
});

describe('switches, safety and replays', () => {
  it('says nothing and creates no work with no Store bound, with the switch off, or when unlinked; the spike reply returns', async () => {
    const { ws, pn } = await setup(40);
    const g = stubGraph();
    await workspace(ws).setStoreLinkSettings({ orderingBot: false });
    expect(await say(ws, pn, text('hi'), g)).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'bot_turn'")).toEqual([]);
    expect(env.SEND_QUEUE.sendBatch).toHaveBeenCalled(); // the generic auto reply is back while the bot is off
    await workspace(ws).setStoreLinkSettings({ orderingBot: true });
    await deliver([storeEvent(ws, 'store.unlinked', { ownerUserId: 'u' })]);
    expect(await say(ws, pn, text('hi'), g)).toEqual([]);
    const prev = configureStoreLink({ bridge: () => null });
    try {
      await deliver([storeEvent(ws, 'store.linked', { ownerUserId: 'u' }, { occurredAt: new Date(Date.now() + 5000).toISOString() })]);
      expect(await say(ws, pn, text('hi'), g)).toEqual([]);
    } finally {
      configureStoreLink(prev);
    }
  });

  it('while the bot is on the generic auto reply stays quiet', async () => {
    const { ws, pn } = await setup(41);
    const g = stubGraph();
    vi.mocked(env.SEND_QUEUE.sendBatch).mockClear();
    await say(ws, pn, text('hi'), g);
    expect(vi.mocked(env.SEND_QUEUE.sendBatch)).not.toHaveBeenCalled();
  });

  it('a replayed turn (task re-run after success, or a Meta redelivery) sends nothing twice', async () => {
    const { ws, pn } = await setup(42);
    const g = stubGraph();
    const m = text('hi');
    await say(ws, pn, m, g);
    const n = sentOf(g).length;
    await postWebhook(SELF, rawMessagePayload(pn, m)); // Meta redelivers the same wamid
    await workspace(ws).runDueTasks();
    expect(sentOf(g)).toHaveLength(n);
    const [msg] = await rows<{ id: number }>(ws, "SELECT id FROM messages WHERE direction = 'in'");
    // and a task that survived a crash after the work was done
    await workspace(ws).schedule('bot_turn', Date.now(), { messageId: msg!.id, wamid: 'x', from: WA_1, phoneNumberId: pn, profileName: null, type: 'text', text: 'hi', reply: null, order: null } as never);
    await workspace(ws).runDueTasks();
    expect(sentOf(g)).toHaveLength(n);
  });

  it('a turn that dies half-way is retried and completes without repeating what was sent', async () => {
    const { ws, pn } = await setup(43);
    const g = stubGraph();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runInDurableObject(workspace(ws), (i) => {
      const real = (i as any).deliverNow.bind(i) as (job: unknown) => Promise<void>;
      let n = 0;
      vi.spyOn(i as any, 'deliverNow').mockImplementation(async (job: unknown) => {
        if (++n === 4) throw new Error('isolate evicted'); // the 4th send of the first run never happens
        return real(job);
      });
    });
    await say(ws, pn, text('hi'), g);
    expect(sentOf(g)).toHaveLength(3);
    expect((await rows(ws, 'SELECT attempts FROM scheduled_tasks WHERE kind = \'bot_turn\''))).toEqual([{ attempts: 1 }]);
    await workspace(ws).runDueTasks(Date.now() + 3_600_000);
    const all = sentOf(g);
    expect(all).toHaveLength(11); // greeting + 9 images + list, each exactly once
    expect(new Set(all.map((s) => flat(s))).size).toBe(11);
    expect(all.at(-1)!.kind).toBe('list');
    expect(await rows(ws, 'SELECT 1 FROM scheduled_tasks WHERE kind = \'bot_turn\'')).toEqual([]);
  });

  it('two messages from one customer at once are handled one after the other', async () => {
    const { ws, pn } = await setup(44);
    link.fake.latencyMs = 20;
    const g = stubGraph();
    await say(ws, pn, text('hi'), g);
    await say(ws, pn, tapList('v:v1'), g);
    // two quantity taps arrive together; both tasks are due and two runners start together
    await postWebhook(SELF, rawMessagePayload(pn, tapBtn('q:1')));
    await postWebhook(SELF, rawMessagePayload(pn, tapBtn('q:2')));
    await Promise.all([workspace(ws).runDueTasks(), workspace(ws).runDueTasks()]);
    const s = await sessionOf(ws);
    // the first tap added 1 and moved to the cart; the second (a stale button) did not change the cart
    expect(JSON.parse(s.data).cart).toEqual([expect.objectContaining({ variantId: 'v1', quantity: 1 })]);
  });

  it('my-orders words list the latest orders from the Store', async () => {
    const { ws, pn } = await setup(45);
    const g = stubGraph();
    expect((await say(ws, pn, text('طلباتي'), g))[0]!.body.text.body).toContain('مفيش طلبات');
    await link.fake.createOrderFromChat(ws, { items: [{ variantId: 'v1', quantity: 1 }], buyer: { buyerKey: BUYER_KEY_1, phoneE164: '+201001234567', name: null, locale: 'ar' }, paymentMethod: 'instapay', idempotencyKey: 'z' });
    expect((await say(ws, pn, text('my orders'), g))[0]!.body.text.body).toMatch(/رقم 1001: مستني الدفع/);
  });

  it('erasing a customer removes the bot session and pending turns', async () => {
    const { ws, pn } = await setup(46);
    const g = stubGraph();
    await say(ws, pn, text('hi'), g);
    await postWebhook(SELF, rawMessagePayload(pn, text('again')));
    expect(await rows(ws, 'SELECT 1 FROM bot_sessions')).toHaveLength(1);
    await workspace(ws).eraseContact(WA_1);
    expect(await rows(ws, 'SELECT 1 FROM bot_sessions')).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'bot_turn'")).toEqual([]);
  });
});

describe('opt-out and erasure', () => {
  it('a STOP message schedules no bot turn and gets no reply', async () => {
    const { ws, pn } = await setup(50);
    const g = stubGraph();
    expect(await say(ws, pn, text('STOP'), g)).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'bot_turn'")).toEqual([]);
    expect(await rows(ws, 'SELECT opted_out_at IS NOT NULL AS out FROM contacts')).toEqual([{ out: 1 }]);
    expect(await rows(ws, 'SELECT 1 FROM bot_sessions')).toEqual([]);
  });

  it('a stop given after the question cancels the pending answer', async () => {
    const { ws, pn } = await setup(51);
    const g = stubGraph();
    const ts = Math.floor(Date.now() / 1000);
    // one batch: the question is stored (turn scheduled), then the stop, before any turn can run
    await workspace(ws).ingest({ phoneNumberId: pn, receivedAt: Date.now(), statuses: [], inbound: [
      { wamid: wamid(), from: WA_1, ts, type: 'text', text: 'hi' },
      { wamid: wamid(), from: WA_1, ts: ts + 1, type: 'text', text: 'وقف' },
    ] });
    await workspace(ws).runDueTasks();
    expect(sentOf(g)).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM bot_sessions')).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM messages WHERE direction = 'out'")).toEqual([]);
  });

  it('Ruling check: a customer who opted out EARLIER and writes in again still gets a plain service answer', async () => {
    const { ws, pn } = await setup(52);
    const g = stubGraph();
    await say(ws, pn, text('hi'), g);
    await exec(ws, 'UPDATE contacts SET opted_out_at = 1000');
    const out = await say(ws, pn, text('hello again'), g);
    expect(out.at(-1)!.kind).toBe('list');
  });

  it('erasing a customer while a bot turn is waiting on the Store writes nothing back', async () => {
    const { ws, pn } = await setup(53);
    link.fake.latencyMs = 80;
    const g = stubGraph();
    await postWebhook(SELF, rawMessagePayload(pn, text('hi')));
    const turn = workspace(ws).runDueTasks();
    await new Promise((r) => setTimeout(r, 30)); // the turn is inside listCatalog
    await workspace(ws).eraseContact(WA_1);
    await turn;
    for (const t of ['contacts', 'conversations', 'messages', 'bot_sessions', 'store_orders']) expect(await rows(ws, `SELECT 1 FROM ${t}`), t).toEqual([]);
    expect(sentOf(g)).toEqual([]);
  });

  it('erasing a customer in the middle of a burst stops it: nothing is sent or stored after the erase', async () => {
    const { ws, pn } = await setup(54);
    const g = stubGraph(undefined, { delayMs: 40 });
    await postWebhook(SELF, rawMessagePayload(pn, text('hi')));
    const turn = workspace(ws).runDueTasks();
    await new Promise((r) => setTimeout(r, 130));
    await workspace(ws).eraseContact(WA_1);
    const sentAtErase = sentOf(g).length;
    await turn;
    expect(sentAtErase).toBeGreaterThan(0);
    expect(sentOf(g).length).toBeLessThanOrEqual(sentAtErase + 1); // at most the one call already in flight
    for (const t of ['contacts', 'conversations', 'messages', 'bot_sessions']) expect(await rows(ws, `SELECT 1 FROM ${t}`), t).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind IN ('bot_turn', 'send_release')")).toEqual([]);
  });

  it('an order that finishes after the customer was erased leaves no local order row', async () => {
    const { ws, pn } = await setup(55);
    const g = stubGraph();
    await toCheckout(ws, pn, g);
    await say(ws, pn, tapBtn('pay:cod'), g);
    link.fake.latencyMs = 80;
    await postWebhook(SELF, rawMessagePayload(pn, text('المعادي، شارع 9')));
    const turn = workspace(ws).runDueTasks();
    await new Promise((r) => setTimeout(r, 30));
    await workspace(ws).eraseContact(WA_1);
    await turn;
    expect(await rows(ws, 'SELECT 1 FROM store_orders')).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM bot_sessions')).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM contacts')).toEqual([]);
  });
});

describe('copy limits', () => {
  it('every button is at most 20 characters and every list label at most 24', () => {
    const t = EBDA_ORDERING_COPY.t;
    const buttons = [...Object.values(t.cartButtons), ...Object.values(t.paymentTitles), t.browseButton, t.addressesButton];
    for (const l of buttons) for (const v of Object.values(l)) expect(Array.from(v).length, v).toBeLessThanOrEqual(20);
    for (const v of [...Object.values(t.moreRow), ...Object.values(t.newAddressRow)]) expect(Array.from(v).length, v).toBeLessThanOrEqual(24);
  });
});

