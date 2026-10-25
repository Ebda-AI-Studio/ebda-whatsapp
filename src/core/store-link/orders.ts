import { outboundStoreEventSchema, type OutboundStoreEvent } from '../api/store-events';
import type { InboundMessage } from '../meta/webhook-schema';
import { addTask } from '../scheduler';
import { bridgeFor, storeLink } from '../store-link';
import { normaliseText } from '../text-normalise';
import type { CodOutcome } from '../store-bridge';
import type { LinkHost } from './host';
import { locale, upsertOrder } from './order-store';
import { queueFreeText, setTag } from './outbound';

export type CodResolution = 'resolved' | 'already' | 'conflict' | 'closed' | 'not_cod' | 'unknown_order';

/** An order in one of these Store statuses can no longer be confirmed or refused. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'refunded', 'delivered', 'returned']);

type CodRow = { order_id: string; order_number: string | null; wa_id: string | null; buyer_key: string | null; cod_state: string | null; outcome: string | null; locale: string | null; payment_method: string | null; status: string | null };
const codRow = (host: LinkHost, where: string, ...params: SqlStorageValue[]) =>
  host.sql.exec<CodRow>(`SELECT order_id, order_number, wa_id, buyer_key, cod_state, outcome, locale, payment_method, status FROM store_orders WHERE ${where}`, ...params).toArray()[0];

/**
 * Records the answer to a COD confirmation, once. A first answer wins; the same answer again is a no-op; a different one
 * after it is a conflict. A real answer (confirmed/refused) may replace a `no_reply` (silence is not a decision).
 * Pushing it to the Store is a separate, retried task. Call inside a transaction.
 */
export function resolveCod(host: LinkHost, orderId: string, outcome: CodOutcome, now: number, idempotencyKey?: string): CodResolution {
  const row = codRow(host, 'order_id = ?', orderId);
  if (!row) return 'unknown_order';
  // Only cash-on-delivery orders have this question, and not once the order is over.
  if (row.payment_method !== 'cod') return 'not_cod';
  if (row.cod_state === 'closed' || (row.status !== null && TERMINAL_STATUSES.has(row.status))) return 'closed';
  if (row.outcome === outcome) return 'already';
  const open = row.cod_state === null || row.cod_state === 'pending' || (row.cod_state === 'no_reply' && outcome !== 'no_reply');
  if (!open) return 'conflict';
  host.sql.exec(
    'UPDATE store_orders SET cod_state = ?, outcome = ?, outcome_at = ?, outcome_idem = ?, outcome_pushed_at = NULL, updated_at = ? WHERE order_id = ?',
    outcome, outcome, now, idempotencyKey ?? `cod:${orderId}:${outcome}`, now, orderId,
  );
  if (row.wa_id) setTag(host, row.wa_id, 'cod_pending', false);
  addTask(host.sql, 'cod_outcome_push', now, { orderId });
  recordCiOutcome(host, { buyerKey: row.buyer_key, orderId, outcome, at: now });
  return 'resolved';
}

/**
 * Customer Intelligence (CI-1): one data point per recorded COD outcome, keyed by the suite-wide hashed customer key, never a
 * phone number. Written when the outcome is recorded (once per transition), best effort: analytics must not block an order.
 */
export function recordCiOutcome(host: LinkHost, o: { buyerKey: string | null; orderId: string; outcome: CodOutcome; at: number }): void {
  if (!o.buyerKey) {
    console.warn(JSON.stringify({ warn: 'ci_outcome_without_buyer_key', workspace: host.workspaceId }));
    return;
  }
  try {
    host.env.CI_OUTCOMES?.writeDataPoint({ indexes: [host.workspaceId], blobs: [o.buyerKey, host.workspaceId, o.outcome, o.orderId, 'whatsapp'], doubles: [o.at] });
  } catch {
    // best effort
  }
}

