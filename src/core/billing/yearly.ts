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

export type YearlyRefundQuote = {
  periodMonths: number;
  /** floor(price / periodMonths): what one month is worth when refunding (never rounded up). */
  monthlyMinor: number;
  /** Whole months that have not begun. The month in progress is never refunded; in the last month this is 0. */
  unusedMonths: number;
  grossMinor: number;
  debtMinor: number;
  /** The wallet debt is settled FIRST out of the refund (WA-REFUND-1). */
  debtSettledMinor: number;
  refundMinor: number;
};

/**
 * Review Focus 5: unused WHOLE months x floor(price / 12), current month kept, debt first. A period that has not begun yet (a queued early renewal)
 * has all its months unused; one that has ended has none. A monthly package (1 month) is always 0: its only month is the current one.
 */
export function yearlyRefundQuote(a: { priceMinor: number; periodMonths: number; periodStart: number; now: number; debtMinor: number }): YearlyRefundQuote {
  const monthlyMinor = Math.floor(a.priceMinor / a.periodMonths);
  const started = monthsStarted(a.periodStart, a.periodMonths, a.now);
  const unusedMonths = Math.max(0, a.periodMonths - started);
  const grossMinor = unusedMonths * monthlyMinor;
  const debtSettledMinor = Math.min(grossMinor, Math.max(0, a.debtMinor));
  return { periodMonths: a.periodMonths, monthlyMinor, unusedMonths, grossMinor, debtMinor: Math.max(0, a.debtMinor), debtSettledMinor, refundMinor: grossMinor - debtSettledMinor };
}
