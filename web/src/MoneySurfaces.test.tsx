import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError } from './data/api';
import type { WalletApi, WalletDto, YearlyRefundView } from './data/billing';
import { createSampleSource } from './data/sample';
import type { InboxSource } from './data/source';
import { STRINGS } from './i18n';
import { formatMoney } from './lib/format';

const store = new Map<string, string>();
beforeEach(() => vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() }));
afterEach(() => { cleanup(); store.clear(); vi.unstubAllGlobals(); });
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const t = STRINGS.ar;
const egp = (minor: number) => formatMoney(minor, 'EGP', 'ar');
const confirm = { confirmId: '11111111-1111-4111-8111-111111111111', token: 'a'.repeat(64), expiresAt: now() + 900_000 };

/** The sample source with the wallet and money calls this test cares about replaced. */
function source(role: InboxSource['role'], patch: Partial<WalletApi> = {}, wallet: Partial<WalletDto> = {}): InboxSource {
  const s = createSampleSource();
  s.role = role;
  const real = s.wallet!.wallet;
  Object.assign(s.wallet!, { wallet: async () => ({ ...(await real()), ...wallet }) }, patch);
  return s;
}
async function openWallet(s: InboxSource) {
  render(<App source={s} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المحفظة' })));
  await screen.findByRole('heading', { name: 'المحفظة', level: 1 });
}
const unknownFunding: Partial<WalletDto> = { funding: [{ phoneNumberId: 'pn-x', displayPhone: '+20 100 555 0777', funding: 'unknown' }, { phoneNumberId: 'pn-sample-shared', displayPhone: '+20 100 555 0900', funding: 'platform_line' }] };

describe('who pays Meta for an own number', () => {
  it('an unset number offers the card; nothing is sent until the owner says yes; the platform line is never offered', async () => {
    const previewNumberFunding = vi.fn(async () => ({ phoneNumberId: 'pn-x', current: 'unknown' as const, funding: 'merchant_card' as const, confirm }));
    const confirmNumberFunding = vi.fn(async () => undefined);
    await openWallet(source('owner', { previewNumberFunding, confirmNumberFunding }, unknownFunding));
    const funding = screen.getByRole('region', { name: t.wFundingTitle });
    expect(within(funding).getAllByRole('button', { name: t.wFundAction })).toHaveLength(1); // only the unset own number, not the platform line
    await act(async () => fireEvent.click(within(funding).getByRole('button', { name: t.wFundAction })));
    expect(confirmNumberFunding).not.toHaveBeenCalled();
    expect(within(funding).getByText(t.wFundConfirmText)).toBeTruthy();
    const yes = within(funding).getByRole('button', { name: t.wFundConfirmBtn });
    await act(async () => { fireEvent.click(yes); fireEvent.click(yes); });
    expect(confirmNumberFunding).toHaveBeenCalledTimes(1);
    expect(confirmNumberFunding).toHaveBeenCalledWith('pn-x', expect.objectContaining({ confirmId: confirm.confirmId, token: confirm.token }));
    expect(await screen.findByText(t.wFundDone)).toBeTruthy();
  });
  it('staff do not see the action', async () => {
    await openWallet(source('staff', {}, unknownFunding));
    expect(screen.queryByRole('button', { name: t.wFundAction })).toBeNull();
  });
  it('a number the operator funds says so instead of failing silently', async () => {
    const previewNumberFunding = vi.fn(async () => { throw new ApiError('invalid_request', 409, 'operator_funded'); });
    await openWallet(source('owner', { previewNumberFunding }, unknownFunding));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.wFundAction })));
    expect(await screen.findByText(t.wFundOperator)).toBeTruthy();
  });
});

