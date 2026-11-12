/**
 * The FX buffer (basis points added on top of the daily USD->EGP rate), recomputed each day from OUR OWN stored rate history. Pure: no I/O.
 *
 *   raw    = 500 + A x max(0, vol - baseline) + B x max(0, drift)
 *   buffer = clamp(500, 700, raw)
 *   vol      = sample stdev of the last 14 daily log returns, in bps per day
 *   baseline = median of that 14-day vol over the trailing 365 days
 *   drift    = the 14-day % move of EGP per USD; only a rising rate (EGP weakening) counts, because that is what under-charges us
 *   jump     = today's one-day move above 3% -> 700 at once
 *   fall limit = the buffer may rise at once but falls at most 50 bps a day, so prices do not flap
 *   fewer than 14 daily moves of history -> 700 (the safe default)
 *
 * A and B were calibrated on the real 364-day series (docs/plans/2026-11-12-daily-fx-rate.md): with A = 1 and B = 20 the calm periods sit at
 * ~500 and the worst 14-day windows (+10%) reach 700. test/fx-buffer.test.ts replays that series and pins the table in the plan.
 */
export const FX_BUFFER = { minBps: 500, maxBps: 700, a: 1, b: 20, jumpPct: 3, maxFallBps: 50, window: 14, baselineDays: 365 } as const;

export type BufferMode = 'computed' | 'jump' | 'short_history' | 'pinned';
export type BufferResult = { bufferBps: number; volBps: number | null; driftPct: number | null; baselineBps: number | null; mode: BufferMode };

const median = (v: number[]): number => {
  const s = [...v].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Sample stdev of log returns ending at index `end` (exclusive of nothing: returns r[end-window+1..end], r[i] = ln(p[i]/p[i-1])), in bps. */
function volAt(p: number[], end: number): number {
  const w = FX_BUFFER.window;
  const r: number[] = [];
  for (let i = end - w + 1; i <= end; i++) r.push(Math.log(p[i]! / p[i - 1]!));
  const mean = r.reduce((s, x) => s + x, 0) / w;
  return Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (w - 1)) * 1e4;
}

/**
 * `rates`: EGP per USD, ONE per day, oldest first, today's observation LAST. `prevBufferBps`: the buffer of the previous row (null = none).
 * `pin`: an operator pin (replaces the result; the computed inputs are still returned for the audit trail).
 */
export function computeFxBuffer(rates: number[], prevBufferBps: number | null, pin: number | null = null): BufferResult {
  const { minBps, maxBps, a, b, jumpPct, maxFallBps, window } = FX_BUFFER;
  const p = rates.slice(-(FX_BUFFER.baselineDays + window + 1));
  const last = p.length - 1;
  let result: BufferResult;
  if (last < window) {
    result = { bufferBps: maxBps, volBps: null, driftPct: null, baselineBps: null, mode: 'short_history' };
  } else {
    const vol = volAt(p, last);
    const vols: number[] = [];
    for (let e = window; e <= last; e++) vols.push(volAt(p, e));
    const baseline = median(vols);
    const drift = (p[last]! / p[last - window]! - 1) * 100;
    const dayMovePct = Math.abs(p[last]! / p[last - 1]! - 1) * 100;
    const raw = Math.min(maxBps, Math.max(minBps, minBps + a * Math.max(0, vol - baseline) + b * Math.max(0, drift)));
    const jump = dayMovePct > jumpPct;
    let buf = jump ? maxBps : raw;
    if (prevBufferBps !== null && buf < prevBufferBps - maxFallBps) buf = prevBufferBps - maxFallBps;
    result = { bufferBps: Math.round(buf), volBps: vol, driftPct: drift, baselineBps: baseline, mode: jump ? 'jump' : 'computed' };
  }
  return pin === null ? result : { ...result, bufferBps: pin, mode: 'pinned' };
}
