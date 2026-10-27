/**
 * Yearly packages (P2). Pure calendar and money rules, shared by the control plane (D1 side) and the workspace (Durable Object).
 *
 * Month arithmetic is whole calendar months in UTC (the same rule SQLite's `+N months` and the existing monthly code use), so a yearly
 * period that starts on 15 Jan ends on 15 Jan, and the monthly anniversaries inside it are the 15th of every month.
 */

/** `ms` plus `n` whole calendar months (UTC). */
export function addMonthsUtc(ms: number, n: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.getTime();
}

/** How many of the period's months have begun at `now` (the current month counts): 0 before the period starts, at most `periodMonths`. */
export function monthsStarted(periodStart: number, periodMonths: number, now: number): number {
  let n = 0;
  for (let j = 0; j < periodMonths; j++) if (addMonthsUtc(periodStart, j) <= now) n++;
  return n;
}

/** How many months a period [start, end] spans (the end is `start` + N whole months, to the second: SQLite month arithmetic truncates to seconds). */
export function periodLengthMonths(periodStart: number, periodEnd: number, maxMonths = 12): number {
  let n = 0;
  for (let j = 1; j <= maxMonths; j++) if (addMonthsUtc(periodStart, j) <= periodEnd + 1000) n = j;
  return n;
}

/** The merchant's favour: money is rounded DOWN to a whole EGP (a multiple of 100 minor). Only money, never months or credits. */
export const floorToWholeEgp = (minor: number): number => Math.floor(minor / 100) * 100;

/**
 * WA-YEARLY-SWITCH-2: the price of upgrading a RUNNING yearly period to a higher yearly package. The new package starts at once with the same end; the merchant
 * pays (new price/12 - old price/12) x the remaining months, where the remaining months are the CURRENT month plus every whole month after it (in month 12: 1),
 * rounded down to a whole EGP. Returns 0 when the target is not higher.
 */
export function upgradePriceMinor(a: { oldPriceMinor: number; newPriceMinor: number; periodMonths: number; periodStart: number; periodEnd: number; now: number }): number {
  const diff = Math.floor(a.newPriceMinor / a.periodMonths) - Math.floor(a.oldPriceMinor / a.periodMonths);
  if (diff <= 0) return 0;
  const n = periodLengthMonths(a.periodStart, a.periodEnd, a.periodMonths);
  const remaining = Math.max(1, n - monthsStarted(a.periodStart, n, a.now) + 1);
  return floorToWholeEgp(diff * remaining);
}

/** Whole months a partial refund takes off a yearly period, cumulative over everything refunded so far, never into the current month, never lengthening. */
export function partialRefundCut(a: { monthlyMinor: number; periodMonths: number; periodStart: number; periodEnd: number; now: number; refundedMinor: number; refundMinor: number; consumedMinor?: number }): { months: number; newEnd: number } {
  const n = periodLengthMonths(a.periodStart, a.periodEnd, a.periodMonths);
  // Money the months already cut consumed: what those refunds were worth at the rate in effect when each was made (default: today's rate, for a period that never changed rate).
  const consumed = a.consumedMinor ?? (a.periodMonths - n) * a.monthlyMinor;
  const unused = Math.max(0, n - monthsStarted(a.periodStart, n, a.now));
  const months = Math.max(0, Math.min(Math.floor((a.refundedMinor + a.refundMinor - consumed) / a.monthlyMinor), unused));
  return { months, newEnd: months > 0 ? addMonthsUtc(a.periodEnd, -months) : a.periodEnd };
}

export type YearlyRefundQuote = {
  periodMonths: number;
  /** floor(price / periodMonths): what one month is worth when refunding (never rounded up). */
  monthlyMinor: number;
  /** Whole months that have not begun, counted up to the CURRENT end of the period. The month in progress is never refunded; in the last month this is 0. */
  unusedMonths: number;
  grossMinor: number;
  debtMinor: number;
  /** The wallet debt is settled FIRST out of the refund (WA-REFUND-1). */
  debtSettledMinor: number;
  refundMinor: number;
};

/**
 * Review Focus 5: unused WHOLE months x floor(price / 12), current month kept, debt first. `priceMinor` is the price whose /12 values a month (after an upgrade:
 * the CURRENT package's); the unused months are counted up to the current `periodEnd` (a period shortened by earlier refunds has fewer); money already refunded
 * beyond the months already cut is deducted, and the result never exceeds `paidMinor` (all paid for the period, default the price) minus what was refunded.
 * A period that has not begun yet (a queued early renewal) has all its months unused; one that has ended has none. A monthly package is always 0.
 */
export function yearlyRefundQuote(a: { priceMinor: number; periodMonths: number; periodStart: number; periodEnd?: number; now: number; debtMinor: number; refundedMinor?: number; paidMinor?: number; consumedMinor?: number }): YearlyRefundQuote {
  const monthlyMinor = Math.floor(a.priceMinor / a.periodMonths);
  const periodEnd = a.periodEnd ?? addMonthsUtc(a.periodStart, a.periodMonths);
  const n = periodLengthMonths(a.periodStart, periodEnd, a.periodMonths) || a.periodMonths;
  const started = monthsStarted(a.periodStart, n, a.now);
  const unusedMonths = Math.max(0, n - started);
  const refunded = a.refundedMinor ?? 0;
  const leftover = Math.max(0, refunded - (a.consumedMinor ?? (a.periodMonths - n) * monthlyMinor)); // money refunded beyond the months already cut
  const cap = Math.max(0, (a.paidMinor ?? a.priceMinor) - refunded);
  const grossMinor = Math.max(0, Math.min(unusedMonths * monthlyMinor - leftover, cap));
  const debtSettledMinor = Math.min(grossMinor, Math.max(0, a.debtMinor));
  return { periodMonths: a.periodMonths, monthlyMinor, unusedMonths, grossMinor, debtMinor: Math.max(0, a.debtMinor), debtSettledMinor, refundMinor: grossMinor - debtSettledMinor };
}