describe('AI credit packs', () => {
  const packs = { enabled: true, items: [{ id: 'credits-100', credits: 100, priceMinor: 23000 }, { id: 'credits-500', credits: 500, priceMinor: 115000 }] };
  it('a low balance links to the credits card; picking a pack shows credits and price and asks yes; one yes is one order and opens the card page', async () => {
    const previewCreditPack = vi.fn(async () => ({ pack: packs.items[0]!, confirm }));
    const buyCreditPack = vi.fn(async () => ({ orderId: 'cp_1', state: 'pending' as const, credits: 100, amountMinor: 23000, checkoutUrl: 'https://checkout.kashier.io/x' }));
    const s = source('owner', { creditPacks: async () => packs, previewCreditPack, buyCreditPack }, { aiCredits: { balance: 3, available: 3, low: true, lowThreshold: 30, allowance: 300 } });
    render(<App source={s} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المحفظة' })));
    expect(await screen.findByRole('link', { name: t.wCrBuyLink })).toBeTruthy(); // the low-credit warning points at the card
    const card = await screen.findByRole('region', { name: t.wCrTitle });
    await act(async () => fireEvent.click(within(card).getAllByRole('button', { name: t.wCrBuy })[0]!));
    expect(buyCreditPack).not.toHaveBeenCalled();
    expect(within(card).getByText(t.wCrConfirmText('100', egp(23000)))).toBeTruthy();
    const yes = within(card).getByRole('button', { name: t.wCrConfirmBtn });
    await act(async () => { fireEvent.click(yes); fireEvent.click(yes); });
    expect(buyCreditPack).toHaveBeenCalledTimes(1);
    expect(buyCreditPack).toHaveBeenCalledWith('credits-100', expect.objectContaining({ token: confirm.token }));
    expect(JSON.parse(store.get('wallet.pendingCredits')!)).toMatchObject({ orderId: 'cp_1', credits: 100 });
  });
  it('only an https checkout page is ever followed', async () => {
    const buyCreditPack = vi.fn(async () => ({ orderId: 'cp_2', state: 'pending' as const, credits: 100, amountMinor: 23000, checkoutUrl: 'http://evil.test/x' }));
    const s = source('owner', { creditPacks: async () => packs, previewCreditPack: async () => ({ pack: packs.items[0]!, confirm }), buyCreditPack });
    await openWallet(s);
    const card = await screen.findByRole('region', { name: t.wCrTitle });
    await act(async () => fireEvent.click(within(card).getAllByRole('button', { name: t.wCrBuy })[0]!));
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wCrConfirmBtn })));
    expect(store.get('wallet.pendingCredits')).toBeUndefined();
    expect(within(card).getByText(t.opFailed)).toBeTruthy();
  });
  it('a paid order says the credits were added; a failed one says nothing was taken', async () => {
    store.set('wallet.pendingCredits', JSON.stringify({ orderId: 'cp_9', credits: 500, at: now() }));
    await openWallet(source('owner', { creditPacks: async () => packs, creditOrderState: async () => ({ orderId: 'cp_9', state: 'paid' as const, credits: 500, amountMinor: 115000 }) }));
    expect(await screen.findByText(t.wCrArrived('500'))).toBeTruthy();
    cleanup();
    store.set('wallet.pendingCredits', JSON.stringify({ orderId: 'cp_8', credits: 500, at: now() }));
    await openWallet(source('owner', { creditPacks: async () => packs, creditOrderState: async () => ({ orderId: 'cp_8', state: 'failed' as const, credits: 500, amountMinor: 115000 }) }));
    expect(await screen.findByText(t.wCrFailed)).toBeTruthy();
  });
  it('a moved price is explained, not a generic error; staff never see the card', async () => {
    const buyCreditPack = vi.fn(async () => { throw new ApiError('invalid_request', 409, 'confirmation_mismatch'); });
    await openWallet(source('owner', { creditPacks: async () => packs, previewCreditPack: async () => ({ pack: packs.items[0]!, confirm }), buyCreditPack }));
    const card = await screen.findByRole('region', { name: t.wCrTitle });
    await act(async () => fireEvent.click(within(card).getAllByRole('button', { name: t.wCrBuy })[0]!));
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wCrConfirmBtn })));
    expect(within(card).getByText(t.wConfirmStale)).toBeTruthy();
    cleanup();
    await openWallet(source('staff', { creditPacks: async () => packs }));
    expect(screen.queryByRole('region', { name: t.wCrTitle })).toBeNull();
  });
  it('the inbox banner says the credits are low', async () => {
    render(<App source={source('owner', { creditPacks: async () => packs }, { aiCredits: { balance: 3, available: 3, low: true, lowThreshold: 30, allowance: 300 } })} now={now} />);
    expect(await screen.findByText(t.wBannerCreditsLow)).toBeTruthy();
  });
});

