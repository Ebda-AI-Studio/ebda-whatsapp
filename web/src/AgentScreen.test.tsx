import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STRINGS } from './i18n';
import { App } from './App';
import { createSampleSource } from './data/sample';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);

describe('AI agent', () => {
  it('opens the agent settings from the rail and saves a change', async () => {
    const source = createSampleSource();
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المساعد الذكي' })));
    const toggle = await screen.findByRole('switch', { name: 'شغّل المساعد الذكي' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => fireEvent.click(toggle));
    await act(async () => fireEvent.change(screen.getByRole('textbox', { name: 'أسئلة وأجوبة متجرك' }), { target: { value: 'الشحن خلال 3 أيام' } }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'حفظ' })));
    expect((await source.agentSettings!())!.enabled).toBe(true);
    expect((await source.agentSettings!())!.faqText).toBe('الشحن خلال 3 أيام');
    expect(screen.getByRole('status').textContent).toContain('اتحفظ');
  });

  it('never shows a saved API key, only that one is set', async () => {
    const source = createSampleSource();
    await source.saveAgentSettings!({ provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-x', apiKey: 'sk-test-12345678' });
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المساعد الذكي' })));
    const key = await screen.findByLabelText('مفتاح الـ API');
    expect((key as HTMLInputElement).value).toBe('');
    expect(screen.getByText('فيه مفتاح محفوظ')).toBeTruthy();
  });

  it('flags a conversation that needs a human and lets staff take it over', async () => {
    const source = createSampleSource();
    render(<App source={source} now={now} />);
    const row = await screen.findByRole('button', { name: /كريم سمير/ });
    expect(within(row).getByText('محتاج حد من الفريق')).toBeTruthy();
    await act(async () => fireEvent.click(row));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'استلم المحادثة' })));
    const conv = (await source.listConversations('all', '')).find((c) => c.id === 2)!;
    expect(conv.assigneeUserId).toBe('u-me');
  });

  it('marks replies written by the AI agent', async () => {
    render(<App source={createSampleSource()} now={now} />);
    const row = await screen.findByRole('button', { name: /سارة محمود/ });
    await act(async () => fireEvent.click(row));
    expect(within(screen.getByRole('log')).getByText('رد المساعد الذكي')).toBeTruthy();
  });

  it('a failed load is an error with Retry, not "owner only"; a real 403 (null) still says owner only', async () => {
    const source = createSampleSource();
    const real = source.agentSettings!;
    source.agentSettings = vi.fn(real).mockRejectedValueOnce(new Error('network'));
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المساعد الذكي' })));
    const alert = await screen.findByRole('alert');
    expect(screen.queryByText(STRINGS.ar.ownerOnly)).toBeNull();
    await act(async () => fireEvent.click(within(alert).getByRole('button', { name: STRINGS.ar.retry })));
    expect(await screen.findByRole('switch', { name: 'شغّل المساعد الذكي' })).toBeTruthy();
    cleanup();
    const staff = createSampleSource();
    staff.agentSettings = async () => null;
    render(<App source={staff} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المساعد الذكي' })));
    expect(await screen.findByText(STRINGS.ar.ownerOnly)).toBeTruthy();
  });
});
