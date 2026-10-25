/**
 * Business hours for the InstaPay review SLA: Sunday to Thursday, 09:00-17:00 Africa/Cairo (Friday and Saturday are the weekend).
 * Cairo's offset changes with daylight saving, so every window edge is converted with Intl for THAT date, never with a fixed offset.
 */
const TZ = 'Africa/Cairo';
const OPEN_HOUR = 9;
const CLOSE_HOUR = 17;
const DAY_MS = 86_400_000;

const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number };
function cairoParts(ms: number): Parts {
  const p: Record<string, number> = {};
  for (const x of fmt.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}
/** Cairo's offset from UTC at an instant (milliseconds, +2 h or +3 h). */
function offsetMs(ms: number): number {
  const p = cairoParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** The instant at which Cairo's wall clock reads y-mo-d h:00 (two passes so a date next to a clock change is still right). */
function cairoWallToUtc(y: number, mo: number, d: number, h: number): number {
  const guess = Date.UTC(y, mo - 1, d, h);
  const first = guess - offsetMs(guess);
  return guess - offsetMs(first);
}

/** Milliseconds of business time inside [from, to]; 0 when `to <= from`. */
export function businessMsBetween(from: number, to: number): number {
  if (!(to > from)) return 0;
  const a = cairoParts(from);
  const b = cairoParts(to);
  let day = Date.UTC(a.y, a.mo - 1, a.d);
  const last = Date.UTC(b.y, b.mo - 1, b.d);
  let total = 0;
  for (; day <= last; day += DAY_MS) {
    const dow = new Date(day).getUTCDay(); // the Cairo calendar date's weekday: 0 Sunday ... 6 Saturday
    if (dow === 5 || dow === 6) continue;
    const d = new Date(day);
    const open = cairoWallToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), OPEN_HOUR);
    const close = cairoWallToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), CLOSE_HOUR);
    total += Math.max(0, Math.min(to, close) - Math.max(from, open));
  }
  return total;
}
