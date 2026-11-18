/**
 * The commerce side as this service sees it. The Store owns orders, stock, prices and payment state; we only ask.
 * Mirrors the integration contract section 5 (incl. the InstaPay addendum). Every method takes the store id first and
 * answers with a result object: an expected failure (out of stock, store not linked) is data, never a throw, so it
 * survives the RPC boundary. Monetary amounts are integer minor units (piasters).
 */
import { z } from 'zod';

export const chatPaymentMethod = z.enum(['cod', 'link', 'instapay']);
export type ChatPaymentMethod = z.infer<typeof chatPaymentMethod>;

export const storeProfileSchema = z.object({
  name: z.string(),
  logoUrl: z.string().nullable(),
  locale: z.enum(['ar', 'en']),
  currency: z.string().length(3),
  paymentMethods: z.array(chatPaymentMethod),
  codEnabled: z.boolean(),
  /** Present when `instapay` is enabled: where the customer sends the transfer. */
  instapay: z.object({ ipa: z.string().min(1), displayName: z.string() }).nullable(),
});
export type StoreProfile = z.infer<typeof storeProfileSchema>;

/** One sellable variant, shaped for Meta's catalog feed (retailer id = variant id). */
export const catalogRowSchema = z.object({
  retailerId: z.string().min(1),
  productId: z.string().min(1),
  title: z.string(),
  titleAr: z.string().nullable(),
  description: z.string().nullable(),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  availability: z.enum(['in_stock', 'out_of_stock']),
  imageUrl: z.string().nullable(),
  link: z.string(),
  brand: z.string().nullable(),
});
export type CatalogRow = z.infer<typeof catalogRowSchema>;
export const catalogPageSchema = z.object({ items: z.array(catalogRowSchema), nextCursor: z.string().nullable() });
export type CatalogPage = z.infer<typeof catalogPageSchema>;
export const productsSchema = z.object({ items: z.array(catalogRowSchema) });
/**
 * Recommendations (Store `getRecommendations`, Ruling CHAT-RECS-1): rows read from the store just now, active + public + in stock. `seedIds` are
 * retailer ids; `orderNumber` + `buyerKey` (+ `phoneE164`) make the buyer's own order the seed. The tenant is the store id argument, never a field here.
 */
export type RecommendationRequest = { seedIds: string[]; orderNumber?: string; buyerKey?: string; phoneE164?: string; mode: 'similar' | 'complement'; limit: number; maxPriceMinor?: number };
/** The Store's ranked search: `degraded` = the meaning leg was wanted but skipped (budget, limit, outage), so an EMPTY list is not a real negative (Store ruling CHAT-AGENT-6). */
export const searchResultSchema = z.object({ items: z.array(catalogRowSchema), degraded: z.boolean().default(false) });
export type SearchResult = z.infer<typeof searchResultSchema>;

/**
 * Chat-agent context (Store ruling CHAT-AGENT-1). Policies: only what the merchant DECLARED; absent = null / empty, never a default,
 * so the agent may not state a fee, window or hours the Store did not return. Money is integer minor units (piasters).
 */
export const shippingZoneSchema = z.object({
  name: z.string(), nameAr: z.string().nullable(), areas: z.array(z.string()), feeMinor: z.number().int().nonnegative(),
  freeOverMinor: z.number().int().nonnegative().nullable(), etaDaysMin: z.number().int().nullable(), etaDaysMax: z.number().int().nullable(),
});
export const governorateRateSchema = z.object({
  governorate: z.string(), governorateAr: z.string(), feeMinor: z.number().int().nonnegative(), feeMaxMinor: z.number().int().nonnegative(), freeOverMinor: z.number().int().nonnegative().nullable(),
});
export const storePoliciesSchema = z.object({
  name: z.string(), nameAr: z.string().nullable(), currency: z.string().length(3), locale: z.enum(['ar', 'en']),
  paymentMethods: z.array(chatPaymentMethod), instapay: z.boolean(),
  cod: z.object({ available: z.boolean(), fixedFeeMinor: z.number().int().nonnegative().nullable(), percentBps: z.number().int().nonnegative().nullable() }),
  shipping: z.object({ zones: z.array(shippingZoneSchema), governorates: z.array(governorateRateSchema) }),
  returns: z.object({ windowDays: z.number().int().nonnegative().nullable(), feesPaidBy: z.enum(['merchant', 'customer']).nullable() }),
  hours: z.string().nullable(),
  location: z.object({ address: z.string().nullable(), addressAr: z.string().nullable(), mapsUrl: z.string().nullable() }).nullable(),
});
export type StorePolicies = z.infer<typeof storePoliciesSchema>;

