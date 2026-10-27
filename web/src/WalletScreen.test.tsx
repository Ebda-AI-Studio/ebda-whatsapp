import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { WalletScreen } from './components/WalletScreen';
import { ApiError } from './data/api';
import type { WalletDto } from './data/billing';
import { createSampleSource } from './data/sample';
import type { InboxSource } from './data/source';
import { STRINGS, num } from './i18n';
import { formatMoney } from './lib/format';
import { dateTime } from './components/CampaignsScreen';

// Node 25 ships a half-working global localStorage; tests get a plain in-memory one.
const store = new Map<string, string>();
beforeEach(() => vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() }));
afterEach(() => { cleanup(); store.clear(); vi.unstubAllGlobals(); });
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const egp = (minor: number) => formatMoney(minor, 'EGP', 'ar');
const t = STRINGS.ar;

/** The sample source with its wallet changed: `patch` edits the DTO the screen will read. */
function withWallet(patch: Partial<WalletDto>, role: InboxSource['role'] = 'owner'): InboxSource {
  const source = createSampleSource();
  source.role = role;
  const real = source.wallet!.wallet;
  source.wallet!.wallet = async () => ({ ...(await real()), ...patch });
  return source;
}

async function openWallet(source = createSampleSource()) {
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المحفظة' })));
  await screen.findByRole('heading', { name: 'المحفظة', level: 1 });
  return source;
}

describe('wallet: balance and who pays Meta', () => {
  it('shows available, balance and held, with the overdraft explained in one sentence', async () => {
    await openWallet();
    const bal = screen.getByRole('region', { name: t.wBalanceTitle });
    expect(within(bal).getByText(egp(16000))).toBeTruthy();
    expect(within(bal).getByText(egp(18500))).toBeTruthy();
    expect(within(bal).getByText(egp(2500))).toBeTruthy();
    expect(within(bal).getByText(t.wOverdraft(egp(5000)))).toBeTruthy();
    expect(within(bal).queryByText(/مديونية/)).toBeNull();
  });

  it('a number whose card Meta bills says so; a wallet-paid number says that instead', async () => {
    await openWallet();
    const funding = screen.getByRole('region', { name: t.wFundingTitle });
    const card = within(funding).getByText(/\+20 100 555 0101/).closest('li')!;
    expect(within(card).getByText(t.wFundingCard)).toBeTruthy();
    const shared = within(funding).getByText(/\+20 100 555 0900/).closest('li')!;
    expect(within(shared).getByText(t.wFundingWallet)).toBeTruthy();
  });

  it('a number whose payer is not set says it is not ready, and never claims Meta bills the card', async () => {
    await openWallet(withWallet({ funding: [{ phoneNumberId: 'pn-x', displayPhone: '+20 100 555 0777', funding: 'unknown' }] }));
    const funding = screen.getByRole('region', { name: t.wFundingTitle });
    const li = within(funding).getByText(/\+20 100 555 0777/).closest('li')!;
    expect(within(li).getByText(t.wFundingUnknown)).toBeTruthy();
    expect(within(li).getByText(t.opFundingUnknown)).toBeTruthy();
    expect(within(li).queryByText(t.wFundingCard)).toBeNull();
    expect(within(li).queryByText(t.wFundingWallet)).toBeNull();
    expect(screen.queryByText(t.wFundingCard)).toBeNull(); // the top-up card does not claim card billing either
  });

  it('debt is stated and says the next top-up pays it first', async () => {
    await openWallet(withWallet({ debtMinor: 3000, balanceMinor: -3000, availableMinor: -5500 }));
    expect(screen.getAllByText(t.wDebtLine(egp(3000))).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t.wMarketingPaused).length).toBeGreaterThan(0);
  });

  it('a past-due plan says marketing is paused', async () => {
    await openWallet(withWallet({ plan: { packageId: 'growth', status: 'past_due', periodEnd: now(), cancelledAt: null } }));
    const plan = screen.getByRole('region', { name: t.wPlanTitle });
    expect(within(plan).getByText(t.planStatus.past_due!)).toBeTruthy();
    expect(within(plan).getByText(t.wPlanPastDue)).toBeTruthy();
  });

  it('shows the AI credits', async () => {
    await openWallet();
    expect(screen.getByText(/٤٨٠|480/)).toBeTruthy();
  });
});

