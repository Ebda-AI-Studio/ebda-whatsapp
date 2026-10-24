/**
 * Events the Store sends on the store-to-messaging queue (envelope version 1). The Store repo carries an identical
 * copy (contracts/wa-v1.ts); test/guards.test.ts pins this file's sha256 so a change here is a deliberate,
 * mirrored one. Zod 3 and 4 compatible subset only: no .loose(), no codecs.
 *
 * Consumers dedupe on `id`. Ordering is not guaranteed: entity events carry `updatedAt`, and an older one is dropped.
 */
import { z } from 'zod';

const iso = z.string().datetime({ offset: true });
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const key = z.string().regex(/^[0-9a-f]{64}$/);
const locale = z.string().min(2).max(10);

const envelope = { id: z.string().uuid(), v: z.literal(1), storeId: z.string().min(1), occurredAt: iso };
const ev = <T extends string, D extends z.ZodType>(type: T, data: D) => z.object({ ...envelope, type: z.literal(type), data });

export const storeEventSchema = z.discriminatedUnion('type', [
  ev('store.plan_changed', z.object({ planCode: z.string(), includesWhatsApp: z.boolean(), ownerUserId: z.string(), effectiveAt: iso })),
  ev('store.linked', z.object({ ownerUserId: z.string() })),
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
  })),
  ev('order.status_changed', z.object({ orderId: z.string().min(1), status: z.string().min(1), updatedAt: iso })),
  ev('shipment.updated', z.object({
    orderId: z.string().min(1), shipmentId: z.string().min(1), status: z.string().min(1), trackingUrl: z.string().url().optional(), updatedAt: iso,
    phoneE164: phone.optional(), locale: locale.optional(), orderNumber: z.string().min(1).optional(),
  })),
  ev('cart.abandoned', z.object({ cartId: z.string().min(1), buyerKey: key, phoneE164: phone, locale, recoveryUrl: z.string().url() })),
  ev('customer.erased', z.object({ buyerKey: key })),
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
]);
export type OutboundStoreEvent = z.infer<typeof outboundStoreEventSchema>;
