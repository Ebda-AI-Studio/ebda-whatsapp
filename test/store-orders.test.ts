import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { configureStoreLink } from '../src/core/store-link';
import { apiFor, graphStub, useApiKey } from './helpers/api';
import { postWebhook } from './helpers/meta';
import { rawMessagePayload, templateButton } from './helpers/payload';
import { BUYER_KEY_1, PHONE_1, WA_1, deliver, flush, iso, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

useApiKey();
const link = useStoreLink();
const S = (n: number) => `00000000-0000-4000-8000-0000000042${String(n).padStart(2, '0')}`;
const K = (n: number) => `00000000-0000-4000-8000-0000000043${String(n).padStart(2, '0')}`;
const buyer = { buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, name: null, locale: 'ar' as const };

/** A COD order in the fake Store, with the Store's request event delivered so the workspace tracks it. */
async function codOrder(ws: string, key = `k-${ws}`) {
  const made = await link.fake.createOrderFromChat(ws, { items: [{ variantId: 'v1', quantity: 1 }], buyer, paymentMethod: 'cod', idempotencyKey: key });
  if (!made.ok) throw new Error('setup');
  await deliver([storeEvent(ws, 'order.cod_confirmation_requested', { orderId: made.value.orderId, buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', deadlineAt: iso(Date.now() + 1e8), orderNumber: made.value.orderNumber, totalMinor: 10_000, currency: 'EGP' })]);
  await flush(ws);
  return made.value;
}
const tags = (ws: string) => rows<{ tag: string }>(ws, 'SELECT tag FROM conversation_tags');
const tap = async (pn: string, wamid: string, payload: string | undefined, text = 'أيوه، أكّد الطلب', from = WA_1) =>
  postWebhook(SELF, rawMessagePayload(pn, templateButton(wamid, text, payload, from)));

describe('GET /contacts/:waId/orders', () => {
  it('lists the customer\'s orders from the Store, an InstaPay order waiting for payment included', async () => {
    const ws = S(1);
    const api = await apiFor(ws);
    await storeWorkspace(ws);
    await link.fake.createOrderFromChat(ws, { items: [{ variantId: 'v2', quantity: 1 }], buyer, paymentMethod: 'instapay', idempotencyKey: 'a' });
    await link.fake.createOrderFromChat(ws, { items: [{ variantId: 'v3', quantity: 2 }], buyer, paymentMethod: 'cod', idempotencyKey: 'b' });
    const res = await api.call('GET', `/contacts/${WA_1}/orders`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { orderNumber: string; status: string; paymentMethod: string; totalMinor: number }[]; source: string };
    expect(body.source).toBe('store');
    expect(body.items.map((o) => [o.paymentMethod, o.status]).sort()).toEqual([['cod', 'pending_confirmation'], ['instapay', 'pending_confirmation']]);
    expect(link.fake.lastCall('listCustomerOrders')).toEqual([ws, BUYER_KEY_1, 10]);
  });

  it('without a Store bound it answers a labelled sample and never calls out', async () => {
    const ws = S(2);
    const api = await apiFor(ws);
    const prev = configureStoreLink({ bridge: () => null });
    try {
      expect(await (await api.call('GET', `/contacts/${WA_1}/orders`)).json()).toEqual({ items: [], source: 'sample' });
    } finally {
      configureStoreLink(prev);
    }
  });

  it('rejects a malformed number, an unknown workspace and reports an unreachable Store as 503', async () => {
    const ws = S(3);
    const api = await apiFor(ws, 'staff');
    expect((await api.call('GET', '/contacts/abc/orders')).status).toBe(400);
    link.fake.failNext.set('listCustomerOrders', 'unavailable');
    expect((await api.call('GET', `/contacts/${WA_1}/orders`)).status).toBe(503);
    const ghost = await apiFor(S(4));
    await env.DB.prepare('DELETE FROM phone_numbers WHERE workspace_id = ?').bind(S(4)).run();
    await env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(S(4)).run();
    // the workspace cache is positive-only and short; a fresh id proves the 404 path
    const fresh = await SELF.fetch(`https://x/api/v1/stores/${S(5)}/contacts/${WA_1}/orders`, { headers: { authorization: `Bearer ${ghost.token}` } });
    expect([403, 404]).toContain(fresh.status);
  });
});

describe('POST cod-outcome (merchant)', () => {
  it('confirms: the Store is told once with the request key, the event is queued, the tag goes', async () => {
    const ws = S(10);
    const api = await apiFor(ws, 'staff');
    await storeWorkspace(ws);
    const o = await codOrder(ws);
    expect(await tags(ws)).toEqual([{ tag: 'cod_pending' }]);
    const res = await api.call('POST', `/contacts/${WA_1}/orders/${o.orderNumber}/cod-outcome`, { outcome: 'confirmed', idempotencyKey: K(1) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orderNumber: o.orderNumber, outcome: 'confirmed', pushed: true });
    expect(link.fake.orders.get(o.orderId)).toMatchObject({ codOutcome: 'confirmed', status: 'confirmed' });
    expect((link.fake.lastCall('recordCodOutcome')[1] as { idempotencyKey: string }).idempotencyKey).toBe(K(1));
    expect(link.sink.sent).toHaveLength(1);
    expect(link.sink.sent[0]).toMatchObject({ type: 'whatsapp.cod_outcome', storeId: ws, data: { orderId: o.orderId, outcome: 'confirmed', source: 'whatsapp' } });
    expect(await tags(ws)).toEqual([]);
  });

  it('is idempotent for the same answer and 409 for the opposite one', async () => {
    const ws = S(11);
    const api = await apiFor(ws);
    await storeWorkspace(ws);
    const o = await codOrder(ws);
    const path = `/contacts/${WA_1}/orders/${o.orderNumber}/cod-outcome`;
    await api.call('POST', path, { outcome: 'refused', idempotencyKey: K(2) });
    const again = await api.call('POST', path, { outcome: 'refused', idempotencyKey: K(3) });
    expect(again.status).toBe(200);
    expect(link.fake.count('recordCodOutcome')).toBe(1);
    expect(link.sink.sent).toHaveLength(1);
    const flip = await api.call('POST', path, { outcome: 'confirmed', idempotencyKey: K(4) });
    expect(flip.status).toBe(409);
    expect(await flip.json()).toMatchObject({ error: 'invalid_request', message: 'already_resolved' });
  });

  it('records locally and retries when the Store is down: pushed:false now, delivered by the scheduler later', async () => {
    const ws = S(12);
    const api = await apiFor(ws);
    await storeWorkspace(ws);
    const o = await codOrder(ws);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    link.fake.failNext.set('recordCodOutcome', 'unavailable');
    const res = await api.call('POST', `/contacts/${WA_1}/orders/${o.orderNumber}/cod-outcome`, { outcome: 'confirmed', idempotencyKey: K(5) });
    expect(await res.json()).toMatchObject({ pushed: false });
    expect(link.fake.orders.get(o.orderId)!.codOutcome).toBeNull();
    expect(link.sink.sent).toHaveLength(0);
    await workspace(ws).runDueTasks();
    expect(link.fake.orders.get(o.orderId)!.codOutcome).toBe('confirmed');
    expect(link.sink.sent).toHaveLength(1);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'cod_outcome_push'")).toEqual([]);
  });

  it('retries when the event queue is down, repeating the (idempotent) Store call', async () => {
    const ws = S(13);
    const api = await apiFor(ws);
    await storeWorkspace(ws);
    const o = await codOrder(ws);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    link.sink.failNext = 1;
    const res = await api.call('POST', `/contacts/${WA_1}/orders/${o.orderNumber}/cod-outcome`, { outcome: 'confirmed', idempotencyKey: K(6) });
    expect(await res.json()).toMatchObject({ pushed: false });
    await workspace(ws).runDueTasks();
    expect(link.sink.sent).toHaveLength(1);
    const keys = link.fake.calls.filter((c) => c.method === 'recordCodOutcome').map((c) => (c.args[1] as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('adopts a COD order the Store created without a WhatsApp request, and 404s a number it does not know', async () => {
    const ws = S(14);
    const api = await apiFor(ws);
    const made = await link.fake.createOrderFromChat(ws, { items: [{ variantId: 'v1', quantity: 1 }], buyer, paymentMethod: 'cod', idempotencyKey: 'adopt' });
    if (!made.ok) throw new Error('setup');
    const ok = await api.call('POST', `/contacts/${WA_1}/orders/${made.value.orderNumber}/cod-outcome`, { outcome: 'confirmed', idempotencyKey: K(7) });
    expect(ok.status).toBe(200);
    expect(link.fake.orders.get(made.value.orderId)!.codOutcome).toBe('confirmed');
    const missing = await api.call('POST', `/contacts/${WA_1}/orders/999999/cod-outcome`, { outcome: 'confirmed', idempotencyKey: K(8) });
    expect(missing.status).toBe(404);
  });

  it('validates the body and needs a Store bound', async () => {
    const ws = S(15);
    const api = await apiFor(ws);
    expect((await api.call('POST', `/contacts/${WA_1}/orders/1/cod-outcome`, { outcome: 'maybe', idempotencyKey: K(9) })).status).toBe(400);
    expect((await api.call('POST', `/contacts/${WA_1}/orders/1/cod-outcome`, { outcome: 'confirmed', idempotencyKey: 'not-a-uuid' })).status).toBe(400);
    const prev = configureStoreLink({ bridge: () => null });
    try {
      expect((await api.call('POST', `/contacts/${WA_1}/orders/1/cod-outcome`, { outcome: 'confirmed', idempotencyKey: K(10) })).status).toBe(503);
    } finally {
      configureStoreLink(prev);
    }
  });
});

describe('customer taps Confirm / Refuse on the COD template', () => {
  it('a tap with the order payload resolves it once, answers in chat and pushes the outcome', async () => {
    const ws = S(20);
    const pn = await storeWorkspace(ws);
    const o = await codOrder(ws);
    const g = graphStub();
    expect((await tap(pn, 'wamid.t1', `cod:y:${o.orderId}`)).status).toBe(200);
    const jobs = await flush(ws);
    expect(jobs.find((j) => j.idempotencyKey === `cod:${o.orderId}:reply:confirmed`)?.text).toContain('اتأكد');
    expect(link.fake.orders.get(o.orderId)).toMatchObject({ codOutcome: 'confirmed' });
    expect(link.sink.sent.map((e) => e.data.outcome)).toEqual(['confirmed']);
    expect(await tags(ws)).toEqual([]);
    // the same tap redelivered by Meta, and the customer tapping Refuse afterwards, change nothing
    await tap(pn, 'wamid.t1', `cod:y:${o.orderId}`);
    await tap(pn, 'wamid.t2', `cod:n:${o.orderId}`, 'إلغاء الطلب');
    await flush(ws);
    expect(link.fake.count('recordCodOutcome')).toBe(1);
    expect(link.fake.orders.get(o.orderId)!.codOutcome).toBe('confirmed');
    g.restore();
  });

  it('a button that carries no payload is matched by title to the customer\'s open request', async () => {
    const ws = S(21);
    const pn = await storeWorkspace(ws);
    const o = await codOrder(ws);
    await tap(pn, 'wamid.t3', undefined, 'إلغاء الطلب');
    await flush(ws);
    expect(link.fake.orders.get(o.orderId)).toMatchObject({ codOutcome: 'refused', status: 'refused' });
    expect(await rows(ws, "SELECT type, preview FROM messages WHERE direction = 'in'")).toEqual([{ type: 'interactive', preview: 'إلغاء الطلب' }]);
  });

  it('another customer cannot answer for an order through its payload', async () => {
    const ws = S(22);
    const pn = await storeWorkspace(ws);
    const o = await codOrder(ws);
    await tap(pn, 'wamid.t4', `cod:y:${o.orderId}`, 'أيوه، أكّد الطلب', '201112223334');
    await flush(ws);
    expect(link.fake.count('recordCodOutcome')).toBe(0);
    expect(await rows(ws, 'SELECT cod_state FROM store_orders')).toEqual([{ cod_state: 'pending' }]);
  });
});

describe('GET /me', () => {
  it('reports whether the deployment can record COD outcomes', async () => {
    const ws = S(30);
    const api = await apiFor(ws);
    expect(await (await api.call('GET', '/me')).json()).toMatchObject({ storeId: ws, role: 'owner', capabilities: { codOutcome: true } });
    const prev = configureStoreLink({ bridge: () => null });
    try {
      expect(await (await api.call('GET', '/me')).json()).toMatchObject({ capabilities: { codOutcome: false } });
    } finally {
      configureStoreLink(prev);
    }
  });
});

describe('store-link settings', () => {
  it('reads defaults, lets the owner change them and keeps staff out', async () => {
    const ws = S(31);
    const owner = await apiFor(ws);
    const staff = await apiFor(ws, 'staff');
    expect(await (await owner.call('GET', '/store-link/settings')).json()).toEqual({ orderConfirmations: true, orderingBot: true, otpViaWhatsApp: false, catalogId: null });
    expect((await staff.call('PATCH', '/store-link/settings', { orderingBot: false })).status).toBe(403);
    const res = await owner.call('PATCH', '/store-link/settings', { orderingBot: false, catalogId: '1234567890' });
    expect(await res.json()).toMatchObject({ orderingBot: false, catalogId: '1234567890' });
    expect((await owner.call('PATCH', '/store-link/settings', {})).status).toBe(400);
    expect((await owner.call('PATCH', '/store-link/settings', { catalogId: 'abc' })).status).toBe(400);
  });
});

describe('who may answer for which order', () => {
  const created = (ws: string, orderId: string, orderNumber: string, paymentMethod: string, waPhone = PHONE_1) =>
    storeEvent(ws, 'order.created', { orderId, orderNumber, buyerKey: BUYER_KEY_1, phoneE164: waPhone, locale: 'ar', totalMinor: 5000, currency: 'EGP', paymentMethod, channel: 'web' });
  const OTHER = '201112223334';

  it('(a) a customer, or a merchant acting for another customer, cannot answer for an order that is not theirs', async () => {
    const ws = S(40);
    const pn = await storeWorkspace(ws);
    const api = await apiFor(ws);
    const o = await codOrder(ws);
    // a row that knows no customer at all (e.g. only a status event reached us) must not be claimable by guessing its number
    await exec(ws, "INSERT INTO store_orders (order_id, order_number, wa_id, payment_method, status, updated_at) VALUES ('orphan', '555', NULL, 'cod', 'created', 1)");
    const guess = await api.call('POST', `/contacts/${OTHER}/orders/555/cod-outcome`, { outcome: 'confirmed', idempotencyKey: K(40) });
    expect(guess.status).toBe(404);
    expect(await rows(ws, "SELECT outcome FROM store_orders WHERE order_id = 'orphan'")).toEqual([{ outcome: null }]);
    const wrongOwner = await api.call('POST', `/contacts/${OTHER}/orders/${o.orderNumber}/cod-outcome`, { outcome: 'confirmed', idempotencyKey: K(41) });
    expect(wrongOwner.status).toBe(404);
    await tap(pn, 'wamid.x1', `cod:y:${o.orderId}`, 'أيوه، أكّد الطلب', OTHER);
    await flush(ws);
    expect(link.fake.count('recordCodOutcome')).toBe(0);
    expect(await rows(ws, "SELECT cod_state, outcome FROM store_orders WHERE order_id = ?", o.orderId)).toEqual([{ cod_state: 'pending', outcome: null }]);
  });

  it('(b) an order that is not cash on delivery cannot be confirmed or refused', async () => {
    const ws = S(41);
    const pn = await storeWorkspace(ws);
    const api = await apiFor(ws);
    await deliver([created(ws, 'ip1', '7001', 'instapay'), created(ws, 'cd1', '7002', 'card')]);
    for (const n of ['7001', '7002']) {
      const res = await api.call('POST', `/contacts/${WA_1}/orders/${n}/cod-outcome`, { outcome: 'confirmed', idempotencyKey: K(42) });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ message: 'not_cod_order' });
    }
    await tap(pn, 'wamid.x2', 'cod:y:ip1');
    await flush(ws);
    expect(await rows(ws, 'SELECT order_id, cod_state, outcome FROM store_orders ORDER BY order_id')).toEqual([{ order_id: 'cd1', cod_state: null, outcome: null }, { order_id: 'ip1', cod_state: null, outcome: null }]);
    expect(link.fake.count('recordCodOutcome')).toBe(0);
  });

  it('(c) after a cancellation nothing can be answered, whatever the COD state was', async () => {
    const ws = S(42);
    const pn = await storeWorkspace(ws);
    const api = await apiFor(ws);
    const pending = await codOrder(ws, 'k42a');
    const answered = await codOrder(ws, 'k42b');
    await deliver([storeEvent(ws, 'order.created', { orderId: 'fresh', orderNumber: '8003', buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', totalMinor: 1, currency: 'EGP', paymentMethod: 'cod', channel: 'web' })]);
    await tap(pn, 'wamid.x3', `cod:y:${answered.orderId}`);
    await flush(ws);
    expect(link.fake.count('recordCodOutcome')).toBe(1);
    const cancel = (orderId: string, at: number) => storeEvent(ws, 'order.status_changed', { orderId, status: 'cancelled', updatedAt: iso(at) });
    await deliver([cancel(pending.orderId, Date.now()), cancel(answered.orderId, Date.now()), cancel('fresh', Date.now())]);
    expect(await rows(ws, 'SELECT order_id, cod_state FROM store_orders ORDER BY order_id')).toEqual(
      [{ order_id: 'fresh', cod_state: 'closed' }, { order_id: answered.orderId, cod_state: 'closed' }, { order_id: pending.orderId, cod_state: 'closed' }].sort((a, b) => a.order_id.localeCompare(b.order_id)),
    );
    for (const n of [pending.orderNumber, '8003']) {
      const res = await api.call('POST', `/contacts/${WA_1}/orders/${n}/cod-outcome`, { outcome: 'refused', idempotencyKey: K(43) });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ message: 'order_closed' });
    }
    await tap(pn, 'wamid.x4', `cod:n:${pending.orderId}`, 'إلغاء الطلب');
    await flush(ws);
    expect(link.fake.count('recordCodOutcome')).toBe(1); // only the earlier confirmation
    expect(await tags(ws)).toEqual([]);
  });
});
