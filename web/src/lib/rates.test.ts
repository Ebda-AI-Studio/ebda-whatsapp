import { describe, expect, it } from 'vitest';
import { parseRates, parseScaled, toMicros } from './rates';

describe('toMicros', () => {
  it('reads a decimal exactly, with no float rounding', () => {
    expect(toMicros('0.0529')).toBe(52_900);
    expect(toMicros('1')).toBe(1_000_000);
    expect(toMicros('48.123456')).toBe(48_123_456);
    expect(toMicros('0.1')).toBe(100_000);
  });
  it('refuses what is not a plain non-negative number with up to 6 decimals', () => {
    for (const bad of ['', 'abc', '-1', '1e3', '0.1234567', '1,5', '.', '1.']) expect(toMicros(bad)).toBeNull();
  });
});

describe('parseScaled', () => {
  it('turns a percent into basis points, accepting Arabic digits and the Arabic decimal mark', () => {
    expect(parseScaled('12.5', 2)).toBe(1250);
    expect(parseScaled('٢٫٥', 2)).toBe(250);
    expect(parseScaled('14', 2)).toBe(1400);
    expect(parseScaled('0.001', 2)).toBeNull();
  });
});

describe('parseRates', () => {
  it('parses country,category,usd lines; blank lines, comments and a header are ignored', () => {
    const r = parseRates('country,category,usd\n# note\n\nEG,marketing,0.0529\nSA, utility ,0.0112\n');
    expect(r).toEqual({ ok: true, rates: [{ country: 'EG', category: 'marketing', usdMicros: 52_900 }, { country: 'SA', category: 'utility', usdMicros: 11_200 }] });
  });
  it('reports the first problem with its line number', () => {
    expect(parseRates('')).toEqual({ ok: false, errors: [{ line: 0, code: 'empty' }] });
    expect(parseRates('EG,marketing')).toEqual({ ok: false, errors: [{ line: 1, code: 'bad_line' }] });
    expect(parseRates('eg,marketing,1')).toEqual({ ok: false, errors: [{ line: 1, code: 'bad_country' }] });
    expect(parseRates('EG,Marketing,1')).toEqual({ ok: false, errors: [{ line: 1, code: 'bad_category' }] });
    expect(parseRates('EG,marketing,x')).toEqual({ ok: false, errors: [{ line: 1, code: 'bad_price' }] });
    expect(parseRates('EG,marketing,1\nEG,marketing,2')).toEqual({ ok: false, errors: [{ line: 2, code: 'duplicate' }] });
  });
  it('collects every bad line, not just the first, up to a handful', () => {
    const r = parseRates('x\ny\nz');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3]);
  });
  it('caps the list at 2000 rates, the server limit', () => {
    const many = Array.from({ length: 2001 }, (_v, i) => `E${String.fromCharCode(65 + (i % 26))},cat_${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26) % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 676)]},1`).join('\n');
    expect(parseRates(many)).toEqual({ ok: false, errors: [{ line: 0, code: 'too_many' }] });
  });
});
