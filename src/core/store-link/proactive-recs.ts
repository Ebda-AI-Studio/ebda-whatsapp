/**
 * Proactive post-order product suggestions (register row 309, Ruling CHAT-RECS-SWITCH-1, docs/rulings/CHAT-RECS-SWITCH-1.md).
 *
 * After `order.created` arrives over the Store bridge, ONE approved MARKETING template may go to the buyer with up to `SUGGESTIONS` products from the
 * Store's own recommendation engine. This is a message the store starts, outside the 24 h window, and it spends wallet credit, so nothing is sent unless
 * EVERY gate below is true, and the switch is OFF by default:
 *   1 switch ON (owner-set, workspace)        2 an approved template name is configured      3 explicit marketing consent on the contact, no opt-out
 *   4 not in quiet hours (deferred, not dropped)  5 per-customer frequency cap            6 something in stock to suggest.
 * Every non-send ends with a reason on `store_orders.recs_outcome` (never silent), and the order is claimed once (idempotent per order).
 * The wallet is touched only inside `queueTemplate`, which is reached after gates 1-6; it fails fast and writes nothing on a refusal.
 */
import { alert } from '../observability';
import { plainAmount } from '../ordering/money';
import { addTask } from '../scheduler';
import { bridgeFor } from '../store-link';
import type { CatalogRow } from '../store-bridge';
import type { LinkHost } from './host';
import { queueTemplate, cleanParam } from './outbound';
import { locale, orderRow } from './order-store';
import { getState, putState, readSettings } from './settings';

/** Products one message carries. */
export const SUGGESTIONS = 3;
/** Wait after the order so the confirmation arrives first. */
export const SEND_DELAY_MS = 2 * 3_600_000;
/** One proactive suggestion message per customer per this long (any order). */
export const CUSTOMER_CAP_MS = 14 * 86_400_000;
/** Local hours (shop time zone) when no marketing message goes out: 21:00 to 09:00. */
export const QUIET_FROM_HOUR = 21;
export const QUIET_TO_HOUR = 9;
/** The Store was unreachable this many times in a row: give up and say so. */
export const MAX_STORE_ATTEMPTS = 6;
const INACTIVE_ORDER = new Set(['cancelled', 'refused', 'returned']);

const K_ON = 'proactive_recs.enabled';
const K_TEMPLATE = 'proactive_recs.template';
export const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;

export type ProactiveRecsView = { enabled: boolean; templateName: string | null; suggestions: number; capDays: number; quietFrom: number; quietTo: number };

export function proactiveRecsView(host: Pick<LinkHost, 'sql'>): ProactiveRecsView {
  return { enabled: getState(host, K_ON) === '1', templateName: getState(host, K_TEMPLATE) || null, suggestions: SUGGESTIONS, capDays: CUSTOMER_CAP_MS / 86_400_000, quietFrom: QUIET_FROM_HOUR, quietTo: QUIET_TO_HOUR };
}

/** Owner setting. Turning it ON needs a template name (the approval itself is checked at send time, never assumed here). */
export function writeProactiveRecs(host: Pick<LinkHost, 'sql'>, patch: { enabled?: boolean; templateName?: string | null }): { ok: true; view: ProactiveRecsView } | { ok: false; reason: 'template_required' | 'invalid_template' } {
  const nextName = patch.templateName === undefined ? proactiveRecsView(host).templateName : patch.templateName;
  if (nextName !== null && !TEMPLATE_NAME.test(nextName)) return { ok: false, reason: 'invalid_template' };
  const nextOn = patch.enabled ?? proactiveRecsView(host).enabled;
  if (nextOn && !nextName) return { ok: false, reason: 'template_required' };
  putState(host, K_TEMPLATE, nextName ?? '');
  putState(host, K_ON, nextOn ? '1' : '0');
  return { ok: true, view: proactiveRecsView(host) };
}

/** Called from the `order.created` handler inside its transaction. Costs one state read when the switch is off; schedules nothing then. */
export function scheduleProactiveRecs(host: LinkHost, a: { orderId: string; phoneNumberId: string | null; now: number }): void {
  if (getState(host, K_ON) !== '1' || !a.phoneNumberId) return;
  addTask(host.sql, 'proactive_recs', a.now + SEND_DELAY_MS, { orderId: a.orderId, phoneNumberId: a.phoneNumberId });
}

function localHour(ms: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: 'numeric' }).format(ms));
}
export const inQuietHours = (ms: number, timeZone: string): boolean => {
  const h = localHour(ms, timeZone);
  return h >= QUIET_FROM_HOUR || h < QUIET_TO_HOUR;
};
/** The first quarter-hour at or after `ms` that is outside quiet hours. */
export function quietEnd(ms: number, timeZone: string): number {
  let t = ms;
  for (let i = 0; i < 96 && inQuietHours(t, timeZone); i++) t += 15 * 60_000;
  return t;
}

const record = (host: LinkHost, orderId: string, outcome: string, now: number): void => {
  host.sql.exec('UPDATE store_orders SET recs_outcome = ?, recs_at = ? WHERE order_id = ?', outcome, now, orderId);
};

