import { scheduleCatalogEmbed } from '../ai/knowledge';
import type { StoreEvent } from '../api/store-events';
import type { Locale } from '../ordering/copy';
import { plainAmount } from '../ordering/money';
import { buyerKey } from '../buyer-key';
import { isE164 } from '../phone';
import { addTask } from '../scheduler';
import { bridgeFor, storeLink } from '../store-link';
import type { LinkHost } from './host';
import { queueFreeText, queueTemplate, setTag, cleanParam, type QueueResult } from './outbound';
import { ensureCatalogReconcile } from './catalog';
import { isLinked, putState, readSettings } from './settings';
import { acceptVersion, locale, orderRow, rememberBuyerKey, schedulePendingPushes, upsertOrder } from './order-store';
import { applyConsentChanged, forgetBuyer, recordCheckoutConsent, recordWithdrawal } from './consent';
import { alert } from '../observability';
import { funnelOnce } from '../funnel';

export type StoreEventOutcome = { status: 'applied' | 'duplicate' | 'stale' | 'skipped' | 'retry'; detail?: string };

/** A COD request that nobody answers within this long is recorded as `no_reply`. */
export const COD_NO_REPLY_MS = 24 * 60 * 60 * 1000;
/** Catalog changes are coalesced: one sync per 30 s of quiet-ish time. */
export const CATALOG_DEBOUNCE_MS = 30_000;
const KEEP_EVENTS_MS = 14 * 24 * 60 * 60 * 1000;

const warn = (host: LinkHost, what: string, extra: Record<string, unknown> = {}) => console.warn(JSON.stringify({ warn: what, workspace: host.workspaceId, ...extra }));

function displayName(host: LinkHost, waId: string, loc: Locale): string {
  const copy = storeLink().copy!;
  const row = host.sql.exec<{ profile_name: string | null }>('SELECT profile_name FROM contacts WHERE wa_id = ?', waId).toArray()[0];
  return cleanParam(row?.profile_name, copy.customerName[loc]);
}

/**
 * Parameters for the richer COD template, or null when it cannot be used (no v2 name, not APPROVED here, a field missing, or the
 * Store's order link does not sit under the template's fixed URL base). Null means: send the plain template. Order is header,
 * body, URL button, as renderTemplate counts them. Never logs the address.
 */
function codV2Params(host: LinkHost, name: string | undefined, loc: Locale, d: { storeName?: string; shippingAddressLine?: string; itemCount?: number; orderUrlSuffix?: string; storefrontOrigin?: string }, base: { customer: string; orderNumber: string; totalMinor: number }): string[] | null {
  if (!name || !d.storeName || !d.shippingAddressLine || !d.itemCount || !d.orderUrlSuffix || !d.storefrontOrigin) return null;
  let components: string | undefined;
  for (const language of [loc, 'ar']) {
    components = host.sql.exec<{ components: string }>("SELECT components FROM templates WHERE name = ? AND language = ? AND status = 'APPROVED'", name, language).toArray()[0]?.components;
    if (components) break;
  }
  if (!components) return null;
  let urlTemplate: string | undefined;
  try {
    const parsed = JSON.parse(components) as { type?: string; buttons?: { type?: string; url?: string }[] }[];
    urlTemplate = parsed.find((c) => c.type?.toUpperCase() === 'BUTTONS')?.buttons?.find((b) => b.type?.toUpperCase() === 'URL')?.url;
  } catch { return null; }
  if (!urlTemplate?.endsWith('{{1}}')) return null;
  const prefix = urlTemplate.slice(0, -5);
  const link = `${d.storefrontOrigin.replace(/\/+$/, '')}/${d.orderUrlSuffix.replace(/^\/+/, '')}`;
  if (!link.startsWith(prefix) || link.length === prefix.length) return null;
  return [cleanParam(d.storeName, d.storeName, 60), base.customer, cleanParam(base.orderNumber, base.orderNumber, 40), cleanParam(d.shippingAddressLine, d.shippingAddressLine, 300), String(d.itemCount), plainAmount(base.totalMinor), link.slice(prefix.length)];
}