describe('yearly package refund request', () => {
  const quote = { orderId: 'o-1', packageId: 'growth-yearly', periodMonths: 12, monthlyMinor: 111750, unusedMonths: 11, grossMinor: 1229250, debtMinor: 100000, debtSettledMinor: 100000, refundMinor: 1129250 };
  const view = (v: Partial<YearlyRefundView>): YearlyRefundView => ({ quote, reason: null, request: null, ...v });
  it('shows the quote, files a request only after a yes, and says no money moved', async () => {
    const previewYearlyRefund = vi.fn(async () => ({ quote, confirm }));
    const requestYearlyRefund = vi.fn(async () => ({ id: confirm.confirmId, orderId: 'o-1', state: 'pending' as const, unusedMonths: 11, debtSettledMinor: 100000, refundMinor: 1129250, createdAt: now() }));
    await openWallet(source('owner', { yearlyRefund: async () => view({}), previewYearlyRefund, requestYearlyRefund }));
    const card = await screen.findByRole('region', { name: t.wYrTitle });
    expect(within(card).getByText(egp(1129250))).toBeTruthy();
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: t.wYrAsk })));
    expect(requestYearlyRefund).not.toHaveBeenCalled();
    const yes = within(card).getByRole('button', { name: t.wYrConfirmBtn });
    await act(async () => { fireEvent.click(yes); fireEvent.click(yes); }); // a double click is one request
    expect(requestYearlyRefund).toHaveBeenCalledTimes(1);
    expect(requestYearlyRefund).toHaveBeenCalledWith(expect.objectContaining({ token: confirm.token }));
    expect(await within(card).findByText(t.wYrSent)).toBeTruthy();
  });
  it('a pending request is shown and cannot be filed twice; a quote that moved is explained', async () => {
    await openWallet(source('owner', { yearlyRefund: async () => view({ request: { id: 'r', orderId: 'o-1', state: 'pending', unusedMonths: 11, debtSettledMinor: 100000, refundMinor: 1129250, createdAt: now() } }) }));
    const card = await screen.findByRole('region', { name: t.wYrTitle });
    expect(within(card).getByText(new RegExp(t.wYrPending.slice(0, 20)))).toBeTruthy();
    expect(within(card).queryByRole('button', { name: t.wYrAsk })).toBeNull();
    cleanup();
    const requestYearlyRefund = vi.fn(async () => { throw new ApiError('invalid_request', 409, 'confirmation_mismatch'); });
    await openWallet(source('owner', { yearlyRefund: async () => view({}), previewYearlyRefund: async () => ({ quote, confirm }), requestYearlyRefund }));
    const c2 = await screen.findByRole('region', { name: t.wYrTitle });
    await act(async () => fireEvent.click(within(c2).getByRole('button', { name: t.wYrAsk })));
    await act(async () => fireEvent.click(within(c2).getByRole('button', { name: t.wYrConfirmBtn })));
    expect(within(c2).getByText(t.wConfirmStale)).toBeTruthy();
  });
  it('no yearly package, no card; staff never see it', async () => {
    await openWallet(source('owner', { yearlyRefund: async () => view({ quote: null, reason: 'not_yearly' }) }));
    await waitFor(() => expect(screen.queryByRole('region', { name: t.wYrTitle })).toBeNull());
    cleanup();
    await openWallet(source('staff', { yearlyRefund: async () => view({}) }));
    expect(screen.queryByRole('region', { name: t.wYrTitle })).toBeNull();
  });
});
