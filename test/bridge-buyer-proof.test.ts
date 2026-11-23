import { describe, expect, it } from 'vitest';
import { createServiceBindingBridge } from '../src/addons/ebda/store-bridge';

// Store PR #648 (rulings WA-BRIDGE-BIND-1/2): the 7 calls that name a buyer or an order carry a proof in the Store's positional order.
// The flow tests (strict FakeStore, requireProof) prove each call SITE sends it from the verified sender; this proves the adapter forwards it.
const PHONE = '+201001234567';
const KEY = 'e8771d4105457e95d06a8589827d6c09043f73bb1750f2ef525bccbc22d67edd';
const calls: unknown[][] = [];
const binding = new Proxy({}, { get: (_t, m: string) => async (...a: unknown[]) => { calls.push([m, ...a]); return { ok: false, reason: 'not_found' }; } });
const bridge = createServiceBindingBridge({ STORE_BRIDGE: binding } as never)!;
const S = '11111111-1111-4111-8111-111111111111';

describe('buyer proof on the wire', () => {
  it.each([
    ['getCustomerAddresses', () => bridge.getCustomerAddresses(S, KEY, PHONE), [S, KEY, PHONE]],
    ['saveCustomerAddress', () => bridge.saveCustomerAddress(S, KEY, { area: 'a', street: 's' }, PHONE), [S, KEY, { area: 'a', street: 's' }, PHONE]],
    ['getOrderStatus', () => bridge.getOrderStatus(S, 'EB-1', KEY, PHONE), [S, 'EB-1', KEY, PHONE]],
    ['listCustomerOrders', () => bridge.listCustomerOrders(S, KEY, 5, PHONE), [S, KEY, 5, PHONE]],
    ['getPaymentLink', () => bridge.getPaymentLink(S, 'o1', KEY), [S, 'o1', KEY]],
    ['attachPaymentProof', () => bridge.attachPaymentProof(S, 'o1', 'https://m.example/p.jpg', KEY), [S, 'o1', 'https://m.example/p.jpg', KEY]],
    ['recordCodOutcome', () => bridge.recordCodOutcome(S, { orderId: 'o1', buyerKey: KEY, outcome: 'confirmed', at: '2026-11-12T10:00:00.000Z', idempotencyKey: 'example-idem-0001' }), [S, { orderId: 'o1', buyerKey: KEY, outcome: 'confirmed', at: '2026-11-12T10:00:00.000Z', idempotencyKey: 'example-idem-0001' }]],
  ])('%s forwards the proof in the Store\'s argument order', async (method, run, args) => {
    calls.length = 0;
    await run();
    expect(calls).toEqual([[method, ...args]]);
  });

  it('without a proof the call keeps the old shape (the relaxed rollout window)', async () => {
    calls.length = 0;
    await bridge.getOrderStatus(S, 'EB-1', KEY);
    expect(calls).toEqual([['getOrderStatus', S, 'EB-1', KEY]]);
  });
});