/** 24 h after a COD request nobody answered: record `no_reply` (a later real answer still replaces it). Call inside a transaction. */
export function closeUnanswered(host: LinkHost, orderId: string, now: number): CodResolution | 'not_pending' {
  const row = codRow(host, 'order_id = ?', orderId);
  if (!row || row.cod_state !== 'pending') return 'not_pending';
  return resolveCod(host, orderId, 'no_reply', now);
}

/** A customer's tap on the COD template: its payload names the order; a button without one is matched by title to their latest open request. */
export function handleCodReply(host: LinkHost, m: InboundMessage, phoneNumberId: string, now: number): boolean {
  const reply = m.reply;
  const copy = storeLink().copy;
  if (!reply || reply.kind !== 'button' || !copy) return false;
  let outcome: 'confirmed' | 'refused' | null = null;
  let orderId: string | null = null;
  const byPayload = /^cod:(y|n):(.+)$/.exec(reply.id);
  if (byPayload) {
    outcome = byPayload[1] === 'y' ? 'confirmed' : 'refused';
    orderId = byPayload[2]!;
  } else {
    const title = normaliseText(reply.title);
    if (copy.codConfirmTitles.some((t) => normaliseText(t) === title)) outcome = 'confirmed';
    else if (copy.codRefuseTitles.some((t) => normaliseText(t) === title)) outcome = 'refused';
    if (outcome) orderId = codRow(host, "wa_id = ? AND cod_state = 'pending' ORDER BY cod_requested_at DESC LIMIT 1", m.from)?.order_id ?? null;
  }
  if (!outcome || !orderId) return false;
  const row = codRow(host, 'order_id = ?', orderId);
  // A payload names an order; only its own customer may answer for it.
  if (!row || row.wa_id !== m.from) return false;
  const res = resolveCod(host, orderId, outcome, now);
  if (res !== 'resolved' && res !== 'already') return true; // answered once already (or cancelled): stay quiet
  const loc = locale(row.locale ?? undefined);
  queueFreeText(host, { waId: m.from, phoneNumberId, text: (outcome === 'confirmed' ? copy.t.codConfirmed : copy.t.codRefused)[loc], idempotencyKey: `cod:${orderId}:reply:${outcome}`, now });
  return true;
}

export type MerchantCodArgs = {
  orderNumber: string;
  waId: string;
  outcome: 'confirmed' | 'refused';
  idempotencyKey: string;
  /** What the Store said about an order this workspace had never heard of (looked up by the route). */
  known?: { orderId: string; totalMinor: number; currency: string; buyerKey: string };
};
export type MerchantCodResult = { ok: true; orderId: string; orderNumber: string; resolution: 'resolved' | 'already' } | { ok: false; reason: 'unknown_order' | 'conflict' | 'closed' | 'not_cod' };

/** The merchant answers for a customer from the inbox. Call inside a transaction. */
export function merchantCod(host: LinkHost, a: MerchantCodArgs, now: number): MerchantCodResult {
  // The number alone is guessable: the order must belong to this very customer.
  let row = codRow(host, 'order_number = ? AND wa_id = ? ORDER BY updated_at DESC LIMIT 1', a.orderNumber, a.waId);
  if (!row && a.known) {
    upsertOrder(host, { orderId: a.known.orderId, orderNumber: a.orderNumber, waId: a.waId, buyerKey: a.known.buyerKey, paymentMethod: 'cod', totalMinor: a.known.totalMinor, currency: a.known.currency }, now);
    row = codRow(host, 'order_id = ?', a.known.orderId);
  }
  if (!row) return { ok: false, reason: 'unknown_order' };
  const res = resolveCod(host, row.order_id, a.outcome, now, a.idempotencyKey);
  if (res === 'resolved' || res === 'already') return { ok: true, orderId: row.order_id, orderNumber: a.orderNumber, resolution: res };
  return { ok: false, reason: res };
}

