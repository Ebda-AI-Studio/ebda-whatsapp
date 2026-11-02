import { describe, expect, it } from 'vitest';
import { createServiceBindingBridge } from '../src/addons/ebda/store-bridge';
import { parseStoreEvent } from '../src/core/api/store-events';
import type { Buyer } from '../src/core/store-bridge';
import { FAKE_STORE_ID, FakeStore } from './helpers/fake-store';

const buyer: Buyer = { buyerKey: 'a'.repeat(64), phoneE164: '+201001234567', name: 'أحمد', locale: 'ar' };
const idem = (n: number) => `idem-${n}`;

describe('fake store (the contract, in memory)', () => {
  it('refuses every call for another store or an unlinked one', async () => {
    const s = new FakeStore();
    expect(await s.getStoreProfile('someone-else')).toMatchObject({ ok: false, reason: 'not_linked' });
    s.linked = false;
    expect(await s.getStoreProfile(FAKE_STORE_ID)).toMatchObject({ ok: false, reason: 'not_linked' });
  });

  it('pages the catalog with an opaque cursor', async () => {
    const s = new FakeStore();
    const a = await s.listCatalog(FAKE_STORE_ID, null, 10);
    expect(a.ok && a.value.items).toHaveLength(10);
    const b = await s.listCatalog(FAKE_STORE_ID, a.ok ? a.value.nextCursor : null, 100);
    expect(b.ok && b.value.items).toHaveLength(13);
    expect(b.ok && b.value.nextCursor).toBeNull();
  });

  it('checks and reserves stock, and creates an order once per idempotency key', async () => {
    const s = new FakeStore(FAKE_STORE_ID, { stock: { v1: 2 } });
    const req = { items: [{ variantId: 'v1', quantity: 2 }], buyer, paymentMethod: 'cod' as const, idempotencyKey: idem(1) };
    const first = await s.createOrderFromChat(FAKE_STORE_ID, req);
    const again = await s.createOrderFromChat(FAKE_STORE_ID, req);
    expect(first.ok && again.ok && first.value.orderId === again.value.orderId).toBe(true);
    expect(s.stock.v1).toBe(0);
    const over = await s.createOrderFromChat(FAKE_STORE_ID, { ...req, idempotencyKey: idem(2) });
    expect(over).toMatchObject({ ok: false, reason: 'out_of_stock', outOfStock: ['v1'] });
  });

  it('keeps an InstaPay order pending_payment, even after a payment proof', async () => {
    const s = new FakeStore();
    const made = await s.createOrderFromChat(FAKE_STORE_ID, { items: [{ variantId: 'v2', quantity: 1 }], buyer, paymentMethod: 'instapay', idempotencyKey: idem(3) });
    if (!made.ok) throw new Error('order failed');
    expect(made.value.instapay).toMatchObject({ ipa: 'shop@instapay', amountMinor: 10_500 });
    await s.attachPaymentProof(FAKE_STORE_ID, made.value.orderId, 'https://proof.example/1');
    expect(s.orders.get(made.value.orderId)!.status).toBe('pending_payment');
    s.markPaid(made.value.orderId);
    expect(s.orders.get(made.value.orderId)!.status).toBe('confirmed');
  });

  it('refuses a payment method the store has not enabled', async () => {
    const s = new FakeStore(FAKE_STORE_ID, { paymentMethods: ['cod'] });
    expect(await s.createOrderFromChat(FAKE_STORE_ID, { items: [{ variantId: 'v1', quantity: 1 }], buyer, paymentMethod: 'instapay', idempotencyKey: idem(4) })).toMatchObject({ ok: false, reason: 'payment_method_disabled' });
  });

  it('applies a COD outcome once', async () => {
    const s = new FakeStore();
    const made = await s.createOrderFromChat(FAKE_STORE_ID, { items: [{ variantId: 'v1', quantity: 1 }], buyer, paymentMethod: 'cod', idempotencyKey: idem(5) });
    if (!made.ok) throw new Error('order failed');
    const base = { orderId: made.value.orderId, at: new Date().toISOString(), idempotencyKey: idem(6) };
    await s.recordCodOutcome(FAKE_STORE_ID, { ...base, outcome: 'confirmed' });
    await s.recordCodOutcome(FAKE_STORE_ID, { ...base, outcome: 'refused' });
    expect(s.orders.get(made.value.orderId)).toMatchObject({ codOutcome: 'confirmed', status: 'confirmed' });
  });
});

