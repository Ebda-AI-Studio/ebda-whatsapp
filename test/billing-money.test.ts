import { describe, expect, it } from 'vitest';
import { countryOf, countryToDigits } from '../src/core/billing/country';
import { egpString, priceMinor, roundHalfEvenDiv, vatOf } from '../src/core/billing/money';
import { monthRange, statementCsv, type Statement } from '../src/core/billing/statement';

describe('roundHalfEven', () => {
  it.each([
    [5n, 10n, 0n], // .5 -> 0 (even)
    [15n, 10n, 2n], // 1.5 -> 2
    [25n, 10n, 2n], // 2.5 -> 2
    [35n, 10n, 4n], // 3.5 -> 4
    [14n, 10n, 1n], [16n, 10n, 2n], [0n, 7n, 0n], [7n, 7n, 1n],
  ])('%s / %s = %s', (n, d, want) => expect(roundHalfEvenDiv(n, d)).toBe(want));
});

describe('priceMinor: piasters = roundHalfEven(usd_micros x fx_micros x (10000 + margin_bps) / 10^14)', () => {
  const FX = 50_000_000; // 50 EGP per USD
  it.each([
    // [usd_micros, margin_bps, expected piasters, why]
    [1000, 0, 5, 'exact: $0.001 x 50 = 5 piasters'],
    [1100, 0, 6, '5.5 -> 6 (round to even)'],
    [1300, 0, 6, '6.5 -> 6 (round to even)'],
    [900, 0, 4, '4.5 -> 4 (round to even)'],
    [100, 0, 0, '0.5 -> 0 (round to even)'],
    [300, 0, 2, '1.5 -> 2'],
    [1000, 1000, 6, '5 x 1.10 = 5.5 -> 6'],
    [1000, 3000, 6, '5 x 1.30 = 6.5 -> 6'],
    [50_000, 0, 250, 'marketing $0.05 = 250'],
  ])('usd %s margin %s bps -> %s (%s)', (usd, margin, want) => {
    expect(priceMinor({ usdMicros: usd, fxMicros: FX, marginBps: margin })).toBe(want);
  });
  it('312.5 -> 312 (even) and 313.5 -> 314', () => {
    expect(priceMinor({ usdMicros: 50_000, fxMicros: FX, marginBps: 2500 })).toBe(312);
    expect(priceMinor({ usdMicros: 50_200, fxMicros: FX, marginBps: 2500 })).toBe(314); // 251 x 1.25 = 313.75 -> 314
  });
  it('is exact for large inputs (no float): a $100 message at 52.3456 EGP', () => {
    expect(priceMinor({ usdMicros: 100_000_000, fxMicros: 52_345_600, marginBps: 0 })).toBe(523_456);
  });
  it('the FX buffer joins the same single rounding', () => {
    expect(priceMinor({ usdMicros: 1000, fxMicros: FX, marginBps: 0, fxBufferBps: 1000 })).toBe(6); // 5 x 1.10 = 5.5 -> 6
    expect(priceMinor({ usdMicros: 1000, fxMicros: FX, marginBps: 0, fxBufferBps: 0 })).toBe(5);
  });
  it('VAT is rounded half-even per row and carries the sign', () => {
    expect(vatOf(250, 1400)).toBe(35);
    expect(vatOf(-250, 1400)).toBe(-35);
    expect(vatOf(125, 1000)).toBe(12); // 12.5 -> 12
    expect(vatOf(135, 1000)).toBe(14); // 13.5 -> 14
    expect(vatOf(250, 0)).toBe(0);
  });
  it('egpString is exact', () => {
    expect([egpString(0), egpString(5), egpString(1234), egpString(-1234), egpString(100)]).toEqual(['0.00', '0.05', '12.34', '-12.34', '1.00']);
  });
});

describe('markets and months', () => {
  it('maps a calling code to a market, unknown to ROW', () => {
    expect([countryOf('201001234567'), countryOf('+966501234567'), countryOf('96550000000'), countryOf('15551234567'), countryOf('99912345')]).toEqual(['EG', 'SA', 'KW', 'US', 'ROW']);
    expect(countryOf(`+${countryToDigits('AE')}500000000`)).toBe('AE');
  });
  it('a Cairo month starts at local midnight (UTC+2 in winter, UTC+3 in summer)', () => {
    expect(monthRange('2026-01')).toEqual({ from: Date.UTC(2025, 11, 31, 22), to: Date.UTC(2026, 0, 31, 22) });
    expect(monthRange('2026-07')).toEqual({ from: Date.UTC(2026, 5, 30, 21), to: Date.UTC(2026, 6, 31, 21) });
    expect(monthRange('2026-13')).toBeNull();
    expect(monthRange('x')).toBeNull();
  });
  it('the CSV defuses spreadsheet formulas and quotes commas', () => {
    const st: Statement = {
      month: '2026-01', from: 0, to: 1, openingMinor: 100, closingMinor: 0, truncated: false, totalsByKind: {}, totalsByCategory: {}, cardCosts: [],
      rows: [{ at: 0, kind: 'adjustment', netMinor: -100, vatMinor: 0, amountMinor: -100, balanceAfterMinor: 0, ref: 'adj:1', wamid: null, category: null, note: '=HYPERLINK("x"),y' }],
    };
    const lines = statementCsv(st).trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain('"\'=HYPERLINK(""x""),y"');
    expect(lines[0]).toBe('date_utc,kind,category,net_egp,vat_egp,amount_egp,balance_after_egp,ref,wamid,note');
  });
});
