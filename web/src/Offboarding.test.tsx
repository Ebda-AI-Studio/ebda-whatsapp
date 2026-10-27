import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { dateTime } from './components/CampaignsScreen';
import { ApiError } from './data/api';
import type { OffboardingView } from './data/billing';
import { createSampleSource } from './data/sample';
import type { InboxSource } from './data/source';
import { STRINGS } from './i18n';
import { formatMoney } from './lib/format';

const store = new Map<string, string>();
beforeEach(() => vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() }));
afterEach(() => { cleanup(); store.clear(); vi.unstubAllGlobals(); });
const NOW = Date.UTC(2026, 9, 24, 17, 0);
const now = () => NOW;
const t = STRINGS.ar;
const egp = (minor: number) => formatMoney(minor, 'EGP', 'ar');
const DAY = 86_400_000;

async function openWallet(role: InboxSource['role'] = 'owner', state?: Partial<OffboardingView>) {
  const source = createSampleSource();
  source.role = role;
  if (state) {
    const base: OffboardingView = { state: 'pending', requestedRole: 'owner', requestedAt: NOW, executeAfter: NOW + 14 * DAY, writeOffMinor: 0 };
    source.wallet!.offboarding = vi.fn(async () => ({ ...base, ...state }));
  }
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المحفظة' })));
  await screen.findByRole('heading', { name: 'المحفظة', level: 1 });
  return source;
}
const card = () => screen.findByRole('region', { name: t.offTitle });

describe('delete this store\'s WhatsApp account (owner)', () => {
  it('is offered to the owner only', async () => {
    await openWallet('staff');
    expect(screen.queryByRole('region', { name: t.offTitle })).toBeNull();
    cleanup();
    await openWallet('owner');
    expect(await card()).toBeTruthy();
  });

  it('shows what happens, the cooling-off, and the balance that would be given up; confirm stays off until the balance is accepted', async () => {
    const source = await openWallet('owner');
    const c = await card();
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offAsk })));
    expect(within(c).getByText(t.offWhat)).toBeTruthy();
    expect(within(c).getByText(t.offBalance(egp(18500)))).toBeTruthy(); // the sample wallet holds 185 EGP
    const confirm = within(c).getByRole('button', { name: t.offConfirm }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(c).getByLabelText(t.offGiveUp(egp(18500))));
    expect(confirm.disabled).toBe(false);
    const request = vi.spyOn(source.wallet!, 'requestOffboarding');
    await act(async () => fireEvent.click(confirm));
    expect(request).toHaveBeenCalledWith({ acceptWriteOff: true });
    expect(await within(c).findByText(t.offPending(dateTime(NOW + 14 * DAY, 'ar')))).toBeTruthy();
    expect(within(c).getByText(t.offWriteOff(egp(18500)))).toBeTruthy();
  });

  it('with no balance there is nothing to accept', async () => {
    const source = createSampleSource();
    const real = source.wallet!.wallet;
    source.wallet!.wallet = async () => ({ ...(await real()), balanceMinor: 0, heldMinor: 0, availableMinor: 0 });
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المحفظة' })));
    const c = await card();
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offAsk })));
    expect(within(c).queryByRole('checkbox')).toBeNull();
    expect((within(c).getByRole('button', { name: t.offConfirm }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a pending deletion the owner asked for shows its date and a cancel button', async () => {
    const source = await openWallet('owner', { writeOffMinor: 4000 });
    const c = await card();
    expect(await within(c).findByText(t.offPending(dateTime(NOW + 14 * DAY, 'ar')))).toBeTruthy();
    expect(within(c).getByText(t.offWriteOff(egp(4000)))).toBeTruthy();
    const cancel = vi.spyOn(source.wallet!, 'cancelOffboarding').mockResolvedValue(undefined);
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offCancel })));
    expect(cancel).toHaveBeenCalled();
    expect(await within(c).findByRole('button', { name: t.offAsk })).toBeTruthy();
  });

  it('a deletion our team started has no cancel button and names the support address', async () => {
    await openWallet('owner', { requestedRole: 'operator' });
    const c = await card();
    expect(await within(c).findByText(t.offOperator('ahlan@ebda.app'))).toBeTruthy();
    expect(within(c).queryByRole('button', { name: t.offCancel })).toBeNull();
  });

  it('while it runs there is nothing to press', async () => {
    await openWallet('owner', { state: 'running' });
    const c = await card();
    expect(await within(c).findByText(t.offRunning)).toBeTruthy();
    expect(within(c).queryByRole('button')).toBeNull();
  });

  it('a balance that changed while the owner read the page is explained, not swallowed', async () => {
    const source = await openWallet('owner');
    source.wallet!.requestOffboarding = vi.fn().mockRejectedValue(new ApiError('invalid_request', 409, 'wallet_balance_remains'));
    const c = await card();
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offAsk })));
    fireEvent.click(within(c).getByLabelText(t.offGiveUp(egp(18500))));
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offConfirm })));
    expect((await within(c).findByRole('alert')).textContent).toBe(t.offBalanceChanged);
  });

  it('English reads right too', () => {
    const en = STRINGS.en;
    expect(en.offOperator('ahlan@ebda.app')).toContain('ahlan@ebda.app');
    expect(en.offTitle).toBe('Delete this store\'s WhatsApp account');
  });
});


