import { describe, expect, it } from 'vitest';
import { formatMoney, relativeTime, windowLeft, orderStops } from './format';

const NOW = Date.UTC(2026, 9, 24, 17, 0);

describe('format (ar)', () => {
  it('formats EGP minor units with Arabic digits', () => expect(formatMoney(68000, 'EGP', 'ar')).toBe('٦٨٠ ج.م'));
  it('formats EGP in English', () => expect(formatMoney(68000, 'EGP', 'en')).toBe('EGP 680'));
  it('keeps piasters when they are not zero', () => {
    expect(formatMoney(74950, 'EGP', 'en')).toBe('EGP 749.50');
    expect(formatMoney(74950, 'EGP', 'ar')).toBe('٧٤٩٫٥٠ ج.م');
  });
  it('relative time: minutes, hours, yesterday', () => {
    expect(relativeTime(NOW - 2 * 60_000, NOW, 'ar')).toBe('٢ د');
    expect(relativeTime(NOW - 3 * 3600_000, NOW, 'ar')).toBe('٣ س');
    expect(relativeTime(NOW - 30 * 3600_000, NOW, 'ar')).toBe('أمس');
    expect(relativeTime(NOW - 2 * 60_000, NOW, 'en')).toBe('2m');
  });
  it('window left: open with hours, closing soon, closed', () => {
    expect(windowLeft(NOW + 22 * 3600_000, NOW, 'ar')).toEqual({ state: 'open', label: 'النافذة مفتوحة · باقي ٢٢ ساعة' });
    expect(windowLeft(NOW + 40 * 60_000, NOW, 'ar')).toEqual({ state: 'closing', label: 'النافذة بتقفل خلال ٤٠ دقيقة' });
    expect(windowLeft(null, NOW, 'ar')).toEqual({ state: 'closed', label: 'النافذة مقفولة · ابعت قالب' });
    expect(windowLeft(NOW - 1, NOW, 'en').state).toBe('closed');
  });
  it('order stops fill up to the current state; refused and cancelled stop the rail', () => {
    expect(orderStops('confirmed').map((s) => s.done)).toEqual([true, true, false, false]);
    expect(orderStops('delivered').map((s) => s.done)).toEqual([true, true, true, true]);
    expect(orderStops('pending_confirmation').map((s) => s.done)).toEqual([true, false, false, false]);
    expect(orderStops('refused').at(1)).toMatchObject({ key: 'confirmed', halted: true });
  });
});
