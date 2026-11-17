import { describe, expect, it } from 'vitest';
import fx from '../vectors/bridge-v1.json';
import ctx from '../vectors/bridge-chat-context-v2.json';
import { createServiceBindingBridge } from '../src/addons/ebda/store-bridge';
import type { StoreBridge } from '../src/core/store-bridge';

/**
 * Caller side of the Store's WhatsAppBridge contract (audit WA-RPC). `vectors/bridge-v1.json` is the Store's recorded conversation
 * (vendored byte for byte, sha pinned in vendored-artifacts.test.ts; the Store replays the same file against its real service).
 * A fake binding answers each recorded call with the recorded bytes; our adapter must (a) call the method with the recorded
 * args and (b) validate and surface the answer unchanged. A shape drift on either side fails here.
 */
type Case = { name: string; method: string; args: unknown[]; expect: unknown };
const cases = fx.cases as Case[];

const REGISTERED = ['getStoreProfile', 'listCatalog', 'getProducts', 'createCheckoutLink', 'createOrderFromChat', 'getPaymentLink', 'recordCodOutcome', 'attachPaymentProof', 'getCustomerAddresses', 'saveCustomerAddress', 'getOrderStatus', 'listCustomerOrders'];

describe('Store bridge contract vectors', () => {
  it('the fixture covers every RPC the adapter calls', () => {
    expect([...new Set(cases.map(c => c.method))].sort()).toEqual([...REGISTERED].sort());
  });
  for (const c of cases) {
    it(c.name, async () => {
      const calls: unknown[][] = [];
      const binding = new Proxy({}, { get: (_t, m: string) => async (...a: unknown[]) => { calls.push([m, ...a]); return c.expect; } });
      const bridge = createServiceBindingBridge({ STORE_BRIDGE: binding } as never) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const got = await bridge[c.method]!(...c.args);
      expect(calls).toEqual([[c.method, ...c.args]]);
      // A well-formed recorded answer passes through unchanged; a malformed one would have been turned into `unavailable`.
      expect(got, 'adapter must accept the Store answer as recorded').toEqual(c.expect);
    });
  }
  it('the adapter implements the whole StoreBridge interface the fixture drives', () => {
    const b = createServiceBindingBridge({ STORE_BRIDGE: {} } as never) as StoreBridge;
    for (const m of REGISTERED) expect(typeof (b as unknown as Record<string, unknown>)[m]).toBe('function');
  });
});

describe('chat-context contract vectors (Store ruling CHAT-AGENT-1)', () => {
  const chat = ctx.cases as Case[];
  it('covers the three context RPCs', () => {
    expect([...new Set(chat.map(c => c.method))].sort()).toEqual(['getCustomerProfile', 'getStorePolicies', 'searchProducts']);
  });
  for (const c of chat) {
    it(c.name, async () => {
      const calls: unknown[][] = [];
      const binding = new Proxy({}, { get: (_t, m: string) => async (...a: unknown[]) => { calls.push([m, ...a]); return c.expect; } });
      const bridge = createServiceBindingBridge({ STORE_BRIDGE: binding } as never) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      const got = await bridge[c.method]!(...c.args);
      expect(calls).toEqual([[c.method, ...c.args]]);
      expect(got, 'adapter must accept the Store answer as recorded').toEqual(c.expect);
    });
  }
});

describe('typed business refusals (Store ruling WA-RPC-8)', () => {
  it('the refusal code survives the adapter, so Chat can show the buyer and never retries', async () => {
    const answer = { ok: false, reason: 'invalid', code: 'MIN_ORDER_NOT_MET', message: 'minimum order not met' };
    const binding = { createOrderFromChat: async () => answer };
    const b = createServiceBindingBridge({ STORE_BRIDGE: binding } as never)!;
    expect(await b.createOrderFromChat('s', {} as never)).toEqual(answer);
  });
});
