import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError } from './data/api';
import { createSampleSource } from './data/sample';
import type { InboxSource } from './data/source';
import { STRINGS } from './i18n';
import { formatMoney } from './lib/format';

afterEach(cleanup);
const NOW = Date.UTC(2026, 9, 24, 17, 0);
const now = () => NOW;
const t = STRINGS.ar;
const egp = (minor: number) => formatMoney(minor, 'EGP', 'ar');
const HOUR = 3_600_000;

async function openOperator(source: InboxSource = createSampleSource(), tab?: keyof typeof t.opTabs) {
  source.role = 'super_admin';
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
  await screen.findByRole('heading', { name: t.opTitle, level: 1 });
  if (tab) await act(async () => fireEvent.click(screen.getByRole('button', { name: t.opTabs[tab]! })));
  return source;
}
const field = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = async (name: string) => act(async () => fireEvent.click(screen.getByRole('button', { name })));

describe('operator: who sees it', () => {
  it('the rail offers it to a super admin only', () => {
    for (const role of ['owner', 'staff'] as const) {
      const source = createSampleSource();
      source.role = role;
      render(<App source={source} now={now} />);
      expect(screen.queryByRole('link', { name: t.opNav })).toBeNull();
      cleanup();
    }
    const source = createSampleSource();
    source.role = 'super_admin';
    render(<App source={source} now={now} />);
    expect(screen.getByRole('link', { name: t.opNav })).toBeTruthy();
  });
});

describe('operator: pricing settings', () => {
  it('lists the current and the scheduled version apart, with who and why', async () => {
    await openOperator();
    const current = await screen.findByRole('region', { name: t.opCurrent });
    expect(within(current).getByText(t.opSettingsLine('١٥', egp(5000), '٢', '٠'))).toBeTruthy();
    expect(within(current).getByText('تحديث هامش الربع الأخير')).toBeTruthy();
    const scheduled = screen.getByRole('region', { name: t.opScheduled });
    expect(within(scheduled).getByText(t.opSettingsLine('١٨', egp(5000), '٢', '٠'))).toBeTruthy();
    expect(screen.getByText(t.opNeverRetro)).toBeTruthy();
  });

  it('publishes percent and pounds as exact integers, never earlier than an hour ahead', async () => {
    const source = createSampleSource();
    const publish = vi.spyOn(source.operator!, 'publishPricingSettings');
    await openOperator(source);
    await screen.findByRole('region', { name: t.opCurrent });
    field(t.opMargin, '12.5'); field(t.opOverdraft, '75'); field(t.opFxBuffer, '1.5'); field(t.opVat, '14');
    field(t.opReason, 'مراجعة الربع');
    await submit(t.opPublishSettings);
    expect(publish).toHaveBeenCalledTimes(1);
    const arg = publish.mock.calls[0]![0];
    expect(arg).toMatchObject({ marginBps: 1250, creditLimitMinor: 7500, fxBufferBps: 150, vatBps: 1400, reason: 'مراجعة الربع' });
    expect(arg.effectiveFrom).toBeGreaterThanOrEqual(NOW + HOUR);
    expect(await screen.findByText(t.opSaved)).toBeTruthy();
  });

  it('refuses an effective time under an hour ahead, a missing reason and a bad number, without calling the server', async () => {
    const source = createSampleSource();
    const publish = vi.spyOn(source.operator!, 'publishPricingSettings');
    await openOperator(source);
    await screen.findByRole('region', { name: t.opCurrent });
    field(t.opReason, 'سبب كافي');
    field(t.opEffective, '2026-10-01T00:00');
    await submit(t.opPublishSettings);
    expect((await screen.findByRole('alert')).textContent).toBe(t.opTooSoon('١'));
    field(t.opEffective, '2030-01-01T00:00');
    field(t.opReason, 'ق');
    await submit(t.opPublishSettings);
    expect(screen.getByRole('alert').textContent).toBe(t.opReasonShort);
    field(t.opReason, 'سبب كافي');
    field(t.opMargin, 'abc');
    await submit(t.opPublishSettings);
    expect(screen.getByRole('alert').textContent).toBe(t.opBadNumber);
    expect(publish).not.toHaveBeenCalled();
  });

  it('while session protection is off, every write says so calmly and changes nothing', async () => {
    const source = createSampleSource();
    source.operator!.publishPricingSettings = vi.fn().mockRejectedValue(new ApiError('rate_limited', 503, 'session_check_unavailable'));
    await openOperator(source);
    await screen.findByRole('region', { name: t.opCurrent });
    field(t.opReason, 'سبب كافي');
    field(t.opEffective, '2030-01-01T00:00');
    await submit(t.opPublishSettings);
    expect((await screen.findByRole('alert')).textContent).toBe(t.opGuard);
    expect(screen.queryByText(t.opSaved)).toBeNull();
  });

  it('a revoked session asks to sign in again', async () => {
    const source = createSampleSource();
    source.operator!.publishPricingSettings = vi.fn().mockRejectedValue(new ApiError('forbidden', 403, 'session_revoked'));
    await openOperator(source);
    await screen.findByRole('region', { name: t.opCurrent });
    field(t.opReason, 'سبب كافي');
    field(t.opEffective, '2030-01-01T00:00');
    await submit(t.opPublishSettings);
    expect((await screen.findByRole('alert')).textContent).toBe(t.opRevoked);
  });
});

