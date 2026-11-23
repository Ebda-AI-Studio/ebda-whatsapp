import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError } from './data/api';
import { createSampleSource } from './data/sample';
import { STRINGS } from './i18n';

const store = new Map<string, string>();
beforeEach(() => vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) }));
afterEach(() => { cleanup(); store.clear(); vi.unstubAllGlobals(); });
const now = () => Date.UTC(2026, 9, 24, 17, 0);
const t = STRINGS.ar;

async function card(source = createSampleSource()) {
  render(<App source={source} now={now} />);
  await act(async () => fireEvent.click(screen.getByRole('link', { name: 'المحفظة' })));
  await screen.findByRole('heading', { name: 'المحفظة', level: 1 });
  return { source, card: await screen.findByRole('region', { name: t.wIpTitle }) };
}

describe('InstaPay self-service: contest a rejection', () => {
  it('asks for a note first (no send under 5 characters), sends it, and the row then says it is under a second review', async () => {
    const source = createSampleSource();
    const spy = vi.spyOn(source.wallet!, 'contestInstapay');
    const { card: c } = await card(source);
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.wIpContest })));
    const send = within(c).getByRole('button', { name: t.wIpContestSend }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await act(async () => fireEvent.change(within(c).getByLabelText(t.wIpContestNote), { target: { value: 'تمام' } }));
    expect(send.disabled).toBe(true);
    await act(async () => fireEvent.change(within(c).getByLabelText(t.wIpContestNote), { target: { value: 'التحويل اتم الساعة 2 والمبلغ 500 جنيه' } }));
    await act(async () => fireEvent.click(send));
    expect(spy).toHaveBeenCalledWith('ip-0', 'التحويل اتم الساعة 2 والمبلغ 500 جنيه');
    expect(await within(c).findByText(t.wIpContestSent)).toBeTruthy();
    expect(await within(c).findByText(t.wIpContested)).toBeTruthy();
    expect(within(c).queryByRole('button', { name: t.wIpContest })).toBeNull(); // once only
  });

  it('a refusal from the server is one plain message, and the request stays contestable text-wise', async () => {
    const source = createSampleSource();
    source.wallet!.contestInstapay = async () => { throw new ApiError('invalid_request', 409, 'already_contested'); };
    const { card: c } = await card(source);
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.wIpContest })));
    await act(async () => fireEvent.change(within(c).getByLabelText(t.wIpContestNote), { target: { value: 'مراجعة تانية لو سمحتوا' } }));
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.wIpContestSend })));
    expect(within(c).getByRole('alert').textContent).toContain(t.wIpContestFailed);
  });
});

describe('InstaPay self-service: cancel a request with no proof', () => {
  it('a new request can be cancelled, says nothing is owed, and shows as cancelled by the owner', async () => {
    const source = createSampleSource();
    const spy = vi.spyOn(source.wallet!, 'cancelInstapay');
    const { card: c } = await card(source);
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.wIpCreate })));
    expect(await within(c).findByText(t.wIpCancelHint)).toBeTruthy();
    await act(async () => fireEvent.click(within(c).getByRole('button', { name: t.wIpCancel })));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await within(c).findByText(t.wIpCancelled, { selector: 'p' })).toBeTruthy();
    expect(within(c).queryByRole('button', { name: t.wIpCancel })).toBeNull();
  });

  it('a request that already has a proof offers no cancel (a person decides it)', async () => {
    const { card: c } = await card();
    expect(within(c).queryByRole('button', { name: t.wIpCancel })).toBeNull();
  });

  it('English strings exist for every new key', () => {
    for (const k of ['wIpCancel', 'wIpCancelHint', 'wIpCancelled', 'wIpCancelFailed', 'wIpContest', 'wIpContestNote', 'wIpContestSend', 'wIpContestSent', 'wIpContestFailed', 'wIpContested'] as const) expect(STRINGS.en[k], k).toBeTruthy();
  });
});
