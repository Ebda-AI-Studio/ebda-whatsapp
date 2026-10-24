import type { Locale } from '../ordering/copy';
import { addTask } from '../scheduler';
import type { LinkHost } from './host';

export const locale = (l: string | undefined): Locale => (l?.toLowerCase().startsWith('en') ? 'en' : 'ar');

type OrderRow = { order_id: string; order_number: string | null; wa_id: string | null; buyer_key: string | null; payment_method: string | null; status: string | null; total_minor: number | null; currency: string | null; cod_state: string | null; locale: string | null };

export function orderRow(host: LinkHost, orderId: string): OrderRow | undefined {
  return host.sql.exec<OrderRow>('SELECT order_id, order_number, wa_id, buyer_key, payment_method, status, total_minor, currency, cod_state, locale FROM store_orders WHERE order_id = ?', orderId).toArray()[0];
}

export function upsertOrder(host: LinkHost, o: { orderId: string; orderNumber?: string | null; waId?: string | null; buyerKey?: string | null; paymentMethod?: string | null; status?: string | null; totalMinor?: number | null; currency?: string | null; codState?: string | null; codRequestedAt?: number | null; locale?: string | null }, now: number): void {
  host.sql.exec(
    `INSERT INTO store_orders (order_id, order_number, wa_id, buyer_key, payment_method, status, total_minor, currency, cod_state, cod_requested_at, locale, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(order_id) DO UPDATE SET
       order_number = coalesce(excluded.order_number, order_number), wa_id = coalesce(excluded.wa_id, wa_id), buyer_key = coalesce(excluded.buyer_key, buyer_key),
       payment_method = coalesce(excluded.payment_method, payment_method), status = coalesce(excluded.status, status), total_minor = coalesce(excluded.total_minor, total_minor),
       currency = coalesce(excluded.currency, currency), cod_state = coalesce(excluded.cod_state, cod_state), cod_requested_at = coalesce(excluded.cod_requested_at, cod_requested_at), locale = coalesce(excluded.locale, locale), updated_at = excluded.updated_at`,
    o.orderId, o.orderNumber ?? null, o.waId ?? null, o.buyerKey ?? null, o.paymentMethod ?? null, o.status ?? null, o.totalMinor ?? null, o.currency ?? null, o.codState ?? null, o.codRequestedAt ?? null, o.locale ?? null, now,
  );
}

/** Outcomes recorded while the Store could not be reached (or before it was linked) are pushed again. */
export function schedulePendingPushes(host: LinkHost, now: number): void {
  for (const r of host.sql.exec<{ order_id: string }>('SELECT order_id FROM store_orders WHERE outcome IS NOT NULL AND outcome_pushed_at IS NULL').toArray()) {
    addTask(host.sql, 'cod_outcome_push', now, { orderId: r.order_id });
  }
  if (host.sql.exec('SELECT 1 FROM store_orders_after_erase WHERE pushed_at IS NULL LIMIT 1').toArray().length) addTask(host.sql, 'erased_order_notify', now);
}
