import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { WalletDto } from './data/billing';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';
import { dateOnly, dateTime } from './lib/datetime';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const t = STRINGS.ar;

describe('one date/time format per locale, Cairo time (CHAT-QA-6)', () => {
  const jan1 = Date.UTC(2027, 0, 1, 0, 0); // 02:00 in Cairo (UTC+2 in winter)
  it('carries the year and a 12-hour clock with am/pm, in Cairo time', () => {
    expect(dateTime(jan1, 'en')).toBe('Fri, 1 Jan 2027, 2:00 am');
    expect(dateTime(jan1, 'ar')).toMatch(/2027/);
    expect(dateTime(jan1, 'ar')).toMatch(/2:00\s?ص/);
    expect(dateTime(jan1, 'ar')).toMatch(/^[^0-9٠-٩]*1 /); // Latin digits in the Arabic UI
    expect(dateTime(Date.UTC(2027, 6, 1, 0, 0), 'en')).toMatch(/3:00 am/); // summer time is applied
    expect(dateOnly(jan1, 'en')).toBe('1 Jan 2027');
  });
  it('a missing moment is a dash, never 1 Jan 1970', () => {
    for (const bad of [null, undefined, 0, Number.NaN]) { expect(dateTime(bad, 'en')).toBe('—'); expect(dateOnly(bad, 'ar')).toBe('—'); }
  });
});

describe('operator pricing: no internal wording (CHAT-QA-5)', () => {
  it('the system-written first version shows the plain starting-settings line, not the ruling ids', async () => {
    const source = createSampleSource();
    source.role = 'super_admin';
    const real = source.operator!.pricingSettings;
    source.operator!.pricingSettings = async () => (await real()).map((s, i) => (i === 0 ? { ...s, actor: 'system', reason: 'WA-MARGIN-1 / WA-OVERDRAFT-1 launch defaults: 0% margin, 50 EGP overdraft, no VAT until Q5 is decided' } : s));
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
    await screen.findByRole('heading', { name: t.opTitle, level: 1 });
    await screen.findByRole('region', { name: t.opCurrent });
    expect(document.body.textContent).not.toMatch(/WA-MARGIN|WA-OVERDRAFT|Q5/);
    expect(screen.getByText(t.opSystemDefault)).toBeTruthy();
    expect(STRINGS.en.opVatLocked).not.toMatch(/ruling/i);
  });
  it('shows the Cairo reading under the effective-from picker', async () => {
    const source = createSampleSource();
    source.role = 'super_admin';
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
    await screen.findByRole('region', { name: t.opCurrent });
    expect(screen.getAllByText(/بتوقيت القاهرة/).length).toBeGreaterThan(0);
  });
});

describe('wallet plan naming (CHAT-QA-13)', () => {
  const open = async (plan: NonNullable<WalletDto['plan']>) => {
    const source = createSampleSource();
    const real = source.wallet!.wallet;
    source.wallet!.wallet = async () => ({ ...(await real()), plan });
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المحفظة' })));
    await screen.findByRole('heading', { name: 'المحفظة', level: 1 });
  };
  const base = { status: 'active' as const, periodEnd: now() + 864e5 * 20, cancelledAt: null };
  it('a Store-included package reads as the Store plan by its Store name, not the raw package id', async () => {
    await open({ ...base, packageId: 'store-included', storePlan: { code: 'business', nameAr: 'الأعمال', nameEn: 'Business' } });
    expect(await screen.findByText(t.wPlanStore('الأعمال'))).toBeTruthy();
    expect(document.body.textContent).not.toContain('store-included');
  });
  it('a Store-included package whose Store plan code was never recorded (applied before the code was kept) reads "Store plan", never the raw package id', async () => {
    await open({ ...base, packageId: 'store-included' });
    expect(await screen.findByText(t.wPlanStoreGeneric)).toBeTruthy();
    expect(document.body.textContent).not.toContain('store-included');
  });
  it('a bought package reads by its size-based name', async () => {
    await open({ ...base, packageId: 'pro', packageName: 'Chat 5,000 AI replies', packageNameAr: 'شات 5000 رد ذكي' });
    expect(await screen.findByText('شات 5000 رد ذكي')).toBeTruthy(); // the size-based name alone: it starts with "Chat", so no prefix is needed
  });
});