describe('operator console: workspace deletion', () => {
  async function openOp() {
    const source = createSampleSource();
    source.role = 'super_admin';
    render(<App source={source} now={now} />);
    await act(async () => fireEvent.click(screen.getByRole('link', { name: t.opNav })));
    await screen.findByRole('heading', { name: t.opTitle, level: 1 });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: t.opTabs.offboarding! })));
    return source;
  }
  const fill = (c: HTMLElement, ws: string, reason: string) => {
    fireEvent.change(within(c).getByLabelText(t.offOpWorkspace), { target: { value: ws } });
    fireEvent.change(within(c).getByLabelText(t.offOpReason), { target: { value: reason } });
  };

  it('needs a workspace and a reason; requests with the cooling-off, then shows the status and the log', async () => {
    const source = await openOp();
    const c = await screen.findByRole('region', { name: t.offOpTitle });
    const request = vi.spyOn(source.operator!, 'requestOffboarding');
    const ask = within(c).getByRole('button', { name: t.offOpRequest }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true); // no workspace, no reason
    fill(c, 'ws-sample', 'طلب كتابي من صاحب المتجر');
    expect(ask.disabled).toBe(false);
    await act(async () => fireEvent.click(ask));
    expect(request).toHaveBeenCalledWith('ws-sample', { reason: 'طلب كتابي من صاحب المتجر' });
    expect(await within(c).findByText(t.offOpState.pending!)).toBeTruthy();
    expect(within(c).getByText(t.offPending(dateTime(NOW + 14 * DAY, 'ar')))).toBeTruthy();
    expect(within(c).getByText('requested')).toBeTruthy(); // the log row
  });

  it('"delete now" skips the wait; the write-off has to be ticked when the server asks for it', async () => {
    const source = await openOp();
    const c = await screen.findByRole('region', { name: t.offOpTitle });
    const request = vi.spyOn(source.operator!, 'requestOffboarding');
    request.mockRejectedValueOnce(new ApiError('invalid_request', 409, 'write_off_required', 50000));
    fill(c, 'ws-sample', 'أمر قانوني رقم 12');
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offOpNow })));
    expect(request).toHaveBeenLastCalledWith('ws-sample', { reason: 'أمر قانوني رقم 12', immediate: true });
    expect((await within(c).findByRole('alert')).textContent).toBe(t.offOpWriteOffNeeded(egp(50000)));
    fireEvent.click(within(c).getByLabelText(t.offOpAccept));
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offOpNow })));
    expect(request).toHaveBeenLastCalledWith('ws-sample', { reason: 'أمر قانوني رقم 12', immediate: true, acceptWriteOff: true });
  });

  it('cancel needs the reason too', async () => {
    const source = await openOp();
    const c = await screen.findByRole('region', { name: t.offOpTitle });
    fill(c, 'ws-sample', 'طلب كتابي من صاحب المتجر');
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offOpRequest })));
    const cancel = vi.spyOn(source.operator!, 'cancelOffboarding');
    await act(async () => fireEvent.click(await within(c).findByRole('button', { name: t.offCancel })));
    expect(cancel).toHaveBeenCalledWith('ws-sample', 'طلب كتابي من صاحب المتجر');
  });

  it('OFFBOARD-2ND-APPROVER-1 and the abuse hold: the second operator gets an Approve button with the reason; a held abuse suspension gets Release; both need the reason', async () => {
    const source = await openOp();
    const c = await screen.findByRole('region', { name: t.offOpTitle });
    fill(c, 'ws-sample', 'أمر قانوني رقم 12');
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offOpNow })));
    const base = await source.operator!.offboarding('ws-sample');
    const approve = vi.spyOn(source.operator!, 'approveOffboarding');
    const release = vi.spyOn(source.operator!, 'releaseOffboardingHold');
    vi.spyOn(source.operator!, 'offboarding').mockResolvedValue({ ...base, needsSecondApproval: true, lastError: 'held:second_approval_required' });
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offOpLoad })));
    expect(await within(c).findByText(t.offOpApproval)).toBeTruthy();
    expect(within(c).getByText(t.offOpHeldWhy.second_approval_required!, { exact: false })).toBeTruthy();
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offOpApprove })));
    expect(approve).toHaveBeenCalledWith('ws-sample', 'أمر قانوني رقم 12');
    expect(within(c).queryByRole('button', { name: t.offOpRelease })).toBeNull();
    vi.spyOn(source.operator!, 'offboarding').mockResolvedValue({ ...base, needsSecondApproval: false, lastError: 'held:suspended_abuse' });
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.offOpLoad })));
    await act(async () => fireEvent.click(await within(c).findByRole('button', { name: t.offOpRelease })));
    expect(release).toHaveBeenCalledWith('ws-sample', 'أمر قانوني رقم 12');
  });
});
