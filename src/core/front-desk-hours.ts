/**
 * Business hours. The local time comes from Intl (never a fixed UTC offset), so daylight saving needs no special case: every
 * answer is computed from the wall clock the shop's customers and staff actually see.
 */
import type { HoursSettings } from './store-link/bot-settings';

type Local = { y: number; mo: number; d: number; weekday: number; minute: number };
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function localOf(ms: number, timeZone: string): Local {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), weekday: WEEKDAYS[p.weekday!]!, minute: Number(p.hour) * 60 + Number(p.minute) };
}

const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Is the shop open at this instant? Disabled hours are always open. */
export function isOpen(hours: HoursSettings, nowMs: number): boolean {
  if (!hours.enabled) return true;
  const l = localOf(nowMs, hours.timezone);
  for (const r of hours.week[l.weekday as 0] ?? []) {
    const open = minutes(r.open);
    const close = minutes(r.close);
    if (open < close ? l.minute >= open && l.minute < close : l.minute >= open) return true;
  }
  // the tail of yesterday's overnight range
  for (const r of hours.week[((l.weekday + 6) % 7) as 0] ?? []) {
    const open = minutes(r.open);
    const close = minutes(r.close);
    if (close < open && l.minute < close) return true;
  }
  return false;
}

/** The instant the wall clock of `timeZone` reads y-mo-d and `minute` (a time swallowed by the clocks moving forward lands just after the gap). */
function instantOf(timeZone: string, y: number, mo: number, d: number, minute: number): number {
  const wall = Date.UTC(y, mo - 1, d, 0, minute);
  const asWall = (ms: number) => { const l = localOf(ms, timeZone); return Date.UTC(l.y, l.mo - 1, l.d, 0, l.minute); };
  const first = wall - (asWall(wall) - wall);
  return wall - (asWall(first) - first);
}

/** The next moment the shop opens after `nowMs`, or null when no day has a range. It is the same value for every instant of one closed period. */
export function nextOpenAt(hours: HoursSettings, nowMs: number): number | null {
  const l = localOf(nowMs, hours.timezone);
  for (let ahead = 0; ahead <= 7; ahead++) {
    const date = new Date(Date.UTC(l.y, l.mo - 1, l.d + ahead));
    const ranges = hours.week[((l.weekday + ahead) % 7) as 0] ?? [];
    const starts = ranges.map((r) => instantOf(hours.timezone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), minutes(r.open))).sort((a, b) => a - b);
    const next = starts.find((s) => s > nowMs);
    if (next !== undefined) return next;
  }
  return null;
}
