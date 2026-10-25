import { SELF, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { apiFor, useApiKey } from './helpers/api';
import { postWebhook } from './helpers/meta';
import { rawMessagePayload, templateButton } from './helpers/payload';
import { BUYER_KEY_1, PHONE_1, WA_1, deliver, flush, iso, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

useApiKey();
const link = useStoreLink();
const S = (n: number) => `00000000-0000-4000-8000-0000000047${String(n).padStart(2, '0')}`;
const buyer = { buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, name: null, locale: 'ar' as const };
const DAY = 86_400_000;

async function codOrder(ws: string) {
  const made = await link.fake.createOrderFromChat(ws, { items: [{ variantId: 'v1', quantity: 1 }], buyer, paymentMethod: 'cod', idempotencyKey: `k-${ws}` });
  if (!made.ok) throw new Error('setup');
  await deliver([storeEvent(ws, 'order.cod_confirmation_requested', { orderId: made.value.orderId, buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', deadlineAt: iso(Date.now() + DAY), orderNumber: made.value.orderNumber, totalMinor: 10_000, currency: 'EGP' })]);
  await flush(ws);
  return made.value;
}
const spyCi = () => vi.spyOn(env.CI_OUTCOMES!, 'writeDataPoint');
const tap = (pn: string, wamid: string, payload: string) => postWebhook(SELF, rawMessagePayload(pn, templateButton(wamid, 'أيوه، أكّد الطلب', payload)));

describe('commerce_outcomes (CI-1)', () => {
  it('writes one data point per outcome: hashed customer key, store, outcome, order, channel; no phone number', async () => {
    const ws = S(1);
    const pn = await storeWorkspace(ws);
    const o = await codOrder(ws);
    const ci = spyCi();
    const before = Date.now();
    await tap(pn, 'wamid.c1', `cod:y:${o.orderId}`);
    await tap(pn, 'wamid.c1', `cod:y:${o.orderId}`); // Meta redelivery
    await tap(pn, 'wamid.c2', `cod:y:${o.orderId}`); // the customer taps again
    await workspace(ws).runDueTasks();
    expect(ci).toHaveBeenCalledTimes(1);
    const point = ci.mock.calls[0]![0]!;
    expect(point).toMatchObject({ indexes: [ws], blobs: [BUYER_KEY_1, ws, 'confirmed', o.orderId, 'whatsapp'] });
    expect(point.doubles![0]).toBeGreaterThanOrEqual(before);
    expect(JSON.stringify(point)).not.toContain(WA_1);
  });

  it('records no_reply 24 h after a COD request nobody answered, tells the Store, and drops the tag', async () => {
    const ws = S(2);
    await storeWorkspace(ws);
    const o = await codOrder(ws);
    const ci = spyCi();
    await workspace(ws).runDueTasks(Date.now() + DAY - 60_000); // not yet
    expect(ci).not.toHaveBeenCalled();
    expect(link.fake.count('recordCodOutcome')).toBe(0);
    await workspace(ws).runDueTasks(Date.now() + DAY + 60_000);
    expect(ci).toHaveBeenCalledTimes(1);
    expect(ci.mock.calls[0]![0]!.blobs).toEqual([BUYER_KEY_1, ws, 'no_reply', o.orderId, 'whatsapp']);
    expect(link.fake.orders.get(o.orderId)!.codOutcome).toBe('no_reply');
    expect(link.sink.sent.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['no_reply']);
    expect(await rows(ws, 'SELECT tag FROM conversation_tags')).toEqual([]);
  });

  it('an answered or cancelled request is not marked no_reply', async () => {
    const ws = S(3);
    const pn = await storeWorkspace(ws);
    const answered = await codOrder(ws);
    const ci = spyCi();
    await tap(pn, 'wamid.c3', `cod:y:${answered.orderId}`);
    await workspace(ws).runDueTasks();
    ci.mockClear();
    link.fake.calls.length = 0;
    await workspace(ws).runDueTasks(Date.now() + 2 * DAY);
    expect(ci).not.toHaveBeenCalled();
    expect(link.fake.count('recordCodOutcome')).toBe(0);

    const ws2 = S(4);
    await storeWorkspace(ws2);
    const o2 = await codOrder(ws2);
    await deliver([storeEvent(ws2, 'order.status_changed', { orderId: o2.orderId, status: 'cancelled', updatedAt: iso() })]);
    await workspace(ws2).runDueTasks(Date.now() + 2 * DAY);
    expect(ci).not.toHaveBeenCalled();
  });

  it('a real answer after no_reply is recorded as its own outcome', async () => {
    const ws = S(5);
    const pn = await storeWorkspace(ws);
    const o = await codOrder(ws);
    const ci = spyCi();
    await workspace(ws).runDueTasks(Date.now() + DAY + 60_000);
    await tap(pn, 'wamid.c4', `cod:n:${o.orderId}`);
    await workspace(ws).runDueTasks();
    expect(ci.mock.calls.map((c) => c[0]!.blobs![2])).toEqual(['no_reply', 'refused']);
    expect(link.fake.calls.filter((c) => c.method === 'recordCodOutcome').map((c) => (c.args[1] as { outcome: string }).outcome)).toEqual(['no_reply', 'refused']);
  });

  it('merchant answers from the inbox are recorded too', async () => {
    const ws = S(6);
    const api = await apiFor(ws);
    await storeWorkspace(ws);
    const o = await codOrder(ws);
    const ci = spyCi();
    await api.call('POST', `/contacts/${WA_1}/orders/${o.orderNumber}/cod-outcome`, { outcome: 'refused', idempotencyKey: '00000000-0000-4000-8000-000000004799' });
    expect(ci).toHaveBeenCalledTimes(1);
    expect(ci.mock.calls[0]![0]!.blobs![2]).toBe('refused');
  });

  it('a failing analytics dataset never blocks the outcome', async () => {
    const ws = S(7);
    const pn = await storeWorkspace(ws);
    const o = await codOrder(ws);
    vi.spyOn(env.CI_OUTCOMES!, 'writeDataPoint').mockImplementation(() => { throw new Error('analytics down'); });
    await tap(pn, 'wamid.c5', `cod:y:${o.orderId}`);
    await workspace(ws).runDueTasks();
    expect(link.fake.orders.get(o.orderId)!.codOutcome).toBe('confirmed');
  });

  it('an order the merchant adopts carries the customer key the route computed', async () => {
    const ws = S(8);
    await storeWorkspace(ws);
    const api = await apiFor(ws);
    const made = await link.fake.createOrderFromChat(ws, { items: [{ variantId: 'v1', quantity: 1 }], buyer, paymentMethod: 'cod', idempotencyKey: 'nokey' });
    if (!made.ok) throw new Error('setup');
    const ci = spyCi();
    // adopted through the route: the route supplies the key it computed, so the point exists
    await api.call('POST', `/contacts/${WA_1}/orders/${made.value.orderNumber}/cod-outcome`, { outcome: 'confirmed', idempotencyKey: '00000000-0000-4000-8000-000000004798' });
    expect(ci.mock.calls[0]![0]!.blobs![0]).toBe(BUYER_KEY_1);
  });
});

