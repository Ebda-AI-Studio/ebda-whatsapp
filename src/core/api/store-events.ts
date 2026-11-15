/**
 * Events the Store sends on the store-to-messaging queue (envelope version 1). The Store repo carries an identical
 * copy (contracts/wa-v1.ts); test/guards.test.ts pins this file's sha256 so a change here is a deliberate,
 * mirrored one. Zod 3 and 4 compatible subset only: no .loose(), no codecs.
 *
 * Consumers dedupe on `id`. Ordering is not guaranteed: entity events carry `updatedAt`, and an older one is dropped.
 */
import { z } from 'zod';

/** The minor version of this contract (envelope `v` stays 1: every change so far is additive). v1.5 = `customer.consent_changed.wording`, v1.6 = the optional COD-request fields below. */
export const CONTRACT_VERSION = '1.6';

const iso = z.string().datetime({ offset: true });
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const key = z.string().regex(/^[0-9a-f]{64}$/);
const locale = z.string().min(2).max(10);
/** A store's plan or package standing; the same five states on both sides. */
const planStatus = z.enum(['trialing', 'active', 'past_due', 'cancelled', 'expired']);

const envelope = { id: z.string().uuid(), v: z.literal(1), storeId: z.string().min(1), occurredAt: iso };
const ev = <T extends string, D extends z.ZodType>(type: T, data: D) => z.object({ ...envelope, type: z.literal(type), data });

export const storeEventSchema = z.discriminatedUnion('type', [
  // `status` and `periodEnd` are optional for compatibility; with them a dunning suspension or a cancellation reaches the package gate.
  // v1.4 (additive, WA-GRACE-1): `pastDueSince` = when the subscription first went past_due (set only while status is past_due). WhatsApp ends its
  // grace at min(periodEnd, pastDueSince + 7 days).
  ev('store.plan_changed', z.object({ planCode: z.string(), includesWhatsApp: z.boolean(), ownerUserId: z.string(), effectiveAt: iso, status: planStatus.optional(), periodEnd: iso.optional(), pastDueSince: iso.optional() })),
  // v1.6 (additive): `storefrontOrigin` = where the store's customers shop (its custom domain, else the platform subdomain). Chat submits its per-store COD v2 template (fixed URL base) with it.
  ev('store.linked', z.object({ ownerUserId: z.string(), storefrontOrigin: z.string().url().max(200).optional() })),
  ev('store.unlinked', z.object({ ownerUserId: z.string() })),
  ev('catalog.product_upserted', z.object({ productId: z.string().min(1), variantIds: z.array(z.string().min(1)), updatedAt: iso })),
  ev('catalog.product_deleted', z.object({ productId: z.string().min(1), variantIds: z.array(z.string().min(1)), updatedAt: iso })),
  ev('order.created', z.object({
    orderId: z.string().min(1), orderNumber: z.string().min(1), buyerKey: key, phoneE164: phone, locale,
    totalMinor: z.number().int().nonnegative(), currency: z.string().length(3),
    paymentMethod: z.enum(['cod', 'link', 'card', 'wallet', 'instapay']), channel: z.string().min(1),
  })),
  ev('order.cod_confirmation_requested', z.object({
    orderId: z.string().min(1), buyerKey: key, phoneE164: phone, locale, deadlineAt: iso,
    // Not in the contract's minimum; the Store should add them. Without them we look the order up by id.
    orderNumber: z.string().min(1).optional(), totalMinor: z.number().int().nonnegative().optional(), currency: z.string().length(3).optional(),
    // v1.6 (additive, all optional: an older Chat ignores them): what the richer COD message shows. `shippingAddressLine` is PII for the
    // same customer only (never logged). `orderUrlSuffix` is the storefront path of the customer's order page (account/orders/<uuid>, sign-in
    // gated), joined to `storefrontOrigin` for the template's URL button.
    storeName: z.string().min(1).max(60).optional(), shippingAddressLine: z.string().min(1).max(300).optional(), itemCount: z.number().int().min(1).max(9999).optional(),
    orderUrlSuffix: z.string().min(1).max(200).optional(), storefrontOrigin: z.string().url().max(200).optional(),
  })),
  ev('order.status_changed', z.object({ orderId: z.string().min(1), status: z.string().min(1), updatedAt: iso })),
  ev('shipment.updated', z.object({
    orderId: z.string().min(1), shipmentId: z.string().min(1), status: z.string().min(1), trackingUrl: z.string().url().optional(), updatedAt: iso,
    phoneE164: phone.optional(), locale: locale.optional(), orderNumber: z.string().min(1).optional(),
  })),
  ev('cart.abandoned', z.object({ cartId: z.string().min(1), buyerKey: key, phoneE164: phone, locale, recoveryUrl: z.string().url() })),
  ev('customer.erased', z.object({ buyerKey: key })),
  // v1.1 (additive): the buyer changed their marketing choice at the Store (account settings or a new checkout tick). Marketing to
  // them follows it; a STOP sent on WhatsApp still wins over a later opt-in here.
  // v1.5 (additive): `wording` = the exact words shown beside the checkout opt-in tick, in the locale shown (proof of what the buyer agreed to). Present
  // only when marketingOptIn is true and the Store recorded the locale.
  ev('customer.consent_changed', z.object({ buyerKey: key, marketingOptIn: z.boolean(), at: iso, wording: z.object({ text: z.string().min(1).max(600), locale: z.enum(['ar', 'en']) }).optional() })),
]);
export type StoreEvent = z.infer<typeof storeEventSchema>;
export type StoreEventType = StoreEvent['type'];