describe('wallet: top-up', () => {
  it('shows the fee on top, sends the exact amount, and redirects only to an https checkout', async () => {
    const source = createSampleSource();
    const go = vi.fn();
    const topup = vi.spyOn(source.wallet!, 'topup');
    render(<WalletScreen t={t} lang="ar" source={source} api={source.wallet!} now={now} go={go} />);
    const card = await screen.findByRole('region', { name: t.wTopupTitle });
    expect(within(card).getByText(t.wTopupHint)).toBeTruthy();
    fireEvent.change(within(card).getByLabelText(t.wTopupAmount), { target: { value: '200' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wTopupContinue })));
    expect(topup).toHaveBeenCalledWith(20000);
    const fee = Math.round(20000 * 0.025) + 300;
    expect(await screen.findByText(t.wTopupSummary(egp(20000), egp(fee), egp(20000 + fee)))).toBeTruthy();
    // Nothing has been paid yet: no success claim.
    expect(screen.queryByText(t.wTopupArrived)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.wTopupPay })));
    expect(go).toHaveBeenCalledWith('https://pay.example.test/checkout/T-1');
    expect(screen.getByRole('status').textContent).toContain(t.wTopupWaiting);
  });

  it('refuses a checkout URL that is not https', async () => {
    const source = createSampleSource();
    source.wallet!.topup = async (a) => ({ orderId: 'T-9', state: 'pending', amountMinor: a, feeMinor: 0, totalMinor: a, checkoutUrl: 'javascript:alert(1)' });
    const go = vi.fn();
    render(<WalletScreen t={t} lang="ar" source={source} api={source.wallet!} now={now} go={go} />);
    const card = await screen.findByRole('region', { name: t.wTopupTitle });
    fireEvent.change(within(card).getByLabelText(t.wTopupAmount), { target: { value: '100' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wTopupContinue })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: t.wTopupPay })));
    expect(go).not.toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toContain(t.wTopupError);
  });

  it('keeps waiting after the return trip; when the order cannot be asked, "arrived" needs the wallet itself to have grown', async () => {
    const source = createSampleSource();
    let balance = 18500;
    const real = source.wallet!.wallet;
    source.wallet!.wallet = async () => ({ ...(await real()), balanceMinor: balance, availableMinor: balance - 2500 });
    source.wallet!.topupState = async () => { throw new Error('order lookup down'); };
    const go = vi.fn();
    const props = { t, lang: 'ar' as const, source, api: source.wallet!, now, go };
    const first = render(<WalletScreen {...props} />);
    const card = await screen.findByRole('region', { name: t.wTopupTitle });
    fireEvent.change(within(card).getByLabelText(t.wTopupAmount), { target: { value: '100' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wTopupContinue })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: t.wTopupPay })));
    first.unmount(); // the browser left for the checkout page

    render(<WalletScreen {...props} />); // ...and came back
    expect((await screen.findByRole('status')).textContent).toContain(t.wTopupWaiting);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(screen.queryByText(t.wTopupArrived)).toBeNull();
    balance += 10000;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(t.wTopupArrived));
  });

  it('the order\'s own state wins: an unrelated credit while the order is still pending does not say "arrived"', async () => {
    const source = createSampleSource();
    let balance = 18500;
    let state: 'pending' | 'paid' = 'pending';
    const real = source.wallet!.wallet;
    source.wallet!.wallet = async () => ({ ...(await real()), balanceMinor: balance, availableMinor: balance - 2500 });
    source.wallet!.topupState = async (orderId) => ({ orderId, state, amountMinor: 10000, feeMinor: 0, totalMinor: 10000 });
    const props = { t, lang: 'ar' as const, source, api: source.wallet!, now, go: vi.fn() };
    const first = render(<WalletScreen {...props} />);
    const card = await screen.findByRole('region', { name: t.wTopupTitle });
    fireEvent.change(within(card).getByLabelText(t.wTopupAmount), { target: { value: '100' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wTopupContinue })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: t.wTopupPay })));
    first.unmount();
    render(<WalletScreen {...props} />);
    balance += 10000; // a refund or an adjustment lands; the card payment has not
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(screen.getByRole('status').textContent).toContain(t.wTopupWaiting);
    expect(screen.queryByText(t.wTopupArrived)).toBeNull();
    state = 'paid';
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(t.wTopupArrived));
  });

  it('a failed or expired order stops the waiting and says nothing was taken', async () => {
    const source = createSampleSource();
    source.wallet!.topupState = async (orderId) => ({ orderId, state: 'failed', amountMinor: 10000, feeMinor: 0, totalMinor: 10000 });
    const props = { t, lang: 'ar' as const, source, api: source.wallet!, now, go: vi.fn() };
    const first = render(<WalletScreen {...props} />);
    const card = await screen.findByRole('region', { name: t.wTopupTitle });
    fireEvent.change(within(card).getByLabelText(t.wTopupAmount), { target: { value: '100' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wTopupContinue })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: t.wTopupPay })));
    first.unmount();
    render(<WalletScreen {...props} />);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(t.wTopupFailed));
  });

  it('rejects an amount outside the range without calling the server', async () => {
    const source = createSampleSource();
    const topup = vi.spyOn(source.wallet!, 'topup');
    render(<WalletScreen t={t} lang="ar" source={source} api={source.wallet!} now={now} go={vi.fn()} />);
    const card = await screen.findByRole('region', { name: t.wTopupTitle });
    fireEvent.change(within(card).getByLabelText(t.wTopupAmount), { target: { value: '5' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wTopupContinue })));
    expect(topup).not.toHaveBeenCalled();
    expect(within(card).getByRole('alert').textContent).toContain(t.wTopupBadAmount);
  });

  it('is the owner’s only, and only while the server has top-ups switched on', async () => {
    await openWallet(withWallet({}, 'staff'));
    expect(screen.queryByRole('region', { name: t.wTopupTitle })).toBeNull();
    cleanup();
    await openWallet(withWallet({ topupsEnabled: false }));
    const card = screen.getByRole('region', { name: t.wTopupTitle });
    expect(within(card).getByText(t.wTopupOff)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: t.wTopupContinue })).toBeNull();
  });
});

