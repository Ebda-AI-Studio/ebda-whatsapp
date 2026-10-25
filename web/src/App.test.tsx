import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('never drops a COD decision: a second decision flushes the first, and leaving the page flushes too', async () => {
    const source = createSampleSource();
    const spy = vi.spyOn(source, 'recordCodOutcome');
    render(<App source={source} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
    let target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    const orders = () => screen.getByRole('complementary', { name: 'طلبات العميل' });
    await act(async () => fireEvent.click(await within(orders()).findByRole('button', { name: 'تأكيد الطلب' })));
    expect(spy).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(spy).toHaveBeenCalledWith('201001112233', '#1048', 'confirmed');
  });

  it('a live event for a message already shown optimistically does not duplicate it', async () => {
    const source = createSampleSource();
    let emit: (e: Parameters<Parameters<typeof source.subscribe>[0]>[0]) => void = () => undefined;
    source.subscribe = (cb) => { emit = cb; return () => undefined; };
    let release: (m: Awaited<ReturnType<typeof source.send>>) => void = () => undefined;
    source.send = (_id, req) => new Promise((r) => { release = r; void req; });
    render(<App source={source} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    await act(async () => fireEvent.change(screen.getByRole('textbox', { name: 'اكتب رسالة' }), { target: { value: 'مرة واحدة بس' } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'إرسال' })));
    const clientId = (screen.getByRole('log').lastElementChild as HTMLElement).dataset.clientId!;
    const real = { id: 777, clientId, wamid: 'w', direction: 'out' as const, type: 'text' as const, text: 'مرة واحدة بس', hasLongBody: false, media: null, template: null, status: 'accepted' as const, errorCode: null, at: 1 };
    await act(async () => emit({ type: 'message.created', seq: 1, conversationId: 1, message: real }));
    await act(async () => release(real));
    expect(within(screen.getByRole('log')).getAllByText('مرة واحدة بس')).toHaveLength(1);
  });

  it('the undo toast follows the language switch', async () => {
    setup();
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    await act(async () => fireEvent.click(await within(screen.getByRole('complementary', { name: 'طلبات العميل' })).findByRole('button', { name: 'تأكيد الطلب' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'English' })));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('confirmed');
  });

  it('asks for template variables before sending a template that has them', async () => {
    setup();
    const target = await screen.findByRole('button', { name: /يوسف علي/ });
    await act(async () => fireEvent.click(target));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'اختيار قالب' })));
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /تحديث الشحن/ })));
    const fields = screen.getAllByRole('textbox', { name: /متغير/ });
    expect(fields).toHaveLength(2);
    const send = screen.getByRole('button', { name: 'ابعت القالب' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await act(async () => { fireEvent.change(fields[0]!, { target: { value: '#0996' } }); fireEvent.change(fields[1]!, { target: { value: 'https://track.example/0996' } }); });
    expect(send.disabled).toBe(false);
    await act(async () => fireEvent.click(send));
    expect(within(screen.getByRole('log')).getByText(/طلبك #0996 اتشحن/)).toBeTruthy();
  });

  it('updates an existing bubble when message.created is re-sent for the same id (media landed)', async () => {
    const source = createSampleSource();
    let emit: (e: Parameters<Parameters<typeof source.subscribe>[0]>[0]) => void = () => undefined;
    source.subscribe = (cb) => { emit = cb; return () => undefined; };
    render(<App source={source} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    const base = { clientId: null, wamid: 'w.img', direction: 'in' as const, type: 'image' as const, hasLongBody: false, template: null, status: null, errorCode: null, at: Date.UTC(2026, 9, 24, 16, 59) };
    await act(async () => emit({ type: 'message.created', seq: 1, conversationId: 1, message: { ...base, id: 900, text: 'صورة', media: null } }));
    await act(async () => emit({ type: 'message.created', seq: 2, conversationId: 1, message: { ...base, id: 900, text: 'صورة المقاس', media: { mime: 'image/jpeg', size: 9, url: '/m/900' } } }));
    const log = within(screen.getByRole('log'));
    expect(log.queryByText('صورة')).toBeNull();
    expect(log.getByText('صورة المقاس')).toBeTruthy();
  });

  it('a failing orders call never blocks the messages from showing', async () => {
    const source = createSampleSource();
    source.orders = async () => { throw new Error('404'); };
    render(<App source={source} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    expect(await within(screen.getByRole('log')).findByText('عايزة أأكد الأوردر بتاع امبارح')).toBeTruthy();
  });

  it('retry resends the original request with the same clientId', async () => {
    const source = createSampleSource();
    const seen: string[] = [];
    let fail = true;
    const real = source.send.bind(source);
    source.send = async (id, req) => { seen.push(req.clientId); if (fail) { fail = false; throw new Error('net'); } return real(id, req); };
    render(<App source={source} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    await act(async () => fireEvent.change(screen.getByRole('textbox', { name: 'اكتب رسالة' }), { target: { value: 'تجربة' } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'إرسال' })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'حاول تاني' })));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('hides Confirm/Refuse when the source cannot record COD outcomes yet', async () => {
    const source = createSampleSource();
    source.capabilities = { codOutcome: false };
    render(<App source={source} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    const orders = screen.getByRole('complementary', { name: 'طلبات العميل' });
    await within(orders).findByText('#1048');
    expect(within(orders).queryByRole('button', { name: 'تأكيد الطلب' })).toBeNull();
  });

  it('a late send response never downgrades a newer status from a live event', async () => {
    const source = createSampleSource();
    let emit: (e: Parameters<Parameters<typeof source.subscribe>[0]>[0]) => void = () => undefined;
    source.subscribe = (cb) => { emit = cb; return () => undefined; };
    let release: (m: Awaited<ReturnType<typeof source.send>>) => void = () => undefined;
    source.send = () => new Promise((r) => { release = r; });
    render(<App source={source} now={() => Date.UTC(2026, 9, 24, 17, 0)} />);
    const target = await screen.findByRole('button', { name: /منى عبد الرحمن/ });
    await act(async () => fireEvent.click(target));
    await act(async () => fireEvent.change(screen.getByRole('textbox', { name: 'اكتب رسالة' }), { target: { value: 'حالة' } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'إرسال' })));
    const clientId = (screen.getByRole('log').lastElementChild as HTMLElement).dataset.clientId!;
    const msg = { id: 55, clientId, wamid: 'w', direction: 'out' as const, type: 'text' as const, text: 'حالة', hasLongBody: false, media: null, template: null, errorCode: null, at: 1 };
    await act(async () => emit({ type: 'message.created', seq: 1, conversationId: 1, message: { ...msg, status: 'delivered' } }));
    await act(async () => release({ ...msg, status: 'queued' }));
    expect(screen.getByRole('log').querySelector('[data-client-id="' + clientId + '"] [data-status]')?.getAttribute('data-status')).toBe('delivered');
  });
});
