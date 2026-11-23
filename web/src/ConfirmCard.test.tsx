import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantPreviewCard } from '../../src/core/api/contract';
import { AssistantPanel } from './components/AssistantPanel';
import { ConfirmCard } from './components/ConfirmCard';
import { ApiError } from './data/api';
import type { AssistantApi } from './data/assistant';
import { STRINGS } from './i18n';

afterEach(() => { cleanup(); sessionStorage.clear(); });
const t = STRINGS.ar;
const card = (over: Partial<AssistantPreviewCard> = {}): AssistantPreviewCard => ({
  previewId: 'p1', approvalId: 'a1', summary: { ar: 'إرسال رسالة لمنى', en: 'Send a message to Mona' }, policy: 'confirm', reasons: ['customer_message', 'irreversible'], undo: 'irreversible',
  rows: [{ label: { ar: 'الرسالة', en: 'Message' }, after: 'أهلا يا منى' }], ...over,
});
const ap = { approvalId: 'a1', previewId: 'p1', token: 'T'.repeat(43) };
const api = (over: Partial<AssistantApi> = {}) => ({ turn: vi.fn(), conversation: vi.fn(async () => []), feedback: vi.fn(), apply: vi.fn(), undo: vi.fn(async () => ({ status: 'undone' })), confirm: vi.fn(async () => ({ status: 'applied', appliedId: 'x1' })), reject: vi.fn(async () => ({ status: 'rejected' })), ...over }) as unknown as AssistantApi & { confirm: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn> };
const mount = (c: AssistantPreviewCard, a: AssistantApi, lang: 'ar' | 'en' = 'ar') => render(<ConfirmCard t={lang === 'ar' ? t : STRINGS.en} lang={lang} card={c} approval={ap} api={a} />);

describe('ConfirmCard', () => {
  it('shows why it needs confirming and that it cannot be undone; nothing is sent until the gold button is pressed, with the one-time token', async () => {
    const a = api();
    mount(card(), a);
    expect(screen.getByText('رسالة لعملاء')).toBeTruthy();
    expect(screen.getByText(t.assistantCantUndo)).toBeTruthy();
    expect(a.confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t.assistantConfirmYes }));
    await screen.findByText(t.assistantConfirmDone);
    expect(a.confirm).toHaveBeenCalledWith('a1', ap.token);
    expect(screen.queryByRole('button', { name: t.assistantUndo })).toBeNull(); // irreversible
  });

  it('the token is never rendered', () => {
    const { container } = mount(card(), api());
    expect(container.textContent).not.toContain(ap.token);
    expect(container.innerHTML).not.toContain(ap.token);
  });

  it('"No" rejects and closes the card; nothing was confirmed', async () => {
    const a = api();
    mount(card(), a);
    fireEvent.click(screen.getByRole('button', { name: t.assistantConfirmNo }));
    await screen.findByText(t.assistantConfirmRejected);
    expect(a.reject).toHaveBeenCalledWith('a1');
    expect(a.confirm).not.toHaveBeenCalled();
  });

  it('a stale answer swaps in the new card and the new token; an expired one says so; 403 says the role does not allow it', async () => {
    const fresh = card({ previewId: 'p2', rows: [{ label: { ar: 'الرسالة', en: 'Message' }, after: 'نص جديد' }] });
    const a = api({ confirm: vi.fn().mockResolvedValueOnce({ status: 'stale', card: fresh, approvals: [{ approvalId: 'a2', previewId: 'p2', token: 'N'.repeat(43) }] }).mockResolvedValueOnce({ status: 'applied', appliedId: 'x' }) });
    mount(card(), a);
    fireEvent.click(screen.getByRole('button', { name: t.assistantConfirmYes }));
    await screen.findByText(t.assistantCardStale);
    expect(screen.getByText('نص جديد')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t.assistantConfirmYes }));
    await waitFor(() => expect(a.confirm).toHaveBeenLastCalledWith('a2', 'N'.repeat(43)));
    cleanup();
    mount(card(), api({ confirm: vi.fn(async () => ({ status: 'expired' })) }));
    fireEvent.click(screen.getByRole('button', { name: t.assistantConfirmYes }));
    await screen.findByText(t.assistantConfirmExpired);
    cleanup();
    mount(card(), api({ confirm: vi.fn(async () => { throw new ApiError('forbidden', 403); }) }));
    fireEvent.click(screen.getByRole('button', { name: t.assistantConfirmYes }));
    await screen.findByText(t.assistantCardForbidden);
  });

  it('a reversible confirmed change offers Undo; English renders; no axe violations', async () => {
    const a = api();
    const { container } = mount(card({ undo: 'reversible', reasons: ['money'] }), a, 'en');
    expect(screen.getByRole('button', { name: STRINGS.en.assistantConfirmYes })).toBeTruthy();
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: STRINGS.en.assistantConfirmYes }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.en.assistantUndo }));
    await screen.findByText(STRINGS.en.assistantCardUndone);
  });

  it('an Undo the server could not do (name taken since the delete) says so and changes nothing; the card stays', async () => {
    const a = api({ undo: vi.fn(async () => ({ status: 'failed' })) });
    mount(card({ undo: 'reversible', reasons: ['delete'] }), a);
    fireEvent.click(screen.getByRole('button', { name: t.assistantConfirmYes }));
    fireEvent.click(await screen.findByRole('button', { name: t.assistantUndo }));
    expect((await screen.findByText(t.assistantUndoFailed)).textContent).toContain('نفس الاسم');
    expect(screen.queryByText(t.assistantCardUndone)).toBeNull();
    expect(screen.getByText(t.assistantConfirmDone)).toBeTruthy();
  });

  it('in the panel, a confirm card appears only for a card whose token came with the turn', async () => {
    const reply = { status: 'answered' as const, turnId: 't1', segments: [{ kind: 'text' as const, text: 'جهزت الرسالة' }], previews: [card()], approvals: [ap] };
    const a = api({ turn: vi.fn(async () => reply) });
    render(<AssistantPanel t={t} lang="ar" storeId="s1" userId="u1" api={a} onNavigate={() => undefined} onClose={() => undefined} onUnavailable={() => undefined} />);
    fireEvent.change(screen.getByLabelText(t.assistantPlaceholder), { target: { value: 'ابعت لمنى' } });
    fireEvent.click(screen.getByRole('button', { name: t.assistantSend }));
    expect(await screen.findByRole('button', { name: t.assistantConfirmYes })).toBeTruthy();
  });
});
