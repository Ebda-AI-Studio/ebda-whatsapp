import type { OrderSummaryDto } from '../../../src/core/api/contract';
import { STRINGS, num, type Lang } from '../i18n';

export function formatMoney(minor: number, currency: string, lang: Lang): string {
  const digits = minor % 100 === 0 ? 0 : 2; // whole pounds stay clean; piasters are never rounded away
  const value = new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: lang !== 'ar' || minor >= 1_000_000 }).format(minor / 100);
  if (currency === 'EGP') return lang === 'ar' ? `${value} ج.م` : `EGP ${value}`;
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / 100);
}

export function relativeTime(at: number, now: number, lang: Lang): string {
  const t = STRINGS[lang];
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 60) return lang === 'ar' ? `${num(Math.max(min, 1), lang)} ${t.minutesShort}` : `${Math.max(min, 1)}${t.minutesShort}`;
  const h = Math.floor(min / 60);
  if (h < 24) return lang === 'ar' ? `${num(h, lang)} ${t.hoursShort}` : `${h}${t.hoursShort}`;
  if (h < 48) return t.yesterday;
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short' }).format(at);
}

export function clockTime(at: number, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Cairo' }).format(at);
}

export type WindowState = { state: 'open' | 'closing' | 'closed'; label: string };

/** Meta's 24 h customer-service window. Closing = under one hour left. */
export function windowLeft(openUntil: number | null, now: number, lang: Lang): WindowState {
  const t = STRINGS[lang];
  if (openUntil === null || openUntil <= now) return { state: 'closed', label: t.windowClosed };
  const min = Math.floor((openUntil - now) / 60_000);
  if (min < 60) return { state: 'closing', label: t.windowClosing(num(min, lang)) };
  return { state: 'open', label: t.windowOpen(num(Math.floor(min / 60), lang)) };
}

export type Stop = { key: 'placed' | 'confirmed' | 'shipped' | 'delivered'; done: boolean; halted?: boolean };

/** The brass rail: four stops filled up to the order's state; a refusal or cancellation halts at "confirmed". */
export function orderStops(status: OrderSummaryDto['status']): Stop[] {
  const reached = { pending_confirmation: 0, confirmed: 1, shipped: 2, delivered: 3, returned: 3, refused: 0, cancelled: 0 }[status];
  const keys: Stop['key'][] = ['placed', 'confirmed', 'shipped', 'delivered'];
  return keys.map((key, i) => ({ key, done: i <= reached, ...(i === 1 && (status === 'refused' || status === 'cancelled') ? { halted: true } : {}) }));
}
