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
    expect((screen.getByLabelText('اكتب رسالة') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'اختيار قالب' })).toBeTruthy();
  });

  it('keeps Arabic customer text in its own direction inside the English UI', async () => {
    setup();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'English' })));
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    const text = await within(screen.getByRole('log')).findByText('عايزة أأكد الأوردر بتاع امبارح');
    expect(text.getAttribute('dir')).toBe('auto');
  });

  it('switches to English LTR', async () => {
    setup();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'English' })));
    expect(document.documentElement.dir).toBe('ltr');
    expect(screen.getByRole('list', { name: 'Conversations' })).toBeTruthy();
  });

  it('confirms a pending COD order in one action: the rail advances and an undo is offered', async () => {
    setup();
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    const orders = screen.getByRole('complementary', { name: 'طلبات العميل' });
    await act(async () => fireEvent.click(await within(orders).findByRole('button', { name: 'تأكيد الطلب' })));
    expect(within(orders).getAllByText('متأكد').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'تراجع' })).toBeTruthy();
  });

  it('asks once before refusing an order', async () => {
    setup();
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    const orders = screen.getByRole('complementary', { name: 'طلبات العميل' });
    await act(async () => fireEvent.click(await within(orders).findByRole('button', { name: 'رفض' })));
    expect(within(orders).queryByText('مرفوض')).toBeNull();
    await act(async () => fireEvent.click(within(orders).getByRole('button', { name: 'أيوه، ارفض الطلب' })));
    expect(within(orders).getAllByText('مرفوض').length).toBeGreaterThan(0);
  });

  it('offers quick replies that fill the composer', async () => {
    setup();
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    const group = screen.getByRole('group', { name: 'ردود سريعة' });
    const first = within(group).getAllByRole('button')[0]!;
    await act(async () => fireEvent.click(first));
    expect((screen.getByRole('textbox', { name: 'اكتب رسالة' }) as HTMLTextAreaElement).value).toBe(first.textContent);
  });

  it('shows a sent message immediately in the queued state, before the server answers', async () => {
    let release: () => void = () => undefined;
    const source = createSampleSource();
    const slowSend = source.send.bind(source);
    source.send = (id, req) => new Promise((r) => { release = () => r(slowSend(id, req)); });
    render(<App source={source} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    await act(async () => fireEvent.change(screen.getByRole('textbox', { name: 'اكتب رسالة' }), { target: { value: 'رسالة سريعة' } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'إرسال' })));
    expect(within(screen.getByRole('log')).getByText('رسالة سريعة')).toBeTruthy();
    await act(async () => release());
    expect(within(screen.getByRole('log')).getAllByText('رسالة سريعة')).toHaveLength(1);
  });

  it('in a closed window the template button is the primary action', async () => {
    setup();
    const target = await screen.findByRole('button', { name: /يوسف علي/ });
    await act(async () => fireEvent.click(target));
    const tpl = screen.getByRole('button', { name: 'اختيار قالب' });
    expect(tpl.className).toContain('gold');
  });
});
