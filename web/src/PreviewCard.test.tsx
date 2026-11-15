import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantPreviewCard } from '../../src/core/api/contract';
import { PreviewCard } from './components/PreviewCard';
import { ApiError } from './data/api';
import type { AssistantApi } from './data/assistant';
import { STRINGS } from './i18n';

afterEach(cleanup);
const t = STRINGS.ar;
const card = (over: Partial<AssistantPreviewCard> = {}): AssistantPreviewCard => ({
  previewId: 'p1', summary: { ar: 'تعديل تاجات منى', en: 'Change the tags on Mona' }, policy: 'preview', reasons: [], undo: 'reversible',
  rows: [{ label: { ar: 'التاجات', en: 'Tags' }, before: '-', after: 'vip' }], ...over,
});
const api = (over: Partial<AssistantApi> = {}) => ({ turn: vi.fn(), conversation: vi.fn(), feedback: vi.fn(), apply: vi.fn(async () => ({ status: 'applied', appliedId: 'a1' })), undo: vi.fn(async () => ({ status: 'undone' })), ...over }) as unknown as AssistantApi & { apply: ReturnType<typeof vi.fn>; undo: ReturnType<typeof vi.fn> };
const mount = (c: AssistantPreviewCard, a: AssistantApi, lang: 'ar' | 'en' = 'ar') => render(<PreviewCard t={lang === 'ar' ? t : STRINGS.en} lang={lang} card={c} api={a} />);

describe('PreviewCard', () => {
  it('shows before and after, and nothing is applied until Apply is pressed; then Undo puts it back', async () => {
    const a = api();
    mount(card(), a);
    expect(screen.getByText('تعديل تاجات منى')).toBeTruthy();
    expect(screen.getByText('vip')).toBeTruthy();
    expect(a.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t.assistantApply }));
    await screen.findByText(t.assistantCardApplied);
    expect(a.apply).toHaveBeenCalledWith('p1');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t.assistantUndo) }));
    await screen.findByText(t.assistantCardUndone);
    expect(a.undo).toHaveBeenCalledWith('a1');
  });

  it('a confirm-class card has no Apply button, shows why, and never calls the API', () => {
    const a = api();
    mount(card({ policy: 'confirm', reasons: ['customer_message', 'bulk'], undo: 'irreversible' }), a);
    expect(screen.queryByRole('button', { name: t.assistantApply })).toBeNull();
    expect(screen.getByText('رسالة لعملاء')).toBeTruthy();
    expect(screen.getByText(t.assistantCantUndo)).toBeTruthy();
    expect(a.apply).not.toHaveBeenCalled();
  });

  it('a stale answer swaps in the fresh card and says so; a 403 says the role does not allow it', async () => {
    const fresh = card({ previewId: 'p2', rows: [{ label: { ar: 'التاجات', en: 'Tags' }, before: 'hand', after: 'vip' }] });
    const a = api({ apply: vi.fn(async () => ({ status: 'stale', card: fresh })) });
    mount(card(), a);
    fireEvent.click(screen.getByRole('button', { name: t.assistantApply }));
    await screen.findByText(t.assistantCardStale);
    expect(screen.getByText('hand')).toBeTruthy();
    cleanup();
    const denied = api({ apply: vi.fn(async () => { throw new ApiError('forbidden', 403); }) });
    mount(card(), denied);
    fireEvent.click(screen.getByRole('button', { name: t.assistantApply }));
    await screen.findByText(t.assistantCardForbidden);
    expect(screen.queryByText(t.assistantCardApplied)).toBeNull();
  });

  it('an irreversible applied change offers no Undo; text from a customer is labelled; English renders', async () => {
    const a = api();
    mount(card({ undo: 'irreversible', rows: [{ label: { ar: 'الملاحظة', en: 'Note' }, after: 'x', source: 'untrusted' }] }), a, 'en');
    expect(screen.getByText(STRINGS.en.assistantFromCustomer)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en.assistantApply }));
    await waitFor(() => expect(screen.getByText(STRINGS.en.assistantCardApplied)).toBeTruthy());
    expect(screen.queryByRole('button', { name: new RegExp(STRINGS.en.assistantUndo) })).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = mount(card({ policy: 'confirm', reasons: ['money'] }), api());
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations).toEqual([]);
  });

  it('a template draft in a row is drawn as the WhatsApp card the customer will see, not as JSON', () => {
    const draft = { name: 'order_shipped', label: 'x', language: 'ar', category: 'UTILITY' as const, header: null, body: { text: 'أهلاً {{1}} طلبك خرج للشحن.', examples: ['منى'] }, footer: null, buttons: [] };
    mount(card({ rows: [{ label: { ar: 'الرسالة', en: 'Message' }, after: { kind: 'whatsapp_template', draft } }], costCredits: 2 }), api());
    expect(screen.getByTestId('tpl-bubble').textContent).toContain('أهلاً منى طلبك خرج للشحن.');
    expect(screen.getByText(t.assistantCardCost(2))).toBeTruthy();
    expect(document.body.textContent).not.toContain('whatsapp_template');
  });
});