describe('wallet: statement', () => {
  it('shows opening and closing, the totals and every row of the month', async () => {
    await openWallet();
    const st = screen.getByRole('region', { name: t.wStatementTitle });
    expect(await within(st).findByText(egp(30000))).toBeTruthy(); // opening
    expect(within(st).getAllByText(egp(18500)).length).toBeGreaterThan(0); // closing
    const rows = within(within(st).getByRole('list', { name: t.wRows })).getAllByRole('listitem');
    expect(rows).toHaveLength(6);
    expect(within(rows[0]!).getByText(t.ledgerKinds.topup!)).toBeTruthy();
    expect(within(st).getByRole('list', { name: t.wByKind })).toBeTruthy();
    expect(within(st).getByRole('list', { name: t.wByCategory })).toBeTruthy();
    expect(within(st).getByText(/تسويق: /)).toBeTruthy(); // card-billed messages, by category
  });

  it('loads another month and says when it is empty', async () => {
    const source = createSampleSource();
    const statement = vi.spyOn(source.wallet!, 'statement');
    await openWallet(source);
    await screen.findByRole('list', { name: t.wRows });
    fireEvent.change(screen.getByLabelText(t.wMonth), { target: { value: '2026-09' } });
    await waitFor(() => expect(statement).toHaveBeenLastCalledWith('2026-09'));
    expect(await screen.findByText(t.wNoRows)).toBeTruthy();
  });

  it('downloads the CSV through the token-carrying API, not a bare link', async () => {
    const source = createSampleSource();
    const csv = vi.spyOn(source.wallet!, 'statementCsv');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await openWallet(source);
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: t.wCsv })));
    expect(csv).toHaveBeenCalledWith('2026-10');
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('staff do not see the statement (the server would answer 403)', async () => {
    await openWallet(withWallet({}, 'staff'));
    expect(screen.queryByRole('region', { name: t.wStatementTitle })).toBeNull();
    expect(screen.queryByRole('region', { name: t.wRefundTitle })).toBeNull();
  });
});

