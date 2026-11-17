import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const open = async (source = createSampleSource()) => {
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: 'البوت' })));
  await screen.findByRole('heading', { name: 'مفاتيح البوت' });
  return source;
};
const sw = (name: string) => screen.getByRole('switch', { name }) as HTMLButtonElement;
const click = (el: HTMLElement) => act(async () => fireEvent.click(el));

describe('bot switches and sending speed (A28, A31-A33)', () => {
  it('shows the tier, use, speed and queue from the throttle report', async () => {
    await open();
    const card = screen.getByRole('heading', { name: 'سرعة الإرسال وحد الرسايل' }).closest('section')!;
    expect(card.textContent).toContain('حد المحادثات الجديدة: 1000 في اليوم');
    expect(card.textContent).toContain('المستخدم في آخر 24 ساعة: 120 من 1000');
    expect(card.textContent).toContain('سرعة الإرسال: 80 رسالة في الثانية');
    expect(card.textContent).toContain('مفيش رسايل مستنية.');
  });

  it('says so when no number is connected', async () => {
    const source = createSampleSource();
    source.switches!.throttle = async () => null;
    await open(source);
    expect(screen.getByText('اربط رقم واتساب الأول علشان تشوف السرعة وحد الرسايل.')).toBeTruthy();
  });

  it('turns the ordering bot off at once (no confirm step) and back on', async () => {
    const source = await open();
    expect(sw('بوت الطلبات').getAttribute('aria-checked')).toBe('true');
    await click(sw('بوت الطلبات'));
    expect((await source.switches!.get()).orderingBot).toBe(false);
    expect(sw('بوت الطلبات').getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('group', { name: 'تأكيد التشغيل' })).toBeNull();
    expect(screen.getAllByRole('status').some((e) => e.textContent === 'اتحفظ')).toBe(true);
  });

  it('asks before turning order confirmations ON: nothing is saved until the owner says yes', async () => {
    const source = await open();
    const save = vi.spyOn(source.switches!, 'save');
    await click(sw('رسايل تأكيد الطلب'));
    const ask = screen.getByRole('group', { name: 'تأكيد التشغيل' });
    expect(ask.textContent).toContain('بتتخصم من محفظتك');
    expect(save).not.toHaveBeenCalled();
    expect((await source.switches!.get()).orderConfirmations).toBe(false);
    await click(within(ask).getByRole('button', { name: 'أيوه، شغّل' }));
    expect(save).toHaveBeenCalledWith({ orderConfirmations: true }, expect.stringMatching(/^[0-9a-f]{64}$/));
    expect((await source.switches!.get()).orderConfirmations).toBe(true);
    expect(screen.queryByRole('group', { name: 'تأكيد التشغيل' })).toBeNull();
  });

  it('leaving it off keeps the switch off and sends nothing', async () => {
    const source = await open();
    const save = vi.spyOn(source.switches!, 'save');
    await click(sw('كود دخول المتجر على واتساب'));
    await click(within(screen.getByRole('group', { name: 'تأكيد التشغيل' })).getByRole('button', { name: 'لأ، سيبه مقفول' }));
    expect(save).not.toHaveBeenCalled();
    expect(sw('كود دخول المتجر على واتساب').getAttribute('aria-checked')).toBe('false');
  });

  it('turning a confirmed switch OFF needs no confirm step', async () => {
    const source = await open();
    await source.switches!.save({ otpViaWhatsApp: true }, (await source.switches!.preview({ otpViaWhatsApp: true })).confirmToken);
    cleanup();
    await open(source);
    await click(sw('كود دخول المتجر على واتساب'));
    expect(screen.queryByRole('group', { name: 'تأكيد التشغيل' })).toBeNull();
    expect((await source.switches!.get()).otpViaWhatsApp).toBe(false);
  });

  it('an expired confirmation shows the reason and keeps the switch off', async () => {
    const source = await open();
    source.switches!.save = async () => { throw Object.assign(new Error('x'), { detail: 'confirm_expired' }); };
    await click(sw('رسايل تأكيد الطلب'));
    await click(screen.getByRole('button', { name: 'أيوه، شغّل' }));
    expect(screen.getByRole('alert').textContent).toContain('التأكيد خلص وقته');
    expect(sw('رسايل تأكيد الطلب').getAttribute('aria-checked')).toBe('false');
  });

  it('staff can read the switches but not flip them', async () => {
    const source = createSampleSource();
    (source as { role: string }).role = 'staff';
    await open(source);
    for (const n of ['بوت الطلبات', 'رسايل تأكيد الطلب', 'كود دخول المتجر على واتساب']) expect(sw(n).disabled).toBe(true);
  });
});
