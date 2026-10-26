import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';
import { num } from './i18n';
import { dateTime } from './components/CampaignsScreen';
import { clockTime, formatMoney, relativeTime } from './lib/format';

afterEach(cleanup);
const ARABIC_INDIC = /[٠-٩۰-۹]/;
const now = () => Date.UTC(2026, 9, 24, 17, 0);

describe('DIGITS-1: the Arabic UI shows Western digits 0-9 only', () => {
  it('money, a date, a time, a count and a relative time come out as 0-9 in Arabic', () => {
    const out = [
      formatMoney(123_456_78, 'EGP', 'ar'), formatMoney(1500, 'EGP', 'ar'), formatMoney(12345, 'USD', 'ar'),
      num(1234567, 'ar'), num(42, 'ar'), num(12_500, 'ar'),
      dateTime(Date.UTC(2026, 9, 24, 9, 30), 'ar'), clockTime(Date.UTC(2026, 9, 24, 9, 30), 'ar'),
      relativeTime(now() - 3 * 3_600_000, now(), 'ar'), relativeTime(now() - 5 * 86_400_000, now(), 'ar'),
    ];
    for (const s of out) expect(s, s).not.toMatch(ARABIC_INDIC);
    expect(num(42, 'ar')).toBe('42');
    expect(formatMoney(1500, 'EGP', 'ar')).toMatch(/15/);
    expect(dateTime(Date.UTC(2026, 9, 24, 9, 30), 'ar')).toMatch(/24/);
  });

  it('the Arabic inbox (counts, times) renders no ٠-٩', async () => {
    render(<App source={createSampleSource()} now={now} />);
    await screen.findByText('منى عبد الرحمن');
    await act(async () => undefined);
    expect(document.body.textContent).not.toMatch(ARABIC_INDIC);
    expect(document.body.textContent).toMatch(/[0-9]/);
  });

  it('the Arabic wallet screen renders no ٠-٩', async () => {
    render(<App source={createSampleSource()} now={now} />);
    await screen.findByText('منى عبد الرحمن');
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المحفظة' })));
    await screen.findByRole('heading', { name: 'المحفظة', level: 1 });
    await act(async () => undefined);
    expect(document.body.textContent).toMatch(/[0-9]/);
    expect(document.body.textContent).not.toMatch(ARABIC_INDIC);
  });
});
