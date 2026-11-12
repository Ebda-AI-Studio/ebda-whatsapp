/**
 * The FX buffer (basis points added on top of the daily USD->EGP rate), recomputed each day from OUR OWN stored rate history. Pure: no I/O.
 *
 *   raw    = 500 + A x max(0, vol - baseline) + B x max(0, drift)
 *   buffer = clamp(500, 700, raw)
 *   vol      = sample stdev of the daily log returns of the last 14 CALENDAR days, in bps per day (a return over a gap of d days is divided by sqrt(d))
 *   baseline = median of that 14-day vol over the trailing 365 days
 *   drift    = the 14-day % rise of EGP per USD (gap-normalised); only a rise (EGP weakening) counts, because that is what under-charges us
 *   jump     = a ONE-calendar-day rise above 3% (signed: a fall never triggers it; a multi-day gap is not a one-day jump) -> 700 at once
 *   fall limit = the buffer may rise at once but falls at most 50 bps a day, and never exceeds 700 (an unpinned value above 700 steps down to 700 at once)
 *   fewer than 60 vol windows of history (about 70 days) -> 700 (the safe default; a 365-day backfill satisfies this at once)
 *
 * A and B were calibrated on the real series (docs/plans/2026-11-12-daily-fx-rate.md): with A = 1 and B = 20 the calm periods sit at ~500 and the worst
 * 14-day windows (+10%) reach 700. test/fx-buffer.test.ts replays that series and pins the table in the plan.
 */
export const FX_BUFFER = { minBps: 500, maxBps: 700, a: 1, b: 20, jumpPct: 3, maxFallBps: 50, windowDays: 14, baselineDays: 365, minWindows: 60, minReturnsPerWindow: 10 } as const;

export type BufferMode = 'computed' | 'jump' | 'short_history' | 'pinned' | 'backfill';
export type BufferResult = { bufferBps: number; volBps: number | null; driftPct: number | null; baselineBps: number | null; mode: BufferMode };
/** One observation per calendar day (`day` is YYYY-MM-DD, UTC), oldest first. */
export type RatePoint = { day: string; rate: number };

const DAY_MS = 86_400_000;
const dayNum = (d: string): number => Date.parse(`${d}T00:00:00Z`) / DAY_MS;

const median = (v: number[]): number => {
  const s = [...v].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Calendar-day windows: stdev (bps) of the gap-normalised log returns ending at point `i`, or null when fewer than minReturnsPerWindow fall inside. */
function volAt(p: RatePoint[], days: number[], norm: number[], i: number): number | null {
  const from = days[i]! - FX_BUFFER.windowDays;
  const r: number[] = [];
  for (let j = i; j >= 1 && days[j]! > from; j--) r.push(norm[j]!);
  if (r.length < FX_BUFFER.minReturnsPerWindow) return null;
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1)) * 1e4;
}

/**
 * `points`: one per day, oldest first, today's observation LAST. `prevBufferBps`: the buffer of the previous row (null = none).
 * `pin`: an operator pin (replaces the result; the computed inputs are still returned for the audit trail).
 */
export function computeFxBuffer(points: RatePoint[], prevBufferBps: number | null, pin: number | null = null): BufferResult {
  const { minBps, maxBps, a, b, jumpPct, maxFallBps, windowDays, minWindows } = FX_BUFFER;
  const finish = (r: BufferResult): BufferResult => (pin === null ? r : { ...r, bufferBps: pin, mode: 'pinned' });
  const short: BufferResult = { bufferBps: maxBps, volBps: null, driftPct: null, baselineBps: null, mode: 'short_history' };
  if (points.length < 2) return finish(short);
  const lastDay = dayNum(points.at(-1)!.day);
  const p = points.filter((x) => dayNum(x.day) >= lastDay - (FX_BUFFER.baselineDays + windowDays));
  const days = p.map((x) => dayNum(x.day));
  const norm = p.map((x, i) => (i === 0 ? 0 : Math.log(x.rate / p[i - 1]!.rate) / Math.sqrt(Math.max(1, days[i]! - days[i - 1]!))));
  const last = p.length - 1;
  const vols: number[] = [];
  for (let i = 1; i <= last; i++) {
    const v = volAt(p, days, norm, i);
    if (v !== null) vols.push(v);
  }
  // Drift anchor: the latest point at least windowDays back; none = too little history.
  let anchor = -1;
  for (let i = last - 1; i >= 0; i--) if (days[i]! <= days[last]! - windowDays) { anchor = i; break; }
  const vol = volAt(p, days, norm, last);
  if (vols.length < minWindows || anchor < 0 || vol === null) return finish(short);
  const baseline = median(vols);
  const drift = (p[last]!.rate / p[anchor]!.rate - 1) * 100 * (windowDays / (days[last]! - days[anchor]!));
  const oneDay = days[last]! - days[last - 1]! === 1;
  const jump = oneDay && (p[last]!.rate / p[last - 1]!.rate - 1) * 100 > jumpPct;
  const raw = Math.min(maxBps, Math.max(minBps, minBps + a * Math.max(0, vol - baseline) + b * Math.max(0, drift)));
  let buf = jump ? maxBps : raw;
  if (prevBufferBps !== null) buf = Math.min(maxBps, Math.max(buf, prevBufferBps - maxFallBps));
  return finish({ bufferBps: Math.round(buf), volBps: vol, driftPct: drift, baselineBps: baseline, mode: jump ? 'jump' : 'computed' });
}
