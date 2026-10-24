import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';

afterEach(cleanup);

function setup() {
  return render(<App source={createSampleSource()} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
}

describe('inbox', () => {
  it('renders Arabic RTL with the three panes and a sample-data label', () => {
    setup();
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByRole('navigation', { name: 'التنقل الرئيسي' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'المحادثات' })).toBeTruthy();
    expect(screen.getByText('بيانات تجريبية للعرض فقط')).toBeTruthy();
  });

  it('opens a conversation, shows its messages and the customer order with a Confirm action', async () => {
    setup();
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    expect(await within(screen.getByRole('log')).findByText('عايزة أأكد الأوردر بتاع امبارح')).toBeTruthy();
    const orders = screen.getByRole('complementary', { name: 'طلبات العميل' });
    expect(within(orders).getByText('#1048')).toBeTruthy();
    expect(within(orders).getByRole('button', { name: 'تأكيد الطلب' })).toBeTruthy();
  });

  it('filters to unread', async () => {
    setup();
    await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    const before = screen.getAllByRole('listitem').length;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'غير مقروءة' })));
    expect(screen.getAllByRole('listitem').length).toBeLessThan(before);
  });

  it('sends a message optimistically', async () => {
    setup();
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    const box = screen.getByRole('textbox', { name: 'اكتب رسالة' });
    await act(async () => fireEvent.change(box, { target: { value: 'تمام، هنأكده دلوقتي' } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'إرسال' })));
    expect(await within(screen.getByRole('log')).findByText('تمام، هنأكده دلوقتي')).toBeTruthy();
  });

  it('a closed window disables free text and offers templates', async () => {
    setup();
    const target = await screen.findByRole('button', { name: /يوسف علي/ });
    await act(async () => fireEvent.click(target));
    expect(within(screen.getByRole('banner')).getByText('النافذة مقفولة · ابعت قالب')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'اكتب رسالة' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'اختيار قالب' })).toBeTruthy();
  });

  it('switches to English LTR', async () => {
    setup();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'English' })));
    expect(document.documentElement.dir).toBe('ltr');
    expect(screen.getByRole('list', { name: 'Conversations' })).toBeTruthy();
  });
});