describe('Service Binding adapter', () => {
  const profile = { ok: true, value: { name: 'x', logoUrl: null, locale: 'ar', currency: 'EGP', paymentMethods: ['cod'], codEnabled: true, instapay: null } };

  it('is null when nothing is bound (the link is off)', () => {
    expect(createServiceBindingBridge({})).toBeNull();
  });

  it('passes the store id first and returns a validated answer', async () => {
    const seen: unknown[][] = [];
    const bridge = createServiceBindingBridge({ STORE_BRIDGE: { getStoreProfile: async (...a: unknown[]) => (seen.push(a), profile) } as unknown as Fetcher })!;
    expect(await bridge.getStoreProfile(FAKE_STORE_ID)).toMatchObject({ ok: true, value: { name: 'x' } });
    expect(seen).toEqual([[FAKE_STORE_ID]]);
  });

  it('turns a throw, a malformed answer and a Store refusal into result objects', async () => {
    const bridge = createServiceBindingBridge({
      STORE_BRIDGE: {
        getStoreProfile: async () => { throw new Error('boom'); },
        listCatalog: async () => ({ ok: true, value: { items: 'nope' } }),
        getPaymentLink: async () => ({ ok: false, reason: 'not_found' }),
      } as unknown as Fetcher,
    })!;
    expect(await bridge.getStoreProfile(FAKE_STORE_ID)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await bridge.listCatalog(FAKE_STORE_ID, null, 10)).toMatchObject({ ok: false, reason: 'unavailable', message: expect.stringContaining('malformed') });
    expect(await bridge.getPaymentLink(FAKE_STORE_ID, 'o1')).toEqual({ ok: false, reason: 'not_found' });
    // a method the Store does not implement yet is also just unavailable
    expect(await bridge.getOrderStatus(FAKE_STORE_ID, '1', 'k')).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('Service Binding adapter: membership (the Store answers with the bare value and throws, no envelope)', () => {
  const U = 'b0000000-0000-4000-8000-000000000001';
  const member = { userId: U, displayName: 'Mona', role: 'staff', addedAt: '2026-10-01T00:00:00.000Z' };

  it('reads the bare role and the bare list, store id first', async () => {
    const seen: unknown[][] = [];
    const bridge = createServiceBindingBridge({ STORE_BRIDGE: {
      memberRole: async (...a: unknown[]) => (seen.push(a), 'staff'),
      listStoreMembers: async (...a: unknown[]) => (seen.push(a), { items: [member] }),
    } as unknown as Fetcher })!;
    expect(await bridge.memberRole(FAKE_STORE_ID, U)).toEqual({ ok: true, value: { role: 'staff' } });
    expect(await bridge.listStoreMembers(FAKE_STORE_ID, 'owner-1')).toEqual({ ok: true, value: { items: [member] } });
    expect(seen).toEqual([[FAKE_STORE_ID, U], [FAKE_STORE_ID, 'owner-1']]);
  });

  it('null is "not a member" (an answer), a throw or a malformed answer is "unavailable" (never read as no members)', async () => {
    const bridge = createServiceBindingBridge({ STORE_BRIDGE: {
      memberRole: async () => null,
      listStoreMembers: async () => ({ items: 'nope' }),
    } as unknown as Fetcher })!;
    expect(await bridge.memberRole(FAKE_STORE_ID, U)).toEqual({ ok: true, value: { role: null } });
    expect(await bridge.listStoreMembers(FAKE_STORE_ID, 'o')).toMatchObject({ ok: false, reason: 'unavailable' });
    const down = createServiceBindingBridge({ STORE_BRIDGE: { memberRole: async () => { throw new Error('db down'); } } as unknown as Fetcher })!;
    expect(await down.memberRole(FAKE_STORE_ID, U)).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('the Store\'s FORBIDDEN / INVALID_ID throws are `invalid`, so a non-owner asker is not retried as an outage', async () => {
    const bridge = createServiceBindingBridge({ STORE_BRIDGE: {
      listStoreMembers: async () => { throw new Error('FORBIDDEN'); },
      memberRole: async () => { throw new Error('INVALID_ID'); },
    } as unknown as Fetcher })!;
    expect(await bridge.listStoreMembers(FAKE_STORE_ID, 'x')).toEqual({ ok: false, reason: 'invalid', message: 'FORBIDDEN' });
    expect(await bridge.memberRole(FAKE_STORE_ID, 'x')).toEqual({ ok: false, reason: 'invalid', message: 'INVALID_ID' });
  });
});

describe('Store event envelope', () => {
  const base = { id: '0b6f1c7e-1d2a-4f3b-9c8d-7e6f5a4b3c2d', v: 1, storeId: FAKE_STORE_ID, occurredAt: '2026-10-25T10:00:00.000Z' };
  const key = 'b'.repeat(64);

  it('accepts every event type of the contract', () => {
    const data: Record<string, unknown> = {
      'store.plan_changed': { planCode: 'business', includesWhatsApp: true, ownerUserId: 'u', effectiveAt: '2026-10-25T10:00:00.000Z' },
      'store.linked': { ownerUserId: 'u' },
      'store.unlinked': { ownerUserId: 'u' },
      'catalog.product_upserted': { productId: 'p1', variantIds: ['v1'], updatedAt: '2026-10-25T10:00:00.000Z' },
      'catalog.product_deleted': { productId: 'p1', variantIds: ['v1'], updatedAt: '2026-10-25T10:00:00.000Z' },
      'order.created': { orderId: 'o1', orderNumber: '1001', buyerKey: key, phoneE164: '+201001234567', locale: 'ar', totalMinor: 75_000, currency: 'EGP', paymentMethod: 'instapay', channel: 'web' },
      'order.cod_confirmation_requested': { orderId: 'o1', buyerKey: key, phoneE164: '+201001234567', locale: 'ar', deadlineAt: '2026-10-26T10:00:00.000Z' },
      'order.status_changed': { orderId: 'o1', status: 'paid', updatedAt: '2026-10-25T10:00:00.000Z' },
      'shipment.updated': { orderId: 'o1', shipmentId: 's1', status: 'shipped', updatedAt: '2026-10-25T10:00:00.000Z' },
      'cart.abandoned': { cartId: 'c1', buyerKey: key, phoneE164: '+201001234567', locale: 'ar', recoveryUrl: 'https://shop.example/cart/c1' },
      'customer.erased': { buyerKey: key },
    };
    for (const [type, d] of Object.entries(data)) expect(parseStoreEvent({ ...base, type, data: d }), type).toMatchObject({ ok: true });
  });

  it('separates an unknown type, a future version and a malformed body', () => {
    expect(parseStoreEvent({ ...base, type: 'loyalty.points', data: {} })).toEqual({ ok: false, reason: 'unknown_type' });
    expect(parseStoreEvent({ ...base, v: 2, type: 'store.linked', data: { ownerUserId: 'u' } })).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(parseStoreEvent({ ...base, type: 'order.status_changed', data: { orderId: 'o1' } })).toEqual({ ok: false, reason: 'invalid' });
    expect(parseStoreEvent({ type: 'store.linked' })).toEqual({ ok: false, reason: 'invalid' });
    expect(parseStoreEvent(null)).toEqual({ ok: false, reason: 'invalid' });
  });
});