/** Just enough to dedupe and route an event whose body we may not understand yet. */
export const storeEnvelopeSchema = z.object({ id: z.string().uuid(), type: z.string().min(1), v: z.number().int(), storeId: z.string().min(1) });

export type ParsedStoreEvent = { ok: true; event: StoreEvent } | { ok: false; reason: 'invalid' | 'unknown_type' | 'unsupported_version' };

export function parseStoreEvent(raw: unknown): ParsedStoreEvent {
  const env = storeEnvelopeSchema.safeParse(raw);
  if (!env.success) return { ok: false, reason: 'invalid' };
  if (env.data.v !== 1) return { ok: false, reason: 'unsupported_version' };
  const known = storeEventSchema.options.some((o) => o.shape.type.value === env.data.type);
  if (!known) return { ok: false, reason: 'unknown_type' };
  const full = storeEventSchema.safeParse(raw);
  return full.success ? { ok: true, event: full.data } : { ok: false, reason: 'invalid' };
}

/** Events we send to the Store on the messaging-to-store queue. */
const out = <T extends string, D extends z.ZodType>(type: T, data: D) => z.object({ ...envelope, type: z.literal(type), data });
export const outboundStoreEventSchema = z.discriminatedUnion('type', [
  // A COD answer recorded here (the Store is the order writer and skips emitting its own outcome for `source: whatsapp`).
  out('whatsapp.cod_outcome', z.object({ orderId: z.string(), outcome: z.enum(['confirmed', 'refused', 'no_reply']), source: z.literal('whatsapp') })),
  // An order was created from chat for a customer who was erased at the same moment: the Store should erase or cancel it.
  out('whatsapp.order_after_erasure', z.object({ orderId: z.string(), buyerKey: key })),
  // The store's messaging package changed (bought here, included by its Store plan, or assigned by an operator). `version` only goes
  // up; the Store ignores an event whose version is not newer than the last it applied. `automation` = the Store may run WhatsApp automation.
  // v1.1 (additive): the buyer stopped (STOP) or restarted (START) WhatsApp messages. `version` only goes up per buyer; the Store
  // ignores an older one. A START here does not re-opt-in the buyer at the Store without a new checkout tick.
  out('whatsapp.opt_out_changed', z.object({ buyerKey: key, optedOut: z.boolean(), at: iso, version: z.number().int().positive() })),
  out('whatsapp.entitlement_changed', z.object({ packageId: z.string().min(1).max(64), automation: z.boolean(), status: planStatus, validUntil: iso, version: z.number().int().positive() })),
]);
export type OutboundStoreEvent = z.infer<typeof outboundStoreEventSchema>;
