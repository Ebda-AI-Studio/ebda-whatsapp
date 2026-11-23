import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantTurnResponse } from '../../src/core/api/contract';
import { App } from './App';
import { AssistantPanel } from './components/AssistantPanel';
import { safeHref, viewForPath, type AssistantApi } from './data/assistant';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

afterEach(() => { cleanup(); sessionStorage.clear(); });

const t = STRINGS.ar;
const reply = (over: Partial<AssistantTurnResponse> = {}): AssistantTurnResponse => ({ status: 'answered', previews: [], turnId: 't1', segments: [{ kind: 'text', text: 'تقدر تشحن المحفظة. ' }, { kind: 'cap', capabilityId: 'wallet.view', label: 'المحفظة', appPath: '/wallet' }], ...over });
const fakeApi = (over: Partial<AssistantApi> = {}): AssistantApi & { turn: ReturnType<typeof vi.fn>; feedback: ReturnType<typeof vi.fn> } => ({
  turn: vi.fn(async () => reply()), conversation: vi.fn(async () => []), feedback: vi.fn(async () => undefined), ...over,
}) as never;
const mount = (api: AssistantApi, extra: { onNavigate?: (v: string) => void; onClose?: () => void; onUnavailable?: () => void } = {}) =>
  render(<AssistantPanel t={t} lang="ar" storeId="s1" userId="u1" api={api} onNavigate={(extra.onNavigate ?? (() => undefined)) as never} onClose={extra.onClose ?? (() => undefined)} onUnavailable={extra.onUnavailable ?? (() => undefined)} />);
const ask = async (text = 'ازاي أشحن المحفظة؟') => {
  fireEvent.change(screen.getByLabelText(t.assistantPlaceholder), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: t.assistantSend }));
};

