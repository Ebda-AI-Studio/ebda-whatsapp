import { describe, expect, it } from 'vitest';
import { formatMoney, relativeTime, windowLeft, orderStops } from './format';

const NOW = Date.UTC(2026, 9, 24, 17, 0);

describe('format (ar)', () => {
  it('formats EGP minor units with Western digits (0-9)', () => expect(formatMoney(68000, 'EGP', 'ar')).toBe('680 ج.م'));
  it('formats EGP in English', () => expect(formatMoney(68000, 'EGP', 'en')).toBe('EGP 680'));
  it('keeps piasters when they are not zero', () => {
    expect(formatMoney(74950, 'EGP', 'en')).toBe('EGP 749.50');
    expect(formatMoney(74950, 'EGP', 'ar')).toBe('749.50 ج.م');
  });
  it('relative time: minutes, hours, yesterday', () => {
    expect(relativeTime(NOW - 2 * 60_000, NOW, 'ar')).toBe('2 د');
    expect(relativeTime(NOW - 3 * 3600_000, NOW, 'ar')).toBe('3 س');
    expect(relativeTime(NOW - 30 * 3600_000, NOW, 'ar')).toBe('أمس');
    expect(relativeTime(NOW - 2 * 60_000, NOW, 'en')).toBe('2m');
  });
  it('window left: open with hours, closing soon, closed', () => {
    expect(windowLeft(NOW + 22 * 3600_000, NOW, 'ar')).toEqual({ state: 'open', label: 'النافذة مفتوحة · باقي 22 ساعة' });
    expect(windowLeft(NOW + 40 * 60_000, NOW, 'ar')).toEqual({ state: 'closing', label: 'النافذة بتقفل خلال 40 دقيقة' });
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

import { STRINGS } from '../i18n';
describe('payment method labels', () => {
  it('names InstaPay in both languages', () => {
    expect(STRINGS.ar.instapay).toBe('إنستاباي');
    expect(STRINGS.en.instapay).toBe('InstaPay');
  });
});