/** The order a COD request is about, when neither the event nor an earlier event named its number and total. */
type LookedUp = { orderNumber: string; totalMinor: number; currency: string };
async function lookupOrder(host: LinkHost, buyerKeyHex: string, orderId: string): Promise<LookedUp | 'retry' | null> {
  const bridge = bridgeFor(host.env);
  if (!bridge) return null;
  const res = await bridge.listCustomerOrders(host.workspaceId, buyerKeyHex, 20);
  if (!res.ok) return res.reason === 'unavailable' ? 'retry' : null;
  const hit = res.value.items.find((o) => o.orderId === orderId);
  return hit ? { orderNumber: hit.orderNumber, totalMinor: hit.totalMinor, currency: hit.currency } : null;
}

/** Wa id of the contact a customer key belongs to. Hashes unkeyed contacts lazily (and remembers the result). */
async function findWaId(host: LinkHost, key: string): Promise<string | null> {
  const known = host.sql.exec<{ wa_id: string }>('SELECT wa_id FROM contacts WHERE buyer_key = ?', key).toArray()[0]
    ?? host.sql.exec<{ wa_id: string }>('SELECT wa_id FROM store_orders WHERE buyer_key = ? AND wa_id IS NOT NULL LIMIT 1', key).toArray()[0];
  if (known) return known.wa_id;
  const secret = storeLink().buyerSecret(host.env);
  if (!secret) return null;
  const pending = host.sql.exec<{ id: number; wa_id: string }>('SELECT id, wa_id FROM contacts WHERE buyer_key IS NULL ORDER BY id LIMIT 5000').toArray();
  let found: string | null = null;
  for (const c of pending) {
    if (!isE164(`+${c.wa_id}`)) continue;
    const k = await buyerKey(secret, `+${c.wa_id}`);
    host.sql.exec('UPDATE contacts SET buyer_key = ? WHERE id = ?', k, c.id);
    if (k === key) found = c.wa_id;
  }
  return found;
}

/**
 * Applies one Store event to this workspace. Dedupes on the envelope id, drops a stale version of an entity, and does
 * every write (state, message row, the task that hands the message to the send queue, the dedupe marker) in ONE
 * transaction, so a redelivered event can neither double-send nor lose a message.
 */
export async function applyStoreEvent(host: LinkHost, event: StoreEvent, opts: { phoneNumberId: string | null; shared?: boolean; now?: number }): Promise<StoreEventOutcome> {
  const now = opts.now ?? Date.now();
  if (event.storeId !== host.workspaceId) return { status: 'skipped', detail: 'wrong_workspace' };
  if (host.sql.exec('SELECT 1 FROM processed_events WHERE event_id = ?', event.id).toArray().length) return { status: 'duplicate' };

  // Async lookups happen before the transaction (a transaction cannot await).
  let codLookup: LookedUp | 'retry' | null = null;
  let erasedWaId: string | null = null;
  let consentWaId: string | null = null;
  if (event.type === 'order.cod_confirmation_requested') {
    const d = event.data;
    const have = orderRow(host, d.orderId);
    if (!d.orderNumber && !have?.order_number) {
      codLookup = await lookupOrder(host, d.buyerKey, d.orderId);
      if (codLookup === 'retry') return { status: 'retry', detail: 'store_unavailable' };
    }
  } else if (event.type === 'customer.erased') {
    erasedWaId = await findWaId(host, event.data.buyerKey);
  } else if (event.type === 'customer.consent_changed') {
    consentWaId = await findWaId(host, event.data.buyerKey);
  }

  const outcome = host.storage.transactionSync((): StoreEventOutcome => {
    // Re-check inside the transaction: a concurrent delivery of the same event may have finished during the awaits above.
    if (host.sql.exec('SELECT 1 FROM processed_events WHERE event_id = ?', event.id).toArray().length) return { status: 'duplicate' };
    const result = handle(host, event, { ...opts, now }, { codLookup, consentWaId });
    if (result.status === 'retry') return result;
    // An erasure is recorded as done only after the contact is really gone (below), so a failure there is redelivered.
    if (event.type === 'customer.erased') return result;
    host.sql.exec('INSERT INTO processed_events (event_id, type, at) VALUES (?, ?, ?)', event.id, event.type, now);
    host.sql.exec('DELETE FROM processed_events WHERE at < ?', now - KEEP_EVENTS_MS);
    return result;
  });
  if (event.type === 'customer.erased') {
    if (erasedWaId) await host.eraseContact(erasedWaId); // throws on failure: no marker, the queue redelivers
    host.storage.transactionSync(() => {
      host.sql.exec('INSERT OR IGNORE INTO processed_events (event_id, type, at) VALUES (?, ?, ?)', event.id, event.type, now);
    });
    return erasedWaId ? { status: 'applied' } : { status: 'skipped', detail: 'unknown_customer' };
  }
  if (outcome.status === 'applied' || outcome.status === 'skipped') await host.arm();
  return outcome;
}