/** Deterministic v4-shaped uuid from a key, so a retried push carries the same event id and the Store dedupes it. */
export async function uuidFromKey(key: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  const hex = [...d.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type PushResult = { pushed: true } | { pushed: false; reason: 'nothing_to_push' | 'link_off' };

/**
 * Tells the Store about a recorded COD outcome: the RPC (it is the order writer) and the event queue (contract section 3).
 * Both carry the same idempotency key, so any step can be repeated. Throws when the Store is unreachable: the scheduler
 * retries with backoff. Without a bridge or a queue there is nothing to push to; the outcome stays recorded for later.
 */
export async function pushCodOutcome(host: LinkHost, orderId: string, now = Date.now()): Promise<PushResult> {
  const row = host.sql.exec<{ outcome: string | null; outcome_at: number | null; outcome_idem: string | null; outcome_pushed_at: number | null; buyer_key: string | null }>(
    'SELECT outcome, outcome_at, outcome_idem, outcome_pushed_at, buyer_key FROM store_orders WHERE order_id = ?', orderId,
  ).toArray()[0];
  if (!row?.outcome || !row.outcome_idem || row.outcome_pushed_at !== null) return { pushed: false, reason: 'nothing_to_push' };
  const bridge = bridgeFor(host.env);
  const sink = storeLink().events(host.env);
  if (!bridge && !sink) return { pushed: false, reason: 'link_off' };
  const outcome = row.outcome as CodOutcome;
  const at = new Date(row.outcome_at ?? now).toISOString();
  if (bridge) {
    const res = await bridge.recordCodOutcome(host.workspaceId, { orderId, outcome, at, idempotencyKey: row.outcome_idem });
    if (!res.ok && res.reason === 'unavailable') throw new Error(`store unavailable: ${res.message ?? ''}`.slice(0, 120));
    // not_found / not_linked / invalid are answers, not outages: retrying would not change them.
    if (!res.ok) console.error(JSON.stringify({ alert: 'cod_outcome_refused', workspace: host.workspaceId, reason: res.reason }));
  }
  if (sink) {
    const event: OutboundStoreEvent = outboundStoreEventSchema.parse({
      id: await uuidFromKey(row.outcome_idem), type: 'whatsapp.cod_outcome', v: 1, storeId: host.workspaceId, occurredAt: at, data: { orderId, outcome, source: 'whatsapp' },
    });
    await sink.send(event);
  }
  host.sql.exec('UPDATE store_orders SET outcome_pushed_at = ? WHERE order_id = ?', now, orderId);
  return { pushed: true };
}

/** Keeps only an order id and the hashed customer key for an order created while its customer was erased, and schedules telling the Store. Call inside a transaction. */
export function recordOrderAfterErase(host: LinkHost, o: { orderId: string; buyerKey: string }, now: number): void {
  host.sql.exec('INSERT OR IGNORE INTO store_orders_after_erase (order_id, buyer_key, created_at) VALUES (?, ?, ?)', o.orderId, o.buyerKey, now);
  addTask(host.sql, 'erased_order_notify', now);
}

/**
 * Tells the Store about each such order, then deletes the row: it exists only while the push is pending or retrying. The event id
 * is deterministic per order, so a retry after a lost acknowledgement stays idempotent. Throws when the queue is down.
 */
export async function pushErasedOrders(host: LinkHost): Promise<void> {
  const sink = storeLink().events(host.env);
  if (!sink) return; // re-scheduled when the store is linked
  for (const r of host.sql.exec<{ order_id: string; buyer_key: string; created_at: number }>('SELECT order_id, buyer_key, created_at FROM store_orders_after_erase').toArray()) {
    const event = outboundStoreEventSchema.parse({
      id: await uuidFromKey(`erased:${r.order_id}`), type: 'whatsapp.order_after_erasure', v: 1, storeId: host.workspaceId, occurredAt: new Date(r.created_at).toISOString(), data: { orderId: r.order_id, buyerKey: r.buyer_key },
    });
    await sink.send(event);
    host.sql.exec('DELETE FROM store_orders_after_erase WHERE order_id = ?', r.order_id);
  }
}