describe('wallet: refund requests', () => {
  it('states the rules, lists past requests with their state and the reviewer’s note', async () => {
    await openWallet();
    const card = screen.getByRole('region', { name: t.wRefundTitle });
    expect(within(card).getByText(t.wRefundRules)).toBeTruthy();
    const list = await within(card).findByRole('list', { name: t.wRefundPast });
    expect(within(list).getByText(t.refundStates.rejected!)).toBeTruthy();
    expect(within(list).getByText('الرصيد اتصرف على حملة قبل الطلب.')).toBeTruthy();
    expect(within(list).getByText(t.refundStates.paid!)).toBeTruthy();
  });

  it('refuses less than 50 EGP before asking the server, then sends a valid request', async () => {
    const source = createSampleSource();
    const request = vi.spyOn(source.wallet!, 'requestRefund');
    await openWallet(source);
    const card = screen.getByRole('region', { name: t.wRefundTitle });
    fireEvent.change(within(card).getByLabelText(t.wRefundAmount), { target: { value: '49' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wRefundSend })));
    expect(request).not.toHaveBeenCalled();
    expect(within(card).getByRole('alert').textContent).toContain(t.wRefundBelowMin);
    fireEvent.change(within(card).getByLabelText(t.wRefundAmount), { target: { value: '120.5' } });
    fireEvent.change(within(card).getByLabelText(t.wRefundNote), { target: { value: 'ألغيت الاشتراك' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wRefundSend })));
    expect(request).toHaveBeenCalledWith(12050, 'ألغيت الاشتراك');
    expect(await within(card).findByText(t.wRefundSent)).toBeTruthy();
    expect(within(card).getByText(t.refundStates.pending!)).toBeTruthy();
  });

  it('explains the server’s refusal in plain words', async () => {
    const source = createSampleSource();
    source.wallet!.requestRefund = async () => { throw new ApiError('invalid_request', 409, 'plan_still_active'); };
    await openWallet(source);
    const card = screen.getByRole('region', { name: t.wRefundTitle });
    fireEvent.change(within(card).getByLabelText(t.wRefundAmount), { target: { value: '100' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wRefundSend })));
    expect((await within(card).findByRole('alert')).textContent).toContain(t.refundReasons.plan_still_active!);
  });
});

describe('wallet: low balance banner in the inbox', () => {
  async function inbox(source: InboxSource) {
    render(<App source={source} now={now} />);
    await screen.findByRole('listbox', { name: 'المحادثات' });
  }

  it('shows nothing while the wallet is healthy', async () => {
    await inbox(createSampleSource());
    await act(async () => undefined);
    expect(document.querySelector('[data-banner="wallet"]')).toBeNull();
  });

  it('a low balance gives a calm banner with a link to the wallet', async () => {
    await inbox(withWallet({ lowBalance: true }));
    const banner = await screen.findByText(t.wBannerLow);
    const link = within(banner.closest('[data-banner="wallet"]') as HTMLElement).getByRole('link', { name: t.wBannerLink });
    await act(async () => fireEvent.click(link));
    expect(await screen.findByRole('heading', { name: 'المحفظة', level: 1 })).toBeTruthy();
  });

  it('a rejected InstaPay payment shows a notice with the reason, in the inbox banner', async () => {
    await inbox(withWallet({ instapayNotice: { id: 'ip-1', reason: 'المبلغ أقل من المطلوب' } }));
    expect(await screen.findByText(t.ipRejectedBanner('المبلغ أقل من المطلوب'))).toBeTruthy();
    expect(STRINGS.en.ipRejectedBanner('x')).toBe('Your InstaPay payment was not accepted: x');
  });

  it('debt, and an empty balance on a wallet-paid number, say what stops', async () => {
    await inbox(withWallet({ debtMinor: 3000, balanceMinor: -3000, availableMinor: -5500, lowBalance: true }));
    expect(await screen.findByText(t.wBannerDebt(egp(3000)))).toBeTruthy();
    expect(screen.getByText(t.wMarketingPaused)).toBeTruthy();
  });

  it('an empty balance does not claim marketing is paused when only cards pay Meta', async () => {
    await inbox(withWallet({ availableMinor: 0, balanceMinor: 0, lowBalance: true, funding: [{ phoneNumberId: 'p', displayPhone: '+20 100', funding: 'merchant_card' }] }));
    expect(await screen.findByText(t.wBannerLow)).toBeTruthy();
    expect(screen.queryByText(t.wMarketingPaused)).toBeNull();
  });
});

