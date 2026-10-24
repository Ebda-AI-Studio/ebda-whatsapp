import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { FakeStore } from './helpers/fake-store';
import { BUYER_KEY_1, PHONE_1, WA_1, deliver, flush, iso, sentJobs, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, openChat, rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000041${String(n).padStart(2, '0')}`;
const link = useStoreLink();
const cod = (ws: string, extra: Record<string, unknown> = {}, id?: string) =>
  storeEvent(ws, 'order.cod_confirmation_requested', { orderId: 'o1', buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', deadlineAt: iso(Date.now() + 86_400_000), orderNumber: '1001', totalMinor: 75_050, currency: 'EGP', ...extra }, id ? { id } : {});
const tags = (ws: string) => rows<{ tag: string }>(ws, 'SELECT tag FROM conversation_tags');

describe('COD confirmation request (Review Focus 1)', () => {
  it('sends the template with Confirm/Refuse payloads, tags the chat and schedules the no-reply check', async () => {
    const ws = W(1);
    await storeWorkspace(ws);
    const res = await deliver([cod(ws)]);
    expect(res.explicitAcks).toEqual(['e0']);
    const [job] = await flush(ws);
    expect(job).toMatchObject({ to: WA_1, kind: 'template', template: { name: 'cod_confirmation', language: 'ar' }, idempotencyKey: 'cod:o1' });
    const comps = job!.template!.components;
    expect(comps[0]).toEqual({ type: 'body', parameters: [{ type: 'text', text: 'عميلنا العزيز' }, { type: 'text', text: '1001' }, { type: 'text', text: '750.50' }] });
    expect(comps.slice(1)).toEqual([
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'cod:y:o1' }] },
      { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'cod:n:o1' }] },
    ]);
    expect(await tags(ws)).toEqual([{ tag: 'cod_pending' }]);
    expect(await rows(ws, "SELECT cod_state, payment_method, order_number, total_minor FROM store_orders")).toEqual([{ cod_state: 'pending', payment_method: 'cod', order_number: '1001', total_minor: 75_050 }]);
    expect(await rows(ws, "SELECT payload FROM scheduled_tasks WHERE kind = 'cod_no_reply'")).toEqual([{ payload: '{"orderId":"o1"}' }]);
  });

  it('a queue redelivery (same event id) and a second event for the same order send one template', async () => {
    const ws = W(2);
    await storeWorkspace(ws);
    const e = cod(ws);
    await deliver([e]);
    await deliver([e], 2);
    await deliver([cod(ws)]); // another envelope id, same order
    await flush(ws);
    expect(sentJobs().filter((j) => j.idempotencyKey === 'cod:o1')).toHaveLength(1);
    expect(await tags(ws)).toEqual([{ tag: 'cod_pending' }]);
    expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE direction = 'out'")).toEqual([{ n: 1 }]);
    expect(await rows(ws, "SELECT count(*) AS n FROM scheduled_tasks WHERE kind = 'cod_no_reply'")).toEqual([{ n: 1 }]);
  });

  it('looks the order number and total up in the Store when the event does not carry them', async () => {
    const ws = W(3);
    await storeWorkspace(ws);
    const created = await link.fake.createOrderFromChat(ws, { items: [{ variantId: 'v1', quantity: 2 }], buyer: { buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, name: null, locale: 'ar' }, paymentMethod: 'cod', idempotencyKey: 'k' });
    if (!created.ok) throw new Error('setup');
    link.fake.calls.length = 0;
    await deliver([cod(ws, { orderId: created.value.orderId, orderNumber: undefined, totalMinor: undefined })]);
    const [job] = await flush(ws);
    expect(link.fake.count('listCustomerOrders')).toBe(1);
    expect(job!.template!.components[0]!.parameters.map((p) => p.text)).toEqual(['عميلنا العزيز', created.value.orderNumber, '200']);
  });

  it('two deliveries of one event racing at the Store lookup still send once', async () => {
    const ws = W(6);
    await storeWorkspace(ws);
    const created = await link.fake.createOrderFromChat(ws, { items: [{ variantId: 'v1', quantity: 1 }], buyer: { buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, name: null, locale: 'ar' }, paymentMethod: 'cod', idempotencyKey: 'k6' });
    if (!created.ok) throw new Error('setup');
    link.fake.latencyMs = 25; // a real service binding yields here, so the second run starts before the first commits
    const e = cod(ws, { orderId: created.value.orderId, orderNumber: undefined, totalMinor: undefined });
    const stub = workspace(ws);
    const [a, b] = await Promise.all([stub.applyStoreEvent(e as never, { phoneNumberId: `pn-${ws}` }), stub.applyStoreEvent(e as never, { phoneNumberId: `pn-${ws}` })]);
    expect([a.status, b.status].sort()).toEqual(['applied', 'duplicate']);
    expect((await flush(ws)).filter((j) => j.idempotencyKey.startsWith('cod:'))).toHaveLength(1);
  });

  it('retries the queue message when the Store is unreachable, and alerts (no send) when it does not know the order', async () => {
    const ws = W(4);
    await storeWorkspace(ws);
    link.fake.failNext.set('listCustomerOrders', 'unavailable');
    const first = await deliver([cod(ws, { orderNumber: undefined, totalMinor: undefined })]);
    expect(first.retryMessages?.map((m: { msgId: string }) => m.msgId)).toEqual(['e0']);
    expect(await rows(ws, 'SELECT 1 FROM processed_events')).toEqual([]);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = await deliver([cod(ws, { orderNumber: undefined, totalMinor: undefined })]);
    expect(second.explicitAcks).toEqual(['e0']);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('cod_request_details_missing'));
    expect(await flush(ws)).toEqual([]);
  });

  it('sends nothing when the template is not approved, and nothing is left half-written', async () => {
    const ws = W(5);
    await storeWorkspace(ws, { templates: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deliver([cod(ws)]);
    expect(await flush(ws)).toEqual([]);
    expect(await tags(ws)).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM store_orders')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('store_event_not_sent'));
  });
});

describe('other Store events', () => {
  it('order.created sends an order confirmation, but not for COD, for a chat order, or when switched off', async () => {
    const ws = W(10);
    await storeWorkspace(ws);
    const created = (orderId: string, o: Record<string, unknown> = {}) =>
      storeEvent(ws, 'order.created', { orderId, orderNumber: `N${orderId}`, buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', totalMinor: 5000, currency: 'EGP', paymentMethod: 'link', channel: 'web', ...o });
    await deliver([created('a'), created('b', { paymentMethod: 'cod' }), created('c', { channel: 'whatsapp' })]);
    expect((await flush(ws)).map((j) => j.idempotencyKey)).toEqual(['order:a:created']);
    expect(await rows(ws, 'SELECT order_id FROM store_orders ORDER BY order_id')).toEqual([{ order_id: 'a' }, { order_id: 'b' }, { order_id: 'c' }]);
    await workspace(ws).setStoreLinkSettings({ orderConfirmations: false });
    await deliver([created('d')]);
    expect((await flush(ws)).map((j) => j.idempotencyKey)).toEqual(['order:a:created']);
  });

  it('uses the customer name from the chat and falls back to Arabic when the locale has no template', async () => {
    const ws = W(11);
    await storeWorkspace(ws);
    await openChat(ws, WA_1);
    await exec(ws, "UPDATE contacts SET profile_name = '  أحمد\n سعيد ' WHERE wa_id = ?", WA_1);
    await deliver([storeEvent(ws, 'order.created', { orderId: 'o9', orderNumber: '77', buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'en', totalMinor: 1, currency: 'EGP', paymentMethod: 'wallet', channel: 'web' })]);
    const job = (await flush(ws)).find((j) => j.idempotencyKey === 'order:o9:created')!;
    expect(job.template).toMatchObject({ name: 'order_confirmation', language: 'ar' });
    expect(job.template!.components[0]!.parameters.map((p) => p.text)).toEqual(['أحمد سعيد', '77']);
    expect(await rows(ws, 'SELECT buyer_key FROM contacts WHERE wa_id = ?', WA_1)).toEqual([{ buyer_key: BUYER_KEY_1 }]);
  });

  it('shipment.updated sends the tracking template with the URL, the status template without it, and ignores statuses it does not announce', async () => {
    const ws = W(12);
    await storeWorkspace(ws);
    await deliver([storeEvent(ws, 'order.created', { orderId: 'o1', orderNumber: '1001', buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', totalMinor: 1, currency: 'EGP', paymentMethod: 'link', channel: 'web' })]);
    const ship = (shipmentId: string, status: string, extra: Record<string, unknown> = {}, at = Date.now()) =>
      storeEvent(ws, 'shipment.updated', { orderId: 'o1', shipmentId, status, updatedAt: iso(at), ...extra });
    await deliver([ship('s1', 'shipped', { trackingUrl: 'https://track.example/abc' }), ship('s2', 'delivered'), ship('s3', 'label_created')]);
    const jobs = (await flush(ws)).filter((j) => j.idempotencyKey.startsWith('ship:'));
    expect(jobs.map((j) => [j.idempotencyKey, j.template!.name])).toEqual([['ship:s1:shipped', 'shipping_tracking'], ['ship:s2:delivered', 'shipping_status']]);
    expect(jobs[0]!.template!.components[0]!.parameters.map((p) => p.text)).toEqual(['عميلنا العزيز', '1001', 'خرج للشحن 🚚', 'https://track.example/abc']);
    // the same status again (new envelope) is not announced twice
    await deliver([ship('s1', 'shipped', { trackingUrl: 'https://track.example/abc' })]);
    expect((await flush(ws)).filter((j) => j.idempotencyKey === 'ship:s1:shipped')).toHaveLength(1);
  });

  it('shipment.updated for an order we never heard of is skipped, not guessed', async () => {
    const ws = W(13);
    await storeWorkspace(ws);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deliver([storeEvent(ws, 'shipment.updated', { orderId: 'ghost', shipmentId: 's', status: 'shipped', updatedAt: iso() })]);
    expect(await flush(ws)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shipment_event_unknown_order'));
  });

  it('cart.abandoned is marketing: needs a recorded opt-in and no opt-out', async () => {
    const ws = W(14);
    await storeWorkspace(ws);
    const abandoned = (cartId: string) => storeEvent(ws, 'cart.abandoned', { cartId, buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', recoveryUrl: 'https://shop.example/cart/x' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deliver([abandoned('c1')]); // never opted in
    expect(await flush(ws)).toEqual([]);
    await openChat(ws, WA_1);
    await exec(ws, "UPDATE contacts SET consent_source = 'checkout', consent_at = 1 WHERE wa_id = ?", WA_1);
    await deliver([abandoned('c2')]);
    expect((await flush(ws)).map((j) => j.idempotencyKey)).toEqual(['cart:c2']);
    await exec(ws, 'UPDATE contacts SET opted_out_at = 5 WHERE wa_id = ?', WA_1);
    await deliver([abandoned('c3')]);
    expect((await flush(ws)).map((j) => j.idempotencyKey)).toEqual(['cart:c2']);
  });

  it('order.status_changed: cancelling a pending COD closes the request without an outcome; paid tells a customer inside the window', async () => {
    const ws = W(15);
    await storeWorkspace(ws);
    await deliver([cod(ws)]);
    await deliver([storeEvent(ws, 'order.status_changed', { orderId: 'o1', status: 'cancelled', updatedAt: iso() })]);
    expect(await rows(ws, 'SELECT cod_state, status, outcome FROM store_orders')).toEqual([{ cod_state: 'closed', status: 'cancelled', outcome: null }]);
    expect(await tags(ws)).toEqual([]);

    await deliver([storeEvent(ws, 'order.created', { orderId: 'o2', orderNumber: '2002', buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', totalMinor: 1, currency: 'EGP', paymentMethod: 'instapay', channel: 'whatsapp' })]);
    await deliver([storeEvent(ws, 'order.status_changed', { orderId: 'o2', status: 'paid', updatedAt: iso() })]);
    expect((await flush(ws)).filter((j) => j.idempotencyKey === 'order:o2:paid')).toEqual([]); // window closed: no free text
    await openChat(ws, WA_1);
    await deliver([storeEvent(ws, 'order.status_changed', { orderId: 'o2', status: 'paid', updatedAt: iso(Date.now() + 5) })]);
    const paid = (await flush(ws)).find((j) => j.idempotencyKey === 'order:o2:paid');
    expect(paid?.text).toContain('2002');
  });
});

describe('ordering, staleness and links', () => {
  it('drops a stale version of an entity, whatever order the events arrive in', async () => {
    const ws = W(20);
    await storeWorkspace(ws);
    const up = (at: number, deleted = false) => storeEvent(ws, deleted ? 'catalog.product_deleted' : 'catalog.product_upserted', { productId: 'p1', variantIds: ['v1'], updatedAt: iso(at) });
    const t = Date.now();
    await deliver([up(t + 2000, true)]);
    await deliver([up(t + 1000)]); // older upsert arrives after the delete
    expect(await rows(ws, 'SELECT deleted FROM catalog_dirty')).toEqual([{ deleted: 1 }]);
    const res = await workspace(ws).applyStoreEvent(up(t + 500) as never, { phoneNumberId: null });
    expect(res.status).toBe('stale');
  });

  it('coalesces catalog changes into one pending sync (30 s debounce)', async () => {
    const ws = W(21);
    await storeWorkspace(ws);
    const t = Date.now();
    await deliver([1, 2, 3].map((i) => storeEvent(ws, 'catalog.product_upserted', { productId: `p${i}`, variantIds: [`v${i}`], updatedAt: iso(t + i) })));
    const tasks = await rows<{ due_at: number }>(ws, "SELECT due_at FROM scheduled_tasks WHERE kind = 'catalog_sync'");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.due_at).toBeGreaterThan(Date.now() + 20_000);
    expect(await rows(ws, 'SELECT count(*) AS n FROM catalog_dirty')).toEqual([{ n: 3 }]);
  });

  it('tracks plan and link state; an unlinked store sends nothing and drops nothing silently', async () => {
    const ws = W(22);
    await storeWorkspace(ws);
    const t = Date.now();
    await deliver([storeEvent(ws, 'store.plan_changed', { planCode: 'business', includesWhatsApp: true, ownerUserId: 'u', effectiveAt: iso(t) }, { occurredAt: iso(t) })]);
    await deliver([storeEvent(ws, 'store.plan_changed', { planCode: 'basic', includesWhatsApp: false, ownerUserId: 'u', effectiveAt: iso(t - 9000) }, { occurredAt: iso(t - 9000) })]); // older
    expect(JSON.parse((await rows<{ value: string }>(ws, "SELECT value FROM store_state WHERE key = 'plan'"))[0]!.value)).toMatchObject({ planCode: 'business', includesWhatsApp: true });
    await deliver([storeEvent(ws, 'store.unlinked', { ownerUserId: 'u' })]);
    await deliver([cod(ws)]);
    expect(await flush(ws)).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM store_orders')).toEqual([]);
    await deliver([storeEvent(ws, 'store.linked', { ownerUserId: 'u' }, { occurredAt: iso(t + 10_000) })]);
    await deliver([cod(ws, { orderId: 'o7' })]);
    expect((await flush(ws)).map((j) => j.idempotencyKey)).toEqual(['cod:o7']);
  });

  it('customer.erased deletes the contact, its messages and its orders', async () => {
    const ws = W(23);
    await storeWorkspace(ws);
    await deliver([cod(ws)]);
    await flush(ws);
    expect(await rows(ws, 'SELECT 1 FROM messages')).toHaveLength(1);
    await deliver([storeEvent(ws, 'customer.erased', { buyerKey: BUYER_KEY_1 })]);
    for (const t of ['contacts', 'conversations', 'messages', 'store_orders', 'conversation_tags']) expect(await rows(ws, `SELECT 1 FROM ${t}`), t).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'send_release'")).toEqual([]);
  });

  it('customer.erased finds a contact that was never keyed by hashing the others', async () => {
    const ws = W(24);
    await storeWorkspace(ws);
    await openChat(ws, WA_1);
    await openChat(ws, '201112223334');
    const res = await deliver([storeEvent(ws, 'customer.erased', { buyerKey: BUYER_KEY_1 })]);
    expect(res.explicitAcks).toEqual(['e0']);
    expect(await rows(ws, 'SELECT wa_id FROM contacts')).toEqual([{ wa_id: '201112223334' }]);
  });

  it('customer.erased is honoured even when the store is unlinked', async () => {
    const ws = W(26);
    await storeWorkspace(ws);
    await openChat(ws, WA_1);
    await deliver([storeEvent(ws, 'store.unlinked', { ownerUserId: 'u' })]);
    await deliver([storeEvent(ws, 'customer.erased', { buyerKey: BUYER_KEY_1 })]);
    expect(await rows(ws, 'SELECT 1 FROM contacts')).toEqual([]);
  });

  it('a failed erasure is not recorded as done: the redelivery erases the contact', async () => {
    const ws = W(27);
    await storeWorkspace(ws);
    await openChat(ws, WA_1);
    const e = storeEvent(ws, 'customer.erased', { buyerKey: BUYER_KEY_1 });
    await runInDurableObject(workspace(ws), async (instance) => {
      vi.spyOn(instance, 'eraseContact').mockRejectedValueOnce(new Error('r2 down'));
      await expect(instance.applyStoreEvent(e as never, { phoneNumberId: null })).rejects.toThrow('r2 down');
    });
    expect(await rows(ws, 'SELECT 1 FROM contacts')).toHaveLength(1);
    expect(await rows(ws, 'SELECT 1 FROM processed_events WHERE event_id = ?', e.id)).toEqual([]);
    const res = await deliver([e], 2);
    expect(res.explicitAcks).toEqual(['e0']);
    expect(await rows(ws, 'SELECT 1 FROM contacts')).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM processed_events WHERE event_id = ?', e.id)).toHaveLength(1);
  });

  it('customer.erased for a customer we do not know is acknowledged and changes nothing', async () => {
    const ws = W(25);
    await storeWorkspace(ws);
    await openChat(ws, '201112223334');
    const res = await deliver([storeEvent(ws, 'customer.erased', { buyerKey: 'c'.repeat(64) })]);
    expect(res.explicitAcks).toEqual(['e0']);
    expect(await rows(ws, 'SELECT wa_id FROM contacts')).toEqual([{ wa_id: '201112223334' }]);
  });
});

describe('queue consumer', () => {
  it('acks and ignores malformed bodies, unknown types and future versions', async () => {
    const ws = W(30);
    await storeWorkspace(ws);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await deliver([{ nope: true }, storeEvent(ws, 'loyalty.points', {}), { ...storeEvent(ws, 'store.linked', { ownerUserId: 'u' }), v: 2 }]);
    expect(res.explicitAcks).toEqual(['e0', 'e1', 'e2']);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('retries an event for a workspace that is not registered (yet)', async () => {
    const res = await deliver([storeEvent(W(31), 'store.linked', { ownerUserId: 'u' })]);
    expect(res.retryMessages?.map((m: { msgId: string }) => m.msgId)).toEqual(['e0']);
  });

  it('retries when the workspace lookup throws, never loses the event', async () => {
    const ws = W(32);
    await storeWorkspace(ws);
    vi.spyOn(env.DB, 'prepare').mockImplementationOnce(() => { throw new Error('d1 down'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await deliver([storeEvent(ws, 'store.linked', { ownerUserId: 'u' })]);
    expect(res.retryMessages?.map((m: { msgId: string }) => m.msgId)).toEqual(['e0']);
    expect(res.explicitAcks).toEqual([]);
  });

  it('logs the class of a failure, never its text: no phone number or e-mail from a thrown message survives', async () => {
    const ws = W(34);
    await storeWorkspace(ws);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const thrown of [new Error('failed for +20 100 123 4567 / ‎٠١٠٠١٢٣٤٥٦٧ and ahmad@example.com'), 'plain string with +201001234567', { message: 'x@y.org 01001234567' }, null]) {
      vi.spyOn(env.DB, 'prepare').mockImplementationOnce(() => { throw thrown; });
      const res = await deliver([storeEvent(ws, 'store.linked', { ownerUserId: 'u' })]);
      expect(res.retryMessages?.map((m: { msgId: string }) => m.msgId)).toEqual(['e0']);
    }
    const lines = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toContain('store_event_failed');
    for (const leak of ['4567', '123', 'ahmad', 'example.com', '٠١٠٠', '01001234567', 'x@y.org', 'plain string']) expect(lines, leak).not.toContain(leak);
    expect(lines).toContain('"error":"Error"');
  });

  it('skips a customer-facing event when the workspace has no active number (nothing to send from)', async () => {
    const ws = W(33);
    await storeWorkspace(ws);
    await env.DB.prepare("UPDATE phone_numbers SET status = 'disconnected' WHERE workspace_id = ?").bind(ws).run();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await deliver([cod(ws)]);
    expect(res.explicitAcks).toEqual(['e0']);
    expect(await flush(ws)).toEqual([]);
  });
});