describe('AssistantPanel', () => {
  it('shows the empty state with suggestions, and a suggestion asks the question', async () => {
    const api = fakeApi();
    mount(api);
    expect(screen.getByText(t.assistantEmptyTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t.assistantSuggest[0]! }));
    await waitFor(() => expect(api.turn).toHaveBeenCalledWith({ conversationId: expect.any(String), text: t.assistantSuggest[0], locale: 'ar' }));
  });

  it('a turn that prepared a change shows its preview card under the reply', async () => {
    const previews = [{ previewId: 'p1', summary: { ar: 'تعديل تاجات منى', en: 'x' }, rows: [], policy: 'preview' as const, reasons: [], undo: 'reversible' as const }];
    mount(fakeApi({ turn: vi.fn(async () => reply({ previews })) }));
    await ask('حط تاج على منى');
    expect(await screen.findByRole('button', { name: t.assistantApply })).toBeTruthy();
  });

  it('renders a cap segment as a link to its screen and opens that screen', async () => {
    const go = vi.fn();
    mount(fakeApi(), { onNavigate: go });
    await ask();
    const link = await screen.findByRole('link', { name: new RegExp(t.assistantShowMe) });
    expect(link.getAttribute('href')).toBe('/wallet');
    fireEvent.click(link);
    expect(go).toHaveBeenCalledWith('wallet');
  });

  it('the empty panel points to the support mailbox (a mailto link, the brand address only) and drops the line once a conversation has started', async () => {
    mount(fakeApi());
    const link = screen.getByRole('link', { name: 'ahlan@ebda.app' });
    expect(link.getAttribute('href')).toBe('mailto:ahlan@ebda.app');
    expect(link.closest('p')!.textContent).toContain(t.assistantSupport);
    await ask();
    await screen.findByRole('link', { name: new RegExp(t.assistantShowMe) });
    expect(screen.queryByRole('link', { name: 'ahlan@ebda.app' })).toBeNull();
  });

  it('never renders an <img> or markup from reply text: it is plain text', async () => {
    const api = fakeApi({ turn: vi.fn(async () => reply({ segments: [{ kind: 'text', text: '<img src="https://evil.example/p?d=1"> ![x](https://evil.example/p) <script>alert(1)</script>' }] })) });
    const { container } = mount(api);
    await ask();
    await screen.findByText(/evil\.example/);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('a link or citation becomes an anchor only for a clean https address', async () => {
    const api = fakeApi({ turn: vi.fn(async () => reply({ segments: [
      { kind: 'cite', articleId: 'a', title: 'دليل المحفظة', url: 'https://help.ebda.app/whatsapp/wallet-top-ups-and-refunds/' },
      { kind: 'link', href: 'javascript:alert(1)', text: 'bad-js' },
      { kind: 'link', href: 'https://user:pw@evil.example/', text: 'bad-cred' },
    ] })) });
    mount(api);
    await ask();
    const cite = await screen.findByRole('link', { name: new RegExp('دليل المحفظة') });
    expect(cite.getAttribute('rel')).toContain('noopener');
    expect(screen.queryByRole('link', { name: 'bad-js' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'bad-cred' })).toBeNull();
    expect(screen.getByText('bad-js')).toBeTruthy();
    expect(safeHref('http://help.ebda.app/x')).toBeNull();
    expect(viewForPath('/wallet')).toBe('wallet');
    expect(viewForPath('/nowhere')).toBeNull();
  });

  it('shows the refusal and the not-covered text the server sent, in words', async () => {
    const api = fakeApi({ turn: vi.fn(async () => reply({ status: 'refused', segments: [{ kind: 'text', text: 'أنا هنا عشان أساعدك في متجرك بس.' }] })) });
    mount(api);
    await ask('احكيلي نكتة');
    expect(await screen.findByText('أنا هنا عشان أساعدك في متجرك بس.')).toBeTruthy();
  });

  it('a thumb down posts feedback once, then thanks', async () => {
    const api = fakeApi();
    mount(api);
    await ask();
    fireEvent.click(await screen.findByRole('button', { name: t.assistantThumbDown }));
    await waitFor(() => expect(api.feedback).toHaveBeenCalledWith('t1', 'down'));
    expect(screen.getByText(t.assistantThanks)).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.assistantThumbDown })).toBeNull();
  });

  it('an error is stated with a retry that asks again; the question is not lost', async () => {
    const turn = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(reply());
    mount(fakeApi({ turn }));
    await ask();
    expect(await screen.findByText(t.assistantError)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t.retry }));
    await screen.findByRole('link', { name: new RegExp(t.assistantShowMe) });
    expect(turn).toHaveBeenCalledTimes(2);
    expect(turn.mock.calls[1]![0].text).toBe('ازاي أشحن المحفظة؟');
  });

  it('shows a waiting state while the answer is on its way', async () => {
    let done!: (r: AssistantTurnResponse) => void;
    mount(fakeApi({ turn: vi.fn(() => new Promise<AssistantTurnResponse>((r) => { done = r; })) }));
    await ask();
    expect(await screen.findByText(t.assistantThinking)).toBeTruthy();
    await act(async () => { done(reply()); });
    expect(screen.queryByText(t.assistantThinking)).toBeNull();
  });

  it('an off first turn tells the owner and withdraws the panel', async () => {
    const gone = vi.fn();
    mount(fakeApi({ turn: vi.fn(async () => reply({ status: 'off', segments: [] })) }), { onUnavailable: gone });
    await ask();
    await waitFor(() => expect(gone).toHaveBeenCalled());
    // onUnavailable fires in the same tick as setOff(true), before React has rendered it: wait for the note instead of assuming it is already there.
    expect(await screen.findByText(t.assistantOff)).toBeTruthy();
    expect((screen.getByLabelText(t.assistantPlaceholder) as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('refuses over-long text before sending, Enter sends, Shift+Enter does not, Esc closes', async () => {
    const api = fakeApi();
    const close = vi.fn();
    mount(api, { onClose: close });
    const box = screen.getByLabelText(t.assistantPlaceholder);
    fireEvent.change(box, { target: { value: 'x'.repeat(2001) } });
    expect((screen.getByRole('button', { name: t.assistantSend }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t.assistantTooLong)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'سؤال' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(api.turn).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.turn).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(close).toHaveBeenCalled();
  });

  it('has no axe violations (empty and answered)', async () => {
    const { container } = mount(fakeApi());
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => v.id)).toEqual([]);
    await ask();
    await screen.findByRole('link', { name: new RegExp(t.assistantShowMe) });
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations.map((v) => v.id)).toEqual([]);
  });
});

describe('assistant in the app shell', () => {
  it('is hidden when the server has it off, shown with its launcher when on, and Ctrl+J toggles it', async () => {
    const off = createSampleSource();
    off.capabilities = { ...off.capabilities, assistant: false };
    const first = render(<App source={off} />);
    expect(first.container.querySelector('#assistant-launcher')).toBeNull();
    cleanup();
    render(<App source={createSampleSource()} />);
    const launcher = await screen.findByRole('button', { name: STRINGS.ar.assistantNav });
    expect(screen.queryByTestId('assistant-panel')).toBeNull();
    fireEvent.click(launcher);
    expect(await screen.findByTestId('assistant-panel')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'j', ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId('assistant-panel')).toBeNull());
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(await screen.findByTestId('assistant-panel')).toBeTruthy();
    expect(within(screen.getByTestId('assistant-panel')).getByRole('heading', { name: t.assistantTitle })).toBeTruthy();
  });
});

describe('conversation id belongs to the person (review of PR 85)', () => {
  it('is kept per store AND user, and sign-out clears every one', async () => {
    const { conversationIdFor, clearAssistantConversations } = await import('./data/assistant');
    const owner = conversationIdFor('s1', 'owner');
    const staff = conversationIdFor('s1', 'staff');
    expect(owner).not.toBe(staff);
    expect(conversationIdFor('s1', 'owner')).toBe(owner);
    const { makeSignOut } = await import('./signout');
    makeSignOut({ stopRealtime: () => undefined, session: { signOut: async () => 'local' }, onLocal: () => undefined })();
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith('assistant.conversation.'))).toEqual([]);
    expect(conversationIdFor('s1', 'staff')).not.toBe(staff);
    clearAssistantConversations();
  });
});