describe('wallet: packages (owner)', () => {
  const props = (source: InboxSource, go = vi.fn()) => ({ t, lang: 'ar' as const, source, api: source.wallet!, now, go });

  it('a yearly package says it is paid once for 12 months with credits added monthly; a monthly one does not', async () => {
    const source = createSampleSource();
    vi.spyOn(source.wallet!, 'packages').mockResolvedValue([
      { id: 'starter', name: 'Starter', priceMinor: 69000, aiCredits: 300, maxMembers: 2, features: ['members'], periodMonths: 1 },
      { id: 'starter-yearly', name: 'Starter (yearly)', priceMinor: 621000, aiCredits: 300, maxMembers: 2, features: ['members'], periodMonths: 12 },
    ]);
    render(<WalletScreen {...props(source, vi.fn())} />);
    const card = await screen.findByRole('region', { name: t.wPackagesTitle });
    const yearly = (await within(card).findByText('Starter (yearly)')).closest('li')!;
    expect(within(yearly).getByText(t.wPackageYearly(num(12, 'ar')))).toBeTruthy();
    const monthly = (await within(card).findByText('Starter')).closest('li')!;
    expect(within(monthly).queryByText(t.wPackageYearly(num(12, 'ar')))).toBeNull();
  });

  it('a refused switch while a period is queued says so and opens no checkout', async () => {
    const source = createSampleSource();
    const go = vi.fn();
    vi.spyOn(source.wallet!, 'buyPackage').mockRejectedValue(new ApiError('yearly_queued', 409));
    render(<WalletScreen {...props(source, go)} />);
    const card = await screen.findByRole('region', { name: t.wPackagesTitle });
    const gold = (await within(card).findByText('Gold')).closest('li')!;
    await act(async () => fireEvent.click(within(gold).getByRole('button', { name: t.wPackageBuy })));
    expect(await screen.findByText(t.wYearlyQueued('ahlan@ebda.app'))).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
  });

  it('lists the packages with price and AI credits and sends only the package id; redirects only to https', async () => {
    const source = createSampleSource();
    const go = vi.fn();
    const buy = vi.spyOn(source.wallet!, 'buyPackage');
    render(<WalletScreen {...props(source, go)} />);
    const card = await screen.findByRole('region', { name: t.wPackagesTitle });
    const gold = (await within(card).findByText('Gold')).closest('li')!;
    expect(within(gold).getByText(egp(50000))).toBeTruthy();
    expect(within(gold).getByText(t.wPackageCredits(num(300, 'ar')))).toBeTruthy();
    await act(async () => fireEvent.click(within(gold).getByRole('button', { name: t.wPackageBuy })));
    expect(buy).toHaveBeenCalledWith('gold');
    expect(go).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\//));
    expect(screen.queryByText(t.wPackageActivated)).toBeNull(); // paying has not been confirmed yet
  });

  it('refuses a non-https checkout url and says so', async () => {
    const source = createSampleSource();
    source.wallet!.buyPackage = async (id) => ({ orderId: 'P-9', state: 'pending', packageId: id, amountMinor: 50000, checkoutUrl: 'javascript:alert(1)' });
    const go = vi.fn();
    render(<WalletScreen {...props(source, go)} />);
    const card = await screen.findByRole('region', { name: t.wPackagesTitle });
    await act(async () => fireEvent.click((await within(card).findAllByRole('button', { name: t.wPackageBuy }))[0]!));
    expect(go).not.toHaveBeenCalled();
    expect(within(card).getByRole('alert').textContent).toBe(t.wPackageError);
  });

  it('after the card form, a waiting order polls and turns into "activated" when the server says paid', async () => {
    const source = createSampleSource();
    render(<WalletScreen {...props(source)} />);
    const card = await screen.findByRole('region', { name: t.wPackagesTitle });
    await act(async () => fireEvent.click((await within(card).findAllByRole('button', { name: t.wPackageBuy }))[0]!));
    expect(await within(card).findByText(t.wPackageWaiting)).toBeTruthy();
    cleanup();
    source.wallet!.packageOrderState = async (orderId) => ({ orderId, state: 'paid', packageId: 'gold', amountMinor: 50000 });
    render(<WalletScreen {...props(source)} />); // coming back from the card form: the pending order survived in storage
    expect(await screen.findByText(t.wPackageActivated)).toBeTruthy();
    expect(store.get('wallet.pendingPackage')).toBeUndefined();
  });

  it.each(['expired', 'failed', 'refunded'] as const)('a waiting order that turns %s stops the polling and says the payment was not confirmed', async (state) => {
    const source = createSampleSource();
    source.wallet!.packageOrderState = async (orderId) => ({ orderId, state, packageId: 'gold', amountMinor: 50000 });
    store.set('wallet.pendingPackage', JSON.stringify({ orderId: 'P-1', at: now() }));
    render(<WalletScreen {...props(source)} />);
    expect(await screen.findByText(t.wPackageFailed('ahlan@ebda.app'))).toBeTruthy();
    expect(store.get('wallet.pendingPackage')).toBeUndefined();
  });

  it('staff do not see the section; a switched-off server (404) hides it; a failure offers retry; no packages says so', async () => {
    const staff = createSampleSource();
    staff.role = 'staff';
    const a = render(<WalletScreen {...props(staff)} />);
    await screen.findByRole('heading', { name: t.walletTitle, level: 1 });
    expect(screen.queryByRole('region', { name: t.wPackagesTitle })).toBeNull();
    a.unmount();

    const off = createSampleSource();
    off.wallet!.packages = async () => { throw new ApiError('not_found', 404); };
    const b = render(<WalletScreen {...props(off)} />);
    await screen.findByRole('heading', { name: t.walletTitle, level: 1 });
    await act(async () => undefined);
    expect(screen.queryByRole('region', { name: t.wPackagesTitle })).toBeNull();
    b.unmount();

    const broken = createSampleSource();
    broken.wallet!.packages = async () => { throw new ApiError('x', 500); };
    const c = render(<WalletScreen {...props(broken)} />);
    expect(await within(await screen.findByRole('region', { name: t.wPackagesTitle })).findByText(t.wPackagesError, { exact: false })).toBeTruthy();
    c.unmount();

    const none = createSampleSource();
    none.wallet!.packages = async () => [];
    render(<WalletScreen {...props(none)} />);
    expect(await screen.findByText(t.wPackagesEmpty)).toBeTruthy();
  });
});

