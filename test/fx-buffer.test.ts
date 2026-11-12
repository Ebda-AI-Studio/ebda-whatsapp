import { describe, expect, it } from 'vitest';
import { FX_BUFFER, computeFxBuffer } from '../src/core/billing/fx-buffer';

import fixture from './fixtures/egp-usd-364d.json';

const series = fixture as { egp: number[] };

/** Replays the real 364-day series day by day, the way the cron would (history = everything before, prev = yesterday's buffer). */
function replay(): number[] {
  const out: number[] = [];
  let prev: number | null = null;
  for (let i = FX_BUFFER.window; i < series.egp.length; i++) {
    prev = computeFxBuffer(series.egp.slice(0, i + 1), prev).bufferBps;
    out.push(prev);
  }
  return out;
}

describe('FX buffer', () => {
  it('uses 700 when there are fewer than 14 daily moves', () => {
    expect(computeFxBuffer([50, 50.1, 50.2], null)).toMatchObject({ bufferBps: 700, mode: 'short_history', volBps: null });
    expect(computeFxBuffer(series.egp.slice(0, 14), null).mode).toBe('short_history'); // 13 moves
    expect(computeFxBuffer(series.egp.slice(0, 15), null).mode).not.toBe('short_history'); // 14 moves
  });

  it('a flat series sits at the 500 floor', () => {
    expect(computeFxBuffer(Array(40).fill(50), null)).toMatchObject({ bufferBps: 500, mode: 'computed' });
  });

  it('rising: a 10% 14-day rise reaches 700, a 2% rise stays under 550', () => {
    const up = (pct: number) => Array.from({ length: 30 }, (_, i) => 50 * (1 + (pct / 100) * Math.max(0, i - 15) / 14));
    expect(computeFxBuffer(up(10), null).bufferBps).toBe(700);
    expect(computeFxBuffer(up(2), null).bufferBps).toBeLessThan(550);
  });

  it('only depreciation counts: a falling rate never raises the buffer through drift', () => {
    const down = Array.from({ length: 30 }, (_, i) => 50 * (1 - 0.1 * Math.max(0, i - 15) / 14));
    expect(computeFxBuffer(down, null).driftPct!).toBeLessThan(0);
    expect(computeFxBuffer(down, null).bufferBps).toBeLessThan(560); // vol may add a little, drift adds nothing
  });

  it('a jump day above 3% goes to 700 at once; 3% exactly does not', () => {
    const base = Array(30).fill(50) as number[];
    expect(computeFxBuffer([...base, 50 * 1.031], 500)).toMatchObject({ bufferBps: 700, mode: 'jump' });
    expect(computeFxBuffer([...base, 50 * 1.0299], 500).mode).toBe('computed');
    expect(computeFxBuffer([...base, 50 * 0.96], 500).bufferBps).toBe(700); // a fall that large also means the feed is unstable
  });

  it('hysteresis: rises at once, falls at most 50 bps a day', () => {
    const flat = Array(40).fill(50) as number[];
    expect(computeFxBuffer(flat, 700).bufferBps).toBe(650);
    expect(computeFxBuffer(flat, 520).bufferBps).toBe(500);
    expect(computeFxBuffer(flat, 500).bufferBps).toBe(500);
    let b = 700;
    const days: number[] = [];
    for (let i = 0; i < 5; i++) days.push((b = computeFxBuffer(flat, b).bufferBps));
    expect(days).toEqual([650, 600, 550, 500, 500]);
  });

  it('a pin replaces the result but the inputs stay for the audit trail', () => {
    const r = computeFxBuffer(Array(40).fill(50), 700, 123);
    expect(r).toMatchObject({ bufferBps: 123, mode: 'pinned' });
    expect(r.volBps).not.toBeNull();
  });

  it('calibration on the real 364-day series matches the table in docs/plans/2026-11-12-daily-fx-rate.md', () => {
    const o = replay();
    expect(o.length).toBe(350);
    expect(Math.min(...o)).toBe(500);
    expect(Math.max(...o)).toBe(700);
    const n = (f: (x: number) => boolean) => o.filter(f).length;
    expect(n((x) => x === 500)).toBe(36);
    expect(n((x) => x > 500 && x < 550)).toBe(226);
    expect(n((x) => x >= 550 && x < 650)).toBe(64);
    expect(n((x) => x >= 650 && x < 700)).toBe(16);
    expect(n((x) => x === 700)).toBe(8);
    // The worst windows (14-day rise >= 9.5%) sit at 700.
    const idx = series.egp.map((_, i) => i).filter((i) => i >= FX_BUFFER.window && (series.egp[i]! / series.egp[i - 14]! - 1) * 100 >= 9.5);
    expect(idx.length).toBe(3);
    for (const i of idx) expect(o[i - FX_BUFFER.window]).toBe(700);
  });
});