describe('operator: rate cards and the dollar rate', () => {
  it('shows a clear, line-numbered error for a bad rate list and does not call the server', async () => {
    const source = createSampleSource();
    const publish = vi.spyOn(source.operator!, 'publishRateCard');
    await openOperator(source, 'rates');
    field(t.opRatesInput, 'EG,marketing,0.05\nsa,utility,1');
    field(t.opReason, 'تحديث ميتا');
    await submit(t.opPublishRates);
    expect((await screen.findByRole('alert')).textContent).toContain(t.opRateLine('٢', t.opRateErrors.bad_country!));
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes a parsed rate list at least 24 hours ahead', async () => {
    const source = createSampleSource();
    const publish = vi.spyOn(source.operator!, 'publishRateCard');
    await openOperator(source, 'rates');
    field(t.opRatesInput, 'EG,marketing,0.0529\nSA,utility,0.0112');
    field(t.opReason, 'تحديث ميتا');
    await submit(t.opPublishRates);
    const arg = publish.mock.calls[0]![0];
    expect(arg.rates).toEqual([{ country: 'EG', category: 'marketing', usdMicros: 52_900 }, { country: 'SA', category: 'utility', usdMicros: 11_200 }]);
    expect(arg.effectiveFrom).toBeGreaterThanOrEqual(NOW + 24 * HOUR);
    expect(arg.reason).toBe('تحديث ميتا');
  });

  it('refuses a 24 h rule violation before asking, for rates and for the dollar rate', async () => {
    const source = createSampleSource();
    const rates = vi.spyOn(source.operator!, 'publishRateCard');
    const fx = vi.spyOn(source.operator!, 'publishFx');
    await openOperator(source, 'rates');
    field(t.opRatesInput, 'EG,marketing,0.0529');
    field(t.opReason, 'تحديث ميتا');
    field(t.opRatesEffective, '2026-10-25T00:00');
    await submit(t.opPublishRates);
    expect(screen.getByRole('alert').textContent).toBe(t.opTooSoon('٢٤'));
    fireEvent.change(screen.getByLabelText(t.opFxRate), { target: { value: '49.5' } });
    field(t.opFxEffective, '2026-10-25T00:00');
    field(t.opFxReason, 'سبب الصرف');
    await submit(t.opPublishFx);
    expect(rates).not.toHaveBeenCalled();
    expect(fx).not.toHaveBeenCalled();
  });

  it('publishes the dollar rate as exact micros', async () => {
    const source = createSampleSource();
    const fx = vi.spyOn(source.operator!, 'publishFx');
    await openOperator(source, 'rates');
    fireEvent.change(screen.getByLabelText(t.opFxRate), { target: { value: '49.75' } });
    fireEvent.change(screen.getByLabelText(t.opFxBufferLabel), { target: { value: '1' } });
    field(t.opFxReason, 'سعر البنك');
    await submit(t.opPublishFx);
    expect(fx.mock.calls[0]![0]).toMatchObject({ egpPerUsdMicros: 49_750_000, bufferBps: 100, reason: 'سعر البنك' });
  });
});

describe('operator: one account', () => {
  it('shows a workspace’s margin override and publishes a new one', async () => {
    const source = createSampleSource();
    const publish = vi.spyOn(source.operator!, 'publishOverride');
    await openOperator(source, 'account');
    field(t.opWorkspace, 'ws-sample');
    await submit(t.opLoad);
    expect(await screen.findByText('اتفاق خاص مع العميل')).toBeTruthy();
    field(t.opMargin, '9');
    field(t.opReason, 'خصم تعاقدي');
    await submit(t.opPublishOverride);
    expect(publish).toHaveBeenCalledWith('ws-sample', expect.objectContaining({ marginBps: 900, reason: 'خصم تعاقدي' }));
  });

  it('changes who pays Meta for a number, with a reason', async () => {
    const source = createSampleSource();
    const set = vi.spyOn(source.operator!, 'setFunding');
    await openOperator(source, 'account');
    field(t.opPhoneId, 'pn-sample-1');
    field(t.opFundingLabel, 'platform_line');
    field(t.opFundingReason, 'اتفاق جديد');
    await submit(t.opSetFunding);
    expect(set).toHaveBeenCalledWith('pn-sample-1', 'platform_line', 'اتفاق جديد');
  });

  it('requests an adjustment in pounds with a signed amount and a reason', async () => {
    const source = createSampleSource();
    const create = vi.spyOn(source.operator!, 'createAdjustment');
    await openOperator(source, 'account');
    field(t.opWorkspace, 'ws-sample');
    field(t.opAdjAmount, '-12.5');
    field(t.opAdjReason, 'خصم مكرر');
    await submit(t.opAdjCreate);
    expect(create).toHaveBeenCalledWith('ws-sample', -1250, 'خصم مكرر');
  });
});