describe('wallet: renew reminder in the inbox', () => {
  const DAY_MS = 86_400_000;
  async function inbox(source: InboxSource) {
    render(<App source={source} now={now} />);
    await screen.findByRole('listbox', { name: 'المحادثات' });
  }
  const plan = (packageId: string, days: number) => ({ plan: { packageId, status: 'active' as const, periodEnd: now() + days * DAY_MS, cancelledAt: null } });

  it('a bought package ending within 7 days shows a renew line with the wallet link', async () => {
    await inbox(withWallet(plan('gold', 3)));
    expect(await screen.findByText(t.wBannerRenew(dateTime(now() + 3 * DAY_MS, 'ar')))).toBeTruthy();
  });
  it('nothing for a package with more than 7 days left, or for the store-included one (the Store renews it)', async () => {
    await inbox(withWallet(plan('gold', 18)));
    await act(async () => undefined);
    expect(document.querySelector('[data-banner="wallet"]')).toBeNull();
    cleanup();
    await inbox(withWallet(plan('store-included', 2)));
    await act(async () => undefined);
    expect(document.querySelector('[data-banner="wallet"]')).toBeNull();
  });
});

describe('wallet: pay with InstaPay', () => {
  const file = (name: string, type: string, bytes = 100) => new File([new Uint8Array(bytes)], name, { type });

  it('lists past requests (a rejection shows its reason), creates a package request and shows the payee, the exact amount and the reference', async () => {
    await openWallet();
    const card = await screen.findByRole('region', { name: t.wIpTitle });
    expect(within(card).getByText(t.instapayStates.rejected!)).toBeTruthy();
    expect(within(card).getByText(t.wIpRejectedLine('المبلغ في الإيصال أقل من المطلوب'))).toBeTruthy();
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wIpCreate })));
    expect(await within(card).findByText(/sample@instapay/)).toBeTruthy();
    expect(within(card).getAllByText(egp(25000)).length).toBeGreaterThanOrEqual(2); // the package option and the exact amount: the server's price, the client never sent one
    expect(within(card).getByText(t.wIpReference, { exact: false })).toBeTruthy();
    expect(within(card).getByLabelText(t.wIpUpload)).toBeTruthy();
  });

  it('refuses a wrong type or an oversize file before anything is sent, and uploads a valid one', async () => {
    const source = createSampleSource();
    const upload = vi.spyOn(source.wallet!, 'uploadInstapayProof');
    await openWallet(source);
    const card = await screen.findByRole('region', { name: t.wIpTitle });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wIpCreate })));
    const input = await within(card).findByLabelText(t.wIpUpload);
    await act(async () => fireEvent.change(input, { target: { files: [file('x.svg', 'image/svg+xml')] } }));
    expect(within(card).getByRole('alert').textContent).toContain(t.wIpBadType);
    await act(async () => fireEvent.change(input, { target: { files: [file('big.png', 'image/png', 5 * 1024 * 1024 + 1)] } }));
    expect(within(card).getByRole('alert').textContent).toContain(t.wIpTooBig);
    expect(upload).not.toHaveBeenCalled();
    await act(async () => fireEvent.change(input, { target: { files: [file('proof.pdf', 'application/pdf')] } }));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await within(card).findByText(t.wIpUploaded)).toBeTruthy();
  });

  it('is hidden while the server has InstaPay billing off, and for staff', async () => {
    const off = createSampleSource();
    off.wallet!.instapay = async () => { throw new ApiError('not_found', 404); };
    await openWallet(off);
    await screen.findByRole('region', { name: t.wRefundTitle });
    expect(screen.queryByRole('region', { name: t.wIpTitle })).toBeNull();
    cleanup();
    const staff = createSampleSource();
    staff.role = 'staff';
    await openWallet(staff);
    expect(screen.queryByRole('region', { name: t.wIpTitle })).toBeNull();
  });
});

