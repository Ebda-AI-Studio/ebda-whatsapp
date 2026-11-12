import { describe, expect, it } from 'vitest';
import { FX_BUFFER, computeFxBuffer, type RatePoint } from '../src/core/billing/fx-buffer';
import fixture from './fixtures/egp-usd-364d.json';

const f = fixture as { days: string[]; egp: number[] };
const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);
const dayOf = (i: number) => new Date(START + i * DAY).toISOString().slice(0, 10);
/** One point per calendar day from 2026-01-01. */
const series = (rates: number[]): RatePoint[] => rates.map((rate, i) => ({ day: dayOf(i), rate }));
const flat = (n: number, v = 50) => Array(n).fill(v) as number[];
const real: RatePoint[] = f.days.map((day, i) => ({ day, rate: f.egp[i]! }));

/** Replays the real series day by day, the way the cron would (history = everything before, prev = yesterday's buffer). */
function replay() {
  const out: { b: number; mode: string; i: number }[] = [];
  let prev: number | null = null;
  for (let i = 1; i < real.length; i++) {
    const r = computeFxBuffer(real.slice(0, i + 1), prev);
    prev = r.bufferBps;
    out.push({ b: r.bufferBps, mode: r.mode, i });
  }
  return out;
}

describe('FX buffer', () => {
  it('stays in short_history (700) until there are 60 vol windows: 69 days is short, 70 is not', () => {
    expect(computeFxBuffer(series([50, 50.1, 50.2]), null)).toMatchObject({ bufferBps: 700, mode: 'short_history', volBps: null });
    expect(computeFxBuffer(series(flat(69)), null).mode).toBe('short_history');
    expect(computeFxBuffer(series(flat(70)), null)).toMatchObject({ mode: 'computed', bufferBps: 500 });
  });

  it('rising: a 10% 14-day rise reaches 700, a 2% rise stays under 550', () => {
    const up = (pct: number) => series([...flat(90), ...Array.from({ length: 14 }, (_, i) => 50 * (1 + (pct / 100) * ((i + 1) / 14)))]);
    expect(computeFxBuffer(up(10), null).bufferBps).toBe(700);
    expect(computeFxBuffer(up(2), null).bufferBps).toBeLessThan(550);
  });

  it('only depreciation counts: a falling rate adds nothing through drift', () => {
    const down = series([...flat(90), ...Array.from({ length: 14 }, (_, i) => 50 * (1 - 0.1 * ((i + 1) / 14)))]);
    const r = computeFxBuffer(down, null);
    expect(r.driftPct!).toBeLessThan(0);
    expect(r.bufferBps).toBeLessThan(560);
  });

  it('jump: a one-day RISE above 3% goes to 700 at once; exactly 3% does not', () => {
    expect(computeFxBuffer(series([...flat(90), 50 * 1.031]), 500)).toMatchObject({ bufferBps: 700, mode: 'jump' });
    expect(computeFxBuffer(series([...flat(90), 50 * 1.0299]), 500).mode).toBe('computed');
  });

  it('jump is signed: a 4% FALL (EGP strengthening) is not a jump', () => {
    const r = computeFxBuffer(series([...flat(90), 50 * 0.96]), 500);
    expect(r.mode).toBe('computed');
    expect(r.bufferBps).toBeLessThan(700);
  });

  it('calendar days: a 3.5% rise over a 4-day gap is a multi-day return, not a one-day jump, and vol is normalised by sqrt(days)', () => {
    const base = series(flat(90));
    const gap: RatePoint[] = [...base, { day: dayOf(93), rate: 50 * 1.035 }]; // days 90..92 missing
    const r = computeFxBuffer(gap, 500);
    expect(r.mode).not.toBe('jump');
    // the same rise as a ONE-day move would be a jump
    expect(computeFxBuffer([...base, { day: dayOf(90), rate: 50 * 1.035 }], 500).mode).toBe('jump');
    // vol: one return of ln(1.035) over 4 days enters as ln(1.035)/2, half of what a one-day move would
    const v4 = computeFxBuffer(gap, null).volBps!;
    const v1 = computeFxBuffer([...base, { day: dayOf(90), rate: 50 * 1.035 }], null).volBps!;
    expect(v4).toBeLessThan(v1);
  });

  it('hysteresis: rises at once, falls at most 50 bps a day', () => {
    const s = series(flat(90));
    expect(computeFxBuffer(s, 700).bufferBps).toBe(650);
    expect(computeFxBuffer(s, 520).bufferBps).toBe(500);
    let b = 700;
    const days: number[] = [];
    for (let i = 0; i < 5; i++) days.push((b = computeFxBuffer(s, b).bufferBps));
    expect(days).toEqual([650, 600, 550, 500, 500]);
  });

  it('never exceeds 700 after an unpin: a previous pinned 1000 steps down to 700 at once; a pin itself may set any value', () => {
    expect(computeFxBuffer(series(flat(90)), 1000).bufferBps).toBe(700);
    expect(computeFxBuffer(series(flat(90)), 900).bufferBps).toBe(700);
    expect(computeFxBuffer(series(flat(90)), 1000, 1200)).toMatchObject({ bufferBps: 1200, mode: 'pinned' });
  });

  it('a pin replaces the result but the inputs stay for the audit trail', () => {
    const r = computeFxBuffer(series(flat(90)), 700, 123);
    expect(r).toMatchObject({ bufferBps: 123, mode: 'pinned' });
    expect(r.volBps).not.toBeNull();
  });

  it('calibration on the real series (calendar-day replay) matches the table in docs/plans/2026-11-12-daily-fx-rate.md', () => {
    const o = replay();
    expect(o.length).toBe(363);
    const short = o.filter((x) => x.mode === 'short_history');
    expect(short.length).toBe(68);
    const ev = o.filter((x) => x.mode !== 'short_history');
    expect(ev.length).toBe(295);
    expect(Math.min(...ev.map((x) => x.b))).toBe(500);
    expect(Math.max(...ev.map((x) => x.b))).toBe(700);
    const n = (g: (x: number) => boolean) => ev.filter((x) => g(x.b)).length;
    expect(n((x) => x === 500)).toBe(25);
    expect(n((x) => x > 500 && x < 550)).toBe(180);
    expect(n((x) => x >= 550 && x < 650)).toBe(64);
    expect(n((x) => x >= 650 && x < 700)).toBe(18);
    expect(n((x) => x === 700)).toBe(8);
    expect(ev.filter((x) => x.mode === 'jump').length).toBe(1);
    // The worst windows (14-day rise >= 9.5%) sit at 700.
    const byDay = new Map(real.map((p, i) => [p.day, i]));
    const worst = real.map((p, i) => ({ i, a: byDay.get(new Date(Date.parse(p.day) - 14 * DAY).toISOString().slice(0, 10)) })).filter((x) => x.a !== undefined && (real[x.i]!.rate / real[x.a!]!.rate - 1) * 100 >= 9.5);
    expect(worst.length).toBe(3);
    for (const w of worst) expect(o.find((x) => x.i === w.i)!.b).toBe(700);
    expect(FX_BUFFER.minWindows).toBe(60);
  });
});