const orderStatusEnum = z.enum(['pending_confirmation', 'pending_payment', 'confirmed', 'refused', 'shipped', 'delivered', 'cancelled', 'returned']);
export const fullAddressSchema = z.object({
  id: z.string(), label: z.string().nullable(), area: z.string(), street: z.string(), governorate: z.string().nullable(), buildingNumber: z.string().nullable(), notes: z.string().nullable(),
});
export type FullAddress = z.infer<typeof fullAddressSchema>;
/** `null` = no such customer in this store (an unknown phone answers like this, never an error). */
export const customerProfileSchema = z.object({
  firstName: z.string().nullable(), preferredLocale: z.enum(['ar', 'en']).nullable(), defaultAddress: fullAddressSchema.nullable(),
  recentOrders: z.array(z.object({
    orderNumber: z.string(), status: orderStatusEnum, totalMinor: z.number().int(), currency: z.string().length(3), at: z.number().int(),
    items: z.array(z.object({ name: z.string(), quantity: z.number().int().positive() })),
  })),
}).nullable();
export type CustomerProfile = NonNullable<z.infer<typeof customerProfileSchema>>;
/** `searcher`: an opaque per-shopper id (the hashed buyer key, never a phone) for the Store's query-embed rate limit. */
export type SearchOptions = { maxPriceMinor?: number; limit: number; searcher?: string };

export const buyerSchema = z.object({
  buyerKey: z.string().regex(/^[0-9a-f]{64}$/),
  phoneE164: z.string().regex(/^\+[1-9]\d{7,14}$/),
  name: z.string().nullable(),
  locale: z.enum(['ar', 'en']),
});
export type Buyer = z.infer<typeof buyerSchema>;
export const orderLine = z.object({ variantId: z.string().min(1), quantity: z.number().int().min(1).max(99) });
export type OrderLine = z.infer<typeof orderLine>;

export const addressSchema = z.object({ id: z.string(), label: z.string().nullable(), area: z.string(), street: z.string() });
export type Address = z.infer<typeof addressSchema>;
export const newAddressSchema = z.object({ label: z.string().max(40).optional(), area: z.string().min(1).max(120), street: z.string().min(1).max(240) });
export type NewAddress = z.infer<typeof newAddressSchema>;

export const checkoutLinkSchema = z.object({ checkoutUrl: z.string().url(), summary: z.object({ itemsCount: z.number().int(), totalMinor: z.number().int(), currency: z.string().length(3) }) });
export const orderCreatedSchema = z.object({
  orderId: z.string().min(1),
  orderNumber: z.string().min(1),
  totalMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  paymentUrl: z.string().url().nullable(),
  /** InstaPay only: the order is `pending_payment` until the Store records the transfer. */
  instapay: z.object({ ipa: z.string(), amountMinor: z.number().int().nonnegative(), reference: z.string() }).nullable(),
});
export type OrderCreated = z.infer<typeof orderCreatedSchema>;
export const paymentLinkSchema = z.object({ url: z.string().url(), expiresAt: z.string() });

export const bridgeOrderStatus = z.enum(['pending_confirmation', 'pending_payment', 'confirmed', 'refused', 'shipped', 'delivered', 'cancelled', 'returned']);
export const bridgeOrderSummarySchema = z.object({
  orderId: z.string(),
  orderNumber: z.string(),
  status: bridgeOrderStatus,
  totalMinor: z.number().int(),
  currency: z.string().length(3),
  paymentMethod: z.enum(['cod', 'link', 'card', 'wallet', 'instapay']),
  itemsCount: z.number().int().positive(),
  at: z.number().int(),
});
export type BridgeOrderSummary = z.infer<typeof bridgeOrderSummarySchema>;
export const customerOrdersSchema = z.object({ items: z.array(bridgeOrderSummarySchema) });
export const orderStatusSchema = z.object({
  orderNumber: z.string(),
  status: bridgeOrderStatus,
  paymentMethod: z.enum(['cod', 'link', 'card', 'wallet', 'instapay']),
  shipment: z.object({ status: z.string(), trackingUrl: z.string().nullable() }).nullable(),
});
export type OrderStatusInfo = z.infer<typeof orderStatusSchema>;
export const codOutcomeAckSchema = z.object({ orderNumber: z.string().nullable() });

/** The Store's bridge schema refuses a whole `getProducts` call when one id is longer than this. */
export const MAX_RETAILER_ID = 64;

export type BridgeFailure = 'not_found' | 'not_linked' | 'out_of_stock' | 'payment_method_disabled' | 'invalid' | 'unavailable';
export type BridgeResult<T> = { ok: true; value: T } | { ok: false; reason: BridgeFailure; message?: string; outOfStock?: string[]; code?: string };

export type CodOutcome = 'confirmed' | 'refused' | 'no_reply';