describe('AI credits: what one is and when it is low (M-084)', () => {
  it('says what a credit pays for and shows no warning while credits are healthy', async () => {
    await openWallet();
    expect(screen.getByText(t.wAiCreditDefinition)).toBeTruthy();
    expect(screen.queryByText(/باقي .* رصيد ذكاء اصطناعي بس/)).toBeNull();
  });
  it('warns, with the threshold, when the credits are low', async () => {
    await openWallet(withWallet({ aiCredits: { balance: 8, available: 8, low: true, lowThreshold: 30, allowance: 300 } }));
    expect(screen.getByText(t.wAiCreditsLow('8', '30'))).toBeTruthy();
  });
});

describe('weekly digest (T13)', () => {
  it('shows the week in counts and the balance, and the owner can switch it off and on', async () => {
    await openWallet();
    const card = await screen.findByRole('region', { name: t.dgTitle });
    expect(card.textContent).toContain(t.dgCustomers);
    expect(card.textContent).toContain(t.dgSpend);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.dgSwitchOff })));
    expect(await screen.findByText(t.dgOff)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.dgSwitchOn })));
    expect((await screen.findByRole('region', { name: t.dgTitle })).textContent).toContain(t.dgCustomers);
  });
  it('staff see the digest but not the switch', async () => {
    await openWallet(withWallet({}, 'staff'));
    await screen.findByRole('region', { name: t.dgTitle });
    expect(screen.queryByRole('button', { name: t.dgSwitchOff })).toBeNull();
  });
});
