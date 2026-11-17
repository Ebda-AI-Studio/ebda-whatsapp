import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REASON_ORDER } from '../../foundation/instapay-decision';
import { REVERT_GRACE_MS } from '../../foundation/instapay-state';
import { App } from './App';
import type { OperatorAuto } from './data/billing';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

afterEach(cleanup);
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const row = (over: Partial<OperatorAuto>): OperatorAuto => ({
  requestId: 'ip-a', workspaceId: 'ws-a', workspaceName: 'Store A', kind: 'topup', state: 'needs_human', verdict: 'needs_human', reasons: [], amountMinor: 20000, expectedAmountMinor: 20000, isFirstPayment: true, confirmedAt: null,
  digestSentAt: null, revertedAt: null, graceUntil: null, creditsRemovedMinor: null, creditsUsedMinor: null, aiCreditsRemoved: null, aiCreditsUsed: null, createdAt: 1, ...over,
});

async function openPanel(lang: 'ar', items: OperatorAuto[], mode: 'off' | 'shadow' | 'live' = 'shadow') {
  const t = STRINGS[lang];
  const source = createSampleSource();
  source.role = 'super_admin';
  source.operator!.autoConfirmations = async () => ({ mode, ready: { ready: true, missing: [] }, items });
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
  await screen.findByRole('heading', { name: t.opTitle, level: 1 });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: t.opTabs.queues! })));
  return { source, card: await screen.findByRole('region', { name: t.opAuto.title }), t };
}

describe('InstaPay auto-confirm operator panel', () => {
  it('every reason code has a label in Arabic and in English (enum-driven: a missing one fails, the raw-key-in-production class)', () => {
    for (const lang of ['ar', 'en'] as const) for (const code of REASON_ORDER) expect(STRINGS[lang].opAuto.reasons[code], `${lang}:${code}`).toBeTruthy();
    expect(Object.keys(STRINGS.ar.opAuto.reasons).sort()).toEqual([...REASON_ORDER].sort());
    expect(Object.keys(STRINGS.en.opAuto.reasons).sort()).toEqual([...REASON_ORDER].sort());
  });

  it('shows the current mode from the server and every reason of a decision in words; the revert button needs a reason first and sends it', async () => {
    const { source, card, t } = await openPanel('ar', [row({ requestId: 'ip-1', state: 'auto_confirmed', verdict: 'auto_confirm' }), row({ requestId: 'ip-2', reasons: ['AMOUNT_MISMATCH', 'DUPLICATE_REFERENCE'] })], 'live');
    expect((within(card).getByLabelText(t.opAuto.mode) as HTMLSelectElement).value).toBe('live');
    expect(within(card).getAllByRole('note').map((n) => n.textContent).join(' ')).toContain(`${t.opAuto.reasons.AMOUNT_MISMATCH} • ${t.opAuto.reasons.DUPLICATE_REFERENCE}`);
    const revert = vi.spyOn(source.operator!, 'revertAutoConfirmed');
    const btn = within(card).getByRole('button', { name: t.opAuto.notReceived }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(within(card).getAllByLabelText(t.opAuto.revertReason)[0]!, { target: { value: 'البنك مفيهوش التحويل' } });
    expect(btn.disabled).toBe(false);
    await act(async () => fireEvent.click(btn));
    expect(revert).toHaveBeenCalledWith('ip-1', 'البنك مفيهوش التحويل');
  });

  it('the global switch needs a reason and a different mode; it calls the API with both', async () => {
    const { source, card, t } = await openPanel('ar', [], 'off');
    const apply = within(card).getByRole('button', { name: t.opAuto.apply }) as HTMLButtonElement;
    const setMode = vi.spyOn(source.operator!, 'setAutoMode');
    expect(apply.disabled).toBe(true);
    fireEvent.change(within(card).getByLabelText(t.opAuto.mode), { target: { value: 'shadow' } });
    expect(apply.disabled).toBe(true); // a different mode but no reason yet
    fireEvent.change(within(card).getByLabelText(t.opAuto.reason), { target: { value: 'أسبوع تجريبي' } });
    expect(apply.disabled).toBe(false);
    await act(async () => fireEvent.click(apply));
    expect(setMode).toHaveBeenCalledWith('shadow', 'أسبوع تجريبي');
  });
});

describe('merchant revert banner copy', () => {
  it('the banner text carries the grace deadline and the two actions; the grace is the foundation constant (48 h)', () => {
    expect(REVERT_GRACE_MS / 3_600_000).toBe(48);
    expect(STRINGS.ar.wIpAuto.revertBanner('الخميس 10:00')).toContain('قبل الخميس 10:00');
    expect(STRINGS.ar.wIpAuto.revertBanner('x')).toContain('ارفع إيصال صح أو ادفع بالكارت');
    expect(STRINGS.ar.wIpAuto.upload).toBe('ارفع إيصال');
    expect(STRINGS.ar.wIpAuto.card).toBe('ادفع بالكارت');
    for (const k of ['checking', 'done', 'waiting'] as const) expect(STRINGS.ar.wIpAuto[k]).toBeTruthy();
    expect(STRINGS.en.wIpAuto.revertBanner('Thu 10:00')).toContain('before Thu 10:00');
  });
});