function sendOutcome(host: LinkHost, r: QueueResult, what: string): StoreEventOutcome {
  if (r.ok) return { status: 'applied' };
  warn(host, 'store_event_not_sent', { what, reason: r.reason });
  return { status: 'skipped', detail: r.reason };
}

function handle(host: LinkHost, event: StoreEvent, opts: { phoneNumberId: string | null; shared?: boolean; now: number }, pre: { codLookup: LookedUp | null; consentWaId: string | null }): StoreEventOutcome {
  const { now } = opts;
  const copy = storeLink().copy;
  const at = (iso: string) => Date.parse(iso);

  switch (event.type) {
    case 'store.plan_changed':
      if (!acceptVersion(host, 'store:plan', at(event.occurredAt))) return { status: 'stale' };
      putState(host, 'plan', JSON.stringify({ planCode: event.data.planCode, includesWhatsApp: event.data.includesWhatsApp, effectiveAt: event.data.effectiveAt }));
      return { status: 'applied' };
    case 'store.linked':
    case 'store.unlinked':
      if (!acceptVersion(host, 'store:link', at(event.occurredAt))) return { status: 'stale' };
      putState(host, 'linked', event.type === 'store.linked' ? '1' : '0');
      if (event.type === 'store.linked') {
        funnelOnce(host, 'linked');
        schedulePendingPushes(host, now);
        ensureCatalogReconcile(host, now);
      }
      return { status: 'applied' };
    case 'customer.erased':
      // Data protection is never gated by link state. Only what is keyed by the customer is dropped here; the contact is
      // erased by the caller, which records this event as processed only once that has succeeded.
      host.sql.exec('DELETE FROM store_orders WHERE buyer_key = ?', event.data.buyerKey);
      forgetBuyer(host, event.data.buyerKey);
      return { status: 'applied' };
    case 'customer.consent_changed': {
      // Withdrawing marketing consent is never gated by link state; granting it needs a linked store (campaigns follow consent_at).
      if (!event.data.marketingOptIn) recordWithdrawal(host, event.data.buyerKey, at(event.data.at)); // before the unknown-buyer return
      if (event.data.marketingOptIn && !isLinked(host)) return { status: 'skipped', detail: 'unlinked' };
      if (!pre.consentWaId) return { status: 'skipped', detail: 'unknown_buyer' }; // the attestation comes with a later event
      return applyConsentChanged(host, pre.consentWaId, event.data.buyerKey, event.data.marketingOptIn, at(event.data.at), event.data.wording);
    }
    default:
  }

  // Everything below talks to customers or touches commerce data: not while the store is unlinked.
  if (!isLinked(host)) return { status: 'skipped', detail: 'unlinked' };

  switch (event.type) {
    case 'catalog.product_upserted':
    case 'catalog.product_deleted': {
      if (!acceptVersion(host, `product:${event.data.productId}`, at(event.data.updatedAt))) return { status: 'stale' };
      host.sql.exec(
        `INSERT INTO catalog_dirty (product_id, variant_ids, deleted, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET variant_ids = excluded.variant_ids, deleted = excluded.deleted, updated_at = excluded.updated_at`,
        event.data.productId, JSON.stringify(event.data.variantIds), event.type === 'catalog.product_deleted' ? 1 : 0, at(event.data.updatedAt),
      );
      // One pending sync at most; scheduling again keeps the earlier due time, which is the debounce.
      addTask(host.sql, 'catalog_sync', now + CATALOG_DEBOUNCE_MS);
      scheduleCatalogEmbed(host, now); // the AI agent's product search index (only while the agent is on)
      return { status: 'applied' };
    }

    case 'order.created': {
      const d = event.data;
      const waId = d.phoneE164.slice(1);
      upsertOrder(host, { orderId: d.orderId, orderNumber: d.orderNumber, waId, buyerKey: d.buyerKey, paymentMethod: d.paymentMethod, status: 'created', totalMinor: d.totalMinor, currency: d.currency, locale: locale(d.locale) }, now);
      // COD orders are confirmed through the COD request; orders placed in this chat were already confirmed in the chat.
      if (d.paymentMethod === 'cod' || d.channel === 'whatsapp') return { status: 'applied' };
      if (!readSettings(host).orderConfirmations) return { status: 'skipped', detail: 'disabled' };
      if (!copy || !opts.phoneNumberId) return { status: 'skipped', detail: copy ? 'no_number' : 'no_copy' };
      const loc = locale(d.locale);
      const r = queueTemplate(host, {
        waId, phoneNumberId: opts.phoneNumberId, name: copy.templates.orderConfirmation, language: loc, fallbackLanguage: 'ar',
        params: [displayName(host, waId, loc), cleanParam(d.orderNumber, d.orderNumber, 40)], idempotencyKey: `order:${d.orderId}:created`, orderRef: d.orderId, now,
      });
      rememberBuyerKey(host, waId, d.buyerKey);
      return sendOutcome(host, r, 'order_confirmation');
    }

    case 'order.cod_confirmation_requested': {
      const d = event.data;
      const waId = d.phoneE164.slice(1);
      const have = orderRow(host, d.orderId);
      // One request per order, however many events (or redeliveries with another id) arrive.
      if (have?.cod_state) return { status: 'skipped', detail: 'already_requested' };
      const orderNumber = d.orderNumber ?? have?.order_number ?? pre.codLookup?.orderNumber;
      const totalMinor = d.totalMinor ?? have?.total_minor ?? pre.codLookup?.totalMinor;
      const currency = d.currency ?? have?.currency ?? pre.codLookup?.currency ?? 'EGP';
      if (!orderNumber || totalMinor === undefined || totalMinor === null) {
        alert('cod_request_details_missing', { workspace: host.workspaceId });
        return { status: 'skipped', detail: 'details_missing' };
      }
      if (!copy || !opts.phoneNumberId) return { status: 'skipped', detail: copy ? 'no_number' : 'no_copy' };
      const loc = locale(d.locale);
      const quick = (index: number, answer: 'y' | 'n') => ({ type: 'button' as const, sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload: `cod:${answer}:${d.orderId}` }] });
      const customer = displayName(host, waId, loc);
      const v2 = codV2Params(host, copy.templates.codConfirmationV2, loc, d, { customer, orderNumber, totalMinor });
      // v2 has the order-page URL button first, so its quick replies sit at index 1 and 2; v1 keeps 0 and 1. Payloads are identical.
      const r = v2
        ? queueTemplate(host, {
          waId, phoneNumberId: opts.phoneNumberId, name: copy.templates.codConfirmationV2!, language: loc, fallbackLanguage: 'ar',
          params: v2, idempotencyKey: `cod:${d.orderId}`, orderRef: d.orderId, extraComponents: [quick(1, 'y'), quick(2, 'n')], now,
        })
        : queueTemplate(host, {
          waId, phoneNumberId: opts.phoneNumberId, name: copy.templates.codConfirmation, language: loc, fallbackLanguage: 'ar',
          params: [customer, cleanParam(orderNumber, orderNumber, 40), plainAmount(totalMinor)],
          idempotencyKey: `cod:${d.orderId}`, orderRef: d.orderId, extraComponents: [quick(0, 'y'), quick(1, 'n')], now,
        });
      if (!r.ok) return sendOutcome(host, r, 'cod_confirmation');
      upsertOrder(host, { orderId: d.orderId, orderNumber, waId, buyerKey: d.buyerKey, paymentMethod: 'cod', totalMinor, currency, codState: 'pending', codRequestedAt: now, locale: loc }, now);
      rememberBuyerKey(host, waId, d.buyerKey);
      setTag(host, waId, 'cod_pending', true);
      addTask(host.sql, 'cod_no_reply', now + COD_NO_REPLY_MS, { orderId: d.orderId });
      return { status: 'applied' };
    }

    case 'order.status_changed': {
      const d = event.data;
      if (!acceptVersion(host, `order:${d.orderId}:status`, at(d.updatedAt))) return { status: 'stale' };
      const have = orderRow(host, d.orderId);
      upsertOrder(host, { orderId: d.orderId, status: d.status }, now);
      if (!have) return { status: 'applied' };
      const closing = d.status === 'cancelled' || d.status === 'refunded';
      if (closing) {
        // Cancelled at the Store: whatever the COD state was, the question is over and no further outcome is accepted.
        host.sql.exec("UPDATE store_orders SET cod_state = 'closed', updated_at = ? WHERE order_id = ? AND (cod_state IS NULL OR cod_state != 'closed')", now, d.orderId);
        if (have.wa_id) setTag(host, have.wa_id, 'cod_pending', false);
      }
      if (d.status === 'paid' && have.wa_id && have.order_number && copy && opts.phoneNumberId && (have.payment_method === 'instapay' || have.payment_method === 'link')) {
        // Free text only inside the 24 h window (the customer is usually still there after paying).
        queueFreeText(host, { waId: have.wa_id, phoneNumberId: opts.phoneNumberId, text: copy.t.paymentConfirmed(have.order_number, locale(have.locale ?? undefined)), idempotencyKey: `order:${d.orderId}:paid`, now });
      }
      return { status: 'applied' };
    }

    case 'shipment.updated': {
      const d = event.data;
      if (!acceptVersion(host, `shipment:${d.shipmentId}`, at(d.updatedAt))) return { status: 'stale' };
      const have = orderRow(host, d.orderId);
      const waId = d.phoneE164?.slice(1) ?? have?.wa_id;
      const orderNumber = d.orderNumber ?? have?.order_number;
      if (!waId || !orderNumber) {
        warn(host, 'shipment_event_unknown_order');
        return { status: 'skipped', detail: 'unknown_order' };
      }
      if (!copy || !opts.phoneNumberId) return { status: 'skipped', detail: copy ? 'no_number' : 'no_copy' };
      const loc = locale(d.locale);
      const phrase = copy.shipmentPhrase(d.status, loc);
      if (!phrase) return { status: 'skipped', detail: 'status_not_announced' };
      const name = displayName(host, waId, loc);
      const r = queueTemplate(host, {
        waId, phoneNumberId: opts.phoneNumberId, name: d.trackingUrl ? copy.templates.shippingTracking : copy.templates.shippingStatus, language: loc, fallbackLanguage: 'ar',
        params: d.trackingUrl ? [name, cleanParam(orderNumber, orderNumber, 40), phrase, d.trackingUrl] : [name, cleanParam(orderNumber, orderNumber, 40), phrase],
        idempotencyKey: `ship:${d.shipmentId}:${d.status}`, orderRef: d.orderId, now,
      });
      return sendOutcome(host, r, 'shipping');
    }

    case 'cart.abandoned': {
      const d = event.data;
      const waId = d.phoneE164.slice(1);
      if (!copy || !opts.phoneNumberId) return { status: 'skipped', detail: copy ? 'no_number' : 'no_copy' };
      if (opts.shared) return { status: 'skipped', detail: 'shared_number_no_marketing' }; // WA-SHARED-NOCAMP-1
      // WA-CONSENT-1: the Store sends this event only for a buyer who ticked the WhatsApp marketing opt-in at checkout, so it attests the
      // consent for THIS reminder (campaigns need the contact to have written to us too, see CAMPAIGN_CONSENT). The checkout phone is typed
      // by the buyer, so nothing is recorded where we would not act. Our opt-out always wins. Recorded only after the checks above.
      recordCheckoutConsent(host, waId, d.buyerKey, at(event.occurredAt));
      const loc = locale(d.locale);
      // Marketing: needs a recorded opt-in and no opt-out. (Phase 7 adds the wallet check here: fail closed at zero.)
      const r = queueTemplate(host, {
        waId, phoneNumberId: opts.phoneNumberId, name: copy.templates.cartRecovery, language: loc, fallbackLanguage: 'ar', requireConsent: true,
        params: [displayName(host, waId, loc), d.recoveryUrl], idempotencyKey: `cart:${d.cartId}`, now,
      });
      return sendOutcome(host, r, 'cart_recovery');
    }

    default:
      return { status: 'skipped', detail: 'unhandled' };
  }
}
