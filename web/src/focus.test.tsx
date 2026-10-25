import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createSampleSource } from './data/sample';
import { SignupStopped } from './lib/embedded-signup';
import { STRINGS } from './i18n';

// After an action the focused control disappears (confirm buttons, the form button): focus must land on its result, not on <body>.
const store = new Map<string, string>();
beforeEach(() => vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() }));
afterEach(() => { cleanup(); store.clear(); vi.unstubAllGlobals(); });
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const t = STRINGS.ar;

async function open(link: string, heading: string, source = createSampleSource()) {
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: link })));
  await screen.findByRole('heading', { name: heading });
  return source;
}

describe('focus follows the result of an action', () => {
  it('connecting a number moves focus to the new number', async () => {
    await open('رقم واتساب', 'رقم واتساب');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.connectNumber })));
    const added = await screen.findByRole('article', { name: /\+20 100 555 0303/ });
    expect(document.activeElement).toBe(added);
  });

  it('a connect that fails moves focus to the message that says why', async () => {
    const source = createSampleSource();
    source.numbers!.launch = vi.fn().mockRejectedValue(new SignupStopped('no_number'));
    await open('رقم واتساب', 'رقم واتساب', source);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.connectNumber })));
    expect(document.activeElement).toBe(await screen.findByRole('alert'));
  });

  it('cancelling a campaign moves focus to that campaign, not to the page', async () => {
    await open('الحملات', 'الحملات');
    const row = screen.getByRole('article', { name: /عروض العيد/ });
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: t.cancelCampaign })));
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: t.cancelYes })));
    expect(within(row).getByText(t.campaignStatus.cancelled!)).toBeTruthy();
    expect(document.activeElement).toBe(row);
  });

  it('sending a refund request moves focus to the confirmation', async () => {
    await open('المحفظة', 'المحفظة');
    const card = screen.getByRole('region', { name: t.wRefundTitle });
    fireEvent.change(within(card).getByLabelText(t.wRefundAmount), { target: { value: '100' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wRefundSend })));
    const sent = await within(card).findByText(t.wRefundSent);
    expect(document.activeElement).toBe(sent);
  });

  it('a refund request the server refuses moves focus to the reason', async () => {
    const source = createSampleSource();
    source.wallet!.requestRefund = vi.fn().mockRejectedValue(new Error('no'));
    await open('المحفظة', 'المحفظة', source);
    const card = screen.getByRole('region', { name: t.wRefundTitle });
    fireEvent.change(within(card).getByLabelText(t.wRefundAmount), { target: { value: '100' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wRefundSend })));
    expect(document.activeElement).toBe(await within(card).findByRole('alert'));
  });
});
