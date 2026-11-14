import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemplateEditor, deriveName, editorReducer, newDraft, type EditorState } from './components/TemplateEditor';
import { ApiError } from './data/api';
import { STRINGS } from './i18n';
import { fakeApi, tpl } from './templates-fixtures';
import type { TemplatesApi } from './data/source';

afterEach(cleanup);
const t = STRINGS.ar;
const onSaved = vi.fn();
const onClose = vi.fn();
const open = (api: TemplatesApi = fakeApi(), over: Partial<Parameters<typeof TemplateEditor>[0]> = {}) => {
  render(<TemplateEditor t={t} lang="ar" api={api} mode="create" existing={[]} onSaved={onSaved} onClose={onClose} {...over} />);
  return api;
};
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => screen.getByRole('button', { name: 'راجع وابعت لميتا' });

describe('editor rules, live', () => {
  it('a body that starts with a variable shows the Arabic error beside the body and disables submit', () => {
    open();
    type('اسم القالب (ليك إنت بس)', 'شحن');
    type('نص الرسالة', '{{1}} شكراً على طلبك');
    expect(screen.getByText(/متبدأش الرسالة ولا تخلّصها بمتغيّر/)).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  it('adding {{1}} adds a required example field', () => {
    open();
    type('نص الرسالة', 'أهلاً شكراً على طلبك.');
    expect(screen.queryByLabelText('مثال للمتغيّر 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ضيف متغيّر' }));
    expect((screen.getByLabelText('نص الرسالة') as HTMLTextAreaElement).value).toContain('{{1}}');
    expect(screen.getByLabelText('مثال للمتغيّر 1')).toBeTruthy();
    expect(screen.getByText(/اكتب مثال للمتغيّر رقم 1/)).toBeTruthy();
  });

  it('an 11th button is impossible: the add buttons disable at 10 and URL disables at 2', () => {
    open();
    const addQr = () => screen.getByRole('button', { name: 'ضيف زر رد سريع' }) as HTMLButtonElement;
    for (let i = 0; i < 10; i++) { expect(addQr().disabled).toBe(false); fireEvent.click(addQr()); }
    expect(addQr().disabled).toBe(true);
    for (const n of ['ضيف زر رابط', 'ضيف زر اتصال', 'ضيف زر نسخ كود']) expect((screen.getByRole('button', { name: n }) as HTMLButtonElement).disabled, n).toBe(true);
    cleanup();
    open();
    const addUrl = () => screen.getByRole('button', { name: 'ضيف زر رابط' }) as HTMLButtonElement;
    fireEvent.click(addUrl());
    fireEvent.click(addUrl());
    expect(addUrl().disabled).toBe(true);
  });

  it('a quick reply cannot land between two URL buttons (the reducer keeps quick replies first)', () => {
    let s: EditorState = { draft: newDraft('abcd'), suffix: 'abcd', nameEdited: false };
    s = editorReducer(s, { type: 'addButton', button: { type: 'URL', text: 'أ', url: 'https://a.example' } });
    s = editorReducer(s, { type: 'addButton', button: { type: 'URL', text: 'ب', url: 'https://b.example' } });
    s = editorReducer(s, { type: 'addButton', button: { type: 'QUICK_REPLY', text: 'ج' } });
    expect(s.draft.buttons.map((b) => b.type)).toEqual(['QUICK_REPLY', 'URL', 'URL']);
  });

  it('the technical name is derived from the title with a suffix and shown only under advanced settings', () => {
    expect(deriveName('Shipping Update!', 'k3x9')).toBe('shipping_update_k3x9');
    expect(deriveName('تحديث الشحن', 'k3x9')).toBe('template_k3x9');
    open();
    const adv = document.querySelector('details.tpl-advanced') as HTMLDetailsElement;
    expect(adv).toBeTruthy();
    expect(adv.open).toBe(false);
    type('اسم القالب (ليك إنت بس)', 'Shipping');
    expect((screen.getByLabelText('الاسم التقني عند ميتا') as HTMLInputElement).value).toMatch(/^shipping_[a-z0-9]{3}$/);
  });

  it('AUTHENTICATION hides the free body field and shows only expiry and the security toggle', () => {
    open();
    fireEvent.click(screen.getByLabelText(/كود تحقق/));
    expect(screen.queryByLabelText('نص الرسالة')).toBeNull();
    expect(screen.getByLabelText('صلاحية الكود بالدقايق (اختياري)')).toBeTruthy();
    expect(screen.getByLabelText(/متشاركش الكود/)).toBeTruthy();
    type('اسم القالب (ليك إنت بس)', 'كودي');
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
    type('صلاحية الكود بالدقايق (اختياري)', '120');
    expect(screen.getByText(/من 1 لـ 90 دقيقة/)).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  it('a promotional-looking service message is a warning that must be acknowledged', () => {
    open();
    type('اسم القالب (ليك إنت بس)', 'عرض');
    type('نص الرسالة', 'أهلاً شكراً، عندنا خصم على طلبك اليوم.');
    expect(screen.getByText(/شكلها ترويجي/)).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('فهمت التنبيه وعايز أكمّل'));
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('submit flow', () => {
  const fill = () => {
    type('اسم القالب (ليك إنت بس)', 'تحديث الشحن');
    type('نص الرسالة', 'أهلاً شكراً لطلبك، شحنتك خرجت.');
  };

  it('submit shows the confirm step and calls create only after confirm, passing expectedHash from the last check', async () => {
    const api = open();
    fill();
    await act(async () => fireEvent.click(submit()));
    expect(api.check).toHaveBeenCalledTimes(1);
    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getByText('ده هيتبعت لميتا للمراجعة ومش هينفع تسحبه بعد كده، تقدر تعدّله أو تمسحه.')).toBeTruthy();
    expect(screen.getByTestId('tpl-bubble').textContent).toContain('شحنتك خرجت');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أيوه، ابعته لميتا' })));
    expect(api.create).toHaveBeenCalledTimes(1);
    const [draft, hash] = (api.create as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(hash).toBe('a'.repeat(64));
    expect(draft).toMatchObject({ label: 'تحديث الشحن', language: 'ar', category: 'UTILITY', body: { text: 'أهلاً شكراً لطلبك، شحنتك خرجت.' } });
    expect(await screen.findByText('اتبعت لميتا. بتاخد لحد 24 ساعة.')).toBeTruthy();
    expect(screen.queryByText(/صنّفت القالب ده/)).toBeNull();
  });

  it('going back from the confirm step sends nothing', async () => {
    const api = open();
    fill();
    await act(async () => fireEvent.click(submit()));
    fireEvent.click(screen.getByRole('button', { name: 'رجوع للتعديل' }));
    expect(api.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText('نص الرسالة')).toBeTruthy();
  });

  it('a server check that finds an error keeps the merchant on the form with the message', async () => {
    const api = open(fakeApi({ check: vi.fn(async () => ({ issues: [{ code: 'duplicate_body' as const, severity: 'error' as const, field: 'body' as const }], payloadHash: 'b'.repeat(64) })) }));
    fill();
    await act(async () => fireEvent.click(submit()));
    expect(screen.getByText(/عندك قالب تاني بنفس النص/)).toBeTruthy();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('server 409 exists shows "عندك قالب بنفس الاسم واللغة"', async () => {
    open(fakeApi({ create: vi.fn(async () => { throw new ApiError('invalid_request', 409, 'exists'); }) }));
    fill();
    await act(async () => fireEvent.click(submit()));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أيوه، ابعته لميتا' })));
    expect(screen.getByRole('alert').textContent).toContain('عندك قالب بنفس الاسم واللغة');
  });

  it('a changed payload and a Meta refusal each have their own sentence', async () => {
    open(fakeApi({ create: vi.fn(async () => { throw new ApiError('invalid_request', 409, 'payload_changed'); }) }));
    fill();
    await act(async () => fireEvent.click(submit()));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أيوه، ابعته لميتا' })));
    expect(screen.getByRole('alert').textContent).toContain('القالب اتغيّر بعد ما راجعته');
    cleanup();
    open(fakeApi({ create: vi.fn(async () => { throw new ApiError('invalid_request', 400, 'Template name already exists'); }) }));
    fill();
    await act(async () => fireEvent.click(submit()));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أيوه، ابعته لميتا' })));
    expect(screen.getByRole('alert').textContent).toContain('Template name already exists');
  });

  it('categoryChanged shows the recategorisation notice (opt-in, price, campaigns)', async () => {
    open(fakeApi({ create: vi.fn(async (d) => ({ name: d.name, language: d.language, status: 'PENDING', category: 'MARKETING' as const, categoryChanged: true })) }));
    fill();
    await act(async () => fireEvent.click(submit()));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أيوه، ابعته لميتا' })));
    const note = await screen.findByText(/صنّفت القالب ده «رسائل تسويق»/);
    expect(note.textContent).toMatch(/موافق على التسويق/);
    expect(note.textContent).toMatch(/سعر الرسالة أعلى/);
    expect(note.textContent).toMatch(/حملاتك/);
  });

  it('edit mode opens the stored template pre-filled, locks the category once approved, and calls edit', async () => {
    const approved = tpl({ name: 'my_t', label: 'قالبي', status: 'APPROVED', components: [{ type: 'BODY', text: 'أهلاً {{1}} طلبك اتسجّل.', example: { body_text: [['أحمد']] } }] });
    const api = open(fakeApi(), { mode: 'edit', template: approved });
    expect((screen.getByLabelText('نص الرسالة') as HTMLTextAreaElement).value).toBe('أهلاً {{1}} طلبك اتسجّل.');
    expect((screen.getByLabelText('مثال للمتغيّر 1') as HTMLInputElement).value).toBe('أحمد');
    expect(screen.getByText('نوع القالب مقفول بعد موافقة ميتا.')).toBeTruthy();
    expect(screen.getByLabelText(/رسالة تسويق/).matches(':disabled')).toBe(true); // disabled by the locked fieldset
    type('نص الرسالة', 'أهلاً {{1}} طلبك اتسجّل عندنا.');
    await act(async () => fireEvent.click(submit()));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'أيوه، ابعته لميتا' })));
    expect(api.edit).toHaveBeenCalledWith('my_t', 'ar', expect.objectContaining({ name: 'my_t', label: 'قالبي' }), 'a'.repeat(64));
  });

  it('Arabic and English both render without missing keys', () => {
    for (const lang of ['ar', 'en'] as const) {
      render(<TemplateEditor t={STRINGS[lang]} lang={lang} api={fakeApi()} mode="create" existing={[]} onSaved={onSaved} onClose={onClose} />);
      expect(within(document.body).queryByText(/undefined/)).toBeNull();
      cleanup();
    }
  });
});