const nameOf = (r: CatalogRow, loc: 'ar' | 'en') => cleanParam(loc === 'ar' ? r.titleAr ?? r.title : r.title, r.title, 60);
/** Body parameter 2: "name (price CUR)" joined with " - " (Meta forbids new lines inside a parameter). */
export const suggestionText = (items: CatalogRow[], loc: 'ar' | 'en'): string =>
  cleanParam(items.map((r) => `${nameOf(r, loc)} (${plainAmount(r.priceMinor)} ${r.currency})`).join(' - '), '', 900);

/**
 * The scheduled task. Returns the next due time to retry later (quiet hours), undefined when finished, and throws to retry with backoff
 * (Store unreachable). Every gate is re-read HERE, not at scheduling time: the owner may have switched it off or the customer may have opted out meanwhile.
 */
export async function runProactiveRecs(host: LinkHost, payload: string | null, now: number, attempts: number): Promise<number | undefined> {
  const p = JSON.parse(payload ?? 'null') as { orderId?: unknown; phoneNumberId?: unknown } | null;
  if (typeof p?.orderId !== 'string' || typeof p.phoneNumberId !== 'string') return undefined;
  const orderId = p.orderId;
  const view = proactiveRecsView(host);
  const order = orderRow(host, orderId);
  if (!order) return undefined;
  const claimed = (): boolean => host.sql.exec<{ recs_outcome: string | null }>('SELECT recs_outcome FROM store_orders WHERE order_id = ?', orderId).toArray()[0]?.recs_outcome != null;
  if (claimed()) return undefined; // idempotent per order
  const skip = (reason: string): undefined => { host.storage.transactionSync(() => record(host, orderId, `skipped:${reason}`, now)); return undefined; };

  if (!view.enabled) return skip('switch_off');
  if (!view.templateName) return skip('no_template');
  if (!order.wa_id || !order.buyer_key || !order.order_number) return skip('order_incomplete');
  if (order.status && INACTIVE_ORDER.has(order.status)) return skip('order_not_active');
  const contact = host.sql.exec<{ consent_at: number | null; opted_out_at: number | null }>('SELECT consent_at, opted_out_at FROM contacts WHERE wa_id = ?', order.wa_id).toArray()[0];
  if (!contact || contact.consent_at == null) return skip('no_consent');
  if (contact.opted_out_at != null) return skip('opted_out');
  const tz = readSettings(host).hours.timezone;
  if (inQuietHours(now, tz)) return quietEnd(now, tz); // deferred, not dropped
  const recent = host.sql.exec<{ n: number }>("SELECT count(*) AS n FROM store_orders WHERE wa_id = ? AND recs_outcome = 'sent' AND recs_at > ?", order.wa_id, now - CUSTOMER_CAP_MS).one().n;
  if (recent > 0) return skip('frequency_cap');

  const bridge = bridgeFor(host.env);
  if (!bridge) return skip('store_not_linked');
  const e164 = `+${order.wa_id}`;
  const res = await bridge.getRecommendations(host.workspaceId, { seedIds: [], orderNumber: order.order_number, buyerKey: order.buyer_key, phoneE164: e164, mode: 'complement', limit: SUGGESTIONS + 3 });
  if (!res.ok) {
    if (res.reason === 'unavailable' && attempts + 1 < MAX_STORE_ATTEMPTS) throw new Error('store_unavailable');
    return skip(res.reason === 'unavailable' ? 'store_unavailable' : 'store_refused');
  }
  const items = res.value.items.filter((r) => r.availability === 'in_stock').slice(0, SUGGESTIONS);
  if (!items.length) return skip('nothing_to_suggest');
  const loc = locale(order.locale ?? undefined);
  const name = cleanParam(host.sql.exec<{ profile_name: string | null }>('SELECT profile_name FROM contacts WHERE wa_id = ?', order.wa_id).toArray()[0]?.profile_name, loc === 'ar' ? 'عميلنا العزيز' : 'there');

  // Everything after the await is one synchronous transaction: re-check the claim and the switch (they may have changed during the Store call),
  // queue the template (wallet speaks first inside queueTemplate), record the result. A throw rolls the queue back; the row is then marked failed, never left queued.
  let failure: string | null = null;
  try {
    host.storage.transactionSync((): void => {
      if (claimed()) return;
      if (!proactiveRecsView(host).enabled) {
        record(host, orderId, 'skipped:switch_off', now);
        return;
      }
      const r = queueTemplate(host, {
        waId: order.wa_id!, phoneNumberId: p.phoneNumberId as string, name: view.templateName!, language: loc, fallbackLanguage: 'ar', params: [name, suggestionText(items, loc)],
        idempotencyKey: `recs:${orderId}`, orderRef: orderId, requireConsent: true, campaign: true, requireCategory: 'MARKETING', now,
      });
      // Pricing not loaded yet is transient: leave the order undecided and retry; every other refusal (wallet empty, plan, template) is final and recorded.
      if (!r.ok && r.reason === 'funding_unknown' && attempts + 1 < MAX_STORE_ATTEMPTS) failure = r.reason;
      else record(host, orderId, r.ok ? 'sent' : `skipped:${r.reason}`, now);
    });
  } catch (err) {
    host.storage.transactionSync(() => record(host, orderId, 'failed:enqueue', now));
    alert('proactive_recs_enqueue_failed', { workspace: host.workspaceId, error: err instanceof Error ? err.name : 'error' });
    return undefined;
  }
  if (failure) throw new Error(failure);
  return undefined;
}
