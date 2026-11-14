import { z } from 'zod';
import type { Env } from '../../env';
import {
  addressSchema, bridgeResultSchema, memberRoleSchema, storeMembersSchema, catalogPageSchema, checkoutLinkSchema, codOutcomeAckSchema, customerOrdersSchema, orderCreatedSchema, orderStatusSchema, paymentLinkSchema, productsSchema,
  storeProfileSchema, type BridgeResult, type StoreBridge,
} from '../../core/store-bridge';

/** The methods the Store's `WhatsAppBridge` entrypoint exposes over the Service Binding (contract section 5). */
type Rpc = Record<string, (...args: unknown[]) => Promise<unknown>>;

export const RPC_TIMEOUT_MS = 8_000;
const unavailable = (message: string): BridgeResult<never> => ({ ok: false, reason: 'unavailable', message });

/**
 * Adapter over `env.STORE_BRIDGE`. Every answer is validated (the Store is another deploy and may drift); a thrown RPC,
 * a timeout or a malformed answer becomes `unavailable`, never an exception, so one slow Store call cannot break a
 * webhook or a queue batch. Returns null when the binding is absent (the Store link is off).
 */
export function createServiceBindingBridge(env: Pick<Env, 'STORE_BRIDGE'>): StoreBridge | null {
  const binding = env.STORE_BRIDGE as unknown as Rpc | undefined;
  if (!binding) return null;
  async function call<S extends z.ZodType>(method: string, schema: S, ...args: unknown[]): Promise<BridgeResult<z.infer<S>>> {
    let raw: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      raw = await Promise.race([
        binding![method]!(...args),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), RPC_TIMEOUT_MS); }),
      ]);
    } catch (err) {
      return unavailable(`rpc ${method}: ${(err as Error).message}`.slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
    const parsed = bridgeResultSchema(schema).safeParse(raw);
    if (!parsed.success) return unavailable(`rpc ${method}: malformed answer`);
    return parsed.data as BridgeResult<z.infer<S>>;
  }
  /**
   * The two membership methods answer with the bare value (and THROW FORBIDDEN / INVALID_ID), not the result envelope the commerce methods use
   * (Store apps/api/src/lib/store-members.ts). A throw we recognise becomes `invalid`; any other failure, a timeout or a malformed answer is `unavailable`.
   */
  async function callBare<S extends z.ZodType>(method: string, schema: S, ...args: unknown[]): Promise<BridgeResult<z.infer<S>>> {
    let raw: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      raw = await Promise.race([
        binding![method]!(...args),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), RPC_TIMEOUT_MS); }),
      ]);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/FORBIDDEN|INVALID_ID/.test(msg)) return { ok: false, reason: 'invalid', message: /FORBIDDEN/.test(msg) ? 'FORBIDDEN' : 'INVALID_ID' };
      return unavailable(`rpc ${method}: ${msg}`.slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return unavailable(`rpc ${method}: malformed answer`);
    return { ok: true, value: parsed.data };
  }
  return {
    getStoreProfile: (s) => call('getStoreProfile', storeProfileSchema, s),
    listCatalog: (s, cursor, limit) => call('listCatalog', catalogPageSchema, s, cursor, limit),
    getProducts: (s, ids) => call('getProducts', productsSchema, s, ids),
    createCheckoutLink: (s, req) => call('createCheckoutLink', checkoutLinkSchema, s, req),
    createOrderFromChat: (s, req) => call('createOrderFromChat', orderCreatedSchema, s, req),
    getPaymentLink: (s, orderId) => call('getPaymentLink', paymentLinkSchema, s, orderId),
    recordCodOutcome: (s, req) => call('recordCodOutcome', codOutcomeAckSchema, s, req),
    attachPaymentProof: (s, orderId, mediaUrl) => call('attachPaymentProof', z.object({}), s, orderId, mediaUrl) as Promise<BridgeResult<Record<string, never>>>,
    getCustomerAddresses: (s, key) => call('getCustomerAddresses', z.object({ items: z.array(addressSchema) }), s, key),
    saveCustomerAddress: (s, key, address) => call('saveCustomerAddress', z.object({ address: addressSchema }), s, key, address),
    getOrderStatus: (s, n, key) => call('getOrderStatus', orderStatusSchema, s, n, key),
    listCustomerOrders: (s, key, limit) => call('listCustomerOrders', customerOrdersSchema, s, key, limit),
    getRecommendations: (s, req) => call('getRecommendations', productsSchema, s, req),
    listStoreMembers: (s, asUserId) => callBare('listStoreMembers', storeMembersSchema, s, asUserId),
    memberRole: async (s, userId) => {
      const r = await callBare('memberRole', memberRoleSchema.nullable(), s, userId);
      return r.ok ? { ok: true, value: { role: r.value } } : r;
    },
  };
}