describe('operator: refunds and adjustments', () => {
  it('approving a refund explains the wallet is debited first, and asks before doing it', async () => {
    const source = createSampleSource();
    const decide = vi.spyOn(source.operator!, 'decideRefund');
    await openOperator(source, 'queues');
    const row = (await screen.findByText(/ألغيت الاشتراك وعايز باقي الرصيد/)).closest('li')!;
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: t.opApprove })));
    expect(within(row).getByText(t.opApproveAsk)).toBeTruthy();
    expect(decide).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: t.opApproveYes })));
    expect(decide).toHaveBeenCalledWith('q-1', 'approve', '');
    expect(within(row).getByText(t.refundStates.processing!)).toBeTruthy();
  });

  it('rejects a refund with a note for the merchant', async () => {
    const source = createSampleSource();
    const decide = vi.spyOn(source.operator!, 'decideRefund');
    await openOperator(source, 'queues');
    const row = (await screen.findByText(/ألغيت الاشتراك وعايز باقي الرصيد/)).closest('li')!;
    fireEvent.change(within(row).getByLabelText(t.opDecisionNote), { target: { value: 'الرصيد اتصرف' } });
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: t.opReject })));
    expect(decide).toHaveBeenCalledWith('q-1', 'reject', 'الرصيد اتصرف');
  });

  it('marks a manual payout as paid', async () => {
    const source = createSampleSource();
    const paid = vi.spyOn(source.operator!, 'markRefundPaid');
    await openOperator(source, 'queues');
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: t.opManualPaid })));
    expect(paid).toHaveBeenCalledWith('q-2');
  });

  it('your own pending adjustment has no approve button and says why; another admin’s can be approved', async () => {
    const source = createSampleSource();
    const decide = vi.spyOn(source.operator!, 'decideAdjustment');
    await openOperator(source, 'queues');
    const mine = (await screen.findByText('تعويض عن عطل في إرسال حملة')).closest('li')!;
    expect(within(mine).queryByRole('button', { name: t.opApprove })).toBeNull();
    expect(within(mine).queryByRole('button', { name: t.opReject })).toBeNull();
    expect(within(mine).getByText(t.opOwnRequest)).toBeTruthy();
    const theirs = screen.getByText('شحنة اتسجلت مرتين').closest('li')!;
    expect(within(theirs).getByText(t.opSecondApprover)).toBeTruthy();
    await act(async () => fireEvent.click(within(theirs).getByRole('button', { name: t.opApprove })));
    expect(decide).toHaveBeenCalledWith('a-2', 'approve');
    expect(within(theirs).getByText(t.adjStates.approved!)).toBeTruthy();
  });

  it('turns a second-approver refusal from the server into plain words', async () => {
    const source = createSampleSource();
    source.operator!.decideAdjustment = vi.fn().mockRejectedValue(new ApiError('forbidden', 403, 'second_approver_required'));
    await openOperator(source, 'queues');
    const theirs = (await screen.findByText('شحنة اتسجلت مرتين')).closest('li')!;
    await act(async () => fireEvent.click(within(theirs).getByRole('button', { name: t.opApprove })));
    expect((await screen.findByRole('alert')).textContent).toBe(t.opSecondApprover);
  });
});

describe('operator: change log', () => {
  it('shows who did what, old to new, and why', async () => {
    await openOperator(createSampleSource(), 'log');
    const item = (await screen.findByText('رفع الهامش بعد زيادة أسعار ميتا', { selector: 'p' })).closest('li')!;
    expect(within(item).getByText('u-root')).toBeTruthy();
    expect(within(item).getByText('settings_published')).toBeTruthy();
    expect(within(item).getByText(/"marginBps":1500/)).toBeTruthy();
    expect(within(item).getByText(/"marginBps":1800/)).toBeTruthy();
  });
});