/**
 * Store membership (identity contract v1.4, Ruling ID-19): the Store owns who is on a team; we only ask. Owner and ACTIVE staff, no email, phone or credential.
 * `memberRole` is called on every person request (a permission is never-stale); `listStoreMembers` is authorised by the CALLING user against the live membership.
 */
export const memberRoleSchema = z.enum(['owner', 'staff']);
export type MemberRole = z.infer<typeof memberRoleSchema>;
export const storeMemberSchema = z.object({ userId: z.string().min(1), displayName: z.string(), role: memberRoleSchema, addedAt: z.string() });
export type StoreMember = z.infer<typeof storeMemberSchema>;
export const storeMembersSchema = z.object({ items: z.array(storeMemberSchema) });
export const memberRoleAnswerSchema = z.object({ role: memberRoleSchema.nullable() });

export interface StoreBridge {
  getStoreProfile(storeId: string): Promise<BridgeResult<StoreProfile>>;
  listCatalog(storeId: string, cursor: string | null, limit: number): Promise<BridgeResult<CatalogPage>>;
  getProducts(storeId: string, productIds: string[]): Promise<BridgeResult<{ items: CatalogRow[] }>>;
  /** The Store's own ranked search (stemming, Franco/dialect terms, meaning leg). `maxPriceMinor` is PIASTERS. An empty list is a real "no match" unless `degraded` is true. */
  searchProducts(storeId: string, query: string, opts: SearchOptions): Promise<BridgeResult<SearchResult>>;
  getStorePolicies(storeId: string): Promise<BridgeResult<StorePolicies>>;
  /** The phone is the buyer proof (the Store rebuilds the key). `{ ok: true, value: null }` = unknown customer. */
  getCustomerProfile(storeId: string, phoneE164: string): Promise<BridgeResult<z.infer<typeof customerProfileSchema>>>;
  createCheckoutLink(storeId: string, req: { items: OrderLine[]; buyer: Buyer }): Promise<BridgeResult<z.infer<typeof checkoutLinkSchema>>>;
  createOrderFromChat(storeId: string, req: { items: OrderLine[]; buyer: Buyer; addressId?: string; address?: NewAddress; paymentMethod: ChatPaymentMethod; idempotencyKey: string }): Promise<BridgeResult<OrderCreated>>;
  getPaymentLink(storeId: string, orderId: string): Promise<BridgeResult<z.infer<typeof paymentLinkSchema>>>;
  recordCodOutcome(storeId: string, req: { orderId: string; outcome: CodOutcome; at: string; idempotencyKey: string }): Promise<BridgeResult<z.infer<typeof codOutcomeAckSchema>>>;
  attachPaymentProof(storeId: string, orderId: string, mediaUrl: string): Promise<BridgeResult<Record<string, never>>>;
  getCustomerAddresses(storeId: string, buyerKey: string): Promise<BridgeResult<{ items: Address[] }>>;
  saveCustomerAddress(storeId: string, buyerKey: string, address: NewAddress): Promise<BridgeResult<{ address: Address }>>;
  getOrderStatus(storeId: string, orderNumber: string, buyerKey: string): Promise<BridgeResult<OrderStatusInfo>>;
  listCustomerOrders(storeId: string, buyerKey: string, limit: number): Promise<BridgeResult<{ items: BridgeOrderSummary[] }>>;
  getRecommendations(storeId: string, req: RecommendationRequest): Promise<BridgeResult<{ items: CatalogRow[] }>>;
  /** Owner + active staff. `invalid` (message FORBIDDEN) = the asker is not the owner; `unavailable` = the Store could not answer (never read as "no members"). */
  listStoreMembers(storeId: string, asUserId: string): Promise<BridgeResult<{ items: StoreMember[] }>>;
  /** The live role of a user on the store; `{ role: null }` = not (or no longer) a member. `unavailable` = could not be read: callers fail closed. */
  memberRole(storeId: string, userId: string): Promise<BridgeResult<{ role: MemberRole | null }>>;
}

/** Wraps a payload schema in the result envelope the Store answers with. */
export function bridgeResultSchema<T extends z.ZodType>(value: T) {
  return z.union([
    z.object({ ok: z.literal(true), value }),
    z.object({
      ok: z.literal(false),
      reason: z.enum(['not_found', 'not_linked', 'out_of_stock', 'payment_method_disabled', 'invalid', 'unavailable']),
      message: z.string().optional(),
      outOfStock: z.array(z.string()).optional(),
      /** The Store's typed refusal code (MIN_ORDER_NOT_MET, TOO_MANY_OPEN_ORDERS, PRODUCT_UNAVAILABLE ...): a permanent business refusal, never retried (Store ruling WA-RPC-8). */
      code: z.string().max(64).optional(),
    }),
  ]);
}
